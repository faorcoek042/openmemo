#!/usr/bin/env node
/**
 * e2e-allcomponents.mjs —— **目录里每一条用户能点「安装」的东西，都要有人真的点过一次。**
 *
 * ## 这条腿为什么存在（用户 2026-08-09 的原话）
 *
 * > **「你有没有测试过每个组件的下载？是不是又偷懒了？」**
 *
 * **答案是"没有"。** `e2e-coldstart` 只装了其中几个（ffmpeg、whisper 引擎、一个 ASR 模型）
 * 就往下走了 —— 而目录里有 **25 个后端包 + 35 个模型变体**，
 * **没有任何一条腿把它们逐个下过一遍**。他问得对。
 *
 * ## 判据分两层，理由是"贵的那一半不该换来覆盖面的缺口"
 *
 * 全量真下是 **39.4 GB**（`[本机实测]` 由清单求和；仅"每组最小变体"也要 20.6 GB）。
 * 而 GitHub runner 的可用磁盘只有十几 GB —— **全下一遍在每次 CI 上做不到**。
 * 但"下不动"不该变成"只测小的"（那等于没测）。所以拆成两层：
 *
 * ### A 层：**每一个组件、每一个镜像**，真发一次带 Range 的请求（每次都跑，无例外）
 *
 * 覆盖 **100%**：25 个包的 14 个文件 + 35 个模型变体的 46 个文件，**含本平台不适用的那些**
 * （URL 可达性与平台无关）。每个镜像都断言：
 *   · HTTP 200/206 真的回来了
 *   · **总长度与清单里的 `sizeBytes` 一致** —— 上游换了文件而清单没跟上，就是在这里露馅
 *   · 头几个字节的**魔数**对得上归档类型（gzip / zip / GGUF / ggml / onnx）
 *
 * 这一层抓的正是用户撞上的那一类：**下载源不可达 / URL 失效 / 文件被换掉**。
 * 它便宜（每个镜像只取 64 KB），所以**没有资格抽样**。
 *
 * ### B 层：**产品自己的完整安装路径**（下载 → 校验 → 解包 → 落位 → 安装记录 → 真的可用）
 *
 *   · **本平台适用的后端包：全部，每次都装。** 体量有界（每平台约 6 个）。
 *   · **模型：按预算挑，且把"这轮抽了谁、漏了谁"逐条打出来。**
 *     `--mode full` 则一个不落（几十 GB，只在手动触发时用）。
 *
 * ## ⚠️ 这条腿**结构上**给不出的保证（必须写在它自己的输出里）
 *
 * **CI 可达 ≠ 用户可达。** GitHub runner 在 GitHub 自己的网络里，
 * `github.com` 对它永远是通的；而用户在中国实测
 * `whispercpp-cpu-win-x64` 是 `0 B / 4.0 MB`、「下载源无法访问 (1/3)」。
 * **所以这条腿很可能全绿，而用户仍然装不上。**
 * 能在 CI 上诚实回答的那一半是**镜像结构**：一个组件如果只有 `github.com` 这一个来源，
 * 那么它在中国就是装不上的 —— 这一条与我从哪儿跑无关，见第 3 节。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const BUNDLE = arg('--bundle', null);
const PORT = Number(arg('--port', '19830'));
const MODE = arg('--mode', 'sample'); // sample | full
const MODEL_BUDGET_MB = Number(arg('--model-budget-mb', '2600'));
const HOST = '127.0.0.1';
const IS_WIN = process.platform === 'win32';

const ROOT = mkdtempSync(join(tmpdir(), 'openmemo-allcomp-'));
const DATA_DIR = join(ROOT, 'data');

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('━'.repeat(96));
  say(`━━ ${s}`);
  say('━'.repeat(96));
};
const mb = (b) => `${(b / 1048576).toFixed(0)}MB`;

const ledger = [];
let exitCode = 0;
let aborted = null;
function judge(name, r, { fatal = true } = {}) {
  ledger.push({ name, ok: r.ok, reason: r.reason, fatal });
  say(`   ${r.ok ? '✔' : '✘'} ${name}：${r.reason}`);
  if (!r.ok && fatal) exitCode = 1;
  return r.ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════════ HTTP（本地 daemon） ═══════════════════ */

