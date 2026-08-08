#!/usr/bin/env node
/**
 * dependency-audit.mjs — 「这些依赖到底是不是现场下载的？」
 *
 * ## 为什么有这个脚本
 *
 * 用户原话：「鉴于之前经历，我怕了你，再检查下是不是都是现场下载的各个依赖？」
 * 他的担心有实据 —— 这台开发机上至少四次"能跑"靠的是历史沉积
 * （搬迁前留下的 .so 链、机器级指针文件、别人刚构建的 `apps/web/dist`、
 * 本机恰好只装了 node 24）。
 *
 * ★ **所以这个脚本的结论只在干净 runner 上才算数。**
 *   在开发机上跑它，得到的仍然是"这台机器怎么样"，而那正是不该信的那台。
 *
 * ## 三个问题，每个组件都要回答
 *
 *   1. 从哪个 URL 下载？          → 静态可答（manifest），`--live` 再拿真实 HTTP 响应
 *   2. 版本/tag 钉死了吗？        → 看 URL 里有没有可变引用（latest / master / main / HEAD）
 *   3. 有没有 sha256 校验？        → 看 manifest；`--verify` 真下载小文件重算比对
 *
 * ## 用法
 *
 *   node scripts/ci/dependency-audit.mjs                # 只做静态审计（离线）
 *   node scripts/ci/dependency-audit.mjs --live         # 每个 URL 发一次真实请求
 *   node scripts/ci/dependency-audit.mjs --live --verify-under 8   # 并下载 <8MB 的重算 sha256
 *
 * 退出码：静态审计发现"没有 sha256"或"引用可变"时 exit 1。`--live` 的网络失败**不**改变
 * 退出码（网络抖动不该变成门禁红），但会在报告里明确标出。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const VERIFY_UNDER_MB = (() => {
  const i = args.indexOf('--verify-under');
  return i >= 0 ? Number(args[i + 1]) : 0;
})();

/** URL 里出现这些片段 = 引用的是**会变的东西**，今天下到的和明天下到的可能不同。 */
const MUTABLE_REF = /\/(latest|master|main|HEAD|download\/latest)(\/|$)/i;

const rows = [];
const notes = [];

/* ───────────────────────────── 1. manifest 里的每一个文件 ───────────────────────── */

const MANIFESTS = readdirSync(join(REPO, 'vendor', 'manifests')).filter((f) => f.endsWith('.json'));

for (const file of MANIFESTS) {
  const raw = JSON.parse(readFileSync(join(REPO, 'vendor', 'manifests', file), 'utf8'));
  const entries = raw.packs ?? raw.models ?? raw.components ?? raw.providers ?? [];
  if (!Array.isArray(entries)) continue;

  for (const entry of entries) {
    const files = entry.files ?? [];
    if (files.length === 0) {
      // components.json 是"来源与许可证"的说明性清单，本来就没有 files —— 不算缺陷。
      if (file !== 'components.json' && file !== 'llm-providers.json') {
        rows.push({
          manifest: file,
          id: entry.id ?? '(no id)',
          name: '(no files[])',
          url: '',
          host: '',
          pinned: null,
          sha256: null,
          sizeBytes: null,
        });
      }
      continue;
    }
    for (const f of files) {
      const url = f.mirrors?.[0]?.url ?? f.url ?? '';
      let host;
      try {
        host = url ? new URL(url).host : '';
      } catch {
        host = '(unparseable)';
      }
      rows.push({
        manifest: file,
        id: entry.id ?? '(no id)',
        name: f.name ?? '(unnamed)',
        url,
        host,
        pinned: url ? !MUTABLE_REF.test(url) : null,
        sha256: typeof f.sha256 === 'string' && f.sha256.length === 64 ? f.sha256 : null,
        sizeBytes: typeof f.sizeBytes === 'number' ? f.sizeBytes : null,
      });
    }
  }
}

/* ───────────────────────────── 2. git submodule 的钉法 ─────────────────────────── */

const submodules = [];
try {
  const out = execFileSync('git', ['submodule', 'status'], { cwd: REPO, encoding: 'utf8' });
  for (const line of out.split('\n').filter(Boolean)) {
    // ` <sha> <path> (<describe>)`
    const m = /^[\s+-U]*([0-9a-f]{40})\s+(\S+)(?:\s+\((.*)\))?/.exec(line);
    if (m)
      submodules.push({
        sha: m[1],
        path: m[2],
        describe: m[3] ?? '(no tag — NOT pinned to a tag)',
      });
  }
} catch (e) {
  notes.push(`git submodule status 跑不了：${e.message}`);
}
let gitmodulesUrls = [];
try {
  const gm = readFileSync(join(REPO, '.gitmodules'), 'utf8');
  gitmodulesUrls = [...gm.matchAll(/\[submodule "([^"]+)"\][\s\S]*?url\s*=\s*(\S+)/g)].map((m) => ({
    path: m[1],
    url: m[2],
  }));
} catch {
  /* 没有 .gitmodules 也可以 */
}

