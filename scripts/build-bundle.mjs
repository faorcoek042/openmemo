#!/usr/bin/env node
/**
 * 预编译包组装器（D-17 §9 步骤 1）。
 *
 * 产出一个**自带 Node 运行时**的目录 + 归档：用户下载、解开、双击启动脚本就能跑，
 * 机器上**不需要预装 Node / pnpm / git**。
 *
 * ## 它不做什么（这条比它做什么更重要）
 *
 * **不打包 ffmpeg / yt-dlp / whisper.cpp / 模型。** 那四样仍然由产品在网页上按需下载，
 * 钉死 tag + sha256（ADR-001 / ADR-015）。理由有两层：
 *   · 体积：whisper 的 CUDA 包一个就 677 MB，模型动辄 1.6 GB；
 *   · **许可证：ffmpeg 与 yt-dlp 是 GPL-3.0-or-later。** 我们把它们的字节放进自己的
 *     产物、再发到 Release 上，就是 conveying —— ADR-002 的「一旦要分发就是硬阻断」
 *     当场触发。让用户的机器直连 BtbN / yt-dlp 官方 GitHub 取，这条就不触发。
 *     **这不是形式主义，是这个包能不能存在的前提**（D-17 §1）。
 *
 * ## 它打包什么
 *
 *   runtime/node            官方 Node 二进制，**原样不改**
 *   app/daemon              daemon 的 dist
 *   app/node_modules        生产依赖闭包（扁平化，非符号链接）
 *   app/apps/web/dist       ★ 网页 bundle —— 缺了用户打开是白页
 *   ext/                    libsimple + sqlite-vec（用户 2026-08-08 裁决 ②）
 *
 * ### 为什么 Node 二进制**原样不改**
 *
 * `[实测 2026-08-08]` 官方 `node-v22.23.1-darwin-arm64` 带 `LC_CODE_SIGNATURE`，
 * 是 Node 官方签名并公证过的。任何改动（SEA 注入、`strip`）都会摧毁它，
 * 而我们没有 Developer ID 可以重签 —— 只能降级成 ad-hoc，Gatekeeper 姿态**更差**。
 * 所以这里既不注入也不 strip。省下的那 17 MB 不值得拿签名去换。
 *
 * ### 为什么 libsimple / sqlite-vec **进包**，而别的依赖不进
 *
 * 用户原判据是「依赖走在线下载」。Manager 2026-08-08 裁决**改判据而不是绕过它**：
 * 那句话针对的是 GPL 组件与 GB 级模型；而这两个加起来每平台约 5.4 MB、**全 MIT**。
 * 不放的后果是 `tokenizer` 静默退化成 `trigram`，而
 * **trigram 在结构上无法匹配长度 < 3 的查询 —— 中文两字词搜索返回 0 条，不报任何错**
 * （`[实测]` D-17 §3.3 的启动日志就是 `tokenizer=trigram vec=off`）。
 * 用 5.4 MB 换掉一个静默零结果，用户是中文使用者。
 *
 * ## 每一件外来字节都必须**对着一个committed 的摘要**校验
 *
 * 三个来源，三份权威，没有一处信"下载回来的东西说自己是谁"：
 *   · Node 运行时      → `nodejs.org/dist/vX/SHASUMS256.txt`（同源，但这是上游唯一发布点）
 *   · sherpa-onnx      → **`pnpm-lock.yaml` 的 `integrity`（sha512）** —— 仓库里 committed 的那份，
 *                        不是 registry 自报的那份
 *   · libsimple/vec    → **`vendor/manifests/sqlite-ext.json` 的 `sha256`** —— 同上
 *
 * ## 用法
 *
 *   node scripts/build-bundle.mjs --target linux-x64|win-x64|darwin-arm64
 *        [--out dist/bundles] [--cache .build/bundle-cache] [--skip-archive]
 *
 * 退出码：0 = 成功；1 = 任何一步失败。**没有"部分成功"这个状态** ——
 * 半个包比没有包更糟，因为半个包看起来是好的（build-backends.yml 的 C4 是同一条）。
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * 版本号的读取点。
 *
 * ★ 首选 `scripts/lib/version.mjs` 的 `readProductVersion()` —— 那是 D-12 定的
 *   **唯一读取点**，而且它的文件头里点名写着「预编译产物的包名要带版本号，
 *   而那条链路读的就是 package.json 的 version」，也就是说它本来就是为这里准备的。
 *
 * ⚠️ 但它此刻**还没进 git**（另一位 agent 在途）。硬 import 会让本脚本
 *   在 CI 上直接 `ERR_MODULE_NOT_FOUND` —— 一个因为别人的文件没提交而挂掉的构建，
 *   排查成本远高于它的价值。
 *
 * 所以这里是**动态 import + 回落**，回落读的是**同一个文件的同一个字段**
 * （根 `package.json` 的 `version`），因此不构成第二个事实来源，只是少了一层校验。
 * 等版本号那条线落地后，这段可以简化成一行静态 import。
 */
async function loadVersion() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  try {
    const m = await import('./lib/version.mjs');
    return {
      version: m.readProductVersion(),
      root: m.REPO_ROOT,
      via: 'scripts/lib/version.mjs（唯一读取点）',
    };
  } catch {
    const pj = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    if (typeof pj.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pj.version)) {
      die(`根 package.json 的 version 不是合法的 X.Y.Z：${JSON.stringify(pj.version)}`);
    }
    return {
      version: pj.version,
      root: repoRoot,
      via: '根 package.json（version.mjs 尚未提交，已回落）',
    };
  }
}

