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
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import BASELINE from './single-source-baseline.json' with { type: 'json' };
import { assertPortFree, killTree } from './launcher-spawn.mjs';
import {
  classifyProbeRows,
  driftedPacks,
  isSingleSource,
  ratchetSingleSource,
  kindByExt as KIND_BY_EXT,
  magicOf,
  tagOf,
} from './e2e-allcomponents-assertions.mjs';

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
/**
 * ★ 覆盖面上报：把本轮**没能被评估**的断言条数落盘，供 attest 作业归并后传给
 * `emit-e2e-attestation.mjs --undecided`。文件形状 `{ unknowns: N }` 与另外三条腿
 * 逐字相同，好共用 `sum-undecided.mjs`。
 *
 * ⚠️ 但**归并口径不同**：那三条腿用 `--reduce sum`（每个平台各自独立的未决），
 *    这条腿用 `--reduce agree`（三格是同一件事的三次观察）。理由见下面
 *    `llmGapIds` 那一段，以及 `e2e-allcomponents.yml` attest 作业里的论证。
 */
const UNDECIDED_OUT = arg('--undecided-out', null);
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
/**
 * ★ 本腿**唯一**的真·未决：`role=llm` 那几个变体，B 层结构上够不着。
 *
 * `/api/models/catalog` 不列 role=llm（它们归 `/api/llm/models` 那条线），
 * 而本腿的 B 层"真装一遍"是**从目录枚举出来的**——所以那几个变体
 * **一次都没被装过，用户能否装上这条腿说不出话**。脚本第 1 节早就把这句话
 * 用 `[未验证]` 写在日志里了，但它此前**只活在日志里**：凭证的 `undecided`
 * 一格是 null，闸门读出来是"这条腿没上报覆盖面"。
 *
 * `null` 是 `[未验证]` 这件事本身没被上报；把它变成一个真数出来的数，
 * 闸门才会替我们把这句话念出来。
 *
 * ⚠️ 保持为 `null` 直到真的数出来为止 —— 中断在数出来之前时**不写文件**，
 *    下游 `sum-undecided.mjs` 会因为缺一格如实收敛成 null。
 *    写一个 `0` 才是撒谎（"查过了，一条未决都没有"）。
 */
let llmGapIds = null;
/**
 * 记一条**被评估过**的断言。本腿是**两态**的：`r.ok` 只有 true/false。
 * 「前提构造不出来」一律主动判 FAIL（典型：第 8 节挑不出可做失败样本的小包时，
 * reason 直接写「**没跑** ——（不是跳过，是到不了）」）。
 * ⚠️ 别往这里塞第三态：汇总段有一条会红的守卫盯着（搜 `TWO_STATE`）。
 */
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

/* ═══════════════════ daemon ═══════════════════ */

const DAEMON = BUNDLE ? join(BUNDLE, 'app', 'daemon', 'dist', 'main.js') : null;
const NODE_BIN = BUNDLE ? join(BUNDLE, 'runtime', IS_WIN ? 'node.exe' : 'node') : null;
let proc = null;
const bootLog = [];

/*
 * `assertPortFree` / `killTree` 此前在这里各有一份本地拷贝，现改用
 * `launcher-spawn.mjs` 的共享实现（Manager 2026-08-09 裁决 R-2 / R-3）。
 *
 * 本地那份 `assertPortFree` 属于"只问 HTTP"那一类 —— `[实测]` 它**看不见**
 * 「bind 住端口但不答 HTTP」的占用者（残留进程正在关闭时就是这个样子），
 * 会判成"端口是空的"然后继续跑。判据与理由见共享实现的文件内注释。
 */
