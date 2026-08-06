#!/usr/bin/env node
/**
 * 把**已经逐字节校验过的**产物，上传到一个**已经存在、且已发布**的 GitHub Release。
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * ★ 这个脚本能做什么、不能做什么（权限边界，请连同 .github/workflows/release-upload.yml
 *   的注释一起读；那边是"谁拿得到写权限"，这边是"拿到之后只能干什么"）
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 *   能：  GET  {api}/repos/{repo}/releases/tags/{tag}      —— 找到那个已存在的 release
 *         POST {uploads}/…/releases/{id}/assets?name=…     —— 往它上面**新增**一个资产
 *
 *   不能：建 release（POST /releases）、改 release（PATCH）、删资产（DELETE）、
 *         改 tag、改仓库可见性、改分支保护、`--clobber` 覆盖同名资产。
 *         **这些调用在本文件里一个都没有**，`scripts/ci/lint-workflows.mjs` 有一条
 *         断言把它们钉住（新增回来会当场红）。
 *
 * ── 为什么要把"上传"和"建 release"分得这么开 ────────────────────────────────────────
 *
 * `pack-publish` 在 T-150 里**拒绝**给 workflow 加 `contents: write`，原话是：
 *
 *   > 建 release 是要人确认的对外动作，"让 CI 代劳"会把那道闸悄悄绕过去
 *   > —— 绕过的还是同一道闸，只是换了个执行者。
 *
 * **那个拒绝是对的，这个脚本没有推翻它。** 用户 2026-08-06 下的指令是"让 CI 传"，
 * 开的是"上传"这一格，不是"随便建 release"那一格。所以：
 *
 *   - release 必须**已经存在**。找不到 → 失败，并明说"本 job 不会替你建"。
 *   - release 必须**不是 draft**。draft 的附件**不能匿名下载**（pack-publish T-146 §1.2
 *     实测过），而我们整条校验链的最后一步正是"不带凭证下下来"。
 *     本 job 也**无权**把 draft 改成 published —— 它只会失败并让人去按那个按钮。
 *
 * ── 为什么"已存在同名资产"不许静默覆盖 ──────────────────────────────────────────────
 *
 * `gh release upload --clobber` 会**先删后传**且不出声。一旦有人用它，
 * "我们到底发了什么"就变成不可追溯的：同一个 URL、同一个 tag，在两个时刻是两份字节，
 * 而没有任何记录说这件事发生过。所以这里的规则是：
 *
 *   已存在 + sha256 一致  →  **跳过**，并打印"为什么跳过"
 *   已存在 + sha256 不同  →  **失败**（不删、不覆盖、不重命名）
 *   已存在 + state 不是 uploaded →  **失败**（那是上次上传中断留下的残骸；
 *                                    删它需要 DELETE，而本 job 没有那个能力）
 *
 * ── 为什么重试是串行的（这一条是用一小时的真实教训换来的）─────────────────────────────
 *
 * 2026-08-06，有人从开发机传那个 294 MB 的模型：`gh` 静默不完成、curl 直传 404，
 * 于是**连开三路后台重试却没有杀掉前面的**。结果三个进程并发上传同一个文件、
 * 互相 `--clobber`，跑了一个多小时都没有一次成功；把它们全部清干净之后，**单跑一次就成了**。
 *
 * > **并发重试会把一个可恢复的失败变成一个永久的失败。**
 *
 * 所以本脚本的重试是一个 `for` + `await` 循环（不是 `Promise.all`），
 * 且**每次重试之前都会重新拉一遍资产列表** —— 上一次可能已经传成功了，
 * 只是响应没回来。互斥的另一半在 workflow 那边：`concurrency.group` 按 tag 分组、
 * `cancel-in-progress: false`（取消一次进行中的上传，留下的就是上面那种 `state` 残骸）。
 *
 * ── 上传什么：`SHA256SUMS` 是唯一的事实来源 ──────────────────────────────────────────
 *
 * 每个 artifact 目录必须自带一份 coreutils 标准格式的 `SHA256SUMS`，**只列它自己那几个
 * 文件**。这条不是格式洁癖，是 `pack-publish` T-150 实测踩出来的：
 * 三个分包共用同一份 9 行清单时，单独验一包的**最显然那条命令**会输出
 * `5 listed files could not be read` + exit 1，而**文件一个都没坏**。
 *
 * > 一个把"完全正常"报成"看起来像损坏"的验证工具，比没有验证工具更糟：
 * > 它要么让人把好产物当坏的丢掉，要么让人学会忽略它的输出 —— 后者更贵。
 * > **正确的做法是让最显然的那条命令本来就是对的。**
 *
 * 本脚本产出的 `<stage>/SHA256SUMS` 因此也遵守同一条：它**恰好**列出这次要保证
 * 在 release 上存在的那些资产，一个不多一个不少 —— 于是校验那一步
 * `cd <下载目录> && sha256sum -c SHA256SUMS` 本来就是对的。
 *
 * 用法：
 *   node scripts/ci/release-upload.mjs \
 *     --repo <owner/repo> --tag <已存在且已发布的 tag> \
 *     --from <gh run download 下来的目录> --stage <暂存目录> [--dry-run]
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/* ── 参数 ────────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);

const REPO = arg('--repo', process.env.GITHUB_REPOSITORY ?? '');
const TAG = arg('--tag', '');
const FROM = resolve(arg('--from', 'dist/release-src'));
const STAGE = resolve(arg('--stage', 'dist/release-stage'));
const DRY_RUN = flag('--dry-run');
const RETRIES = Math.max(1, Number(arg('--retries', '3')));
/* `--api-base` / `--download-base` 只为自检里的桩服务器存在（真 draft release 我们无权创建，
 * 所以"draft 必须红"这条只能对着桩验；见 scripts/ci/selftest-release-upload.mjs）。 */