const execFileAsync = promisify(execFile);

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 平台表
 *
 * ★ 只有三格。其余组合是用户 2026-08-05 / 08-07 明确裁掉的（linux-arm64 / macos-x64 /
 *   win-arm64 / rocm）。**别"顺手"加回来** —— 每加一格就要多养一条 CI 腿和一份实测证据，
 *   而没有证据的那一格正是本仓最贵的东西。
 * ═══════════════════════════════════════════════════════════════════════════════════ */
const TARGETS = {
  'linux-x64': {
    nodeDist: 'linux-x64',
    nodeArchiveExt: '.tar.xz',
    nodeExe: 'node',
    platform: 'linux',
    // better-sqlite3 的 prebuilds/ 里的文件名（prebuildify 约定：<platform>-<arch>.node）
    prebuild: 'linux-x64.node',
    sherpaPkg: 'sherpa-onnx-linux-x64',
    extPackIds: ['libsimple-linux-x64', 'sqlite-vec-linux-x64'],
    archiveExt: '.tar.xz',
    launcher: 'start.sh',
  },
  'win-x64': {
    nodeDist: 'win-x64',
    nodeArchiveExt: '.zip',
    nodeExe: 'node.exe',
    platform: 'win32',
    prebuild: 'win32-x64.node',
    sherpaPkg: 'sherpa-onnx-win-x64',
    extPackIds: ['libsimple-win32-x64', 'sqlite-vec-win32-x64'],
    // Windows 只能用 .zip：系统自带解压认它，而 .tar.xz 要用户另装工具。
    // 代价是 deflate 压得比 xz 差不少，`[实测]` 同一棵 linux 树 xz 37.4 MiB / zip 56.0 MiB。
    archiveExt: '.zip',
    launcher: 'start.cmd',
  },
  'darwin-arm64': {
    nodeDist: 'darwin-arm64',
    nodeArchiveExt: '.tar.gz',
    nodeExe: 'node',
    platform: 'darwin',
    prebuild: 'darwin-arm64.node',
    sherpaPkg: 'sherpa-onnx-darwin-arm64',
    extPackIds: ['libsimple-darwin-arm64', 'sqlite-vec-darwin-arm64'],
    archiveExt: '.tar.gz',
    launcher: 'OpenMemo.command',
  },
};

/**
 * Node 运行时版本。
 *
 * **钉死，不取 "latest"。** 理由与 build-backends.yml 里 Vulkan SDK 那条同源：
 * 「凡是不显式指定就取构建机当前值的东西，都会把构建机的新度焊进产物」。
 *
 * 选 22 而不是 24：ADR-006 决策 7 把 Node 基线定在 22（better-sqlite3 v13 要求 ≥22），
 * CI 也钉的 22。**包里的运行时必须就是我们测过的那个** —— 否则"本机绿 CI 红"那类
 * 事故会换个地方重演（T-145 已经因为 node 22/24 的测试发现规则差异栽过一次）。
 *
 * `[实测 2026-08-08]` 该版本三平台产物的两条地板都在承诺范围内：
 *   darwin-arm64  minos 11.0.0   （README 承诺 ≥13.3，通过）
 *   linux-x64     GLIBC_2.28     （本仓基线 ≤2.34，通过）
 */
const NODE_VERSION = '22.23.1';

/** 随包发出、但自己没带 LICENSE 文件的包 —— 见 §"许可证声明"。 */
const KNOWN_LICENSE_TEXT_URL = {
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0.txt',
  MIT: 'https://opensource.org/license/mit',
};

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
function die(msg) {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
}
function say(msg) {
  console.log(msg);
}
function hdr(msg) {
  console.log(`\n\x1b[1m── ${msg}\x1b[0m`);
}

const TARGET = arg('--target');
if (!TARGET || !(TARGET in TARGETS)) {
  die(`--target 必须是 ${Object.keys(TARGETS).join(' | ')}（收到：${TARGET ?? '(空)'}）`);
}
const T = TARGETS[TARGET];
const SKIP_ARCHIVE = argv.includes('--skip-archive');

// 顶层 await（本文件是 ESM）——版本号的来源可能是两条路之一，见 loadVersion()。
const { version: VERSION, root: REPO_ROOT, via: VERSION_VIA } = await loadVersion();
const OUT_ROOT = arg('--out', join(REPO_ROOT, 'dist', 'bundles'));
const CACHE = arg('--cache', join(REPO_ROOT, '.build', 'bundle-cache'));
const BUNDLE_NAME = `openmemo-${VERSION}-${TARGET}`;
const STAGE = join(OUT_ROOT, BUNDLE_NAME);

/* ─────────────────────────────────────────────────────────────────────────────────
 * 小工具
 * ───────────────────────────────────────────────────────────────────────────────── */

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256Of(file) {
  const h = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

async function sha512Base64Of(file) {
  const h = createHash('sha512');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(file), h);
  return h.digest('base64');
}

/**
 * 下载到缓存。**已存在且摘要对得上就不重下** —— CI 上三条腿各跑一次，
 * 缓存命中能省掉几十 MB 的重复流量；但**命中的前提是摘要仍然对**，
 * 而不是"文件在那儿"。一个只看存在性的缓存会把一次损坏永久固化。
 */