let cookie = '';
function localOnce(path, { method = 'GET', body = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        agent: false,
        headers: {
          host: `${HOST}:${PORT}`,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => {
          const raw = Buffer.concat(c);
          const sc = res.headers['set-cookie'];
          if (sc) {
            const m = /om_sid=[^;]+/.exec(sc.join(';'));
            if (m) cookie = m[0];
          }
          let parsed = raw.toString('utf8');
          try {
            parsed = JSON.parse(parsed);
          } catch {
            /* 非 JSON 原样给 */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function local(path, opts = {}) {
  let last;
  for (let i = 0; i < 4; i += 1) {
    try {
      return await localOnce(path, opts);
    } catch (e) {
      if (!['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(e?.code ?? '')) throw e;
      last = e;
      await sleep(300 * (i + 1));
    }
  }
  throw new Error(`${path}: ${last?.message}（重试 4 次后仍失败）`);
}

/* ═══════════════════ A 层：镜像探针 ═══════════════════ */

/**
 * 对一个 URL 发**真实**的 Range 请求，只取前 `want` 字节。
 *
 * 只取头部而不整下：这一层要回答的是「这个来源还在不在、还是不是那个文件」，
 * 而那三件事（可达、总长度、魔数）在头 64 KB 里就能答完。
 * 整下一遍留给 B 层 —— 两层加起来才是完整判据，单独任何一层都不是。
 */
function probeUrl(url, want = 65536, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, reason: `URL 不合法：${url}` });
      return;
    }
    const fn = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = fn(
      {
        host: u.host,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { range: `bytes=0-${want - 1}`, 'user-agent': 'openmemo-e2e-allcomponents' },
        timeout: timeoutMs,
      },
      (res) => {
        // 跟随重定向（GitHub releases → objects CDN；HF → CDN）
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          resolve({ redirect: new URL(res.headers.location, url).href });
          return;
        }
        const chunks = [];
        let got = 0;
        res.on('data', (d) => {
          chunks.push(d);
          got += d.length;
          if (got >= want) req.destroy();
        });
        const done = () => {
          const buf = Buffer.concat(chunks);
          let total = null;
          const cr = res.headers['content-range'];
          if (cr) {
            const m = /\/(\d+)$/.exec(String(cr));
            if (m) total = Number(m[1]);
          } else if (res.headers['content-length'] && res.statusCode === 200) {
            total = Number(res.headers['content-length']);
          }
          resolve({
            ok: res.statusCode === 200 || res.statusCode === 206,
            status: res.statusCode,
            total,
            head: buf,
          });
        };
        res.on('end', done);
        res.on('close', done);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, reason: e.message }));
    req.end();
  });
}
async function probeFollow(url, hops = 5) {
  let cur = url;
  for (let i = 0; i < hops; i += 1) {
    const r = await probeUrl(cur);
    if (r.redirect) {
      cur = r.redirect;
      continue;
    }
    return r;
  }
  return { ok: false, reason: `重定向超过 ${hops} 跳` };
}

/** 归档/权重的魔数。判据是"它还是不是原来那种东西"，不是精确格式解析。 */
function magicOf(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  const b = buf;
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (b.subarray(0, 4).toString('ascii') === 'GGUF') return 'gguf';
  if (b.readUInt32LE(0) === 0x67676d6c) return 'ggml';
  if (b[0] === 0x08 || b[0] === 0x0a) return 'onnx-ish';
  if (b.subarray(0, 5).toString('ascii') === '<?xml' || b[0] === 0x7b) return 'text/json';
  return 'other';
}
const KIND_BY_EXT = (name) =>
  /\.tar\.gz$|\.tgz$/.test(name)
    ? 'gzip'
    : /\.zip$/.test(name)
      ? 'zip'
      : /\.gguf$/.test(name)
        ? 'gguf'
        : /\.bin$/.test(name)
          ? 'ggml'
          : /\.onnx$/.test(name)
            ? 'onnx-ish'
            : 'any';