const API_BASE = arg('--api-base', 'https://api.github.com').replace(/\/+$/, '');
const DOWNLOAD_BASE = arg('--download-base', 'https://github.com').replace(/\/+$/, '');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

/** 清单族文件：它们是给传输过程用的，本身不是资产（`SHA256SUMS` 没法列出自己）。 */
const MANIFEST_FAMILY = new Set([
  'SHA256SUMS',
  'SHA256SUMS.all',
  'MIRROR-MANIFEST.json',
  'RELEASE-UPLOAD-PLAN.json',
]);

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

const problems = [];
const fatal = (msg) => {
  problems.push(msg);
};

async function die() {
  say('');
  console.error(`✘ release-upload: ${problems.length} 个问题`);
  for (const p of problems) console.error(`  - ${p}`);
  await summary(`### ✘ release-upload 失败\n\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
  process.exit(1);
}

async function summary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) await appendFile(f, `${md}\n`);
}

/* ── 基础工具 ────────────────────────────────────────────────────────────────────── */

function sha256Of(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('error', rej)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')));
  });
}

/** coreutils 的 `sha256sum` 输出格式：`<64 hex><两个空格或 " *"><文件名>`。 */
function parseSha256Sums(text, where) {
  const out = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const m = /^([0-9a-f]{64})\s[ *](.+)$/.exec(line);
    if (!m) {
      fatal(`${where}:${i + 1} 不是 sha256sum 的标准格式：${JSON.stringify(line)}`);
      continue;
    }
    out.push({ sha256: m[1], name: m[2] });
  }
  return out;
}

/* ── 阶段 1：暂存 —— 把要传的东西集中到一个目录，并现场复算一遍 ──────────────────── */

/** `emit-pack-manifest.mjs` 产出的 fragment 长这样：`{ id, files: [{ name, sha256, sizeBytes }] }`。 */
async function readPackFragment(path) {
  try {
    const j = JSON.parse(await readFile(path, 'utf8'));
    if (typeof j?.id === 'string' && Array.isArray(j?.files) && j.files.length > 0) {
      const ok = j.files.every(
        (f) => typeof f?.name === 'string' && typeof f?.sha256 === 'string' && typeof f?.sizeBytes === 'number',
      );
      if (ok) return j;
    }
  } catch {
    /* 不是我们的 fragment，忽略 */
  }
  return null;
}

/** 找出所有"够格当一个 artifact 目录"的目录：自带 SHA256SUMS，或者含 pack fragment。 */
async function collectSourceDirs(root) {
  const found = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries.filter((e) => e.isFile());
    const hasSums = files.some((e) => e.name === 'SHA256SUMS');
    let hasFragment = false;
    for (const e of files) {
      if (!e.name.endsWith('.json')) continue;
      if (await readPackFragment(join(dir, e.name))) {
        hasFragment = true;
        break;
      }
    }
    if (hasSums || hasFragment) {
      found.push({ dir, mode: hasSums ? 'sha256sums' : 'pack-fragment' });
      return; /* 不再往下钻：这一层就是一个 artifact */
    }
    for (const e of entries.filter((x) => x.isDirectory())) await walk(join(dir, e.name));
  };
  await walk(root);
  return found;
}

/**
 * 两种 mode 的严格程度**刻意不同**，理由写在这里免得下一个人以为是漏写：
 *
 * - `sha256sums`：这份清单是**为了上传而写的**，所以"目录里有、清单里没有"= 有人漏列了，
 *   直接失败。（清单族文件除外 —— 它们没法列出自己。）
 * - `pack-fragment`：fragment 描述的是**一个 pack 是什么**，而 build 的 artifact 里
 *   本来就刻意带着别的构建产物（`openmemo-probe` 至今没有分发通道，见 D-11 §5）。
 *   所以这里"多出来的文件"是预期内的，**逐个打印名字**但不失败。
 */
async function stageOne(src, mode, seen) {
  const staged = [];
  const entries = (await readdir(src.dir, { withFileTypes: true })).filter((e) => e.isFile());
  const names = entries.map((e) => e.name);

  let wanted; /* [{ name, sha256 }] */
  if (mode === 'sha256sums') {
    const text = await readFile(join(src.dir, 'SHA256SUMS'), 'utf8');
    wanted = parseSha256Sums(text, join(src.dir, 'SHA256SUMS'));
    if (wanted.length === 0) {
      fatal(`${src.dir}/SHA256SUMS 一行都没有 —— 一个"什么都不传"却报成功的上传是最坏的一种`);
      return staged;
    }
    const listed = new Set(wanted.map((w) => w.name));
    const extra = names.filter((n) => !listed.has(n) && !MANIFEST_FAMILY.has(n));
    if (extra.length > 0) {
      fatal(
        `${src.dir}: 这些文件在目录里但不在 SHA256SUMS 里：${extra.join(', ')}。` +
          `要么补进清单，要么别放进来 —— 悄悄不传比传错更难发现`,
      );
    }
  } else {
    wanted = [];
    const covered = new Set();
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      const frag = await readPackFragment(join(src.dir, n));
      if (!frag) continue;
      covered.add(n);
      for (const f of frag.files) {
        wanted.push({ name: f.name, sha256: f.sha256, sizeBytes: f.sizeBytes });
        covered.add(f.name);
      }
    }
    const extra = names.filter((n) => !covered.has(n) && !MANIFEST_FAMILY.has(n));
    if (extra.length > 0) {
      say(`   ℹ ${src.dir}: 不是 pack 资产、不上传：${extra.join(', ')}`);
    }
  }

  for (const w of wanted) {
    const p = join(src.dir, w.name);
    let st;
    try {
      st = await stat(p);
    } catch {
      fatal(`${src.dir}: 清单里有 ${w.name}，但目录里没有这个文件`);
      continue;
    }
    const got = await sha256Of(p);
    if (got !== w.sha256) {
      fatal(`${w.name}: 清单说 ${w.sha256}，本地实算 ${got} —— 产物在传输途中坏了，或者清单不是这一版的`);
      continue;
    }
    if (w.sizeBytes != null && st.size !== w.sizeBytes) {
      fatal(`${w.name}: 清单说 ${w.sizeBytes} B，本地实测 ${st.size} B`);
      continue;
    }

    /*
     * ★ 全局重名检查。`pack-publish` T-150 点过名的那颗雷：那 9 个模型文件里
     *   `tokens.txt` 出现两次（sherpa 一份、paraformer 一份，**内容不同**），
     *   用原名上传会让后一个**覆盖前一个，且不会有任何报错**。
     *   资产名带前缀正是为了让这件事不可能发生 —— 这条断言是那件事的守卫。
     */
    const prev = seen.get(w.name);
    if (prev) {
      if (prev.sha256 !== got) {
        fatal(
          `资产名 ${w.name} 在两个来源里内容不同（${prev.from} 与 ${src.dir}）——` +
            ` release 的资产名是全局唯一的，这样传上去后一个会顶掉前一个而且不会报错`,
        );
      } else {
        say(`   ↩ ${w.name.padEnd(56)} 与 ${prev.from} 里的那份逐字节相同，只留一份`);
      }
      continue;
    }
    seen.set(w.name, { sha256: got, from: src.dir });

    await copyFile(p, join(STAGE, w.name));
    staged.push({ name: w.name, sha256: got, sizeBytes: st.size, from: src.dir });
    say(`   ✔ ${w.name.padEnd(56)} ${String(st.size).padStart(12)} B  ${got.slice(0, 12)}…`);
  }
  return staged;
}

/* ── 阶段 2：找到那个 release（只 GET，不建、不改）──────────────────────────────── */

async function ghGet(path) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'openmemo-release-upload',
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`${API_BASE}${path}`, { headers });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}

/* ── 阶段 3：逐个资产判定 ────────────────────────────────────────────────────────── */

const digestOf = (asset) =>
  typeof asset?.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null;

/** 不带任何凭证地把已存在的资产下下来复算 —— 用在 API 没给 `digest` 的老资产上。 */
async function anonymousSha256(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'openmemo-release-upload' } });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of r.body) {
    h.update(chunk);
    size += chunk.length;
  }
  return { sha256: h.digest('hex'), size };
}

/* ── 阶段 4：上传（串行；无 --clobber；无 DELETE）─────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postAsset(uploadUrlTemplate, name, buf) {
  const url = `${uploadUrlTemplate.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/octet-stream',
      'content-length': String(buf.length),
      'user-agent': 'openmemo-release-upload',
    },
    body: buf,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${t.slice(0, 400)}`);
  }
  return r.json();
}

/* ── main ────────────────────────────────────────────────────────────────────────── */

async function main() {
  if (!/^[^/]+\/[^/]+$/.test(REPO)) fatal(`--repo 必须是 owner/repo，实得 ${JSON.stringify(REPO)}`);
  if (!TAG) fatal('--tag 必填：本脚本只能往一个**已存在**的 tag 上传，它不会替你建 release');
  if (problems.length > 0) await die();

  hdr(`0. 暂存并现场复算 —— 来源 ${FROM}`);
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });

  const sources = await collectSourceDirs(FROM);
  if (sources.length === 0) {
    fatal(
      `${FROM} 下没有找到任何可上传的 artifact 目录（需要自带 SHA256SUMS，或含 emit-pack-manifest 的 fragment）。` +
        `一个"什么都没传"却绿灯的上传，正是本仓最贵的那类失败`,
    );
    await die();
  }
  for (const s of sources) say(`   来源目录 ${s.dir}   模式=${s.mode}`);
  say('');

  const seen = new Map();
  let assets = [];
  for (const s of sources) assets = assets.concat(await stageOne(s, s.mode, seen));
  if (assets.length === 0) fatal('暂存之后一个资产都没有 —— 拒绝报成功');
  if (problems.length > 0) await die();

  const sums = `${assets.map((a) => `${a.sha256}  ${a.name}`).join('\n')}\n`;
  await writeFile(join(STAGE, 'SHA256SUMS'), sums);
  say('');
  say(`   ${assets.length} 个资产，合计 ${assets.reduce((n, a) => n + a.sizeBytes, 0)} B`);
  say(`   已写 ${join(STAGE, 'SHA256SUMS')}（**只列这次的这些**，所以 \`sha256sum -c SHA256SUMS\` 本来就是对的）`);

  /* ── 找 release ── */

  hdr(`1. 找到 release ${REPO} @ ${TAG} —— 只 GET；找不到就失败，不创建`);
  const rel = await ghGet(`/repos/${REPO}/releases/tags/${encodeURIComponent(TAG)}`);
  if (rel.status === 404) {
    fatal(
      `release tag \`${TAG}\` 不存在。**本 job 不会替你建** —— 建 release 是要人确认的对外动作，` +
        `让 CI 代劳等于把那道闸换个执行者绕过去。请先由人建好（已发布、可 prerelease、不能是 draft），再重跑本 workflow`,
    );
    await die();
  }
  if (rel.status !== 200 || !rel.body?.id) {
    fatal(`查 release 失败：HTTP ${rel.status} ${JSON.stringify(rel.body)?.slice(0, 300)}`);
    await die();
  }
  const release = rel.body;
  say(`   id=${release.id}  draft=${release.draft}  prerelease=${release.prerelease}`);
  say(`   ${release.html_url ?? ''}`);
  if (release.draft) {
    fatal(
      `这个 release 是 **draft**。draft 的附件**不能匿名下载**（要 token），` +
        `而本流水线最后一步就是"不带任何凭证重新下下来复算" —— 传上去也过不了那一关。` +
        `本 job 也**无权**把它改成 published（那需要 PATCH，属于"改 release"，刻意没有实现）。` +
        `请由人点一下 Publish 再重跑`,
    );
    await die();
  }

  /* ── 逐个判定 ── */

  hdr('2. 上传前逐个判定 —— 已存在且一致就跳过；已存在但不同就失败（绝不静默覆盖）');
  const existing = new Map((release.assets ?? []).map((a) => [a.name, a]));
  const plan = [];
  for (const a of assets) {
    const cur = existing.get(a.name);
    if (!cur) {
      plan.push({ ...a, action: 'upload', why: 'release 上还没有这个资产' });
      say(`   ⬆ ${a.name.padEnd(56)} 要上传`);
      continue;
    }
    if (cur.state !== 'uploaded') {
      fatal(
        `${a.name}: release 上已有同名资产，但 state=${cur.state}（不是 uploaded）——` +
          ` 这是上一次上传中断留下的残骸。清掉它需要 DELETE，而本 job **没有删除能力**（刻意的）。请人工处理`,
      );
      continue;
    }
    let curSha = digestOf(cur);
    let how = 'API 的 digest 字段';
    if (!curSha) {
      /* 老资产没有 digest 字段 —— 那就不带凭证真的下下来算一遍。 */
      const got = await anonymousSha256(cur.browser_download_url);
      if (got.error) {
        fatal(`${a.name}: release 上已有同名资产，但匿名下载失败（${got.error}），无法判断是不是同一份`);
        continue;
      }
      curSha = got.sha256;
      how = '匿名下载后复算';
    }
    if (curSha === a.sha256 && cur.size === a.sizeBytes) {
      plan.push({ ...a, action: 'skip', why: `已存在且 sha256 一致（${how}）` });
      say(`   = ${a.name.padEnd(56)} 跳过：已存在且 sha256 一致（${how}）`);
      continue;
    }
    fatal(
      `${a.name}: release 上已有同名资产，但**内容不同** —— ` +
        `线上 ${cur.size} B / ${curSha}，本次 ${a.sizeBytes} B / ${a.sha256}。` +
        `本脚本**不会** \`--clobber\`：静默覆盖会让"我们到底发了什么"变成不可追溯的。` +
        `要换内容请换资产名，或者由人明确决定删掉旧的那份`,
    );
  }
  if (problems.length > 0) await die();

  /* ── 上传 ── */

  const toUpload = plan.filter((p) => p.action === 'upload');
  hdr(
    DRY_RUN
      ? `3. --dry-run：不上传。本来会传 ${toUpload.length} 个，跳过 ${plan.length - toUpload.length} 个`
      : `3. 上传 ${toUpload.length} 个资产 —— **串行**，一个传完再传下一个`,
  );
  if (!DRY_RUN && toUpload.length > 0 && !TOKEN) {
    fatal('要上传但环境里没有 GITHUB_TOKEN / GH_TOKEN');
    await die();
  }

  for (const p of toUpload) {
    if (DRY_RUN) {
      say(`   （dry-run）会上传 ${p.name}`);
      continue;
    }
    const buf = await readFile(join(STAGE, p.name));
    let done = false;
    for (let attempt = 1; attempt <= RETRIES && !done; attempt += 1) {
      const t0 = Date.now();
      try {
        await postAsset(release.upload_url, p.name, buf);
        say(`   ⬆ ${p.name.padEnd(56)} 第 ${attempt} 次尝试成功（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
        done = true;
      } catch (e) {
        say(`   ✘ ${p.name.padEnd(56)} 第 ${attempt} 次失败：${e instanceof Error ? e.message : String(e)}`);
        /*
         * ★ 重试前**重新拉一遍资产列表**。上一次可能其实已经传成功了，只是响应没回来；
         *   闷头再传一次就会撞上 422 already_exists，或者更糟 —— 留下一个半截资产。
         *   （这也是为什么重试是 for+await 而不是并发：见文件头那段一小时的教训。）
         */
        const fresh = await ghGet(`/repos/${REPO}/releases/${release.id}`);
        const now = (fresh.body?.assets ?? []).find((x) => x.name === p.name);
        if (now) {
          const d = digestOf(now);
          if (now.state === 'uploaded' && (d === null || d === p.sha256) && now.size === p.sizeBytes) {
            say(`   ↩ ${p.name}：其实上一次已经传上去了（size/digest 都对），不再重试`);
            break;
          }
          fatal(
            `${p.name}: 重试时发现 release 上已经有一个同名资产（state=${now.state}, size=${now.size}）` +
              `但它和我们要传的不一致。本 job 无权删除，**停止重试** —— 继续重试只会制造更多残骸`,
          );
          break;
        }
        if (attempt === RETRIES) fatal(`${p.name}: ${RETRIES} 次尝试全部失败`);
        else await sleep(3000 * attempt);
      }
    }
  }
  if (problems.length > 0) await die();

  /* ── 交给校验那一步 ── */

  const planJson = {
    generatedAt: new Date().toISOString(),
    repo: REPO,
    tag: TAG,
    releaseId: release.id,
    draft: release.draft,
    prerelease: release.prerelease,
    dryRun: DRY_RUN,
    downloadBase: DOWNLOAD_BASE,
    assets: plan.map((p) => ({ name: p.name, sha256: p.sha256, sizeBytes: p.sizeBytes, action: p.action })),
  };
  await writeFile(join(STAGE, 'RELEASE-UPLOAD-PLAN.json'), `${JSON.stringify(planJson, null, 2)}\n`);

  hdr('4. 结果');
  const nUp = plan.filter((p) => p.action === 'upload').length;
  const nSkip = plan.filter((p) => p.action === 'skip').length;
  say(`   上传 ${nUp} 个 · 跳过（已存在且一致）${nSkip} 个 · 合计 ${plan.length} 个资产`);
  say(`   计划与清单写在 ${STAGE}/{RELEASE-UPLOAD-PLAN.json,SHA256SUMS}`);
  say('');
  say('   ⚠️ 到这里为止，只证明了"我们以为传上去了"。**下一 job 会不带任何凭证重新下一遍**');
  say('      —— 那一步同时证明了：匿名下得到（draft 的附件下不到）、且字节没变。');

  await summary(
    [
      `### release-upload → \`${TAG}\`${DRY_RUN ? '（dry-run）' : ''}`,
      '',
      `- 仓库 \`${REPO}\` · release id \`${release.id}\` · draft=\`${release.draft}\` · prerelease=\`${release.prerelease}\``,
      `- 上传 **${nUp}** 个 · 跳过（已存在且 sha256 一致）**${nSkip}** 个`,
      '',
      '| 资产 | 字节 | sha256 | 处置 |',
      '|---|---:|---|---|',
      ...plan.map((p) => `| \`${p.name}\` | ${p.sizeBytes} | \`${p.sha256}\` | ${p.action} |`),
      '',
    ].join('\n'),
  );
}

await main();