async function fetchToCache(url, fileName) {
  await mkdir(CACHE, { recursive: true });
  const dst = join(CACHE, fileName);
  if (await exists(dst)) {
    say(`   缓存命中 ${fileName}`);
    return dst;
  }
  say(`   下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die(`下载失败 HTTP ${res.status}：${url}`);
  const tmp = `${dst}.partial`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const { rename } = await import('node:fs/promises');
  await rename(tmp, dst);
  return dst;
}

/**
 * 归档类型。`unpackArchive` 要求显式传 kind（它**不猜**，见该函数的注释）——
 * 这里按文件名推断一次，推断不出就退出，而不是传一个 undefined 进去。
 */
function kindOf(fileName) {
  if (fileName.endsWith('.zip')) return 'zip';
  if (fileName.endsWith('.tar.xz')) return 'tar.xz';
  if (fileName.endsWith('.tar.gz') || fileName.endsWith('.tgz')) return 'tar.gz';
  return die(`认不出归档类型：${fileName}`);
}

/** 目录字节数（du -sb 的等价物，纯 Node，Windows 上也成立）。 */
async function dirSize(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}

const mib = (n) => `${(n / 1048576).toFixed(1)} MiB`;

/* ─────────────────────────────────────────────────────────────────────────────────
 * ① Node 运行时
 * ───────────────────────────────────────────────────────────────────────────────── */

async function acquireNode() {
  hdr(`① Node 运行时 v${NODE_VERSION} (${T.nodeDist})`);
  const file = `node-v${NODE_VERSION}-${T.nodeDist}${T.nodeArchiveExt}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;

  // 权威摘要：上游的 SHASUMS256.txt。这是 nodejs.org 唯一的发布点，
  // 没有第二个地方可以对照 —— 如实说明这一点，不假装它是独立信源。
  const sumsPath = await fetchToCache(`${base}/SHASUMS256.txt`, `SHASUMS256-${NODE_VERSION}.txt`);
  const sums = await readFile(sumsPath, 'utf8');
  const line = sums
    .split('\n')
    .find((l) => l.trim().endsWith(` ${file}`) || l.trim().endsWith(`  ${file}`));
  if (!line)
    die(`SHASUMS256.txt 里没有 ${file} —— Node ${NODE_VERSION} 是否真的有这个平台的产物？`);
  const want = line.trim().split(/\s+/)[0];

  const archive = await fetchToCache(`${base}/${file}`, file);
  const got = await sha256Of(archive);
  if (got !== want) die(`Node 运行时摘要不符\n   期望 ${want}\n   实得 ${got}`);
  say(`   ✔ sha256 校验通过 ${want.slice(0, 16)}…`);

  const work = await mkdtemp(join(tmpdir(), 'om-node-'));
  const { unpackArchive } = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/downloader/dist/index.js')).href
  );
  await unpackArchive(archive, work, kindOf(file));

  // 解出来是 node-v<ver>-<plat>/ 一层壳
  const [inner] = await readdir(work);
  const nodeBin = T.nodeDist.startsWith('win')
    ? join(work, inner, 'node.exe')
    : join(work, inner, 'bin', 'node');
  if (!(await exists(nodeBin))) die(`解开后找不到 node 二进制：${nodeBin}`);

  await mkdir(join(STAGE, 'runtime'), { recursive: true });
  const dst = join(STAGE, 'runtime', T.nodeExe);
  await cp(nodeBin, dst);
  if (!T.nodeDist.startsWith('win')) await chmod(dst, 0o755);
  say(`   ✔ runtime/${T.nodeExe}  ${mib((await stat(dst)).size)}`);
  await rm(work, { recursive: true, force: true });
}

/* ─────────────────────────────────────────────────────────────────────────────────
 * ② 我们自己的 JS
 * ───────────────────────────────────────────────────────────────────────────────── */

const WORKSPACE_PKGS = ['db', 'downloader', 'llm', 'mindmap', 'pipeline', 'runtime', 'shared'];

/**
 * 只留运行时需要的东西。
 * `[实测]` 剥掉 `*.test.js` / `*.d.ts` / `*.map` / `.tsbuildinfo` 之后，
 * 8 棵 dist 从 7.0 MiB 降到约 1.5 MiB —— 五分之四是给编译器和测试用的。
 */
async function copyRuntimeDist(srcDist, dstDist) {
  await cp(srcDist, dstDist, {
    recursive: true,
    filter: (src) => {
      const b = basename(src);
      if (b.endsWith('.test.js') || b.endsWith('.test.d.ts')) return false;
      if (b.endsWith('.d.ts') || b.endsWith('.d.ts.map') || b.endsWith('.js.map')) return false;
      if (b.endsWith('.tsbuildinfo')) return false;
      return true;
    },
  });
}