/* ═══════════════════ daemon ═══════════════════ */

const DAEMON = BUNDLE ? join(BUNDLE, 'app', 'daemon', 'dist', 'main.js') : null;
const NODE_BIN = BUNDLE ? join(BUNDLE, 'runtime', IS_WIN ? 'node.exe' : 'node') : null;
let proc = null;
const bootLog = [];

/** PROTOCOL §11：起服务前先证明端口是空的，否则测到的"通过"可能是别人给的。 */
async function assertPortFree(label) {
  try {
    const r = await localOnce('/api/health', { timeoutMs: 3000 });
    throw new Error(`端口 ${PORT} 上已经有人应答（HTTP ${r.status}）—— ${label} 之前必须是空的`);
  } catch (e) {
    if (/已经有人应答/.test(e.message)) throw e;
  }
}
/** 按 pid 收整棵进程树（§11）。**绝不 `pkill -f`**（含 `-0`）。 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 20_000 });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    /* 已经没了 */
  }
}
async function startDaemon(label) {
  await assertPortFree(label);
  proc = spawn(NODE_BIN, [DAEMON, '--data-dir', DATA_DIR, '--port', String(PORT)], {
    env: {
      ...process.env,
      OPENMEMO_AUTH: 'none',
      OPENMEMO_DATA_DIR: DATA_DIR,
      OPENMEMO_POINTER_FILE: join(ROOT, 'pointer.json'), // §9：绝不写全局指针
      OPENMEMO_WEB_DIST: join(BUNDLE, 'app', 'apps', 'web', 'dist'),
      OPENMEMO_EXT_DIR: join(BUNDLE, 'ext'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN,
  });
  proc.stdout.on('data', (d) => bootLog.push(String(d)));
  proc.stderr.on('data', (d) => bootLog.push(String(d)));
  for (let i = 0; i < 180; i += 1) {
    await sleep(500);
    try {
      const r = await localOnce('/api/health', { timeoutMs: 4000 });
      if (r.status === 200) {
        say(`   [${label}] daemon 起来了（pid=${proc.pid}）`);
        return;
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break;
  }
  throw new Error(`daemon 没起来（exitCode=${proc.exitCode}）`);
}
async function stopDaemon() {
  if (!proc) return;
  killTree(proc.pid);
  for (let i = 0; i < 20 && proc.exitCode === null; i += 1) await sleep(150);
  proc = null;
  await sleep(500);
}

/** 等一个 job 到终态；**认不出就如实报，绝不回退到别的 job**。 */
async function waitJob(jobId, timeoutSec = 3600) {
  for (let i = 0; i < timeoutSec; i += 1) {
    await sleep(1000);
    const r = await local(`/api/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 20_000 });
    const job = r.body?.job ?? r.body;
    if ((job?.jobId ?? job?.uid ?? job?.id) !== jobId) return { state: 'unknown', job };
    if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(job.state)) {
      return { state: job.state, job };
    }
  }
  return { state: 'timeout', job: null };
}

/* ═══════════════════════════ 主流程 ═══════════════════════════ */

if (!BUNDLE) {
  console.error('✘ --bundle <解压后的包目录> 必填');
  process.exit(2);
}

try {
  hdr('0. 这条腿**给不出**什么保证（先说局限，别让绿灯比事实强）');
  say('   ⚠️ **CI 可达 ≠ 用户可达。**');
  say('      GitHub runner 就在 GitHub 自己的网络里，github.com 对它永远是通的；');
  say('      而用户 `[真机实测 2026-08-09，中国网络]` 装 whispercpp-cpu-win-x64 是');
  say('      `0 B / 4.0 MB`、「下载源无法访问 (1/3)」。');
  say('      **所以这条腿很可能全绿，而用户仍然装不上。**');
  say('      能在 CI 上诚实回答的那一半是**镜像结构**（第 3 节）：');
  say('      一个组件只有 github.com 一个来源，它在中国就是装不上的 —— 这一条与我从哪儿跑无关。');

  hdr('1. 全集枚举 —— **来自目录本身**，不是手写清单');
  await startDaemon('cold');
  await local('/api/auth/session', { method: 'POST', body: {} });

  const cat = await local('/api/backends/catalog', { timeoutMs: 90_000 });
  const packs = cat.body?.packs ?? cat.body?.items ?? [];
  const mcat = await local('/api/models/catalog', { timeoutMs: 90_000 });
  const groups = mcat.body?.groups ?? [];
  const variants = groups.flatMap((g) =>
    (g.variants ?? []).map((v) => ({ ...v, role: v.role ?? g.role, groupId: g.groupId })),
  );
  say(`   /api/backends/catalog → **${packs.length}** 个后端包`);
  say(`   /api/models/catalog   → **${groups.length}** 个模型组 / **${variants.length}** 个变体`);

  /*
   * ★ 枚举必须来自目录，且**与清单对得上**。
   *   手写清单会在有人加包时静默漏掉新的那个 —— 而新加的那个正是最需要被测的。
   *   这里再加一道：目录给的数量必须 ≥ 清单里的数量，否则是 API 把谁过滤掉了。
   */
  const manifestDir = join(REPO, 'vendor', 'manifests');
  let manifestPacks = 0;
  const manifestModelIds = [];
  const manifestLlmIds = [];
  for (const f of readdirSync(manifestDir).filter((n) => n.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(manifestDir, f), 'utf8'));
    manifestPacks += (j.packs ?? []).length;
    for (const m of j.models ?? []) {
      if (m.role === 'llm') manifestLlmIds.push(m.id);
      else manifestModelIds.push(m.id);
    }
  }
  /*
   * ★ 判据要**对得上各自的口径**，不能拿总数硬比。
   *
   * `[CI 实测 run 31295033171]` 第一版拿"目录变体数 ≥ 清单模型数"比，结果三平台都红：
   * 目录 30 / 清单 35。追下去差的**恰好是 5 个 `role=llm`** ——
   * `/api/models/catalog` 不列 LLM（它们归 `/api/llm/models` 那条线）。
   * **那是我的断言口径错了，不是产品少了东西** —— 差一点报成一条产品缺陷。
   * 现在按 role 分开比，并把 LLM 那一格单列成覆盖缺口（见下）。
   */
  const catalogIds = new Set(variants.map((v) => v.id));
  const missingFromCatalog = manifestModelIds.filter((id) => !catalogIds.has(id));
  judge('目录枚举与清单对得上（非 llm 那部分；少了就是 API 把谁静默过滤掉了）', {
    ok: packs.length >= manifestPacks && missingFromCatalog.length === 0,
    reason:
      `目录 ${packs.length} 包 / ${variants.length} 变体；` +
      `清单 ${manifestPacks} 包 / ${manifestModelIds.length} 非 llm 模型 + ${manifestLlmIds.length} 个 llm` +
      (missingFromCatalog.length ? `；**目录里没有**：${missingFromCatalog.join(', ')}` : ''),
  });

  /*
   * ★ LLM 那 5 个：`/api/models/catalog` 不列它们，所以**这条腿的 B 层覆盖不到**。
   *   A 层照常逐个探过它们的每一个镜像（URL 可达性与哪个端点列它无关）。
   *   用户能不能从 `/api/llm/models` 那条线把它们装上，我**没有验**。
   */
  const llmProbe = await local('/api/llm/models', { timeoutMs: 30_000 }).catch(() => null);
  say('');
  say(`   ⓘ role=llm 的 ${manifestLlmIds.length} 个变体不在 /api/models/catalog 里：`);
  for (const id of manifestLlmIds) say(`     ${id}`);
  say(
    `     它们归 /api/llm/models（本轮探测 HTTP ${llmProbe?.status ?? '(取不到)'}）——` +
      `**本腿 B 层覆盖不到它们**，A 层已逐个探过镜像。` +
      `用户能否从那条线装上：\`[未验证]\`。`,
  );

  /* ── 2. A 层：每一个组件的每一个镜像，真发一次请求 ── */

  hdr('2. A 层：**每一个组件、每一个镜像**都真发一次 Range 请求（100% 覆盖，不抽样）');
  const manifest = {};
  for (const f of readdirSync(manifestDir).filter((n) => n.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(manifestDir, f), 'utf8'));
    for (const p of j.packs ?? []) manifest[p.id] = { kind: 'pack', files: p.files ?? [] };
    for (const m of j.models ?? []) manifest[m.id] = { kind: 'model', files: m.files ?? [] };
  }

  const compRows = [];
  const ids = Object.keys(manifest);
  say(`   共 ${ids.length} 个组件，逐个逐镜像探测（每个镜像只取 64 KB）…`);
  for (const id of ids) {
    const entry = manifest[id];
    for (const file of entry.files) {
      const mirrors = file.mirrors ?? [];
      const results = [];
      for (const mi of mirrors) {
        const r = await probeFollow(mi.url);
        const host = (() => {
          try {
            return new URL(mi.url).host;
          } catch {
            return '?';
          }
        })();
        const sizeOk = r.ok && file.sizeBytes ? r.total === file.sizeBytes : null;
        const wantKind = KIND_BY_EXT(file.name ?? '');
        const gotKind = r.ok ? magicOf(r.head) : null;
        const kindOk = r.ok && wantKind !== 'any' ? gotKind === wantKind : null;
        results.push({
          host,
          ok: !!r.ok,
          status: r.status,
          total: r.total,
          sizeOk,
          kindOk,
          gotKind,
          reason: r.reason,
        });
      }
      compRows.push({
        id,
        kind: entry.kind,
        file: file.name,
        sizeBytes: file.sizeBytes,
        mirrors: results,
      });
    }
  }

  let reachableAll = 0;
  const noMirror = [];
  const sizeMismatch = [];
  const kindMismatch = [];
  const githubOnly = [];
  for (const row of compRows) {
    const okMirrors = row.mirrors.filter((m) => m.ok);
    if (okMirrors.length === 0) noMirror.push(row);
    else reachableAll += 1;
    for (const m of okMirrors) {
      if (m.sizeOk === false) sizeMismatch.push({ row, m });
      if (m.kindOk === false) kindMismatch.push({ row, m });
    }
    const hosts = new Set(row.mirrors.map((m) => m.host));
    if ([...hosts].every((h) => /github(usercontent)?\.com$/.test(h))) githubOnly.push(row);
  }

  say('');
  say(`   ── 结果：${compRows.length} 个文件，${reachableAll} 个至少有一个镜像可达 ──`);
  for (const row of compRows.slice(0, 200)) {
    const s = row.mirrors
      .map((m) => `${m.host}${m.ok ? '' : `(✘${m.status ?? m.reason ?? ''})`}`)
      .join(' ');
    say(
      `   ${row.ok === false ? '✘' : ' '} ${String(row.id).padEnd(34)} ${String(row.file).slice(0, 30).padEnd(31)} ${s}`,
    );
  }

  judge('★ 每一个组件至少有一个镜像真的可达（下载源不可达 = 用户装不上）', {
    ok: noMirror.length === 0,
    reason:
      noMirror.length === 0
        ? `${compRows.length} 个文件全部至少一个镜像可达`
        : `${noMirror.length} 个文件**一个镜像都不可达**：${noMirror.map((r) => `${r.id}/${r.file}`).join(', ')}`,
  });
  judge('★ 可达镜像的总长度与清单里的 sizeBytes 一致（上游换了文件就在这里露馅）', {
    ok: sizeMismatch.length === 0,
    reason:
      sizeMismatch.length === 0
        ? '全部一致'
        : sizeMismatch
            .map((x) => `${x.row.id}/${x.row.file}: 清单 ${x.row.sizeBytes} 实得 ${x.m.total}`)
            .join('；'),
  });
  judge('★ 取回的头部魔数与归档类型对得上', {
    ok: kindMismatch.length === 0,
    reason:
      kindMismatch.length === 0
        ? '全部对得上'
        : kindMismatch.map((x) => `${x.row.id}/${x.row.file}: 实得 ${x.m.gotKind}`).join('；'),
  });

  /* ── 3. 镜像结构：用户装不上的那一半，CI 上唯一能诚实回答的部分 ── */

  hdr('3. ★ 镜像结构 —— 「CI 可达 ≠ 用户可达」里，CI 能诚实回答的那一半');
  say('   判据与我从哪儿跑无关：**一个组件如果只有 github.com 一个来源，它在中国就是装不上的。**');
  say(`   只有 github 系来源的文件：**${githubOnly.length} / ${compRows.length}**`);
  for (const r of githubOnly) say(`     ${String(r.id).padEnd(34)} ${r.file}`);
  judge('★ 每个组件都至少有一个非 github 的镜像（否则中国用户装不上）', {
    ok: githubOnly.length === 0,
    reason:
      githubOnly.length === 0
        ? '全部组件都有备用来源'
        : `**${githubOnly.length} 个文件只有 github 一个来源** —— 用户 2026-08-09 在中国实测撞的就是这一类` +
          `（whispercpp-cpu-win-x64：0 B / 4.0 MB、下载源无法访问）。模型那边早就挂了 hf-mirror / ModelScope，` +
          `后端包这边一条都没有。**有人在修，这条腿如实报出来。**`,
  });

  /* ── 4. B 层：产品自己的完整安装路径 ── */

  hdr('4. B 层：走产品自己的安装路径真装（下载 → 校验 → 解包 → 落位 → 记录 → 可用）');
  const applicable = packs.filter((p) => p.applicable === true);
  const notApplicable = packs.filter((p) => p.applicable !== true);
  say(`   后端包：适用 ${applicable.length} 个、**本平台不适用 ${notApplicable.length} 个**`);
  say('   ── 不适用的逐个列出（"不适用"是正常，不是失败；但必须看得见是哪些、为什么）──');
  for (const p of notApplicable) {
    say(
      `     ${String(p.id).padEnd(34)} ${String(
        p.reasonZh ?? p.reason ?? p.applicableReason ?? '(目录没给理由)',
      )
        .replace(/\s+/g, ' ')
        .slice(0, 70)}`,
    );
  }

  const packResults = [];
  for (const p of applicable) {
    const t0 = Date.now();
    const r = await local('/api/backends/install', {
      method: 'POST',
      body: { id: p.id },
      timeoutMs: 60_000,
    });
    const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    const st = jobId ? await waitJob(jobId) : { state: `HTTP ${r.status}`, job: null };
    packResults.push({
      id: p.id,
      state: st.state,
      secs: ((Date.now() - t0) / 1000).toFixed(1),
      err: st.job?.error,
    });
    say(
      `   ${String(p.id).padEnd(34)} ${String(st.state).padEnd(10)} ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    if (st.state !== 'succeeded' && st.job?.error) {
      say(`      error: ${JSON.stringify(st.job.error).slice(0, 300)}`);
    }
  }
  const inst = await local('/api/backends/installed');
  const instArr = Array.isArray(inst.body)
    ? inst.body
    : (inst.body?.packs ?? inst.body?.installed ?? []);
  const instIds = new Set(instArr.map((x) => x.id ?? x.packId));
  const packFailed = applicable.filter((p) => !instIds.has(p.id));
  judge('★ 本平台适用的后端包**全部**装上了（地面真相：已安装列表，不信 job 自述）', {
    ok: packFailed.length === 0,
    reason:
      packFailed.length === 0
        ? `${applicable.length}/${applicable.length} 个：${applicable.map((p) => p.id).join(', ')}`
        : `${packFailed.length} 个没装上：${packFailed.map((p) => p.id).join(', ')}`,
  });

  /* ── 5. 模型：预算内挑，且把抽了谁/漏了谁逐条打出来 ── */

  hdr('5. 模型：全量 39.4 GB —— 说清这轮抽了谁、**漏了谁**');
  const sizeOf = (v) => (v.files ?? []).reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
  const sorted = [...variants]
    .map((v) => ({ v, bytes: sizeOf(v) }))
    .sort((a, b) => a.bytes - b.bytes);
  const picked = [];
  const skipped = [];
  if (MODE === 'full') {
    for (const x of sorted) picked.push(x);
  } else {
    /*
     * ★ 抽样规则**写死且可复现**：先保证**每个 role 至少一个**（否则某类落位逻辑
     *   一次都走不到），再在预算内按从小到大补满。
     *   规则打印出来，漏掉的也逐条打印 —— "抽样"不许变成"没测的那些看不见"。
     */
    const budget = MODEL_BUDGET_MB * 1048576;
    let used = 0;
    const roleSeen = new Set();
    for (const x of sorted) {
      const role = x.v.role ?? '?';
      if (!roleSeen.has(role) && used + x.bytes <= budget) {
        picked.push(x);
        used += x.bytes;
        roleSeen.add(role);
      }
    }
    for (const x of sorted) {
      if (picked.includes(x)) continue;
      if (used + x.bytes <= budget) {
        picked.push(x);
        used += x.bytes;
      } else skipped.push(x);
    }
  }
  say(`   模式 ${MODE}${MODE === 'sample' ? `（预算 ${MODEL_BUDGET_MB} MB）` : '（全量）'}`);
  say(`   ── 这一轮**要下**的 ${picked.length} 个 ──`);
  for (const x of picked)
    say(`     ${String(x.v.id).padEnd(36)} ${String(x.v.role).padEnd(12)} ${mb(x.bytes)}`);
  say(`   ── 这一轮**没下**的 ${skipped.length} 个（A 层已逐个探过它们的每一个镜像）──`);
  for (const x of skipped)
    say(`     ${String(x.v.id).padEnd(36)} ${String(x.v.role).padEnd(12)} ${mb(x.bytes)}`);

  const modelResults = [];
  for (const x of picked) {
    const t0 = Date.now();
    const r = await local('/api/models/pull', {
      method: 'POST',
      body: { id: x.v.id },
      timeoutMs: 60_000,
    });
    const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    const st = jobId ? await waitJob(jobId) : { state: `HTTP ${r.status}`, job: null };
    modelResults.push({
      id: x.v.id,
      state: st.state,
      secs: ((Date.now() - t0) / 1000).toFixed(1),
      err: st.job?.error,
    });
    say(
      `   ${String(x.v.id).padEnd(36)} ${String(st.state).padEnd(10)} ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    if (st.state !== 'succeeded' && st.job?.error) {
      say(`      error: ${JSON.stringify(st.job.error).slice(0, 300)}`);
    }
  }
  const minst = await local('/api/models/installed');
  const minstArr = Array.isArray(minst.body)
    ? minst.body
    : (minst.body?.models ?? minst.body?.installed ?? []);
  const minstIds = new Set(minstArr.map((m) => m.id ?? m.modelId));
  const modelFailed = picked.filter((x) => !minstIds.has(x.v.id));
  judge('★ 这一轮挑中的模型**全部**装上了（地面真相：已安装列表）', {
    ok: modelFailed.length === 0,
    reason:
      modelFailed.length === 0
        ? `${picked.length}/${picked.length} 个`
        : `${modelFailed.length} 个没装上：${modelFailed.map((x) => x.v.id).join(', ')}`,
  });

  /* ── 6. 装完真的可用（不是"记录里有" ── */

  hdr('6. 装完之后**真的可用** —— 不是"安装记录里有它"');
  await stopDaemon();
  await startDaemon('warm');
  await local('/api/auth/session', { method: 'POST', body: {} });
  const h = await local('/api/health');
  const missing = h.body?.pipeline?.missing ?? [];
  say(`   pipeline.missing = ${JSON.stringify(missing)}`);
  const sc = await local('/api/selfcheck', { timeoutMs: 120_000 });
  const checks = sc.body?.checks ?? sc.body?.results ?? [];
  const toolChecks = checks.filter((c) => String(c.id).startsWith('tool.'));
  for (const c of toolChecks) {
    say(
      `   ${String(c.id).padEnd(22)} ${String(c.status).padEnd(6)} ${String(c.detail ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 70)}`,
    );
  }
  judge('★ 装完之后流水线缺件清单里不再有刚装的那些工具', {
    ok:
      !missing.includes('ffmpeg') &&
      !missing.includes('ffprobe') &&
      !missing.includes('whisper-cli'),
    reason: `pipeline.missing = ${JSON.stringify(missing)}`,
  });
  const badTools = toolChecks.filter((c) => c.status === 'fail');
  judge('★ 自检里 tool.* 没有 fail（装上了 ≠ 能用）', {
    ok: badTools.length === 0,
    reason:
      badTools.length === 0
        ? `${toolChecks.length} 项 tool.* 全部非 fail`
        : badTools.map((c) => `${c.id}: ${String(c.detail ?? '').slice(0, 80)}`).join('；'),
  });
} catch (e) {
  aborted = e.message;
  say('');
  say(`✘ e2e-allcomponents 中断：${e.message}`);
  if (bootLog.length) {
    say('   daemon 最后 40 行：');
    say(
      bootLog
        .join('')
        .split('\n')
        .slice(-40)
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
  exitCode = 1;
} finally {
  await stopDaemon();
  hdr('结论台账');
  for (const e of ledger) {
    say(`   ${e.ok === null ? 'ⓘ' : e.ok ? '✔' : '✘'} ${e.name}`);
    say(`      ${String(e.reason).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const red = ledger.filter((x) => x.ok === false && x.fatal);
  say('');
  if (aborted) {
    say(`✘ 整条腿被异常打断：${aborted}`);
    say(
      `   打断之前成立 ${ledger.filter((x) => x.ok === true).length} 条、不成立 ${red.length} 条，**其余没有跑到**（不是通过）。`,
    );
  } else if (red.length === 0) {
    say(`✔ ${ledger.filter((x) => x.ok === true).length} 条关键断言全部成立`);
  } else {
    say(`✘ ${red.length} 条不成立：${red.map((x) => x.name).join('；')}`);
  }
  say('');
  say('   ⚠️ 重申局限：**CI 可达 ≠ 用户可达。** 这条腿全绿也不代表中国网络下装得上；');
  say('      能代表的那一半是第 3 节的镜像结构。');
  // 几 GB 的下载留在 runner 上没意义，跑完自己清（Manager 2026-08-09 要求）
  try {
    rmSync(ROOT, { recursive: true, force: true });
    say(`   已清理临时目录 ${ROOT}`);
  } catch (e) {
    say(`   ⚠️ 清理 ${ROOT} 失败：${e.message}`);
  }
}

process.exit(exitCode);