async function startDaemon(label, extraEnv = {}, dataDir = DATA_DIR) {
  await assertPortFree(PORT, { label });
  proc = spawn(NODE_BIN, [DAEMON, '--data-dir', dataDir, '--port', String(PORT)], {
    env: {
      ...process.env,
      OPENMEMO_AUTH: 'none',
      OPENMEMO_DATA_DIR: dataDir,
      OPENMEMO_POINTER_FILE: join(ROOT, 'pointer.json'), // §9：绝不写全局指针
      OPENMEMO_WEB_DIST: join(BUNDLE, 'app', 'apps', 'web', 'dist'),
      OPENMEMO_EXT_DIR: join(BUNDLE, 'ext'),
      ...extraEnv,
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
  /*
   * ★★ 清单**必须读包里那一份**，不是这棵 checkout 的。
   *
   * `[CI 实测 run 31295507733]` 第一版读的是 checkout 的清单，于是同一轮里出现了
   * 自相矛盾的两句话：
   *     A 层  whispercpp-cpu-linux-x64 → **206**，长度与清单逐字节一致
   *     B 层  whispercpp-cpu-linux-x64 → **NOT_FOUND**，1.0 秒失败
   * 我当时把真因记成 UNKNOWN。**真因是这两层读的根本不是同一份清单。**
   *
   * 时间线（已核实）：
   *   99995b8 01:00  打包 → 包内清单里 whispercpp 指向 **v0.3.0**
   *   ddccef4 03:58  目录重指 **v0.4.0**（比打包晚约 3 小时）
   *   随后          **v0.3.0 release 被删除**
   * → 包内那份指向一个**已经不存在的 release**：`curl` 实测 v0.3.0 是 **404**、v0.4.0 是 206。
   * 只有 whispercpp 一族中招，因为只有它托管在我们自己的 release 上
   * （media-tools/ytdlp 指上游 BtbN、libsimple/sqlite-vec 也指上游）。
   *
   * **用户手里的包用的就是包内那一份** —— 所以判据也只能是它。
   * checkout 那份仍然读，但只用来做"包内与当前目录是否已经漂开"的比对（见下）。
   */
  const bundleManifestDir = join(BUNDLE, 'vendor', 'manifests');
  const manifestDir = existsSync(bundleManifestDir)
    ? bundleManifestDir
    : join(REPO, 'vendor', 'manifests');
  say(
    `   清单来源：${manifestDir === bundleManifestDir ? '**包内**（用户实际用的那一份）' : `包内没有，退回 checkout：${manifestDir}`}`,
  );
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
  /*
   * ★ 就在这里把这句 `[未验证]` **数出来**，而不是让它只活在日志里。
   *   这是本腿唯一进 `undecided` 的东西 —— 抽样跳过的那些模型**不算**，
   *   理由见 yml 里 attest 那一段（一句话：它们是样本更小，不是判据没跑，
   *   而且 `mode=sample` 已经在替它们说话，再报一遍只会稀释这个数）。
   */
  llmGapIds = [...manifestLlmIds];

  /*
   * ★ 包内清单 vs 当前 checkout 的清单：**漂开了就当场点名**。
   *
   * 这一条是本轮那个 bug 的**一句话诊断**。没有它的时候，我从"A 层 206 / B 层 404"
   * 一路追了很久才找到"两层读的不是同一份清单"。有了它，输出直接就是：
   *   whispercpp-cpu-linux-x64: 包内 v0.3.0 → 目录 v0.4.0
   *
   * 判据只提"用户会不会因此装不上"，所以**漂开本身只是警告**（新包总会比旧包新），
   * **真正判红的是 A 层"包内那个 URL 到底还活着没有"**。
   * 两者合起来才说得清：漂开 + 旧 URL 已死 = 用户手里那个包永久装不上。
   */
  const checkoutDir = join(REPO, 'vendor', 'manifests');
  if (manifestDir !== checkoutDir && existsSync(checkoutDir)) {
    const urlsOf = (dir) => {
      const out = {};
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        for (const p of j.packs ?? []) {
          const a = (p.files ?? []).find((x) => x.role === 'archive') ?? (p.files ?? [])[0];
          if (a?.mirrors?.[0]?.url) out[p.id] = a.mirrors[0].url;
        }
      }
      return out;
    };
    const inBundle = urlsOf(manifestDir);
    const inCheckout = urlsOf(checkoutDir);
    const drifted = driftedPacks(inBundle, inCheckout);
    say('');
    if (drifted.length === 0) {
      say('   ⓘ 包内清单与当前 checkout 一致（没有漂开）');
    } else {
      say(
        `   ⚠️ **包内清单与当前 checkout 已漂开 ${drifted.length} 项**（旧包 + 目录已更新 = 正常，但要看旧 URL 还活着没有）：`,
      );
      for (const d of drifted) {
        say(`     ${String(d.id).padEnd(32)} 包内 ${tagOf(d.bundle)} → 目录 ${tagOf(d.checkout)}`);
      }
    }
  }

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

  /*
   * 分类走 `e2e-allcomponents-assertions.mjs` 的纯函数 —— 那份有变异证明
   * （`selftest-e2e-allcomponents.mjs`，含"空集不许报全都好"的前提自检）。
   * 内联一份看起来更省事，但那份**没有人喂过它坏数据**，
   * 而我上一轮正是差点把一条自己写错的判据报成产品缺陷。
   */
  const cls = classifyProbeRows(compRows);
  if (!cls.ok) {
    judge('A 层分类的前提成立（探到了东西）', { ok: false, reason: cls.reason });
  }
  const { noMirror, sizeMismatch, kindMismatch } = cls;
  const reachableAll = compRows.length - noMirror.length;

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

  hdr('3. 来源结构 —— **已知且已接受的状态**，看得见但不该红');
  /*
   * ★★ 这一节的判据在 2026-08-09 被用户裁决改过，改动本身值得记下来。
   *
   * 用户原话：**「不管什么中国托管，有代理作为兜底就行，你不应该操心这么多。」**
   * 所以"后端包没有中国可达兜底"从此是**已知且已接受的状态**，不是缺口。
   *
   * 我此前把它挂成**永久红**。那是错的，而且错在一个本仓反复在治的模式上：
   * **一条为已被接受的状态永远亮着的红灯，等于一条被删掉的守卫** ——
   * 它不会让任何人去修（没什么可修的），只会训练所有人忽略红灯，
   * 顺带把**真正的意外**淹掉。
   *
   * 但**判据的能力不许一起删掉**。变的是"这个数是几时该红"，不是"要不要数"。
   * 所以改成**棘轮**（与 `check:orphans` 基线 70 同形）：
   *   · 基线里已有的单一来源 → 接受，只计数
   *   · **基线之外**新出现的单一来源 → **红**
   * 那才是意外：一个**本来有镜像**的组件掉到了单一来源（上游撤了 hf-mirror /
   * ModelScope 那一份），或者有人新加组件只配了一个源 —— 后者也该被逼着
   * 做一次显式决定，而不是顺手混进来。
   */
  const singleRows = compRows.filter((r) => isSingleSource(r));
  say(
    `   共 ${compRows.length} 个文件，其中**单一来源** ${singleRows.length} 个（按去重后的主机数算）。`,
  );
  const byKind = { pack: 0, model: 0 };
  for (const r of singleRows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  say(`     后端包 ${byKind.pack ?? 0} 个、模型 ${byKind.model ?? 0} 个`);
  say('   ── 用户裁决（2026-08-09）──');
  say('     「不管什么中国托管，有代理作为兜底就行，你不应该操心这么多。」');
  say('     → 后端包全部单一来源是**已接受的状态**；用户在受限网络下走代理。');
  say('     → 失败消息里必须带得出代理这句提示（第 7 节真的去撞一次失败来验它）。');

  const ratchet = ratchetSingleSource(compRows, BASELINE.entries);
  if (ratchet.stale.length > 0) {
    // 基线过期 = 它变好了。提醒收紧，但不红（收紧是好事，不该拦住任何人）。
    say('');
    say(
      `   ⓘ 基线里有 ${ratchet.stale.length} 项现在已经不是单一来源了（变好了，建议把基线收紧）：`,
    );
    for (const k of ratchet.stale) say(`     ${k}`);
  }
  judge('★ 单一来源没有**新增**（棘轮：已接受的接受，基线之外的才是意外）', {
    ok: ratchet.ok,
    reason: ratchet.ok
      ? `单一来源 ${ratchet.singleCount} 个，全部在基线（${ratchet.acceptedCount} 项）之内 —— 没有新增`
      : `**基线之外新出现 ${ratchet.unexpected.length} 个单一来源**：${ratchet.unexpected.join('、')}\n` +
        `      这才是意外：要么上游把某个镜像撤了，要么新加的组件只配了一个源。\n` +
        `      确认是有意为之的话，把它显式加进 scripts/ci/single-source-baseline.json。`,
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
  /*
   * ★ #87：`missing` 现在是**三态**。`?? []` 会把 daemon 明确报的
   * `null`（"我没能确认"）读成空清单 ⇒ 下面那条 `!missing.includes(...)` 恒真 ⇒
   * **UNKNOWN 被收进"通过"那一档**。而这条腿正是验证链本身 ——
   * 让验证链把"没查出来"当成"查过了、没问题"，正是这条修复要治的病。
   * 容忍第三态 ≠ 当成通过：这里把它判**失败**（本脚本的 judge 只有二值）。
   */
  const missingRaw = h.body?.pipeline?.missing;
  const toolchainUnknown = missingRaw === null;
  const missing = missingRaw ?? [];
  say(`   pipeline.missing = ${toolchainUnknown ? 'null（没能确认）' : JSON.stringify(missing)}`);
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
      !toolchainUnknown &&
      !missing.includes('ffmpeg') &&
      !missing.includes('ffprobe') &&
      !missing.includes('whisper-cli'),
    reason: toolchainUnknown
      ? `pipeline.missing = null —— daemon 没能确认工具链，**这不是"通过"**：` +
        `${h.body?.pipeline?.missingUnknownReason ?? '（未给原因）'}`
      : `pipeline.missing = ${JSON.stringify(missing)}`,
  });
  const badTools = toolChecks.filter((c) => c.status === 'fail');
  /*
   * ★ 空集守卫，与冷启动那条同形：没有 tool.* 时 `badTools.length === 0` 恒真 ⇒ 判通过，
   * 理由打印「**0 项 tool.* 全部非 fail**」。那个 `0` 确实漏在理由里、细心的读者能抓到，
   * **但一条断言不该靠读者细心** —— 它该自己红。
   * 自检正常时必然有 5 项 `tool.*`，所以 0 项 = 没拿到，不是"都好"。
   */
  const toolChecksUsable = sc.status === 200 && toolChecks.length > 0;
  judge('★ 自检里 tool.* 没有 fail（装上了 ≠ 能用）', {
    ok: toolChecksUsable && badTools.length === 0,
    reason: !toolChecksUsable
      ? `拿不到 tool.* 自检项（HTTP ${sc.status}，共 ${checks.length} 项、tool.* ${toolChecks.length} 项）` +
        ` —— **这不是"全部非 fail"，是"没检查成"**`
      : badTools.length === 0
        ? `${toolChecks.length} 项 tool.* 全部非 fail`
        : badTools.map((c) => `${c.id}: ${String(c.detail ?? '').slice(0, 80)}`).join('；'),
  });
  /* ── 7. ★ 代理那句提示，在真实失败路径上到底出不出得来 ── */

  hdr('7. ★ 用户撞到失败时，看不看得到「去设置代理」这句');
  /*
   * 用户裁决「有代理作为兜底就行」之后，**代理就是官方答案**。
   * 那么一个撞到下载失败的用户**必须在错误里看到它** ——
   * 否则"有兜底"只是我们知道、他不知道，与没有兜底在体验上等价。
   *
   * ## 怎么验：**真的去撞一次失败**，不是读代码
   *
   * 把包内清单**复制一份**，把其中一个包的地址改成一个必然 404 的 URL，
   * 用产品自己支持的 `OPENMEMO_MANIFEST_DIR` 指过去，然后走**真实安装路径**。
   * 改的是我复制出来的那份，**包内那份一个字节都没动**。
   *
   * 判据是错误文案里出现「设置 → 代理」——
   * `packages/downloader/src/download.ts:308` 在 probe 失败分支拼上了 PROXY_HINT_ZH，
   * 而 probe 失败正是用户那条（连不上 / DNS / TLS）与本例（404）共同经过的那一步。
   */
  const doctored = join(ROOT, 'manifests-doctored');
  mkdirSync(doctored, { recursive: true });
  /*
   * ⚠️ 样本必须挑**本平台适用**的那一个。
   *
   * `[CI 实测 run 31301671541]` 第一版按名字挑，在 linux 上挑中了
   * `libsimple-darwin-arm64` —— 安装路由在下载**之前**就回 409
   * 「该后端包不适用于本机」，于是根本没走到下载那一步。
   * 好在前提断言（"这一步必须真的失败"）当场把它抓住了，
   * 否则代理那条会在一个**从未发生过的失败**上报绿。
   * 所以 id 只能来自产品自己判定 applicable 的那一批。
   */
  const victimIds = new Set(
    applicable.filter((p) => /libsimple|sqlite-vec/.test(p.id)).map((p) => p.id),
  );
  if (victimIds.size === 0) for (const p of applicable.slice(0, 1)) victimIds.add(p.id);
  let doctoredId = null;
  for (const f of readdirSync(manifestDir).filter((n) => n.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(manifestDir, f), 'utf8'));
    if (!doctoredId) {
      const victim = (j.packs ?? []).find((p) => victimIds.has(p.id));
      if (victim) {
        doctoredId = victim.id;
        for (const file of victim.files ?? []) {
          for (const m of file.mirrors ?? []) {
            m.url = `https://github.com/faorcoek042/openmemo/releases/download/v0.0.0-does-not-exist/${file.name}`;
          }
        }
      }
    }
    writeFileSync(join(doctored, f), JSON.stringify(j));
  }
  if (!doctoredId) {
    judge('代理提示出现在失败路径上', {
      ok: false,
      reason: '**没跑** —— 清单里挑不出一个可以拿来制造失败的小包（不是跳过，是到不了）',
    });
  } else {
    say(`   拿 ${doctoredId} 做失败样本（只改我复制出来的那份清单，包内原件未动）`);
    /*
     * ★ 用一个**全新的空数据目录**：第 4 节已经把所有适用的包都装过一遍了，
     *   在原数据目录上再装一次可能被去重/直接成功，那样这一节测的就不是失败路径。
     */
    const freshData = join(ROOT, 'data-proxyhint');
    await stopDaemon();
    await startDaemon('proxyhint', { OPENMEMO_MANIFEST_DIR: doctored }, freshData);
    cookie = '';
    await local('/api/auth/session', { method: 'POST', body: {} });
    const r = await local('/api/backends/install', {
      method: 'POST',
      body: { id: doctoredId },
      timeoutMs: 60_000,
    });
    const jid = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    const st = jid ? await waitJob(jid, 600) : { state: `HTTP ${r.status}`, job: null };
    const errText = JSON.stringify(st.job?.error ?? st.job ?? {});
    say(`   安装 job：${st.state}`);
    say(`   错误全文：${errText.slice(0, 600)}`);
    judge('★ 下载失败时**真的**失败了（前提：这一步必须红，否则下面那条恒真）', {
      ok: st.state === 'failed',
      reason: `job=${st.state}`,
    });
    judge('★★ 失败消息里带得出「设置 → 代理」这句（代理是官方兜底，用户必须看得见）', {
      ok: /设置\s*→\s*代理/.test(errText) || /Settings\s*→\s*Proxy/i.test(errText),
      reason:
        /设置\s*→\s*代理/.test(errText) || /Settings\s*→\s*Proxy/i.test(errText)
          ? '出现了'
          : `**没有出现** —— 用户撞到失败时看不到官方兜底办法。错误原文：${errText.slice(0, 300)}`,
    });
  }
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
  /*
   * ⚠️ 这里原本写的是 `e.ok === null ? 'ⓘ' : …` —— 一条**零生产者**的渲染分支：
   *   全文 `ledger.push` 只有 `judge()` 一个写入点，而 `ok: null` 一次都没出现过，
   *   那个 ⓘ **一次也画不出来**。
   *
   *   它不是无害的死代码：**任何来审计这条腿的人，看到那个分支都会得出
   *   "这条腿支持三态"的结论**，而它一次都没成立过。本仓这一周抓到的四道
   *   空转守卫全是这个形状 —— 一个**看起来在工作**的东西。
   *   （record 腿是反过来的：那边有人写第三态、没人分类。**有人写没人分 vs
   *     有人分没人写，两种都得治。**）
   *
   *   所以删掉它，并在下面钉一根**会红**的桩：真有人往台账里塞第三态时当场喊，
   *   而不是让一个画不出来的图标替我们假装支持它。
   */
  for (const e of ledger) {
    say(`   ${e.ok ? '✔' : '✘'} ${e.name}`);
    say(`      ${String(e.reason).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  /*
   * ★ TWO_STATE —— 「本腿是两态的」这句话的看门狗。
   *
   * 它撑着两件事：① 上面那个只认 true/false 的渲染；② 凭证里 `--undecided` 报的
   * 是 `llmGapIds.length`，**而不是从台账里数第三态**。哪天有人往 `judge()` 里
   * 塞一个 `ok: null`（或别的非布尔），这两件事会同时变成假话，而**两件都不会自己喊**。
   * 所以在这里判红，并直接指到该一起改的那三个地方。
   */
  const nonBoolean = ledger.filter((e) => e.ok !== true && e.ok !== false);
  if (nonBoolean.length > 0) {
    exitCode = 1;
    say('');
    say(`   ✘ 台账里出现了 ${nonBoolean.length} 条非布尔的 ok（本腿此前是**两态**的）：`);
    for (const e of nonBoolean) say(`     · ${e.name} → ok=${JSON.stringify(e.ok)}`);
    say('     如果它表示「这条断言没能被评估」，那么三处要一起改：');
    say('       ① 上面的渲染（现在只认 true/false）；');
    say('       ② 本文件的 --undecided-out（现在只报 llmGapIds.length，不数台账）；');
    say('       ③ e2e-allcomponents.yml 里 attest 那段论证（它明写"未决只有 LLM 那一处"）。');
    say('     别只把渲染补回去 —— 那正是这一行要挡的事。');
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

  /*
   * 覆盖面落盘。**包在 try 里**：纯展示用的统计出故障不该连累这条腿的判定
   * （`sum-undecided.mjs` 顶部那段裁决同一条理由）。
   *
   * ⚠️ `llmGapIds === null` 时**一个字都不写** —— 那表示这一轮压根没跑到数它的地方
   *    （第 1 节之前就中断了）。少一格会让下游如实收敛成 null，而写个 0 是撒谎：
   *    0 的意思是"查过了，一条未决都没有"。**没数 ≠ 数出来是 0**，这正是这批
   *    改动从头到尾在守的那条线。
   */
  if (UNDECIDED_OUT) {
    if (llmGapIds === null) {
      say('');
      say(`   ⚠️ 没跑到统计未决的那一步，**不写** ${UNDECIDED_OUT}。`);
      say('      下游 sum-undecided.mjs 会因为缺一格如实收敛成 null —— 那是对的：');
      say('      「没数」和「数出来是 0」必须分得开。');
    } else {
      try {
        mkdirSync(dirname(UNDECIDED_OUT), { recursive: true });
        writeFileSync(
          UNDECIDED_OUT,
          `${JSON.stringify({ unknowns: llmGapIds.length, llmIds: llmGapIds }, null, 2)}\n`,
        );
        say('');
        say(`   覆盖面已写到 ${UNDECIDED_OUT}（unknowns=${llmGapIds.length}）`);
        say(
          `     内容：role=llm 的 ${llmGapIds.length} 个变体本腿 B 层够不着 —— ${llmGapIds.join(', ')}`,
        );
      } catch (err) {
        say(`   ⚠️ 覆盖面写不出去（${String(err?.message ?? err)}）—— 不影响本腿判定。`);
      }
    }
  }
  // 几 GB 的下载留在 runner 上没意义，跑完自己清（Manager 2026-08-09 要求）
  try {
    rmSync(ROOT, { recursive: true, force: true });
    say(`   已清理临时目录 ${ROOT}`);
  } catch (e) {
    say(`   ⚠️ 清理 ${ROOT} 失败：${e.message}`);
  }
}

process.exit(exitCode);