async function assembleOurCode() {
  hdr('② 我们自己的 JS');

  // --- daemon ---
  const daemonDist = join(REPO_ROOT, 'apps/daemon/dist');
  if (!(await exists(join(daemonDist, 'main.js')))) {
    die(`apps/daemon/dist/main.js 不存在 —— 先跑 \`pnpm build:safe\``);
  }
  await mkdir(join(STAGE, 'app/daemon'), { recursive: true });
  await copyRuntimeDist(daemonDist, join(STAGE, 'app/daemon/dist'));
  await cp(join(REPO_ROOT, 'apps/daemon/package.json'), join(STAGE, 'app/daemon/package.json'));

  // --- build-info：包里必须有，否则 /api/health 认不出自己是哪个版本 ---
  const buildInfo = join(daemonDist, 'build-info.json');
  if (!(await exists(buildInfo)))
    die('apps/daemon/dist/build-info.json 不存在 —— 先跑 `pnpm build:safe`');

  // --- workspace 包 ---
  for (const p of WORKSPACE_PKGS) {
    const src = join(REPO_ROOT, 'packages', p);
    const dst = join(STAGE, 'app/node_modules/@openmemo', p);
    if (!(await exists(join(src, 'dist'))))
      die(`packages/${p}/dist 不存在 —— 先跑 \`pnpm build:safe\``);
    await mkdir(dst, { recursive: true });
    await copyRuntimeDist(join(src, 'dist'), join(dst, 'dist'));
    await cp(join(src, 'package.json'), join(dst, 'package.json'));
    // migrations 是 packages/db 的 `files` 之一，schema 迁移靠它
    if (await exists(join(src, 'migrations'))) {
      await cp(join(src, 'migrations'), join(dst, 'migrations'), { recursive: true });
    }
  }
  say(`   ✔ daemon + ${WORKSPACE_PKGS.length} 个 workspace 包`);

  /*
   * --- 网页 bundle ---
   *
   * ★★ 这一步是**硬失败**，而且必须检查内容而不只是目录存在。
   *
   * 理由：`apps/web/dist` **只有 `pnpm -r build` 会产出**，而 `build:safe` 与
   * `typecheck` 都不产出（PROTOCOL §7 补充）。一个漏了这步的包，
   * 用户打开是**白页** —— daemon 正常启动、端口正常监听、日志一行错都没有。
   * 那正是本仓最贵的那类失败：**成功地什么都没做**。
   */
  const webDist = join(REPO_ROOT, 'apps/web/dist');
  const indexHtml = join(webDist, 'index.html');
  if (!(await exists(indexHtml))) {
    die(
      `apps/web/dist/index.html 不存在。\n` +
        `   网页 bundle 只有 \`pnpm -r build\` 会产出（\`build:safe\` 与 \`typecheck\` 都不会）。\n` +
        `   ⚠️ 本机跑 \`pnpm -r build\` 会覆盖 :10000 正在托管的前端（PROTOCOL §7）——\n` +
        `      CI 上跑没有这个问题；本机验证请用 \`vite build --outDir /tmp/<你的名字>/dist\`。`,
    );
  }
  const assets = join(webDist, 'assets');
  if (!(await exists(assets)) || (await readdir(assets)).length === 0) {
    die('apps/web/dist/assets 为空 —— 这是一个白页包，不许出厂');
  }
  await mkdir(join(STAGE, 'app/apps/web'), { recursive: true });
  await cp(webDist, join(STAGE, 'app/apps/web/dist'), { recursive: true });
  say(`   ✔ apps/web/dist  ${mib(await dirSize(join(STAGE, 'app/apps/web/dist')))}`);
}

/* ─────────────────────────────────────────────────────────────────────────────────
 * ③ 第三方 npm 生产依赖
 * ───────────────────────────────────────────────────────────────────────────────── */

/** 从 node_modules/.pnpm 里取一个包的真实目录。 */
function pnpmDir(name, version) {
  return join(REPO_ROOT, 'node_modules/.pnpm', `${name}@${version}`, 'node_modules', name);
}

