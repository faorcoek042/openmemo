#!/usr/bin/env node
/**
 * 预编译包组装器（D-17 §9 步骤 1）。
 *
 * 产出一个**自带 Node 运行时**的目录 + 归档：用户下载、解开、双击启动脚本就能跑，
 * 机器上**不需要预装 Node / pnpm / git**。
 *
 * ## 它不做什么（这条比它做什么更重要）
 *
 * **不打包 GPU 后端 / 大模型。** 这些仍然由产品在网页上按需下载，钉死 tag + sha256
 * （ADR-001 / ADR-015）——体积：whisper 的 CUDA 包一个就 677 MB，多数模型动辄百 MB
 * 到 GB 级，跟本包无关（D-20 §9/§11 定案随包内置的那 3 个小模型是另一件事，见下方
 * 「它打包什么」）。
 *
 * **ffmpeg / yt-dlp 不再是一句话能说完——三个平台/组件三种情况（2026-08-09 起）：**
 *
 *   · **Linux / Windows：ffmpeg / ffprobe 随包内置**，字节是 BtbN 构建的
 *     **LGPL-3.0-or-later** 变体（与此前用过的 GPL 变体同一 release tag、同一源码
 *     commit，见 `vendor/manifests/backends.json` 的 `sha256Provenance`），见
 *     `assembleFfmpeg()`。我们只以 `spawn` 调用其可执行文件，不 `dlopen`、不链接
 *     它的任何库（D-20 §13.3），LGPL 的链接触发义务不适用；随包附带、原名不改的
 *     `LICENSE.txt` 满足「许可证全文可得」这条仍然成立的义务（D-20 §13.7）。
 *   · **macOS：不变，仍是下载，字节不经过我们。** 供应商（jellyfin-ffmpeg）不发
 *     LGPL 变体（D-20 §13.4 供应商缺口），继续维持 GPL-3.0-or-later + 用户机器
 *     直连官方源取，不触发 ADR-002「一旦要分发就是硬阻断」的 conveying 判断
 *     （D-17 §1）。
 *   · **yt-dlp：全平台仍然只走下载**，且理由**不是**"项目许可证宽松"——项目本身
 *     确实是 Unlicense（D-20 §1.1 已核实），但官方发行的二进制内嵌了 GPL 组件
 *     （mutagen 全平台 GPL-2.0-or-later；Linux x64/arm64 另有 GNU Readline
 *     GPL-3.0-or-later，详见 D-20 §14）。这份内嵌依赖清点是另一条发布阻断线
 *     （未补完前不许打进包），所以它眼下仍然只走下载，字节不经过我们。
 *
 * ## 它打包什么
 *
 *   runtime/node            官方 Node 二进制，**原样不改**
 *   runtime/probe/          最小探针 + CPU 基线转写链（whisper.cpp，MIT，见 assembleProbeRuntime）
 *   app/daemon              daemon 的 dist
 *   app/node_modules        生产依赖闭包（扁平化，非符号链接）
 *   app/apps/web/dist       ★ 网页 bundle —— 缺了用户打开是白页
 *   ext/                    libsimple + sqlite-vec（用户 2026-08-08 裁决 ②）
 *   models/                 ★ D-20 §9/§11 定案的 3 个非 GPL、体积可控模型（≈55.7 MB，
 *                            见 assembleModels）——首次启动由
 *                            `apps/daemon/src/http/rest/modelReconcile.ts` 导入 ArtifactStore，
 *                            这里只负责把字节、连同 sha256 校验，落进包里
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
import { createWriteStream, existsSync } from 'node:fs';
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
import { basename, dirname, join, resolve } from 'node:path';
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
    probePackId: 'whispercpp-cpu-linux-x64',
    // ffmpeg-lgpl-manifest（Manager 2026-08-09 裁定）：Linux/Windows 的 ffmpeg 从
    // "下载" 改判 "内置"（见 assembleFfmpeg()）。macOS 没有这个字段——供应商
    // （jellyfin-ffmpeg）不发 LGPL 变体，维持下载 + GPL-3.0-or-later，见该函数注释。
    ffmpegPackId: 'media-tools-linux-x64',
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
    probePackId: 'whispercpp-cpu-win-x64',
    ffmpegPackId: 'media-tools-win-x64',
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
    probePackId: 'whispercpp-cpu-macos-arm64',
    // 刻意不写 ffmpegPackId：macOS 的 ffmpeg（jellyfin-ffmpeg）供应商不发 LGPL 变体
    // （D-20 §13.4 供应商缺口），维持"下载 + GPL-3.0-or-later"，不随包内置。
    // assembleFfmpeg() 见 `T.ffmpegPackId` 缺失时直接跳过，不是漏配。
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

/**
 * 残包标记文件名。`scripts/ci/verify-bundle.sh` 见到它就当场拒绝。
 * ⚠️ 刻意**不导出**：唯一的读者是同文件里的两处 + 一个 bash 脚本（按字面量比对），
 * 导出会变成一条零引用导出而抬高 check:orphans 的棘轮。
 */
const INCOMPLETE_MARKER = '.openmemo-build-incomplete';

// 顶层 await（本文件是 ESM）——版本号的来源可能是两条路之一，见 loadVersion()。
const { version: VERSION, root: REPO_ROOT, via: VERSION_VIA } = await loadVersion();
/*
 * ★★ `--out` / `--cache` **必须在这里就绝对化**。
 *
 * 病灶是 `makeArchive()` 里那句
 *   `execFileAsync('tar', [flag, out, BUNDLE_NAME], { cwd: OUT_ROOT })`
 * —— 归档路径**跨了一次 `cwd` 边界**。`--out` 给相对路径时 `out` 也是相对的，
 * 于是 tar 把它**再相对 OUT_ROOT 解析一次**，产物落到
 *   `dist/bundles/dist/bundles/openmemo-….tar.xz`
 * 而不是 `dist/bundles/openmemo-….tar.xz`。
 *
 * **而脚本照样 exit 0** —— 它确实打了个包，只是打在没人会去看的地方。
 * 下游 `upload-artifact` 的 glob 匹配不到，表现成"这次构建没有产物"，
 * 与"构建失败"长得完全不一样。这正是本仓那个招牌形状：**成功地什么都没做**。
 *
 * 判据不是"记得传绝对路径"，是**传什么都不会错**：任何要跨 `cwd` 边界、
 * 或者要写进 `$GITHUB_OUTPUT` 给别的 step 当路径用的值，一律先 `resolve()`。
 * （`$GITHUB_OUTPUT` 那一路同理：读它的 step 未必在同一个工作目录。）
 */
const OUT_ROOT = resolve(arg('--out', join(REPO_ROOT, 'dist', 'bundles')));
const CACHE = resolve(arg('--cache', join(REPO_ROOT, '.build', 'bundle-cache')));
const BUNDLE_NAME = `openmemo-${VERSION}-${TARGET}`;
const STAGE = join(OUT_ROOT, BUNDLE_NAME);

/*
 * `--print-paths`：只把解析后的路径打成 JSON 然后退出，**不做任何事、不碰网络**。
 *
 * 加它是为了让上面那条性质**可测**：真跑一次要下 ~180 MB、要网络，
 * 于是"路径算得对不对"这件事在此之前只能靠读代码 —— 而它已经错过一次了。
 * 现在 `selftest-bundle.mjs` 用它把相对 / 绝对 / 含 `..` 三种输入各钉一条。
 */