/* ─────────────────── 3. npm 侧：哪些包在 install 期下载二进制 ───────────────────── */

let onlyBuilt = [];
try {
  const ws = readFileSync(join(REPO, 'pnpm-workspace.yaml'), 'utf8');
  /*
   * ★ T-145 自陈：这一段第一版是一条正则
   *     /onlyBuiltDependencies:\s*\n((?:\s*-\s*\S+\n?)+)/
   *   它要求列表项**连续**，而实际文件里每一项前面都有一行 `# 原因` 注释，
   *   于是它匹配到 0 项，脚本**面不改色地打印「onlyBuiltDependencies: (空)」**。
   *   我差一点就把"pnpm install 期不下载任何二进制"当成结论报上去 ——
   *   而真实答案是 4 个包，其中两个（ffmpeg-static / youtube-dl-exec）
   *   **明确就是去下载二进制的**。
   *   这正是本任务在查的那个形状：**一个工具安静地返回空，被读成了"没有"。**
   *   → 改成逐行解析，并在下面加一条 sanity 断言：解析出 0 项就报错，不许静默。
   */
  const lines = ws.split('\n');
  const start = lines.findIndex((l) => /^onlyBuiltDependencies:/.test(l));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\S/.test(l)) break; // 回到顶层键，块结束
      const m = /^\s*-\s*['"]?([^'"\s#]+)['"]?/.exec(l);
      if (m) onlyBuilt.push(m[1]);
    }
    if (onlyBuilt.length === 0) {
      notes.push(
        '⚠️ 找到了 onlyBuiltDependencies 这个键，却解析出 0 项 —— 解析器可能坏了，不要读成"没有"',
      );
    }
  } else {
    notes.push('pnpm-workspace.yaml 里没有 onlyBuiltDependencies 键');
  }
} catch (e) {
  notes.push(`读不到 pnpm-workspace.yaml：${e.message}`);
}

/* ─────────────── 4. 仓库里有没有被提交进来的二进制（用户点名要确认） ─────────────── */

let biggestTracked = [];
try {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const BINARY_EXT =
    /\.(so|dylib|dll|exe|a|lib|o|node|wasm|bin|gguf|onnx|tar|tgz|gz|xz|zip|7z|dmg|pkg|msi|jar|pyd)$/i;
  const sized = [];
  for (const f of files) {
    try {
      const st = statSync(join(REPO, f));
      sized.push({ f, size: st.size, suspicious: BINARY_EXT.test(f) });
    } catch {
      /* submodule 目录之类，跳过 */
    }
  }
  sized.sort((a, b) => b.size - a.size);
  biggestTracked = sized.slice(0, 15);
  const bins = sized.filter((x) => x.suspicious);
  if (bins.length > 0) {
    notes.push(
      `⚠️ 疑似被提交进仓库的二进制 ${bins.length} 个：${bins
        .slice(0, 10)
        .map((b) => `${b.f}(${b.size}B)`)
        .join(', ')}`,
    );
  }
} catch (e) {
  notes.push(`git ls-files 跑不了：${e.message}`);
}

/* ─────────────────────────── 5. --live：真实 HTTP 响应 ──────────────────────────── */

async function probe(url) {
  // 用 Range 只取第一个字节：既能证明 URL 活着、又不下载整个大文件。
  // 有些 CDN 不认 HEAD，Range GET 更可靠。
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    return {
      status: res.status,
      finalHost: new URL(res.url).host,
      contentRange: res.headers.get('content-range') ?? '',
      contentLength: res.headers.get('content-length') ?? '',
    };
  } catch (e) {
    return { status: 0, error: String(e.message ?? e) };
  }
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

if (LIVE) {
  const withUrl = rows.filter((r) => r.url);
  // 同一个 URL 只探一次
  const uniq = [...new Map(withUrl.map((r) => [r.url, r])).values()];
  const CONC = 6;
  let i = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= uniq.length) return;
        uniq[idx].live = await probe(uniq[idx].url);
      }
    }),
  );
  const liveByUrl = new Map(uniq.map((r) => [r.url, r.live]));
  for (const r of withUrl) r.live = liveByUrl.get(r.url);

  if (VERIFY_UNDER_MB > 0) {
    const cap = VERIFY_UNDER_MB * 1024 * 1024;
    const small = uniq.filter(
      (r) => r.sha256 && r.sizeBytes && r.sizeBytes <= cap && r.live?.status && r.live.status < 400,
    );
    for (const r of small) {
      try {
        const got = await download(r.url);
        r.verify =
          got.sha256 === r.sha256
            ? `MATCH (${got.bytes}B)`
            : `MISMATCH got=${got.sha256.slice(0, 16)}…`;
      } catch (e) {
        r.verify = `download failed: ${e.message}`;
      }
    }
    const verifiedByUrl = new Map(uniq.filter((r) => r.verify).map((r) => [r.url, r.verify]));
    for (const r of withUrl) if (verifiedByUrl.has(r.url)) r.verify = verifiedByUrl.get(r.url);
  }
}