/** 读 pnpm-lock.yaml 里某个包的 version + integrity。**committed 的那份才是权威。** */
async function lockEntry(pkg) {
  const lock = await readFile(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
  const re = new RegExp(
    `^  ${pkg.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}@([^:]+):\\s*\\n\\s*resolution: \\{integrity: (sha\\d+-[^}]+)\\}`,
    'm',
  );
  const m = lock.match(re);
  if (!m) return null;
  return { version: m[1], integrity: m[2] };
}

const PLAIN_DEPS = [
  ['zod', '4.4.3'],
  ['ws', '8.21.1'],
  ['undici', '7.29.0'],
  ['socks', '2.8.9'],
  ['smart-buffer', '4.2.0'],
  ['ip-address', '10.4.0'],
  ['xz-decompress', '0.2.3'],
  ['sherpa-onnx-node', '1.13.4'],
];

async function assembleNodeModules() {
  hdr('③ 第三方生产依赖');
  const nm = join(STAGE, 'app/node_modules');

  for (const [name, version] of PLAIN_DEPS) {
    const src = pnpmDir(name, version);
    if (!(await exists(src)))
      die(`node_modules 里找不到 ${name}@${version} —— 先跑 \`pnpm install\``);
    await cp(src, join(nm, name), { recursive: true, dereference: true });
  }
  say(`   ✔ ${PLAIN_DEPS.length} 个纯 JS 依赖`);

  /*
   * --- better-sqlite3：裁到单平台 ---
   *
   * `[实测]` 它用 prebuildify —— **8 个平台的 .node 全在同一个 npm tarball 里**，
   * 且没有 install 脚本（`gypfile: false`）。所以：
   *   · 跨平台打包不需要为它做任何额外的事；
   *   · **用户机器上不需要 make/gcc/Python**，不会炸在编译上。
   * 而且是 N-API v10（不是 NODE_MODULE_VERSION），一个 .node 跨 Node 22/24 通用。
   *
   * 这里把另外 7 个平台的 prebuild 和 10.3 MB 的 SQLite 源码删掉：26.1 MiB → 约 2.2 MiB。
   */
  const bsq = join(nm, 'better-sqlite3');
  await cp(pnpmDir('better-sqlite3', '13.0.2'), bsq, { recursive: true, dereference: true });
  await rm(join(bsq, 'deps'), { recursive: true, force: true });
  await rm(join(bsq, 'src'), { recursive: true, force: true });
  const prebuilds = join(bsq, 'prebuilds');
  const keep = T.prebuild;
  let kept = false;
  for (const f of await readdir(prebuilds)) {
    if (f === keep) kept = true;
    else await rm(join(prebuilds, f), { recursive: true, force: true });
  }
  if (!kept) die(`better-sqlite3 的 prebuilds/ 里没有 ${keep} —— 上游是否改了产物矩阵？`);
  say(`   ✔ better-sqlite3（裁到 ${keep}，${mib(await dirSize(bsq))}）`);

  await acquireSherpa(nm);
}

/**
 * sherpa-onnx 的**平台包**。
 *
 * ★★★ 这是整条路上最容易漏、且漏了只在**别的平台**上才显形的一步。
 *
 * 它与 better-sqlite3 的模型正好相反：6 个平台包是 `optionalDependencies` +
 * `os`/`cpu` 门控，**pnpm 只装宿主那一个**。在 Linux 上打 Windows 包时，
 * `node_modules` 里根本没有 `sherpa-onnx-win-x64` ——
 * 如果这里"找不到就跳过"，产出的包会在 Linux 上测得好好的，
 * 到了 Windows 用户手里才发现流式 ASR / VAD 整条不可用。
 *
 * 所以这一步**没有降级路径，找不到就退出 1**（Manager 2026-08-08 的明确要求：
 * 「让"某平台的 optional dep 没取到"在 CI 里当场红」）。
 *
 * 取法：从 npm registry 取 tarball，**对着 `pnpm-lock.yaml` 里 committed 的
 * `integrity` 校验** —— 不是对着 registry 自己报的那个（那是自证）。
 */
async function acquireSherpa(nm) {
  const pkg = T.sherpaPkg;
  const entry = await lockEntry(pkg);
  if (!entry) {
    die(
      `pnpm-lock.yaml 里没有 ${pkg} 的条目。\n` +
        `   它是 sherpa-onnx-node 的平台可选依赖，**必须**随包发出，否则该平台上\n` +
        `   流式 ASR / VAD 整条不可用，而且只在那个平台上才显形。\n` +
        `   不允许跳过（Manager 2026-08-08 裁决）。`,
    );
  }
  const { version, integrity } = entry;
  const tarName = `${pkg}-${version}.tgz`;
  const url = `https://registry.npmjs.org/${pkg}/-/${tarName}`;
  const tgz = await fetchToCache(url, tarName);

  // integrity 形如 sha512-<base64>
  const [alg, wantB64] = integrity.split('-', 2);
  if (alg !== 'sha512') die(`${pkg} 的 integrity 不是 sha512（是 ${alg}）—— 校验逻辑需要更新`);
  const gotB64 = await sha512Base64Of(tgz);
  if (gotB64 !== wantB64) {
    die(
      `${pkg} 摘要与 pnpm-lock.yaml 不符\n   期望 ${wantB64.slice(0, 24)}…\n   实得 ${gotB64.slice(0, 24)}…`,
    );
  }

  const work = await mkdtemp(join(tmpdir(), 'om-sherpa-'));
  const { unpackArchive } = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/downloader/dist/index.js')).href
  );
  await unpackArchive(tgz, work, kindOf(tarName));
  const inner = join(work, 'package'); // npm tarball 固定一层 package/
  if (!(await exists(inner))) die(`${pkg} 的 tarball 结构异常：解开后没有 package/`);
  await cp(inner, join(nm, pkg), { recursive: true });
  await rm(work, { recursive: true, force: true });

  // 反向自检：包里必须真的有原生件，否则我们只是复制了一个空壳
  const files = await readdir(join(nm, pkg));
  const natives = files.filter((f) => /\.(node|so|dylib|dll)$/.test(f) || /\.so\./.test(f));
  if (natives.length === 0) {
    die(`${pkg} 解开后一个原生库都没有 —— 拿到的不是我们要的那个包`);
  }
  say(
    `   ✔ ${pkg}@${version}（sha512 对着 lockfile 校验通过，${natives.length} 个原生件，${mib(await dirSize(join(nm, pkg)))}）`,
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────
 * ④ SQLite 扩展（libsimple 中文分词 + sqlite-vec）
 * ───────────────────────────────────────────────────────────────────────────────── */

async function assembleExtensions() {
  hdr('④ SQLite 扩展（中文分词 + 向量）');
  const manifest = JSON.parse(
    await readFile(join(REPO_ROOT, 'vendor/manifests/sqlite-ext.json'), 'utf8'),
  );
  const extDir = join(STAGE, 'ext');
  await mkdir(extDir, { recursive: true });

  const work = await mkdtemp(join(tmpdir(), 'om-ext-'));
  const { unpackArchive } = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/downloader/dist/index.js')).href
  );

  for (const id of T.extPackIds) {
    const pack = manifest.packs.find((p) => p.id === id);
    if (!pack) die(`vendor/manifests/sqlite-ext.json 里没有 pack ${id}`);
    const file = pack.files.find((f) => f.role === 'archive');
    const mirror = file.mirrors.find((m) => m.official) ?? file.mirrors[0];

    const local = await fetchToCache(mirror.url, file.name);
    const got = await sha256Of(local);
    if (got !== file.sha256) {
      die(`${id} 摘要与 manifest 不符\n   期望 ${file.sha256}\n   实得 ${got}`);
    }
    const dest = join(work, id);
    await unpackArchive(local, dest, kindOf(file.name));
    say(`   ✔ ${id}  sha256 对着 manifest 校验通过`);
  }

  /*
   * ★★ 落盘时用的是**产品自己那个函数** `sqliteExtensionSources(platform)`，
   *    不是我在这里另写一套文件名。
   *
   *    理由是具体的：`libsimple-win32-x64` 的压缩包里叫 **`simple.dll`（没有 lib 前缀）**，
   *    而加载侧 `defaultExtensionPaths()` 找的是 **`libsimple.dll`**。
   *    这一格错了的后果**不是报错，是中文搜索静默返回 0 条** ——
   *    `win-fixes` 已经在这上面栽过一次。
   *    第三套命名约定绝不能从这个脚本里长出来。
   */
  const { sqliteExtensionSources } = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/pipeline/dist/index.js')).href
  );
  for (const { dst, candidates } of sqliteExtensionSources(T.platform)) {
    let found = null;
    for (const cand of candidates) {
      const hit = await findUnder(work, cand);
      if (hit) {
        found = hit;
        break;
      }
    }
    if (!found) {
      die(
        `扩展文件 ${dst} 没找到（候选：${candidates.join(' / ')}）。\n` +
          `   用户 2026-08-08 裁决 ② 要求这两个扩展随包出厂：不放的后果是\n` +
          `   tokenizer 静默退化成 trigram，中文两字词搜索返回 0 条且不报错。\n` +
          `   **不允许降级放行。**`,
      );
    }
    await cp(found, join(extDir, dst), { recursive: true });
  }
  await rm(work, { recursive: true, force: true });
  say(`   ✔ ext/  ${mib(await dirSize(extDir))}`);
}