if (argv.includes('--print-paths')) {
  console.log(
    JSON.stringify(
      {
        version: VERSION,
        target: TARGET,
        outRoot: OUT_ROOT,
        stage: STAGE,
        cache: CACHE,
        archive: join(OUT_ROOT, `${BUNDLE_NAME}${T.archiveExt}`),
        meta: join(OUT_ROOT, `${BUNDLE_NAME}.json`),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

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
 * 与 `fetchToCache()` 相同的缓存/下载语义，但**按 manifest 里的镜像顺序依次重试**
 * （`official` 优先），而不是只认第一个。
 *
 * 不能直接复用 `fetchToCache()`：它在 HTTP 非 2xx 时调用 `die()`——那是
 * `process.exit(1)`，不是抛异常，包不住，也就没法"这个源不行，换下一个"。
 * `vendor/manifests` 里的每个文件本来就带 2–3 个镜像，就是为了应对
 * "某个源在当前网络环境下不可达"这种情况（`[实测]` 这个沙箱能连 `hf-mirror.com`
 * / `modelscope.cn`，连不上 `huggingface.co`）——只试 official 一个会把这种
 * 可恢复的情况变成整个构建直接退出。
 */
async function fetchModelMirror(mirrors, fileName) {
  await mkdir(CACHE, { recursive: true });
  const dst = join(CACHE, fileName);
  if (await exists(dst)) {
    say(`   缓存命中 ${fileName}`);
    return dst;
  }
  const ordered = [...mirrors].sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0));
  const errors = [];
  for (const m of ordered) {
    try {
      say(`   下载 ${m.url}`);
      const res = await fetch(m.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = `${dst}.partial`;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      const { rename } = await import('node:fs/promises');
      await rename(tmp, dst);
      return dst;
    } catch (e) {
      errors.push(`${m.url} → ${e instanceof Error ? e.message : String(e)}`);
      say(`   ⚠️ 这个镜像取不到，换下一个`);
    }
  }
  return die(`${fileName} 所有镜像都取不到：\n${errors.map((s) => `   ${s}`).join('\n')}`);
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
 * ④-bis 最小探针运行时（鸡生蛋的那一环）
 * ───────────────────────────────────────────────────────────────────────────────── */

/**
 * 把 `openmemo-probe` 与它**跑得起来所必需的最小 ggml** 放进包里。
 *
 * ## 为什么非放不可 —— 一个用户真的撞上的环
 *
 * `[用户真机实测 2026-08-08, Windows, v0.3.0]` 解压即运行，运行时页**六个后端全部**报：
 * ```
 * probe did not complete: probe executable not found:
 *   C:\Users\...\AppData\Roaming\OpenMemo\bin\runtime\openmemo-probe.exe
 * ```
 * `[本机复现 2026-08-08, linux-x64, 全新空数据目录]` 一模一样。
 *
 * 环是这样的：探针**随 whisper 包出厂**（ADR-015 §7 的例外），
 * 而用户**要先探测硬件才知道该装哪个包** —— 探针在包里面。
 * CI 从没撞到，因为 `e2e-runtime` 直接 `POST /api/backends/install` 指定包 id，
 * **跳过了"探测→推荐"这一步**。
 *
 * ## 为什么是"最小 ggml"而不是别的形状
 *
 * ADR-015 §7.2 的三条实测事实**今天仍然成立**：探针动态链接 ggml（`RUNPATH $ORIGIN`）、
 * `backendDir = dirname(probePath)`、`probe.c` 只加载与自己同目录的后端模块。
 * 所以"探针放哪"和"它能不能跑"是绑死的 —— 只搬 exe 不搬 ggml 是搬不动的。
 *
 * `[本机实测 2026-08-08]` 最小集只要 **1.60 MiB**（linux-x64）：
 * ```
 * openmemo-probe            14,552 B     ← 探针本体只有 14 KB
 * libggml-base.so.0.15.1   825,528 B
 * libggml.so.0.15.1         47,632 B
 * libggml-cpu-x64.so       821,056 B     ← 一个通用 CPU 后端模块
 * ```
 *
 * ## ⚠️ 它**不能**、也不打算回答"我该装 CUDA 还是 Vulkan"
 *
 * 探针只能枚举**与自己同目录**的后端模块，而 `libggml-cuda.so` 本身就有 **564 MB**
 * —— 那正是用户要决定装不装的东西。**"验证后端 X 能用"在装 X 之前structurally 无解。**
 *
 * 但这不构成静默降级，因为 `manager.ts` 的判定链是
 *   `!probe.ok` → `!installed` → `!probed` → …
 * **`installed` 在 `probed` 之前**。探针一旦跑得起来，未装的后端会得到
 * **`backend package not installed`** —— 一句真话，而不是"你没有 CUDA"这种
 * 自信的假阴性，也不是今天那句带内部路径的 `probe did not complete`。
 *
 * ## 来源：**已经钉死并校验过的那个包**，不另开通道
 *
 * 直接取 `vendor/manifests/backends.json` 里 `whispercpp-cpu-*` 的归档（钉死 tag + sha256），
 * 只抽出上面那四个文件。不新建构建通道、不引入第二份 ggml 来源。
 * whisper.cpp 是 MIT，随包分发不触发任何 copyleft（D-17 §1）。
 */
async function assembleProbeRuntime() {
  hdr('④-bis 最小探针运行时（否则用户第一屏六个后端全报"找不到探针"）');
  const manifest = JSON.parse(
    await readFile(join(REPO_ROOT, 'vendor/manifests/backends.json'), 'utf8'),
  );
  const pack = manifest.packs.find((p) => p.id === T.probePackId);
  if (!pack) die(`backends.json 里没有 pack ${T.probePackId} —— 探针没有来源`);
  const file = pack.files.find((f) => f.role === 'archive');
  const mirror = file.mirrors.find((m) => m.official) ?? file.mirrors[0];

  const local = await fetchToCache(mirror.url, file.name);
  const got = await sha256Of(local);
  if (got !== file.sha256)
    die(`${T.probePackId} 摘要与 manifest 不符\n   期望 ${file.sha256}\n   实得 ${got}`);
  say(`   ✔ ${T.probePackId}  sha256 对着 manifest 校验通过`);

  const work = await mkdtemp(join(tmpdir(), 'om-probe-'));
  const { unpackArchive } = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/downloader/dist/index.js')).href
  );
  await unpackArchive(local, work, kindOf(file.name));

  const probeName = T.platform === 'win32' ? 'openmemo-probe.exe' : 'openmemo-probe';
  const probeSrc = await findUnder(work, probeName);
  if (!probeSrc) {
    die(
      `${T.probePackId} 的归档里没有 ${probeName}。\n` +
        `   探针是"网页检测硬件"那一步的执行者（ADR-003 决策 3）；缺了它，用户第一屏\n` +
        `   六个后端会全部报 "probe did not complete" —— 用户 2026-08-08 真机撞到过。\n` +
        `   **不允许降级放行。**`,
    );
  }

  const dst = join(STAGE, 'runtime', 'probe');
  await mkdir(dst, { recursive: true });
  const srcDir = dirname(probeSrc);
  await cp(probeSrc, join(dst, probeName));
  if (T.platform !== 'win32') await chmod(join(dst, probeName), 0o755);

  /*
   * ggml 核心 + **一个** CPU 后端模块。
   * · 核心：`ggml-base` 与 `ggml`（含 `.so.0` 这类版本软链 —— `NEEDED` 写的是软链名，
   *   丢了链探针就起不来）。用 `dereference:false` 保住链本身。
   * · CPU 模块：优先 `*ggml-cpu-x64*`（通用基线），没有就取第一个 `*ggml-cpu*`。
   *   只要有**一个能加载**，探针就能枚举出 CPU 设备；多带 13 个变体在 linux 上
   *   要多花 13.6 MB，而对"能不能跑起来"这个判据没有增量。
   */
  const entries = await readdir(srcDir);
  /*
   * ggml **核心库**（`ggml` 与 `ggml-base`），三平台的命名各不相同：
   *   linux   libggml.so · libggml.so.0 · libggml.so.0.15.1 · libggml-base.so.0.15.1
   *   macOS   libggml.dylib · **libggml.0.dylib** · libggml-base.0.15.1.dylib   ← 版本在扩展名**前面**
   *   win     ggml.dll · ggml-base.dll
   *
   * `[CI 实测 2026-08-08 run 31261013823]` 第一版只认 `libggml.so*` 那种形状，
   * 于是 macOS 上漏掉了 `libggml.0.dylib`：包里只进了 6 个文件（linux 是 8），
   * **三条文件存在性断言全绿**（ggml-base 在、CPU 模块在），
   * 而 `verify-bundle.sh` 里那条「**真的跑一次**」当场红：
   *     dyld: Library not loaded: @rpath/libggml.0.dylib
   * —— 这正是那条断言存在的理由：**存在 ≠ 能跑**。
   *
   * 版本段只允许数字/点/连字符，所以 `libggml-cpu-x64.so` / `libggml-cpu.so`
   * （含字母的后端后缀）不会被误判成核心库。
   */
  const isCore = (n) => /^(lib)?ggml(-base)?[-.0-9]*\.(so|dylib|dll)(\.[0-9.]+)?$/.test(n);
  const cpuMods = entries.filter((n) => /ggml-cpu/.test(n));
  const chosenCpu = cpuMods.find((n) => /ggml-cpu-x64/.test(n)) ?? cpuMods[0];
  if (!chosenCpu) die(`${T.probePackId} 里一个 ggml-cpu 模块都没有 —— 探针会枚举出 0 个设备`);

  let copied = 0;
  for (const n of entries) {
    if (!isCore(n) && n !== chosenCpu) continue;
    await cp(join(srcDir, n), join(dst, n), { verbatimSymlinks: true });
    copied += 1;
  }
  if (copied === 0) die(`没有复制任何 ggml 库 —— 探针一定起不来`);

  /*
   * ─────────────────────────────────────────────────────────────────────────────
   * ★★ CPU 基线转写链：**与探针共用这一个目录**（Manager 2026-08-08 裁决）
   * ─────────────────────────────────────────────────────────────────────────────
   *
   * ## 裁决依据（三条，都不是体积上的）
   *
   * 1. **许可证理由不成立。** whisper.cpp 是 **MIT**，随包分发不触发
   *    ffmpeg / yt-dlp 那条 GPL 传染（D-17 §1 的顾虑只对那两个成立）。
   *    所以"不打包"此前只剩体积理由，而用户 2026-08-08 明确说过
   *    「你只管功能有效就行，不要管性能先」—— 体积不是他的约束。
   * 2. **它补上一个从来没被验证过的洞。** `ADR-003` 决策 3 的 L1
   *    「永不失败的兜底」**一次都没有被验证过**，因为兜底的那个包根本不在包里。
   * 3. **对照 memo.ac 量出的结构差距**：它把引擎装在盒子里，我们发的是一个安装器。
   *
   * ## 为什么塞进 `runtime/probe/` 而不是新开一个目录
   *
   * **为了不长出第二份 ggml。** 探针与 whisper-cli 需要的 ggml 核心
   * （`libggml` / `libggml-base` / 一个 CPU 后端模块）**是同一份**，
   * 而两者都按 `$ORIGIN` / `@rpath` 找同目录的库。
   * 各放一份的话，同一个包里会有两套 ggml —— 既白占体积，又制造出
   * "两份可能不同版本的 ggml"这种以后一定会咬人的状态。
   *
   * ⚠️ 所以这个目录现在装的是「**随包出厂的 CPU 基线运行时**」，
   * 名字仍叫 `probe/` 是**刻意保留**的：`OPENMEMO_BUNDLED_PROBE_DIR` 这个契约
   * 刚刚落地，`launcher-spawn.mjs`、`selftest-bundle.mjs`、两个启动脚本都在引用它。
   * 为了一个更贴切的名字去动那四处，收益不抵风险。**改名留作后续。**
   *
   * ## 只抽必需的三件，不是把 17 MB 整包塞进来
   *
   * `[本机实测 2026-08-08, linux-x64]` 归档解开 17 MB，而跑得起来的最小集
   * （探针 + whisper-cli + ggml 核心 + 一个 CPU 模块 + libwhisper）只要 **3.0 MB**，
   * 其中探针那部分（1.60 MiB）**已经在上面复制过了**，
   * 本段的**增量**只有 whisper-cli(840 KB) + libwhisper(523 KB) + VAD 切分器(548 KB)。
   * 不带的：`whisper-bench`、`libparakeet*`、其余 13 个 `ggml-cpu-*` 变体
   * （多带它们在 linux 上要再花 13.6 MB，而对"能不能转写"这个判据没有增量）。
   *
   * `whisper-vad-speech-segments` **带上**：VAD 权重不随包出厂，所以它现在用不上，
   * 但一旦用户装了 ggml VAD 模型而没装 whisper 包，就会出现
   * 「有权重没切分器」这种新的半吊子状态。548 KB 买断这个半状态。
   */
  const cliName = T.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const vadName =
    T.platform === 'win32' ? 'whisper-vad-speech-segments.exe' : 'whisper-vad-speech-segments';
  const cliSrc = await findUnder(work, cliName);
  if (!cliSrc) {
    die(
      `${T.probePackId} 的归档里没有 ${cliName}。\n` +
        `   CPU 基线转写链是 ADR-003 决策 3 里 L1「永不失败的兜底」的执行者；\n` +
        `   缺了它，用户解压之后仍然必须先下一个引擎包才能转写第一段音频。\n` +
        `   **不允许降级放行。**`,
    );
  }
  /*
   * `libwhisper` 的命名与 ggml 同构（三平台各不相同，且带版本软链）：
   *   linux  libwhisper.so · libwhisper.so.1 · libwhisper.so.1.9.1
   *   macOS  libwhisper.dylib · libwhisper.1.dylib · libwhisper.1.9.1.dylib
   *   win    whisper.dll
   * 软链必须原样保留（`verbatimSymlinks`）—— `NEEDED` 写的是软链名，
   * 丢了链 whisper-cli 就起不来。这一条与上面 ggml 那段栽过的坑是同一个。
   */
  /*
   * ⚠️ 命名段里**可以有字母**（不只是版本号里的数字点）。
   *
   * `[CI 实测 2026-08-08 run 31263423087]` 第一版写的是 `[-.0-9]*`，
   * 于是 macOS 上漏掉了 `libwhisper.coreml.dylib`：
   * 文件存在性三条**全绿**（whisper-cli 在、libwhisper 3 个文件在），
   * 而 `verify-bundle.sh` 里那条「**真的跑一次**」当场红：
   *     dyld: Library not loaded: @rpath/libwhisper.coreml.dylib
   * —— 与 ggml 那段栽过的坑一模一样（那次漏的是 `libggml.0.dylib`），
   * 也再一次说明那条断言为什么必须存在：**存在 ≠ 能跑**。
   */
  const isWhisperLib = (n) => /^(lib)?whisper[A-Za-z0-9._-]*\.(so|dylib|dll)(\.[0-9.]+)?$/.test(n);
  let cliCopied = 0;
  for (const n of entries) {
    if (!isWhisperLib(n)) continue;
    await cp(join(srcDir, n), join(dst, n), { verbatimSymlinks: true });
    cliCopied += 1;
  }
  await cp(cliSrc, join(dst, cliName));
  if (T.platform !== 'win32') await chmod(join(dst, cliName), 0o755);
  cliCopied += 1;
  const vadSrc = await findUnder(work, vadName);
  if (vadSrc) {
    await cp(vadSrc, join(dst, vadName));
    if (T.platform !== 'win32') await chmod(join(dst, vadName), 0o755);
    cliCopied += 1;
  } else {
    // 不致命（没有 VAD 权重时本来就走固定窗口），但要出声，不许静默少一件
    say(`   ⚠️ 归档里没有 ${vadName} —— 装了 ggml VAD 权重的用户会退回固定窗口切分`);
  }

  await rm(work, { recursive: true, force: true });
  say(
    `   ✔ runtime/probe/  探针 + ggml 核心 + ${chosenCpu} + CPU 转写链` +
      `（共 ${copied + cliCopied + 1} 个文件，${mib(await dirSize(dst))}）`,
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────
 * ④-sexies ffmpeg / ffprobe（仅 Linux/Windows，随包内置，LGPL-3.0-or-later）
 * ───────────────────────────────────────────────────────────────────────────────── */

/**
 * 把 ffmpeg / ffprobe 的字节放进 `runtime/probe/`（与探针、whisper-cli 同一个目录——
 * 理由与 `assembleProbeRuntime()` 那段相同：`discoverTools()` 的 `fromBundle()`
 * 兜底只认 `bundledRuntimeDir()` 这**一个**目录，工具名任意，ffmpeg/ffprobe 不例外，
 * 不必新开一条 ArtifactStore 导入通道（模型才需要，见 `modelReconcile.ts` 顶部注释；
 * 这里更接近 `assembleProbeRuntime()` 那条"包内兜底"先例，机制上不是新东西）。
 *
 * ══ 只在 Linux/Windows 跑 ══════════════════════════════════════════════════════
 *
 * `T.ffmpegPackId` 只有这两个平台的 `TARGETS` 条目里有——`ffmpeg-lgpl-manifest` 那路
 * 把 Linux/Windows 的 ffmpeg 换成了 BtbN 的 LGPL-3.0-or-later 变体（与原 GPL 变体
 * 同一个 release tag、同一个源码 commit，见 `vendor/manifests/backends.json` 的
 * `sha256Provenance`），随包内置不再触发 GPL 传染顾虑；macOS 的供应商
 * （jellyfin-ffmpeg）不发 LGPL 变体（D-20 §13.4 供应商缺口），维持"下载 + GPL"，
 * 这里遇到 `T.ffmpegPackId` 缺失直接跳过，不是遗漏。
 *
 * ══ 为什么这里只抽两个可执行文件，不需要像 ggml 那样搜集一堆共享库 ══════════════
 *
 * `[本机实测 2026-08-09]` BtbN 这份 LGPL 变体是**静态链接**：`ldd bin/ffmpeg` 只
 * 挂了 libc/libm/libdl/librt/libpthread/libmvec/libgcc_s ——全部是 glibc 基线自带
 * 的系统库，归档里除了 `bin/{ffmpeg,ffprobe,ffplay}` 没有任何 `.so`；Windows 的
 * `.exe` 同理（PE 静态链接，`bin/` 下同样只有三个 `.exe`，没有伴随 `.dll`）。
 * 不像 `assembleProbeRuntime()` 里的 ggml/whisper 需要额外复制版本化共享库软链。
 *
 * ══ LICENSE.txt 必须随行——这不是可选项 ══════════════════════════════════════════
 *
 * `writeNotices()` 对 Linux/Windows 的那段新文字（`ffmpeg-lgpl-manifest` 加的）
 * 原文是：*"'许可证全文可得'义务由 ffmpeg 归档自带的 LICENSE.txt 满足——该文件随
 * ffmpeg 归档整份分发，未在本 NOTICES 中另行摘抄。"* ——这句话能不能算真话，
 * 完全取决于这份 LICENSE.txt 有没有真的进包。所以在这里把它一并复制进
 * `runtime/probe/`，**原名 `LICENSE.txt` 不改名**。`[本机实测 2026-08-09]`
 * 第一版曾改名成 `ffmpeg-LICENSE.txt`"避免撞名"，结果 `scripts/ci/verify-bundle.sh`
 * 那条双向核对（`find … -iname 'LICENSE.txt' …`）按**精确 basename 白名单**找
 * LICENSE 类文件，不是前缀/包含匹配——改了名字的文件它找不到，于是报
 * "翻遍 LICENSE/COPYING/NOTICE 类文件都没找到 Lesser General Public License 正文"，
 * 即使文本明明就在包里。改回原名后 `runtime/probe/` 目录里不会撞名（这里目前只有
 * ffmpeg 一家自带 LICENSE 文件；whisper.cpp 的 MIT 许可证是在 NOTICES 里引 URL，
 * 没有随文件进包），真出现第二个的那天再处理。`[本机核对 2026-08-09]`
 * 归档里的 LICENSE.txt 开头即是「GNU LESSER GENERAL PUBLIC LICENSE / Version 3」，
 * 与 `components.json` 的 `sha256Provenance` 记录的核对结果一致。
 *
 * ══ 二进制名字从 `providesFiles` 读，不在这里另猜一遍 ══════════════════════════
 *
 * `pack.providesFiles`（Linux 是 `["ffmpeg","ffprobe"]`，Windows 是
 * `["ffmpeg.exe","ffprobe.exe"]`）已经是 `discoverTools()` 在该平台查找的**确切
 * 文件名**（`platformPacks.test.ts` 有断言守着这条一致性），直接复用，不在本函数
 * 里重复 `T.platform === 'win32' ? … : …` 这种判断——单一事实来源，减少一处
 * "两边分别写、以后分叉"的风险。
 */
async function assembleFfmpeg() {
  if (!T.ffmpegPackId) {
    say('   （本平台 ffmpeg 维持下载，不随包内置——跳过，见 TARGETS 里的注释）');
    return;
  }
  hdr('④-sexies ffmpeg / ffprobe（LGPL-3.0-or-later，随包内置）');
  const manifest = JSON.parse(
    await readFile(join(REPO_ROOT, 'vendor/manifests/backends.json'), 'utf8'),
  );
  const pack = manifest.packs.find((p) => p.id === T.ffmpegPackId);
  if (!pack) die(`backends.json 里没有 pack ${T.ffmpegPackId} —— ffmpeg 没有来源`);
  const file = pack.files.find((f) => f.role === 'archive');
  const mirror = file.mirrors.find((m) => m.official) ?? file.mirrors[0];

  const local = await fetchToCache(mirror.url, file.name);
  const got = await sha256Of(local);
  if (got !== file.sha256)
    die(`${T.ffmpegPackId} 摘要与 manifest 不符\n   期望 ${file.sha256}\n   实得 ${got}`);
  say(`   ✔ ${T.ffmpegPackId}  sha256 对着 manifest 校验通过`);

  const work = await mkdtemp(join(tmpdir(), 'om-ffmpeg-'));
  const { unpackArchive } = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/downloader/dist/index.js')).href
  );
  await unpackArchive(local, work, kindOf(file.name));

  const dst = join(STAGE, 'runtime', 'probe');
  await mkdir(dst, { recursive: true });

  let copied = 0;
  for (const name of pack.providesFiles) {
    const src = await findUnder(work, name);
    if (!src) {
      die(
        `${T.ffmpegPackId} 的归档里没有 ${name}（backends.json 的 providesFiles 声明有它）。\n` +
          `   ffmpeg/ffprobe 是导入与转写前必经的音视频解码步骤；缺了它，"随包内置"这条\n` +
          `   兜底就是一句空话。**不允许降级放行。**`,
      );
    }
    await cp(src, join(dst, name));
    if (T.platform !== 'win32') await chmod(join(dst, name), 0o755);
    copied += 1;
  }

  const licenseSrc = await findUnder(work, 'LICENSE.txt');
  if (!licenseSrc) {
    die(
      `${T.ffmpegPackId} 的归档里没有 LICENSE.txt —— writeNotices() 对 ${T.platform} 的\n` +
        '   声明依赖这份文件随包分发来满足 LGPL "许可证全文可得" 义务；缺了它，\n' +
        '   NOTICES 里那句话就是假话。**不允许降级放行。**',
    );
  }
  await cp(licenseSrc, join(dst, 'LICENSE.txt'));
  copied += 1;

  await rm(work, { recursive: true, force: true });
  say(
    `   ✔ runtime/probe/  ffmpeg + ffprobe + LICENSE.txt（共 ${copied} 个文件，${mib(await dirSize(dst))}）`,
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────
 * ④-ter 组件目录（`vendor/manifests`）—— 用户"装不了任何组件"的**真因**
 * ───────────────────────────────────────────────────────────────────────────────── */

/**
 * 把 `vendor/manifests` 放进包里。
 *
 * ## 这是那条"点安装没有任何反应"的真因
 *
 * `[实测 2026-08-08，改走启动器那位量的]` 双击打开之后：
 * ```
 * packs = 0, groups = 0        ← 组件目录整个是空的
 * ```
 * 同一个包、同一个启动器，只加 `OPENMEMO_MANIFEST_DIR` → **0 变成 25**。
 *
 * `resolveManifestDir()` 的三条兜底**全落空**：
 *   ① 环境变量 —— 没人设；
 *   ② 模块相对的 `<bundle>/vendor/manifests` —— **包里根本没有 `vendor/`**；
 *   ③ `process.cwd()/vendor/manifests` —— **而启动器 `cd` 进了 `app/daemon`**。
 * 用户后果：组件页空的 → 装不了 ffmpeg / whisper / yt-dlp → **导入和转写全都用不了**。
 *
 * ## 为什么 CI 从来没看见
 *
 * 旧的直接启动方式 cwd = 仓库检出目录，那里**正好**有 `vendor/manifests` ——
 * 第三条兜底是**碰巧**落上的，把前两条的失败完全遮住了。
 *
 * ## 为什么是"打进包"而不是"让启动器设环境变量"
 *
 * **模块相对的兜底不依赖你从哪儿启动。** 而环境变量方案只修双击那一条路：
 * 从终端跑 `./start.sh`、从别的目录调启动器、CI 直接起 daemon —— 三条都还漏着。
 * 放进包之后 `resolveManifestDir()` 的第 ② 条**在两种布局里算出来的都是对的**：
 *   仓库   `apps/daemon/dist/http/rest` 上溯 5 层 = 仓库根 → `vendor/manifests` ✔
 *   包内   `app/daemon/dist/http/rest`  上溯 5 层 = 包根   → `vendor/manifests` ✔
 * 一条规则同时对两种布局成立，这才是它该有的样子。
 */
/**
 * 把 `vendor/whisper.cpp/samples/jfk.wav` **按原路径原名**打进包。
 *
 * ## 为什么零代码改动就能被找到
 *
 * `apps/daemon/src/runtime/setup.ts` 的 `repoSampleAudio()` 从模块位置上溯 4 层：
 *   仓库   `apps/daemon/{src,dist}/runtime` → 仓库根 → `vendor/whisper.cpp/samples/jfk.wav`
 *   包内   `app/daemon/dist/runtime`        → **包根** → 同一条相对路径
 * 也就是说**代码早就在找对地方了，只是那个位置一直是空的** ——
 * 自检的三条候选（环境变量 / `<dataDir>/selftest/jfk.wav` / 上面这条）在包里全部落空，
 * 所以 `audio: null` **对每个包用户都是必然**，不是偶发。
 *
 * ## ⚠️ 必须原名 `jfk.wav`
 *
 * 自检靠**这个文件名**才用内置的时长与参考文本去核对识别结果。
 * 改名会让它退回"只知道跑完了、不知道跑对没有"。
 *
 * 344 KB，MIT（随 whisper.cpp submodule 一起进来的官方样本）。
 */
/* ─────────────────────────────────────────────────────────────────────────────────
 * ④-quater 随包出厂模型（D-20 §11.2）
 * ───────────────────────────────────────────────────────────────────────────────── */

/**
 * 把 D-20 §9/§11 定案的 3 个非 GPL、体积可控模型的字节打进包
 * （`<包根>/models/<id>/<file.name>`）。
 *
 * ## 这只是半件事——"能不能被产品发现"是另一半，在别的文件里
 *
 * `[实测]` `grep -rn "BUNDLED_MODELS|bundledModels|resolveBundledModel"` 在这个改动
 * 之前是 0 命中：模型的唯一发现路径是 `ArtifactStore`（数据目录下的
 * `blobs/` + `manifests/`），这里放的字节它一个都不认，且不会报任何错
 * （D-20 §11.1）。真正"装上"发生在 daemon **首次启动**时的
 * `apps/daemon/src/http/rest/modelReconcile.ts`（`reconcileBundledModels`）——
 * 那一步会把这里放的文件哈希重新校验一遍、硬链接（同盘）或复制（跨盘）进
 * ArtifactStore、写出一份诚实的安装记录。**这个函数只负责把字节落进包里**，
 * 且每个字节在落包前都已经对着 vendor/manifests 的 sha256 校验过。
 *
 * ## id 从哪来：`BUNDLED_MODEL_IDS`，唯一权威
 *
 * 与 `modelReconcile.ts` 共享同一个常量（`packages/shared/src/bundled.ts`），
 * 不在这里重新拍一遍清单——两处分别抄一份 id 列表，就是 `roleMap.ts` 文件头
 * 点名警告过的"同一份映射分裂成两份认知，迟早漂移"。
 *
 * ## 清单怎么找：与 `loadModelCatalog()`（ADR-014）同一套判类规则
 *
 * 不写死是哪个文件名——`vendor/manifests` 下所有 `*.json`，含 `models` 数组的才算数。
 * 这里读的是仓库里 committed 的那份原始文件（不是 `assembleManifests()` 已经复制到
 * `STAGE` 里的那份副本），两者内容相同，只是**读取时机不同**，不构成两个事实来源。
 *
 * ## `yt-dlp` 为什么不在这里
 *
 * Manager 明令：嵌入依赖清点没做完之前不许打进包（发布阻断条件，另有一路在做）。
 * 这个函数只处理模型，不碰 `extPackIds`/`probePackId` 之外的任何新增打包项。
 */
async function assembleModels() {
  hdr('④-quater 随包出厂模型（D-20 §11.2：VAD + whisper-tiny + sherpa 流式，≈55.7 MB）');
  const { BUNDLED_MODEL_IDS } = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/shared/dist/index.js')).href
  );

  const manifestDir = join(REPO_ROOT, 'vendor', 'manifests');
  const catalogFiles = (await readdir(manifestDir)).filter(
    (n) => n.endsWith('.json') && n !== 'schema.json',
  );
  const byId = new Map();
  for (const name of catalogFiles) {
    const raw = JSON.parse(await readFile(join(manifestDir, name), 'utf8'));
    if (!Array.isArray(raw.models)) continue; // 不是模型目录（backends.json 之类），跳过
    for (const m of raw.models) byId.set(m.id, m);
  }

  const modelsDir = join(STAGE, 'models');
  await mkdir(modelsDir, { recursive: true });

  let totalFiles = 0;
  for (const id of BUNDLED_MODEL_IDS) {
    const model = byId.get(id);
    if (!model) {
      die(
        `BUNDLED_MODEL_IDS 里的 ${id} 在 vendor/manifests 里找不到 —— 常量与实际目录\n` +
          `   已经不同步（packages/shared/src/bundled.ts vs vendor/manifests/*.json）。`,
      );
    }
    const dir = join(modelsDir, id);
    await mkdir(dir, { recursive: true });
    for (const f of model.files) {
      if (!f.mirrors || f.mirrors.length === 0) die(`${id} 的文件 ${f.name} 一个镜像都没有`);
      // 缓存文件名带上 id，避免不同模型间正好同名（如多个 tokens.txt）互相覆盖缓存。
      const local = await fetchModelMirror(f.mirrors, `${id.replace(/\//g, '_')}-${f.name}`);
      const got = await sha256Of(local);
      if (got !== f.sha256) {
        die(
          `${id}/${f.name} 摘要与 vendor/manifests 不符\n   期望 ${f.sha256}\n   实得 ${got}\n` +
            `   不允许把一个校验不过的文件打进"内置"产物——那会让"内置"这个词本身\n` +
            `   失去意义（与 D-20 §11.3 第③条"不许改已内置项 sha256"同一条纪律）。`,
        );
      }
      await cp(local, join(dir, f.name));
      totalFiles += 1;
    }
    say(`   ✔ ${id}  ${model.files.length} 个文件，sha256 全部对着 vendor/manifests 校验通过`);
  }

  const bytes = await dirSize(modelsDir);
  say(
    `   ✔ models/  ${totalFiles} 个文件，${mib(bytes)}` +
      `（首次启动由 modelReconcile.ts 导入 ArtifactStore，此刻只是落包）`,
  );
}

async function assembleSampleAudio() {
  hdr('④-quinquies 自检样本音频 vendor/whisper.cpp/samples/jfk.wav');
  const src = join(REPO_ROOT, 'vendor', 'whisper.cpp', 'samples', 'jfk.wav');
  if (!existsSync(src)) {
    die(
      `找不到 ${src} —— submodule 没 checkout？\n` +
        `   缺了它，**每一个包用户**的自检都会停在「没有测试音频」（audio: null），\n` +
        `   而那是必然发生、不是偶发的。**不允许降级放行。**`,
    );
  }
  const dst = join(STAGE, 'vendor', 'whisper.cpp', 'samples');
  await mkdir(dst, { recursive: true });
  await cp(src, join(dst, 'jfk.wav'));
  say(`   ✔ vendor/whisper.cpp/samples/jfk.wav（${mib(await dirSize(dst))}，原名不可改）`);
}

async function assembleManifests() {
  hdr('④-ter 组件目录 vendor/manifests（缺了它用户的组件页是空的）');
  const src = join(REPO_ROOT, 'vendor', 'manifests');
  const dst = join(STAGE, 'vendor', 'manifests');
  await mkdir(dst, { recursive: true });
  const names = (await readdir(src)).filter((n) => n.endsWith('.json'));
  if (names.length === 0) die(`${src} 里一个 .json 都没有 —— 组件目录会是空的`);
  for (const n of names) await cp(join(src, n), join(dst, n));
  say(
    `   ✔ vendor/manifests/  ${names.length} 份清单（${mib(await dirSize(dst))}）：${names.join(', ')}`,
  );
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
/*
 * ★ 双击进来的人**没有控制台可以读 URL**，所以启动器请 daemon 自己开浏览器。
 *   用户已设则尊重他的值（`OPENMEMO_OPEN_BROWSER=0` 可关）。
 *   实现在 apps/daemon/src/bootstrap/open-browser.ts，**默认关**——
 *   只有启动器（= 双击入口）才打开它，脚本/CI 直接跑 `dist/main.js` 因而不受影响。
 */

/** POSIX 两个启动器共用的正文；差别只在文件名与注释。 */
const posixBody = (self) => `set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# 缺件预检：说清"缺什么、多半是为什么、下一步做什么"，而不是让 node 抛一个
# 用户看不懂的 MODULE_NOT_FOUND。
if [ ! -x "$DIR/runtime/node" ] || [ ! -f "$DIR/app/daemon/dist/main.js" ]; then
  echo ""
  echo "  OpenMemo 无法启动：这个包看起来不完整。"
  echo ""
  echo "  期望在 ${self} 旁边找到："
  echo "      runtime/node"
  echo "      app/daemon/dist/main.js"
  echo "  当前目录：$DIR"
  echo ""
  echo "  常见原因：只解开了一部分，或者把 ${self} 单独拷了出来。"
  echo "  重新完整解压一次再试。"
  echo ""
  exit 1
fi

# 已设则尊重用户的值；未设才用包内的
: "\${OPENMEMO_WEB_DIST:=$DIR/app/apps/web/dist}"
: "\${OPENMEMO_EXT_DIR:=$DIR/ext}"
# 随包出厂的最小探针运行时（探针 + ggml 核心 + 一个 CPU 后端模块）。
# 缺了它，用户第一屏六个后端会全部报 "probe did not complete"。
# daemon 把它排在**最后**：已安装的后端包优先，否则装完 Vulkan 也检测不到（见 setup.ts）。
: "\${OPENMEMO_BUNDLED_PROBE_DIR:=$DIR/runtime/probe}"
# 同一个目录还装着 CPU 基线转写链（whisper-cli + libwhisper，与探针共用 ggml）
: "\${OPENMEMO_BUNDLED_WHISPER_DIR:=$DIR/runtime/probe}"
# 随包出厂的模型字节（D-20 §11.2）。首次启动由 modelReconcile.ts 读这里、
# 逐字节校验、导入 ArtifactStore —— 与 MANIFEST_DIR 同样能靠模块相对路径自己找到，
# 这条环境变量只是给双击那条路多一层保险（与 PROBE_DIR / WHISPER_DIR 同样的理由）。
: "\${OPENMEMO_BUNDLED_MODELS_DIR:=$DIR/models}"
: "\${OPENMEMO_OPEN_BROWSER:=1}"
export OPENMEMO_WEB_DIST OPENMEMO_EXT_DIR OPENMEMO_BUNDLED_PROBE_DIR OPENMEMO_BUNDLED_WHISPER_DIR OPENMEMO_BUNDLED_MODELS_DIR OPENMEMO_OPEN_BROWSER
cd "$DIR/app/daemon"
exec "$DIR/runtime/node" dist/main.js "$@"
`;

const LAUNCHERS = {
  'start.sh': `#!/bin/sh
# OpenMemo 启动脚本。用法：./start.sh [--port 17650] [--data-dir /路径]
#
# 在文件管理器里双击本文件通常**不会运行它**（GNOME Files 等默认用文本编辑器打开
# 脚本）。Linux 上请在终端里跑：  ./start.sh
${posixBody('start.sh')}`,

  'OpenMemo.command': `#!/bin/sh
# OpenMemo 启动脚本（macOS 上可双击 —— .command 后缀会用「终端」打开）。
#
# ⚠️ 如果双击**什么都没发生**、或弹出"无法打开，因为无法验证开发者"：
#    那是 Gatekeeper 在拦，**不是这个脚本出错** —— 它根本没被执行到，
#    所以你也读不到这段话。**解法必须写在包外**：见同目录的 READ-ME-FIRST.txt
#    与 Release 正文。
#
#    （v0.2.0 的教训：那时解法只写在本文件里 ——
#     把说明书锁在了它要解释的那扇门后面。）
${posixBody('OpenMemo.command')}`,

  /*
   * ★★ 这个文件**必须保持纯 ASCII**。
   *
   * `cmd.exe` 读 `.cmd` 用的是**控制台的 OEM 代码页**（中文系统常是 936，英文 437），
   * 不是 UTF-8。文件里任何非 ASCII 字节在不同机器上会被解成不同东西。
   *
   * `[实测 2026-08-08]` v0.2.0 那版的 rem 注释里有中文，但**非 ASCII 字节全部落在
   * rem 行内**，可执行行是纯 ASCII；且 GBK 的 trail byte 范围是 0x40–0xFE，
   * 换行符 0x0A **不可能**被前一个 lead byte 吞掉。所以"代码页把脚本解坏"这条
   * **没有成立**（见 D-18）。保持 ASCII 是为了**从结构上取消这一整类问题**，
   * 而不是因为它已经炸了 —— 判据照 PROTOCOL §7 补充：跑错了也不该有后果。
   *
   * `chcp 65001` 管的是**另一件事**：daemon 自己的输出是 UTF-8 中文，
   * 在 cp437 控制台上会显示成乱码。那是**渲染**，不是解析。两者不要混。
   */
  'start.cmd': `@echo off
rem OpenMemo launcher for Windows.  Usage: start.cmd [--port 17650] [--data-dir C:\\path]
rem
rem KEEP THIS FILE PURE ASCII -- cmd.exe parses .cmd with the console OEM code page
rem (936 on Chinese Windows, 437 on English), not UTF-8.  See docs/design/D-18.
setlocal
title OpenMemo

rem The daemon prints UTF-8.  Without this, its startup instructions render as
rem mojibake on an English (cp437) console.  This affects rendering, not parsing.
chcp 65001 >nul 2>&1

set "DIR=%~dp0"

if not exist "%DIR%runtime\\node.exe" goto :incomplete
if not exist "%DIR%app\\daemon\\dist\\main.js" goto :incomplete

if not defined OPENMEMO_WEB_DIST set "OPENMEMO_WEB_DIST=%DIR%app\\apps\\web\\dist"
if not defined OPENMEMO_EXT_DIR set "OPENMEMO_EXT_DIR=%DIR%ext"
if not defined OPENMEMO_BUNDLED_PROBE_DIR set "OPENMEMO_BUNDLED_PROBE_DIR=%DIR%runtime\\probe"
if not defined OPENMEMO_BUNDLED_WHISPER_DIR set "OPENMEMO_BUNDLED_WHISPER_DIR=%DIR%runtime\\probe"
if not defined OPENMEMO_BUNDLED_MODELS_DIR set "OPENMEMO_BUNDLED_MODELS_DIR=%DIR%models"
if not defined OPENMEMO_OPEN_BROWSER set "OPENMEMO_OPEN_BROWSER=1"

cd /d "%DIR%app\\daemon"
"%DIR%runtime\\node.exe" dist\\main.js %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :failed
endlocal
exit /b 0

:incomplete
echo.
echo   OpenMemo cannot start: this package looks incomplete.
echo.
echo   Expected next to start.cmd:
echo       runtime\\node.exe
echo       app\\daemon\\dist\\main.js
echo   Current folder: %DIR%
echo.
echo   Most common cause: start.cmd was launched from *inside* the .zip.
echo   Windows only unpacks the single file you double-click, so everything
echo   else is missing.
echo.
echo   Fix: right-click the .zip -^> "Extract All...", open the extracted
echo        folder, and double-click start.cmd there.
echo.
pause
endlocal
exit /b 1

:failed
echo.
echo   OpenMemo stopped with exit code %RC%.
echo   The real error is printed ABOVE this line -- please read it.
echo.
echo   If it mentions VCRUNTIME140.dll or "side-by-side configuration",
echo   install "Microsoft Visual C++ 2015-2022 Redistributable (x64)".
echo.
pause
endlocal
exit /b %RC%
`,
};

/*
 * 包内的「首次运行请先看我」。
 *
 * ★ 为什么它必须是**包外可读的一个文件**，而不是启动脚本里的注释：
 *   macOS 上 Gatekeeper 拦的时候，`OpenMemo.command` **根本没被执行**，
 *   写在它里面的解法用户一个字也看不到。v0.2.0 恰恰就是这么写的 ——
 *   **把说明书锁在了它要解释的那扇门后面。**
 *   同一句话必须同时出现在：这个文件、README、以及 Release 正文。
 */
const READ_ME_FIRST = `OpenMemo —— 首次运行请先看我
================================

Windows
-------
1. 先把 .zip **完整解压**出来（右键 →「全部解压缩」）。
   ⚠️ 不要直接在压缩包里双击 start.cmd —— Windows 只会解开你点的那一个文件，
      其余全都不在，于是必然失败。
2. 打开解压出来的文件夹，双击 start.cmd。
3. 首次运行可能弹「Windows 已保护你的电脑」（SmartScreen）——
   我们没有购买代码签名证书，这是预期内的。
   点「更多信息」→「仍要运行」。
4. 浏览器会自动打开。没自动打开的话，看控制台窗口里那行地址。

macOS
-----
1. 双击 .tar.gz 解压（访达会解成一个文件夹）。
2. **如果双击 OpenMemo.command 什么都没发生，或提示"无法验证开发者"：**
   那是 Gatekeeper 在拦 —— 浏览器下载的文件带 com.apple.quarantine 属性，
   解压会把它传播给解出来的所有文件。

   ⚠️ 注意：**换成命令行 tar xzf 解压并不能绕开它。**
      归档带 quarantine 时，访达的「归档实用工具」和命令行 tar
      **都会**把该属性传给解出来的文件。

   解法（任选其一）：
     · 右键点 OpenMemo.command →「打开」→ 在弹窗里再点「打开」。
       只需要做这一次；之后双击就正常了。
       （macOS 13–14 是这个流程；macOS 15+ 可能要去
        「系统设置 → 隐私与安全性」，在下方点「仍要打开」。）
     · 或者在「终端」里跑一次：
         xattr -dr com.apple.quarantine "<解压出来的文件夹>"
       ⚠️ 这条命令会**清除整个文件夹的隔离标记**，等于对这些文件关掉 Gatekeeper 检查。
          请确认你信任这个来源再执行。
3. 放行之后会打开一个「终端」窗口，浏览器随后自动打开。

Linux
-----
在终端里跑：  ./start.sh
（文件管理器里双击 .sh 通常不会运行它，而是用文本编辑器打开。）

共通
----
· 关闭 OpenMemo：回到那个控制台/终端窗口按 Ctrl+C，或直接关掉窗口。
· 首次启动会提示"以下组件还没装"——这是正常的，不是出错。
  打开网页后在「设置 → 组件」里点安装即可。
· 数据保存在系统的用户数据目录里，**不在这个解压出来的文件夹里**。
  升级时直接删掉旧文件夹、解压新的即可，数据不受影响。
`;

async function writeLauncher() {
  hdr('⑤ 启动脚本');
  const name = T.launcher;
  const p = join(STAGE, name);
  const body = LAUNCHERS[name];

  /*
   * ★ Windows 启动器**必须是纯 ASCII + CRLF**，而且这条要在**组装时**就验，
   *   不能等到用户双击才发现。
   *
   *   · 纯 ASCII：cmd.exe 按控制台 OEM 代码页解析 .cmd（见 LAUNCHERS 里的长注释）。
   *   · CRLF：`.cmd` 的传统行尾。LF-only 在多数情况下能跑，但它是又一个
   *     "在别人机器上才显形"的自由度，而这里消灭它的成本是零。
   *
   *   这不是"记得别写中文"，是**写了就当场退出 1** —— 判据同 PROTOCOL §7 补充。
   */
  if (name.endsWith('.cmd')) {
    const bad = [...body].filter((c) => c.charCodeAt(0) > 0x7f);
    if (bad.length > 0) {
      die(
        `start.cmd 含 ${bad.length} 个非 ASCII 字符（${JSON.stringify(bad.slice(0, 10).join(''))}）——` +
          ` cmd.exe 按 OEM 代码页解析 .cmd，非 ASCII 在中文/英文系统上解出来的东西不一样。`,
      );
    }
    const crlf = body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    await writeFile(p, crlf, 'latin1');
    say(`   ✔ ${name}（纯 ASCII 已校验 · CRLF 行尾 · ${crlf.length} 字节）`);
  } else {
    await writeFile(p, body, 'utf8');
    await chmod(p, 0o755);
    say(`   ✔ ${name}（0755）`);
  }

  /*
   * 「首次运行请先看我」必须是**不需要执行任何东西就能读到**的文件。
   * macOS 上 Gatekeeper 拦住 .command 时，写在脚本里的解法用户一个字都看不到。
   */
  /*
   * ⚠️ 文件名保持 **纯 ASCII**，理由与 start.cmd 同源：zip 里非 ASCII 文件名是否
   *   被标成 UTF-8（通用位标记 bit 11）取决于打包工具 —— `zip(1)` 与 Python 的
   *   `zipfile` 行为不同，而 Windows 资源管理器对没标记的名字按 OEM 代码页解。
   *   一个叫「首次运行请先看我.txt」的文件很可能在用户机器上显示成乱码，
   *   **恰好是它要解决的那类问题**。正文用中文，文件名用英文。
   */
  const readme = join(STAGE, 'READ-ME-FIRST.txt');
  await writeFile(readme, READ_ME_FIRST, 'utf8');
  say(`   ✔ READ-ME-FIRST.txt`);
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
  /*
   * 2026-08-09（ytdlp-binary-audit Phase 2）：这行原来写"yt-dlp（GPL-3.0-or-later）"，
   * 把"官方二进制内嵌了什么"和"项目本身的许可证"混为一谈——yt-dlp 项目本身是
   * Unlicense，GPL 是官方 PyInstaller 二进制里内嵌的运行时依赖（mutagen 全平台
   * GPL-2.0-or-later、GNU Readline 仅 Linux x64/arm64 GPL-3.0-or-later，实测见
   * D-20 §14）。已按下面这行改准；但这不改变本段的结论——yt-dlp 内部无论嵌了
   * 多少层什么许可证，那都是**它自己发布物**的声明义务，不是我们的：NOTICES 的
   * 边界是"随本包分发的字节"，而 yt-dlp 的字节从没进过这条流水线（用户机器直连
   * 上游官方仓库下载，我们既不转存也不重新分发）。因此 mutagen / Readline /
   * certifi / requests / packaging / cryptography / yt-dlp 内嵌的 OpenSSL
   * （Linux/macOS 3.x·Apache-2.0 与 Windows 1.1.x·旧 OpenSSL 许可证·已 EOL 这条
   * 版本分叉，同样见 D-20 §14）都**不**在这份 NOTICES 里逐条列出——不是漏了，
   * 是判断后排除在外：这些字节从没随我们的包分发过，义务不在我们。D-20 §14.4
   * 那张"供写 NOTICES 时用"的表，结论恰恰是这张表最终不喂给这个函数；那句框架性
   * 描述已经过时，留给 D-20 自己的订正处理，这里不重复改。
   *
   * 2026-08-09（ffmpeg-lgpl-manifest，Manager 裁定，D-20 §9.2/§13.7）：ffmpeg 那半句
   * 不再对 Linux/Windows 成立——那两个平台从"下载"改成"随包内置"（LGPL-3.0-or-later
   * 变体，与原 GPL 变体同源同 commit，见 vendor/manifests/backends.json 的
   * media-tools-{linux,win}-x64）。macOS 不变，供应商（jellyfin-ffmpeg）不发 LGPL
   * 变体，仍是下载 + GPL-3.0-or-later（D-20 §13.4 供应商缺口）。三平台不再是同一句话，
   * 按 T.platform 分叉，不在这里重复维护"内置到底有没有落地"的判断——一旦 ffmpeg
   * 真的没有被打包进某平台的 stage，那是打包实现那一路的 bug，不是这段文字该兜底的事；
   * 这里只负责在"确实内置"的前提下把 LGPL 的分发义务（许可证全文可得）说清楚。
   * 本次改动**只碰这段文字**，未触碰任何 ffmpeg 字节的打包/复制逻辑（那由另一路负责，
   * 见 D-20 §13.6）。
   */
  if (T.platform === 'darwin') {
    parts.push('⚠️ 本包**不含** ffmpeg 与 yt-dlp。ffmpeg 是 GPL-3.0-or-later');
    parts.push('   （jellyfin-ffmpeg 构建）；yt-dlp 项目本身是 Unlicense，但官方发行的');
    parts.push(
      '   二进制内嵌了 GPL 组件（mutagen 等，详见 docs/design/D-20-bundled-deps.md §14）。',
    );
    parts.push('   这两个组件都由产品在你的机器上按需从上游官方 GitHub 下载，');
    parts.push('   我们既不转存也不重新分发它们的字节。详见 docs/adr/ADR-002。');
  } else {
    parts.push('⚠️ 本包**内置** ffmpeg / ffprobe（LGPL-3.0-or-later，BtbN LGPL 变体，');
    parts.push('   与本条目下方"随包出厂的 CPU 基线转写引擎"逻辑一致：字节随本包分发）。');
    parts.push('   我们只以 `spawn` 命令行方式调用 ffmpeg 可执行文件，不 `dlopen`、');
    parts.push('   不链接其任何库（D-20 §13.3），LGPL 的链接触发义务不适用；仍需满足的');
    parts.push('   "许可证全文可得"义务由 ffmpeg 归档自带的 LICENSE.txt 满足——该文件');
    parts.push('   随 ffmpeg 归档整份分发，未在本 NOTICES 中另行摘抄。');
    parts.push('   本包**不含** yt-dlp：项目本身是 Unlicense，但官方发行的二进制内嵌了');
    parts.push('   GPL 组件（mutagen 等，详见 docs/design/D-20-bundled-deps.md §14）。');
    parts.push('   yt-dlp 由产品在你的机器上按需从上游官方 GitHub 下载，我们既不转存也');
    parts.push('   不重新分发它的字节。详见 docs/adr/ADR-002。');
  }
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

  /*
   * 随包出厂的模型（D-20 §11.2，assembleModels()）——同样必须声明许可证与来源。
   * 从 vendor/manifests 里的 license/source 字段生成，不在这里另抄一份文字，
   * 避免"清单改了，NOTICES 没跟着改"这类漂移。
   */
  parts.push('');
  parts.push('─'.repeat(78));
  parts.push('随包出厂的模型（不经 npm，来自 vendor/manifests，D-20 §11.2）');
  parts.push('─'.repeat(78));
  {
    const modelManifestDir = join(REPO_ROOT, 'vendor', 'manifests');
    const modelById = new Map();
    for (const name of (await readdir(modelManifestDir)).filter((n) => n.endsWith('.json'))) {
      const raw = JSON.parse(await readFile(join(modelManifestDir, name), 'utf8'));
      if (!Array.isArray(raw.models)) continue;
      for (const m of raw.models) modelById.set(m.id, m);
    }
    const { BUNDLED_MODEL_IDS } = await import(
      pathToFileURL(join(REPO_ROOT, 'packages/shared/dist/index.js')).href
    );
    for (const id of BUNDLED_MODEL_IDS) {
      const m = modelById.get(id);
      if (!m) continue; // assembleModels() 已经 die() 过这种情况，这里只是不重复报
      parts.push(`  ${m.displayName ?? id} (${id})  —  ${m.license?.id ?? 'UNKNOWN'}`);
      if (m.source?.provider === 'hf') {
        parts.push(
          `      来源 https://huggingface.co/${m.source.repo}  revision ${m.source.revision}`,
        );
      }
      if (m.license?.url) parts.push(`      许可证 ${m.license.url}`);
    }
  }

  /*
   * 2026-08-09（ytdlp-binary-audit Phase 2 task ④）：随包出厂的 CPU 基线转写引擎
   * （assembleProbeRuntime() 装进 runtime/probe/ 的那份 whisper.cpp + ggml）此前
   * 完全没有出现在 NOTICES 里——即使上面加了模型那一节之后依然是空白，这是一个
   * 真实的覆盖缺口，不是口径判断。许可证同样从 vendor/manifests/backends.json 的
   * T.probePackId 那条 pack 读，理由与模型那节相同：不在这里另抄一份文字，避免
   * "清单改了、NOTICES 没跟着改"这类漂移。assembleProbeRuntime() 早于本函数运行
   * （见 main()），已经对同一个 T.probePackId 校验过存在性，这里理论上不会再 die。
   */
  parts.push('');
  parts.push('─'.repeat(78));
  parts.push('随包出厂的 CPU 基线转写引擎（runtime/probe/，来自 vendor/manifests/backends.json）');
  parts.push('─'.repeat(78));
  {
    const backendsManifest = JSON.parse(
      await readFile(join(REPO_ROOT, 'vendor/manifests/backends.json'), 'utf8'),
    );
    const probePack = backendsManifest.packs.find((p) => p.id === T.probePackId);
    if (!probePack) {
      die(
        `writeNotices: backends.json 里没有 pack ${T.probePackId} —— ` +
          'assembleProbeRuntime() 理应已经先 die 过，这里不应该走到',
      );
    }
    parts.push(
      `  ${probePack.displayName ?? T.probePackId}  —  ${probePack.license?.id ?? 'UNKNOWN'}`,
    );
    const engineLine = `      engine ${probePack.engine ?? 'whisper.cpp'} ${probePack.engineVersion ?? ''}`;
    parts.push(engineLine.trimEnd());
    if (probePack.license?.url) parts.push(`      许可证 ${probePack.license.url}`);
  }

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

  /*
   * ★ 残包标记：**构建一开始就落，成功走完才删。**
   *
   * `[实测 2026-08-09]` 本机断网时构建中止在 `assembleModels()`（要联网），
   * 而 `writeLauncher()` 排在它**后面** —— 于是留下一个
   * `app/ext/runtime` 齐全、**却没有 start.sh** 的目录：
   * **看起来像个包，其实用户双击不开，而且没有任何东西说它是残的。**
   *
   * 这与本仓那一族完全同形（探针不在包里、`vendor/manifests` 不在包里、
   * `copy_if_exists` 缺文件不吭声）：**"看起来成了，其实没成"。**
   *
   * ⚠️ 刻意**不做成"检查文件齐不齐"的清单**（Manager 2026-08-09 明确）：
   * 清单会和现实漂移 —— 今天列 8 个文件，明天多一个没人回来加，
   * 于是清单绿着而包是残的。**标记不会漂**：它只回答一个问题
   * 「这次构建有没有跑完」，而那正是要问的。
   */
  await writeFile(
    join(STAGE, INCOMPLETE_MARKER),
    '这次构建还没跑完。看到这个文件说明包是**残的**，不要分发、也不要拿它当产物验证。\n' +
      'This build did not finish. This bundle is INCOMPLETE — do not ship or verify against it.\n',
    'utf8',
  );

  await acquireNode();
  await assembleOurCode();
  await assembleNodeModules();
  await assembleExtensions();
  await assembleProbeRuntime();
  await assembleManifests();
  await assembleModels();
  await assembleSampleAudio();
  await assembleFfmpeg();
  await writeLauncher();
  await writeNotices();

  // 走到这里 = 所有装配步骤都成功了。**删标记必须在归档之前**，否则残包标记会被打进归档。
  await rm(join(STAGE, INCOMPLETE_MARKER), { force: true });

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