/* ─────────────────────────────────── 报告 ──────────────────────────────────────── */

const line = (s = '') => console.log(s);
line();
line('='.repeat(100));
line(
  `依赖来源审计  |  host=${process.platform}/${process.arch}  node=${process.version}  live=${LIVE}`,
);
line('='.repeat(100));

line();
line('── ① manifest 声明的每一个下载文件 ────────────────────────────────────────────');
line();
const byManifest = new Map();
for (const r of rows) {
  if (!byManifest.has(r.manifest)) byManifest.set(r.manifest, []);
  byManifest.get(r.manifest).push(r);
}
for (const [mf, list] of byManifest) {
  const withUrl = list.filter((r) => r.url);
  const noSha = list.filter((r) => r.url && !r.sha256);
  const mutable = list.filter((r) => r.pinned === false);
  line(`${mf}`);
  line(
    `   条目 ${list.length}  |  有 URL ${withUrl.length}  |  有 sha256 ${withUrl.length - noSha.length}/${withUrl.length}  |  引用可变 ${mutable.length}`,
  );
  const hosts = [...new Set(withUrl.map((r) => r.host))].sort();
  if (hosts.length) line(`   host: ${hosts.join(', ')}`);
  if (noSha.length) line(`   ⚠️ 没有 sha256: ${noSha.map((r) => `${r.id}/${r.name}`).join(', ')}`);
  if (mutable.length) line(`   ⚠️ 可变引用: ${mutable.map((r) => `${r.id}/${r.name}`).join(', ')}`);
  line();
}

if (LIVE) {
  line('── ② 真实 HTTP 响应（干净 runner 发出，这一节才是"现场下载"的证据）──────────');
  line();
  const withUrl = rows.filter((r) => r.url);
  const uniqUrls = [...new Map(withUrl.map((r) => [r.url, r])).values()];
  const ok = uniqUrls.filter((r) => r.live?.status && r.live.status < 400);
  const bad = uniqUrls.filter((r) => !(r.live?.status && r.live.status < 400));
  line(`   唯一 URL ${uniqUrls.length}  |  可达 ${ok.length}  |  不可达 ${bad.length}`);
  line();
  for (const r of uniqUrls) {
    const l = r.live ?? {};
    const st = l.status ? String(l.status) : `ERR ${l.error ?? ''}`;
    line(
      `   ${st.padEnd(6)} ${(l.contentRange || l.contentLength || '').padEnd(22)} ${r.verify ? `sha256 ${r.verify}`.padEnd(26) : ''.padEnd(26)} ${r.id}/${r.name}`,
    );
    line(`          ${r.url}`);
  }
  line();
}

line('── ③ git submodule（A 类依赖：源码进构建树）──────────────────────────────────');
line();
for (const s of submodules) {
  const url = gitmodulesUrls.find((g) => g.path === s.path)?.url ?? '(未在 .gitmodules 找到 url)';
  line(`   ${s.path.padEnd(24)} ${s.describe.padEnd(12)} ${s.sha.slice(0, 12)}  ${url}`);
}
line();

line('── ④ pnpm install 期会跑 postinstall / 下载二进制的包 ─────────────────────────');
line();
line(`   onlyBuiltDependencies: ${onlyBuilt.length ? onlyBuilt.join(', ') : '(空)'}`);
line('   ⚠️ 这些包的下载**不受本仓 manifest 的 sha256 约束**，走的是各自 npm 包的逻辑。');
line();

line('── ⑤ 仓库里被跟踪的最大文件（确认没有二进制被提交进来）──────────────────────');
line();
for (const b of biggestTracked) {
  line(`   ${String(b.size).padStart(9)}B  ${b.suspicious ? '⚠️ ' : '   '}${b.f}`);
}
line();

if (notes.length) {
  line('── 注记 ──────────────────────────────────────────────────────────────────────');
  for (const n of notes) line(`   ${n}`);
  line();
}

/* ─────────────────────────────── 门禁判定 ──────────────────────────────────────── */

const problems = [];
const urlRows = rows.filter((r) => r.url);
const noSha = urlRows.filter((r) => !r.sha256);
const mutable = urlRows.filter((r) => r.pinned === false);
if (noSha.length) problems.push(`${noSha.length} 个下载文件没有 sha256`);
if (mutable.length)
  problems.push(`${mutable.length} 个 URL 引用了可变的 ref（latest/master/main/HEAD）`);
if (LIVE) {
  const mismatch = urlRows.filter(
    (r) => typeof r.verify === 'string' && r.verify.startsWith('MISMATCH'),
  );
  if (mismatch.length) problems.push(`${mismatch.length} 个文件的 sha256 与上游实际内容**不一致**`);
}

if (problems.length) {
  console.error(`✘ dependency-audit: ${problems.join('；')}`);
  process.exit(1);
}
console.log(`✔ dependency-audit: ${urlRows.length} 个下载文件全部带 sha256、全部钉死引用`);