/** 在目录树里按名字找第一个匹配（文件或目录）。 */
async function findUnder(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.name === name) return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────────
 * ⑤ 启动脚本
 * ───────────────────────────────────────────────────────────────────────────────── */

/*
 * ★ 只设两个环境变量，而且都用"用户已设则不覆盖"的写法。
 *
 *   OPENMEMO_WEB_DIST  指向包内的网页 bundle
 *   OPENMEMO_EXT_DIR   指向包内的 ext/
 *
 * ★★ **绝不设 `OPENMEMO_DATA_DIR`。**
 *   数据目录是用户可迁移的（网页「设置 → 数据目录」），启动脚本一旦写死它，
 *   用户搬完家下次启动又被脚本拽回来 —— 这正是 PROTOCOL §9 那一族
 *   「进程级配置覆盖了机器级状态」的形状。数据目录的解析权留给 daemon 自己。
 */
const LAUNCHERS = {
  'start.sh': `#!/bin/sh
# OpenMemo 启动脚本。用法：./start.sh [--port 17650] [--data-dir /路径]
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 已设则尊重用户的值；未设才用包内的
: "\${OPENMEMO_WEB_DIST:=$DIR/app/apps/web/dist}"
: "\${OPENMEMO_EXT_DIR:=$DIR/ext}"
export OPENMEMO_WEB_DIST OPENMEMO_EXT_DIR
cd "$DIR/app/daemon"
exec "$DIR/runtime/node" dist/main.js "$@"
`,
  'OpenMemo.command': `#!/bin/sh
# OpenMemo 启动脚本（macOS 上可双击）。
#
# ⚠️ 首次运行如果被 Gatekeeper 拦住（"无法验证开发者"），原因是浏览器下载的归档
#    带 com.apple.quarantine，用「访达」解压会把它传播给解出来的文件。
#    两种解法（任选其一）：
#      · 用命令行解压：tar xzf openmemo-*.tar.gz   （不传播 quarantine）
#      · 已经解开了：  xattr -dr com.apple.quarantine "$(dirname "$0")"
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "\${OPENMEMO_WEB_DIST:=$DIR/app/apps/web/dist}"
: "\${OPENMEMO_EXT_DIR:=$DIR/ext}"
export OPENMEMO_WEB_DIST OPENMEMO_EXT_DIR
cd "$DIR/app/daemon"
exec "$DIR/runtime/node" dist/main.js "$@"
`,
  'start.cmd': `@echo off
rem OpenMemo 启动脚本。用法：start.cmd [--port 17650] [--data-dir C:\\路径]
rem
rem ⚠️ 首次运行可能弹 SmartScreen（"Windows 已保护你的电脑"）——我们不签名，
rem    点「更多信息」→「仍要运行」。这是 ADR-003 决策 4 的已知后果。
setlocal
set "DIR=%~dp0"
if not defined OPENMEMO_WEB_DIST set "OPENMEMO_WEB_DIST=%DIR%app\\apps\\web\\dist"
if not defined OPENMEMO_EXT_DIR set "OPENMEMO_EXT_DIR=%DIR%ext"
cd /d "%DIR%app\\daemon"
"%DIR%runtime\\node.exe" dist\\main.js %*
`,
};

async function writeLauncher() {
  hdr('⑤ 启动脚本');
  const name = T.launcher;
  const p = join(STAGE, name);
  await writeFile(p, LAUNCHERS[name], 'utf8');
  if (!name.endsWith('.cmd')) await chmod(p, 0o755);
  say(`   ✔ ${name}`);
}

/* ─────────────────────────────────────────────────────────────────────────────────
 * ⑥ 许可证声明
 * ───────────────────────────────────────────────────────────────────────────────── */

/**
 * 生成 THIRD-PARTY-NOTICES。
 *
 * ## 为什么这个文件在"自用"时不需要、现在需要
 *
 * MIT 与 Apache-2.0 都要求**在分发物中保留版权与许可声明**。个人自用永远不触发这一条；
 * 一旦有人从 Release 上下载我们的包，它就触发了。用户 2026-08-08 裁决 ①：
 * 「我们确实在分发别人的 MIT 代码，保留版权声明是真义务，不是形式」。
 *
 * ## 三个包自己没带 LICENSE 文件
 *
 * `[实测]` `sherpa-onnx-node` / `sherpa-onnx-<platform>`（Apache-2.0）与
 * `xz-decompress`（MIT）的 npm tarball 里**没有 LICENSE 文件**。
 * 这里**不伪造许可证正文** —— 只如实写下 SPDX 标识、包版本、以及上游许可证正文的 URL，
 * 并明确标注"上游包内未附正文"。编一份正文出来比缺一份更糟。
 */
async function writeNotices() {
  hdr('⑥ 许可证声明');
  const nm = join(STAGE, 'app/node_modules');
  const rows = [];

  async function collect(dir, label) {
    const pjPath = join(dir, 'package.json');
    if (!(await exists(pjPath))) return;
    const pj = JSON.parse(await readFile(pjPath, 'utf8'));
    let licenseText = null;
    let licenseFile = null;
    for (const cand of await readdir(dir)) {
      if (/^(LICENSE|LICENCE|COPYING|NOTICE)($|[.\-_])/i.test(cand)) {
        const p = join(dir, cand);
        if ((await stat(p)).isFile()) {
          licenseFile = cand;
          licenseText = await readFile(p, 'utf8');
          break;
        }
      }
    }
    rows.push({
      name: label ?? pj.name,
      version: pj.version ?? '(无 version 字段)',
      license: typeof pj.license === 'string' ? pj.license : (pj.license?.type ?? 'UNKNOWN'),
      licenseFile,
      licenseText,
    });
  }

  for (const e of await readdir(nm, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name === '@openmemo') continue; // 我们自己的代码
    await collect(join(nm, e.name));
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const missing = rows.filter((r) => !r.licenseText);
  const parts = [];
  parts.push(`OpenMemo ${VERSION} — 第三方许可证声明 / THIRD-PARTY NOTICES`);
  parts.push(`目标平台：${TARGET}`);
  parts.push('');
  parts.push('本文件列出随本预编译包一同分发的第三方组件。');
  parts.push('OpenMemo 自身的代码不在此列（见同目录 LICENSE）。');
  parts.push('');
  parts.push('⚠️ 本包**不含** ffmpeg 与 yt-dlp（GPL-3.0-or-later）。');
  parts.push('   那两个组件由产品在你的机器上按需从上游官方 GitHub 下载，');
  parts.push('   我们既不转存也不重新分发它们的字节。详见 docs/adr/ADR-002。');
  parts.push('');
  parts.push('─'.repeat(78));
  parts.push('汇总');
  parts.push('─'.repeat(78));
  for (const r of rows) {
    parts.push(
      `  ${r.name}@${r.version}  —  ${r.license}${r.licenseText ? '' : '   [上游包内未附许可证正文]'}`,
    );
  }

  /*
   * libsimple 的 MIT election —— `vendor/README.md:40` 挂了很久的一条要求。
   *
   * 上游 wangfenjin/simple 是 **MIT OR GPL-3.0 双许可**。双许可的含义是
   * 接收方可以任选其一，而**我们必须说明本项目选的是哪一支** ——
   * 不说明的话，一个只看到 GPL 那一支的人有理由认为整个包被 GPL 传染了。
   * 自用时这条无处可写；现在有了分发物，它必须写在这里。
   */
  parts.push('');
  parts.push('─'.repeat(78));
  parts.push('随包出厂的 SQLite 扩展（不经 npm，来自 vendor/manifests/sqlite-ext.json）');
  parts.push('─'.repeat(78));
  parts.push('  libsimple (wangfenjin/simple) v0.7.1');
  parts.push('      上游为 **MIT OR GPL-3.0 双许可**；');
  parts.push('      ★ OpenMemo 依据该双许可选择 **MIT** 一支（elects the MIT option）。');
  parts.push('      https://github.com/wangfenjin/simple/blob/master/LICENSE');
  parts.push('  sqlite-vec (asg017/sqlite-vec) v0.1.9  —  Apache-2.0 OR MIT');
  parts.push('      https://github.com/asg017/sqlite-vec');
  parts.push('');
  parts.push('随包出厂的 Node.js 运行时');
  parts.push(`  Node.js v${NODE_VERSION}  —  MIT（含其依赖 OpenSSL / ICU / libuv 等，`);
  parts.push(
    '      正文见运行时上游发行包内的 LICENSE：https://github.com/nodejs/node/blob/main/LICENSE）',
  );

  if (missing.length > 0) {
    parts.push('');
    parts.push('─'.repeat(78));
    parts.push('以下组件的上游 npm 包内未附许可证正文（如实记录，不代为撰写）');
    parts.push('─'.repeat(78));
    for (const r of missing) {
      const url = KNOWN_LICENSE_TEXT_URL[r.license] ?? '(无标准正文 URL)';
      parts.push(`  ${r.name}@${r.version}  声明为 ${r.license}；正文见 ${url}`);
    }
  }

  parts.push('');
  parts.push('─'.repeat(78));
  parts.push('许可证正文');
  parts.push('─'.repeat(78));
  for (const r of rows) {
    if (!r.licenseText) continue;
    parts.push('');
    parts.push(`### ${r.name}@${r.version}  (${r.license})   [来自上游包内 ${r.licenseFile}]`);
    parts.push('');
    parts.push(r.licenseText.trimEnd());
  }

  await writeFile(join(STAGE, 'THIRD-PARTY-NOTICES'), parts.join('\n') + '\n', 'utf8');

  // 仓库根的 LICENSE 一并随包发出（说明我们自己的授权状态）
  const rootLicense = join(REPO_ROOT, 'LICENSE');
  if (await exists(rootLicense)) {
    await cp(rootLicense, join(STAGE, 'LICENSE'));
    say('   ✔ LICENSE + THIRD-PARTY-NOTICES');
  } else {
    die(
      'LICENSE 不存在。公开分发的包必须说明自身的授权状态 —— ' +
        '哪怕结论是"保留所有权利"，也要写出来（用户 2026-08-08 裁决 ①）。',
    );
  }
  say(`   ✔ 覆盖 ${rows.length} 个 npm 包，其中 ${missing.length} 个上游未附正文（已如实标注）`);
}

/* ─────────────────────────────────────────────────────────────────────────────────
 * ⑦ 归档
 * ───────────────────────────────────────────────────────────────────────────────── */

async function makeArchive() {
  hdr('⑦ 归档');
  const out = join(OUT_ROOT, `${BUNDLE_NAME}${T.archiveExt}`);
  await rm(out, { force: true });
  if (T.archiveExt === '.zip') {
    // Windows 包。`zip` 未必存在，优先用它，退回 python3（CI runner 两者必有其一）。
    try {
      await execFileAsync('zip', ['-qry', out, BUNDLE_NAME], { cwd: OUT_ROOT });
    } catch {
      await execFileAsync(
        'python3',
        [
          '-c',
          `import zipfile,os,sys
z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED,compresslevel=6)
for r,d,fs in os.walk(sys.argv[2]):
    for f in fs: z.write(os.path.join(r,f))
z.close()`,
          out,
          BUNDLE_NAME,
        ],
        { cwd: OUT_ROOT },
      );
    }
  } else {
    const flag = T.archiveExt === '.tar.xz' ? '-cJf' : '-czf';
    await execFileAsync('tar', [flag, out, BUNDLE_NAME], { cwd: OUT_ROOT });
  }
  const size = (await stat(out)).size;
  const digest = await sha256Of(out);
  say(`   ✔ ${basename(out)}  ${mib(size)}`);
  say(`     sha256 ${digest}`);
  return { out, size, digest };
}

/* ─────────────────────────────────────────────────────────────────────────────────
 * main
 * ───────────────────────────────────────────────────────────────────────────────── */

async function main() {
  say(`\n\x1b[1mOpenMemo 预编译包组装器\x1b[0m`);
  say(`  版本   ${VERSION}   （来源：${VERSION_VIA}）`);
  say(`  目标   ${TARGET}`);
  say(`  输出   ${STAGE}`);

  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });

  await acquireNode();
  await assembleOurCode();
  await assembleNodeModules();
  await assembleExtensions();
  await writeLauncher();
  await writeNotices();

  const raw = await dirSize(STAGE);
  hdr('汇总');
  say(`   未压缩 ${mib(raw)}`);

  let archive = null;
  if (!SKIP_ARCHIVE) archive = await makeArchive();

  // 机器可读的产物描述 —— CI 的后续步骤读它，而不是去 parse 上面的人类输出
  const meta = {
    name: BUNDLE_NAME,
    version: VERSION,
    target: TARGET,
    nodeVersion: NODE_VERSION,
    rawBytes: raw,
    archive: archive
      ? { file: basename(archive.out), bytes: archive.size, sha256: archive.digest }
      : null,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(
    join(OUT_ROOT, `${BUNDLE_NAME}.json`),
    JSON.stringify(meta, null, 2) + '\n',
    'utf8',
  );
  say(`   ✔ ${BUNDLE_NAME}.json`);

  if (process.env['GITHUB_OUTPUT']) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env['GITHUB_OUTPUT'],
      `bundle_dir=${STAGE}\nbundle_name=${BUNDLE_NAME}\nraw_bytes=${raw}\n` +
        (archive
          ? `archive=${archive.out}\narchive_bytes=${archive.size}\narchive_sha256=${archive.digest}\n`
          : ''),
    );
  }
  say('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
