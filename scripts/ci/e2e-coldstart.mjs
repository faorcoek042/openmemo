#!/usr/bin/env node
/**
 * e2e-coldstart.mjs —— **一个刚解压的最小包 + 一个从不存在的数据目录 + 一个什么都没装的用户。**
 *
 * ## 这条腿为什么存在（用户 2026-08-08 的原话）
 *
 * 他在 Windows 上下了 v0.3.0 的 zip、解压、运行，
 * **发现根本没法通过向导下载 whisper / asr-model 等任何组件 —— 点「安装模型」完全没有任何反应。**
 * 然后他问了一句，而他问对了：
 *
 * > 「你测试的时候是不是把全部组件准备好了来模拟环境，
 * >   而不是按照只模拟最小压缩包的形式探测功能缺失？」
 *
 * **是的。** 已有的四条 e2e 腿**自己调 `POST /api/backends/install` 把包装上**，
 * 然后才开始断言。也就是说它们跑的全是「**组件已就位之后各条流程正不正常**」，
 * 而「**一个刚解压的最小包，用户从零开始**」这一整类**从来没跑过**。
 *
 * 这和上一次是同一个病：上次是「CI 从没执行过启动器」，这次是
 * 「**CI 从没经历过一个空的数据目录**」。
 *
 * ## 判据
 *
 * **一个刚解压的包、一个从不存在的数据目录、一个什么都没装的用户，
 * 能不能一步步把产品用起来。**
 *
 * ## 两条纪律，写在最前面
 *
 * 1. **绝不硬编码包 id 去跳过「探测 → 推荐」。**
 *    包 id 只能来自**产品自己交出来的目录**（`GET /api/backends/catalog` 里
 *    它自己判定 `applicable` 的那些）。硬编码一个 id 直接 `POST install`
 *    **正是此前漏掉这一整类的原因** —— 那条路用户根本走不到。
 *    目录里一个可装的都没有，**那就是结论本身**（用户点什么都没有），不是"换个 id 再试"。
 * 2. **PROTOCOL §11**：起服务前先证明端口是空的、收尾按 pid 收整棵进程树、
 *    外部命令一律带超时、**「跳过」不许渲染成「成功」**。
 *    我自己上一轮就栽过「跳过的平台报告成功、零步骤」。
 *
 * ## 已知会撞到的那件事（`[报告]`，由另一路在解）
 *
 * 六个后端会报 `probe executable not found: …\runtime\openmemo-probe.exe`
 * —— **探针不在包里**。那是一个鸡生蛋（探针随 whisper 包出厂，可你要先探测才知道装哪个包）。
 * **这条腿不修它**，但要**如实报出这个状态**，而且判据要写成
 * 「用户能不能装上东西」而不是「探针在不在」—— 这样它被修好之后**自动变绿**，
 * 不需要有人回来改这个脚本。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  existsSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const BUNDLE = arg('--bundle', null);
const PORT = Number(arg('--port', '19810'));
const HOST = '127.0.0.1';
const IS_WIN = process.platform === 'win32';
/*
 * ★ **默认不屏蔽**（`--mask` 才开）—— 这条腿要的是「用户那台干净机器」，
 *   而假二进制制造的是「有一个坏掉的 ffmpeg」，那是**另一回事**。
 *
 * `[CI 实测 run 31260530952]` 第一版默认屏蔽，后果是首屏读数三平台不一致：
 *   · Linux   `missing = ["asr-model"]`         ← shim 无扩展名 + chmod +x，被当成"装了"
 *   · Windows `missing = ["ffmpeg","ffprobe","whisper-cli","asr-model"]` ← 产品找 .exe，shim 是 .cmd
 * 用户报的正是 Windows 那一行。也就是说**Linux 那一行是我自己伪造出来的**，
 * 而它恰恰是本腿第 1 问要回答的东西。屏蔽对 e2e-record 是对的（那里要让"借用"可见），
 * 对这里是错的。改成默认不屏蔽 + 下面那条「首屏读数没被宿主污染」的断言。
 */
const MASK = argv.includes('--mask');

const ROOT = mkdtempSync(join(tmpdir(), 'openmemo-coldstart-e2e-'));
/** ★ 判据要求「一个**从不存在**的数据目录」—— 所以只算路径，**不建**，交给产品自己建。 */
const DATA_DIR = join(ROOT, 'data');
const POINTER = join(ROOT, 'pointer.json');
const MASK_BIN = join(ROOT, 'maskbin');

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('━'.repeat(96));
  say(`━━ ${s}`);
  say('━'.repeat(96));
};
/** 原样把一份响应摊开 —— Manager 要的是「每一步的真实响应」，不是我的转述。 */
const dump = (label, v, cap = 2600) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  say(`   ── ${label} ──`);
  for (const line of String(s).slice(0, cap).split('\n')) say(`      ${line}`);
  if (String(s).length > cap) say(`      …（截断，共 ${String(s).length} 字符）`);
};

const ledger = [];
let exitCode = 0;
function judge(name, r, { fatal = true } = {}) {
  ledger.push({ name, ok: r.ok, reason: r.reason, fatal });
  say(`   ${r.ok ? '✔' : '✘'} ${name}：${r.reason}`);
  if (!r.ok && fatal) exitCode = 1;
  return r.ok;
}
function observe(name, text) {
  ledger.push({ name, ok: null, reason: text, fatal: false });
  say(`   ⓘ ${name}：${String(text).slice(0, 300)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────── HTTP（带超时与重试） ─────────────────────────── */

function httpOnce(path, { method = 'GET', body = null, headers = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        // keep-alive 复用会在这类脚本里变成随机的 ECONNRESET（e2e-record 实测过）
        agent: false,
        headers: {
          host: `${HOST}:${PORT}`,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const sc = res.headers['set-cookie'];
          if (sc) {
            const m = /om_sid=[^;]+/.exec(sc.join(';'));
            if (m) cookie = m[0];
          }
          const text = raw.toString('utf8');
          let parsed = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* 不是 JSON 就原样给 */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
        });
      },
    );
    // ★ §11：一切外部调用带超时。没有超时的步骤会拖死整条腿。
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
let cookie = '';
async function http(path, opts = {}) {
  let last;
  for (let i = 0; i < 4; i += 1) {
    try {
      return await httpOnce(path, opts);
    } catch (e) {
      const code = e?.code ?? '';
      if (!['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(code)) throw e;
      last = e;
      await sleep(300 * (i + 1));
    }
  }
  throw new Error(`${path}: ${last?.message ?? '连不上'}（重试 4 次后仍失败）`);
}

/* ───────────────────── §11：端口必须先是空的 / 按 pid 收树 ───────────────────── */

/**
 * ★ PROTOCOL §11：**起服务之前先证明这个端口是空的。**
 *
 * 不然「探测到的通过」可能根本不是我启动的那个东西给的 —— 本仓三个 agent
 * 各撞过一次，其中一次差点据此宣布「macOS 双击是好的」，而用户手里的包打不开。
 * 端口不空**当场判失败**，不是继续跑下去拿一个无意义的绿。
 *
 * ⚠️ 这段逻辑与 `e2e-runtime-audit.mjs` 里的是**同一份的第 N 份拷贝**。
 * 该提成 `scripts/ci/lib/` 了，但那要动别的 agent 正在改的文件，本轮不做，
 * 已在回执里记给 Manager。
 */
async function assertPortFree(label) {
  try {
    const r = await httpOnce('/api/health', { timeoutMs: 3000 });
    throw new Error(
      `端口 ${PORT} 上已经有人在应答（HTTP ${r.status}）——` +
        `${label} 之前必须是空的，否则后面测到的一切都可能是别人给的（PROTOCOL §11）`,
    );
  } catch (e) {
    if (/已经有人在应答/.test(e.message)) throw e;
    // 连不上 = 没人应答 = 端口是空的，正是我们要的
  }
}

/** 按 **pid 收整棵进程树**（§11）。**不许 `pkill -f`** —— 模式匹配会打到别人的进程。 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 15_000 });
    } else {
      // 负号 = 整个进程组（daemon 是用 detached 起的，见 startDaemon）
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    /* 已经没了 */
  }
}

/* ─────────────────────────────── daemon ─────────────────────────────── */

const DAEMON = BUNDLE ? join(BUNDLE, 'app', 'daemon', 'dist', 'main.js') : null;
const NODE_BIN = BUNDLE ? join(BUNDLE, 'runtime', IS_WIN ? 'node.exe' : 'node') : null;

let proc = null;
let bootLog = [];
async function startDaemon(label) {
  await assertPortFree(label);
  const logs = [];
  proc = spawn(NODE_BIN, [DAEMON, '--data-dir', DATA_DIR, '--port', String(PORT)], {
    env: {
      ...process.env,
      PATH: PATH_FOR_DAEMON,
      OPENMEMO_AUTH: 'none',
      OPENMEMO_DATA_DIR: DATA_DIR,
      // PROTOCOL §9：绝不写全局指针
      OPENMEMO_POINTER_FILE: POINTER,
      OPENMEMO_WEB_DIST: join(BUNDLE, 'app', 'apps', 'web', 'dist'),
      OPENMEMO_EXT_DIR: join(BUNDLE, 'ext'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX 上单独成组，收尾时才收得干净（§11）
    detached: !IS_WIN,
  });
  const keep = (d) => {
    logs.push(String(d));
    bootLog.push(String(d));
  };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);

  for (let i = 0; i < 180; i += 1) {
    await sleep(500);
    try {
      const r = await httpOnce('/api/health', { timeoutMs: 4000 });
      if (r.status === 200) {
        say(`   [${label}] daemon 起来了（${((i + 1) * 0.5).toFixed(1)}s，pid=${proc.pid}）`);
        return logs;
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break;
  }
  dump(`[${label}] daemon 没起来，它的全部输出`, logs.join(''), 6000);
  throw new Error(`daemon 没起来（exitCode=${proc.exitCode}）`);
}
async function stopDaemon() {
  if (!proc) return;
  const pid = proc.pid;
  killTree(pid);
  for (let i = 0; i < 20 && proc.exitCode === null; i += 1) await sleep(150);
  if (proc.exitCode === null) {
    try {
      if (IS_WIN) killTree(pid);
      else process.kill(-pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
  proc = null;
  // 收完必须让端口真的空出来，否则下一次 startDaemon 的 §11 断言会误判
  for (let i = 0; i < 30; i += 1) {
    try {
      await httpOnce('/api/health', { timeoutMs: 1500 });
      await sleep(300);
    } catch {
      return;
    }
  }
}

/* ────────────────────────── 屏蔽宿主工具 ────────────────────────── */

const HOST_TOOLS = ['ffmpeg', 'ffprobe', 'yt-dlp', 'whisper-cli', 'python3'];
const SHIM_MARK = 'E2E-COLDSTART-SHIM-INVOKED';
let PATH_FOR_DAEMON = process.env.PATH ?? '';
function which(tool) {
  const exts = IS_WIN ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, tool + ext), fsConstants.X_OK);
        return join(dir, tool + ext);
      } catch {
        /* 下一个 */
      }
    }
  }
  return null;
}

/* ═══════════════════════════════ 主流程 ═══════════════════════════════ */

if (!BUNDLE) {
  console.error('✘ --bundle <解压后的包目录> 必填 —— 这条腿的全部意义就是跑那个包。');
  process.exit(2);
}
for (const [what, p] of [
  ['daemon 入口', DAEMON],
  ['包自带的 Node', NODE_BIN],
]) {
  if (!existsSync(p)) {
    console.error(`✘ 找不到${what}：${p}`);
    process.exit(2);
  }
}

try {
  hdr('0. 出发点：一个刚解压的包 + 一个**还不存在**的数据目录');
  say(`   包        ${BUNDLE}`);
  say(`   Node      ${NODE_BIN}（包自带，不是宿主的 ${process.execPath}）`);
  say(`   数据目录  ${DATA_DIR}`);
  say(`   存在吗？  ${existsSync(DATA_DIR) ? '**已存在（不该）**' : '否 —— 由产品自己创建'}`);
  judge('数据目录在启动前确实不存在（这条腿的前提）', {
    ok: !existsSync(DATA_DIR),
    reason: existsSync(DATA_DIR) ? '它已经存在了，那就不是冷启动' : '不存在，交给产品自己建',
  });
  say(`   宿主自带：`);
  const hostHas = [];
  for (const t of HOST_TOOLS) {
    const p = which(t);
    say(`     ${t.padEnd(12)} ${p ?? '(不在 PATH 上)'}`);
    if (p && t !== 'python3') hostHas.push(t);
  }
  /*
   * ★ 这条腿第 1 问是「用户打开看到什么」。如果这台 runner 自带 ffmpeg，
   *   产品就会找到它，首屏读数与用户机器上的**不是同一件事** ——
   *   那不是"小瑕疵"，是**这一问在这台机器上答不了**。所以当场判红，
   *   而不是打一行小字然后照常报绿。（python3 不计：它不在 pipeline.missing 的口径里。）
   */
  judge('首屏读数没有被宿主自带的工具污染（否则这一问在这台 runner 上答不了）', {
    ok: hostHas.length === 0,
    reason:
      hostHas.length === 0
        ? '流水线相关的工具在宿主 PATH 上一个都没有 —— 首屏读数与用户机器可比'
        : `宿主自带 ${hostHas.join(', ')}，产品会找到它们，首屏的"缺少工具"清单会比用户机器上短`,
  });

  if (MASK) {
    mkdirSync(MASK_BIN, { recursive: true });
    for (const t of HOST_TOOLS) {
      if (IS_WIN) {
        writeFileSync(
          join(MASK_BIN, `${t}.cmd`),
          `@echo off\r\necho ${SHIM_MARK} ${t} 1>&2\r\nexit /b 127\r\n`,
        );
      }
      const shim = join(MASK_BIN, t);
      writeFileSync(shim, `#!/bin/sh\necho "${SHIM_MARK} ${t}" >&2\nexit 127\n`);
      try {
        chmodSync(shim, 0o755);
      } catch {
        /* Windows 上是空操作 */
      }
    }
    PATH_FOR_DAEMON = `${MASK_BIN}${delimiter}${PATH_FOR_DAEMON}`;
    say(`   已屏蔽宿主同名工具 ${HOST_TOOLS.length} 个 —— 用户的机器上不一定有它们`);
  }

  /* ── 1. 首屏 ── */

  hdr('1. 首屏：用户双击之后，产品实际说了什么');
  const boot = await startDaemon('cold');
  say('');
  dump('daemon 启动横幅（用户在终端/日志里看到的原文）', boot.join('').trim(), 3000);

  /*
   * 浏览器打开页面后做的第一件事就是换会话。照做 —— 这条腿要走用户走的路，
   * 而且 `/ws/**` 那侧即使 AUTH=none 也认 cookie（e2e-record 实测过）。
   */
  const sess = await http('/api/auth/session', { method: 'POST', body: {} });
  say(
    `   POST /api/auth/session → HTTP ${sess.status}，cookie=${cookie ? '已拿到' : '**没拿到**'}`,
  );

  const health = await http('/api/health');
  dump('GET /api/health', health.body, 2000);

  const missingAtBoot = health.body?.pipeline?.missing ?? [];
  observe(
    '首屏「缺少工具」清单',
    `pipeline.missing = ${JSON.stringify(missingAtBoot)}（这就是用户看到的第一句话的来源）`,
  );

  const sc = await http('/api/selfcheck');
  const checks = sc.body?.checks ?? sc.body?.results ?? [];
  say('');
  say(`   ── GET /api/selfcheck：**每一项**的真实状态（共 ${checks.length} 项）──`);
  say('   id                              status  required  detail');
  say('   ' + '-'.repeat(92));
  for (const c of checks) {
    say(
      `   ${String(c.id).padEnd(31)} ${String(c.status).padEnd(7)} ${String(c.required ?? '').padEnd(9)} ` +
        `${String(c.detail ?? c.message ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 74)}`,
    );
  }

  /*
   * ★ 判据不是"自检有没有红"—— 一个刚解压的包**本来就该**有一堆红。
   *   判据是「**红的那些，用户能不能自己走出去**」：required 且 fail 的每一项
   *   都必须带 remediation（界面据它渲染"去安装"按钮）。
   *   没有 remediation 的红 = 一句"坏了"，用户无路可走 —— 那才是缺陷。
   */
  const deadEnds = checks.filter(
    (c) => c.status === 'fail' && c.required === true && !c.remediation,
  );
  judge('自检里每一条 required 的红都带得出「怎么修」（否则用户只看到"坏了"）', {
    ok: deadEnds.length === 0,
    reason:
      deadEnds.length === 0
        ? `${checks.filter((c) => c.status === 'fail' && c.required === true).length} 条 required 红全部带 remediation`
        : `${deadEnds.length} 条 required 的红没有 remediation：${deadEnds.map((c) => c.id).join(', ')}`,
  });

  // 两个页面路由真的发得出来（SPA 兜底）—— "界面打不开"是用户的原始抱怨之一
  for (const route of ['/runtime', '/models']) {
    const r = await http(route, { headers: { accept: 'text/html' } });
    judge(`页面路由 ${route} 发得出 HTML`, {
      ok: r.status === 200 && /<script|<div id="root"/i.test(String(r.body)),
      reason: `HTTP ${r.status}，${r.raw.length} 字节`,
    });
  }

  /* ── 2. 探测 → 推荐 → 安装：走用户会走的那条路 ── */

  hdr('2. 用户点「安装」之前，产品先要探测硬件并给出推荐');
  const hw = await http('/api/runtime/hardware', { timeoutMs: 90_000 });
  dump('GET /api/runtime/hardware（首屏探测，原样）', hw.body, 3000);

  /*
   * ★ 这一条**刻意不写成「探针必须存在」**。
   *   探针进包是另一路在解的事；写成"探针在不在"的话，它修好之后
   *   还得有人回来改这个脚本 —— 而没人会回来。
   *   写成用户视角：**探测要么成功，要么明确降级并告诉用户下一步做什么。**
   *   两种都算通过；只有"既没结果也没说法"才是红。它被修好之后自动变绿。
   */
  const hwBody = hw.body ?? {};
  const hwUsable =
    hw.status === 200 &&
    (Array.isArray(hwBody.devices) || hwBody.hardware || hwBody.snapshot || hwBody.cpu);
  const hwHasReason = Boolean(
    hwBody.reasonZh ?? hwBody.reason ?? hwBody.error ?? hwBody.degraded ?? hwBody.breaker,
  );
  judge('硬件探测：要么给出结果，要么明确降级并说清原因（不许既没结果也没说法）', {
    ok: hwUsable || hwHasReason,
    reason: hwUsable
      ? `HTTP ${hw.status}，拿到可用的探测结果`
      : hwHasReason
        ? `HTTP ${hw.status}，探测没成功但**明确说了原因**：${JSON.stringify(hwBody).slice(0, 200)}`
        : `HTTP ${hw.status}，既没有结果也没有原因：${JSON.stringify(hwBody).slice(0, 200)}`,
  });

  const cat = await http('/api/backends/catalog', { timeoutMs: 90_000 });
  const packs = cat.body?.packs ?? cat.body?.items ?? [];
  say('');
  say(`   ── GET /api/backends/catalog：${packs.length} 个包，逐个看产品怎么判的 ──`);
  for (const p of packs) {
    say(
      `   ${String(p.id).padEnd(34)} applicable=${String(p.applicable).padEnd(5)} ` +
        `${String(p.reasonZh ?? p.reason ?? p.applicableReason ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 80)}`,
    );
  }

  const applicable = packs.filter((p) => p.applicable === true);
  /*
   * ★★ 这条就是用户那句「点安装完全没有任何反应」在 API 层的样子。
   *   目录里一个可装的都没有 → 界面上没有任何可点的东西 → 用户以为点了没反应。
   *   **不许**为了让脚本往下走而硬挑一个 id —— 那正是此前漏掉这一整类的原因。
   */
  const canInstallSomething = judge(
    '★ 目录里至少有一个包是「这台机器现在可以装的」（否则用户点什么都没有）',
    {
      ok: applicable.length > 0,
      reason:
        applicable.length > 0
          ? `${applicable.length}/${packs.length} 个可装：${applicable.map((p) => p.id).join(', ')}`
          : `**0/${packs.length} 个可装** —— 用户在界面上看不到任何可安装项，` +
            `这正是「点安装没有任何反应」的服务端形态。逐包理由见上表。`,
    },
  );

  /* ── 3. 真的装一个（id 只能来自上面那张表）── */

  hdr('3. 装一个组件：每一步的真实响应');
  let installedOk = false;
  const queuedExtra = [];
  if (!canInstallSomething) {
    /*
     * ★ §11：「跳过」不许渲染成「成功」。
     *   这里**明确记一条红**，而不是安静地不跑。
     */
    judge('安装链路（GET 目录 → 挑 → POST 安装 → 进度 → 完成）', {
      ok: false,
      reason:
        '**没跑** —— 上一步产品没有交出任何可装的包，所以这条路从用户那里就走不到。' +
        '这不是"跳过"，这是"到不了"：它就是用户报的那个故障。',
    });
  } else {
    /*
     * ★ **把产品判定可装的全部装一遍**，不是只装第一个。
     *
     * 第一版只装 `applicable[0]`，于是跑完 `missing` 里还剩 ffmpeg/ffprobe ——
     * 那不是产品的缺陷，是我根本没装 media-tools。一个照着向导走的用户
     * 会把推荐的那些都装上，判据必须跟他一致。
     * id 仍然**只来自产品自己交出来的目录**，一个都不是我写死的。
     */
    for (const p of applicable.slice(1)) queuedExtra.push(p.id);
    const pick = applicable[0];
    say(`   产品判定可装的共 ${applicable.length} 个，逐个装。先装：${pick.id}`);
    const t0 = Date.now();
    const r = await http('/api/backends/install', {
      method: 'POST',
      body: { id: pick.id },
      timeoutMs: 60_000,
    });
    dump(`POST /api/backends/install {id:${pick.id}}`, { status: r.status, body: r.body });
    const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    judge('POST 安装被受理（拿到 jobId）', {
      ok: r.status === 202 || Boolean(jobId),
      reason: `HTTP ${r.status}，jobId=${jobId ?? '**没有**'}`,
    });

    if (jobId) {
      let last = null;
      let state = 'unknown';
      for (let i = 0; i < 900; i += 1) {
        await sleep(1000);
        const jr = await http(`/api/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 20_000 });
        const job = jr.body?.job ?? jr.body;
        const got = job?.jobId ?? job?.uid ?? job?.id;
        if (got !== jobId) {
          state = 'unknown';
          last = `端点返回的不是这个 job（要 ${jobId}，拿到 ${got}）`;
          break;
        }
        last = job;
        if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
          state = job.state;
          break;
        }
        if (i % 10 === 0) {
          say(
            `   … 进度：state=${job.state} progress=${job.progress ?? '?'} ` +
              `${String(job.stage ?? job.message ?? '').slice(0, 60)}`,
          );
        }
      }
      dump('轮询到终态时 job 的全文', last, 1600);
      judge('安装 job 跑到 succeeded', {
        ok: state === 'succeeded',
        reason: `${state}（${((Date.now() - t0) / 1000).toFixed(1)}s）`,
      });

      // 地面真相：不信 job 自述
      const inst = await http('/api/backends/installed');
      const arr = Array.isArray(inst.body)
        ? inst.body
        : (inst.body?.packs ?? inst.body?.installed ?? []);
      installedOk = arr.some((x) => (x.id ?? x.packId) === pick.id);
      judge('独立核对：它真的出现在已安装列表里（不信 job 自述）', {
        ok: installedOk,
        reason: `/api/backends/installed 有 ${arr.length} 条；${pick.id} ${installedOk ? '在' : '**不在**'}`,
      });
    }

    /* 其余可装的逐个装完 —— 照着向导走的用户会把推荐的那些都装上。 */
    for (const id of queuedExtra) {
      const rr = await http('/api/backends/install', {
        method: 'POST',
        body: { id },
        timeoutMs: 60_000,
      });
      const jid = rr.body?.jobId ?? rr.body?.uid ?? rr.body?.id;
      let st2 = `HTTP ${rr.status}`;
      if (jid) {
        for (let i = 0; i < 900; i += 1) {
          await sleep(1000);
          const jr = await http(`/api/jobs/${encodeURIComponent(jid)}`, { timeoutMs: 20_000 });
          const job = jr.body?.job ?? jr.body;
          if ((job?.jobId ?? job?.uid ?? job?.id) !== jid) {
            st2 = '认不出这个 job';
            break;
          }
          if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
            st2 = job.state + (job.error ? ` — ${JSON.stringify(job.error).slice(0, 200)}` : '');
            break;
          }
        }
      }
      say(`   ${String(id).padEnd(32)} ${st2}`);
    }

    const inst2 = await http('/api/backends/installed');
    const arr2 = Array.isArray(inst2.body)
      ? inst2.body
      : (inst2.body?.packs ?? inst2.body?.installed ?? []);
    judge('产品判定可装的那些，最后都真的装上了', {
      ok: arr2.length >= applicable.length,
      reason: `可装 ${applicable.length} 个，已安装列表 ${arr2.length} 条：${arr2
        .map((x) => x.id ?? x.packId)
        .join(', ')}`,
    });
  }

  /* ── 4. 装完重启，缺失清单要真的变短 ── */

  hdr('4. 装了一半重启：状态要延续，缺失清单要真的变短');
  await stopDaemon();
  await startDaemon('warm');
  const health2 = await http('/api/health');
  const missingAfter = health2.body?.pipeline?.missing ?? [];
  say(`   重启前 missing = ${JSON.stringify(missingAtBoot)}`);
  say(`   重启后 missing = ${JSON.stringify(missingAfter)}`);
  if (installedOk) {
    judge('★ 装完并重启之后，缺失清单真的变短了（"装了有用"，不是"job 说成功了"）', {
      ok: missingAfter.length < missingAtBoot.length,
      reason:
        missingAfter.length < missingAtBoot.length
          ? `${missingAtBoot.length} → ${missingAfter.length}`
          : `${missingAtBoot.length} → ${missingAfter.length}：装完之后一项都没少，` +
            `说明装上的东西没有被产品认出来`,
    });
  } else {
    judge('★ 装完并重启之后，缺失清单真的变短了', {
      ok: false,
      reason: '**没跑** —— 前面没能装上任何东西（不是跳过，是到不了）',
    });
  }

  /* ── 5. 模型：用户的第二步 ── */

  hdr('5. 模型：用户点「安装模型」那条路');
  const mcat = await http('/api/models/catalog', { timeoutMs: 90_000 });
  const groups = mcat.body?.groups ?? [];
  const models = groups.flatMap((g) =>
    (g.variants ?? []).map((v) => ({ ...v, role: v.role ?? g.role })),
  );
  say(`   GET /api/models/catalog：${groups.length} 个分组，展平 ${models.length} 个条目`);
  if (models.length === 0) {
    dump('目录 top-level keys（展平为空时先怀疑 unwrap 写错）', Object.keys(mcat.body ?? {}));
  }
  judge('模型目录里有东西可挑（否则「安装模型」同样点不出反应）', {
    ok: models.length > 0,
    reason: `${models.length} 个模型条目`,
  });

  /*
   * 挑**产品自己推荐**的那个；没有推荐标记就挑体积最小的 ASR ——
   * 这一步证的是"这条路走得通"，不是"哪个模型好"。仍然不硬编码 id。
   */
  const sizeOf = (m) => (m.files ?? []).reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
  const asr = models
    .filter((m) => m.role === 'asr')
    .map((m) => ({ m, bytes: sizeOf(m) }))
    .filter((x) => x.bytes > 0)
    .sort((a, b) => a.bytes - b.bytes);
  /*
   * ★ **只在 `role === 'asr'` 里挑**。
   *
   * 第一版写的是「先找全目录里带 `recommended-default` 的」——
   * `[CI 实测 run 31260530952]` 它在三个平台上都挑中了 `llm/qwen3-4b-q4_k_m`
   * （**一个 2.4 GB 的大语言模型**），下完当然还是 `missing: ['asr-model']`。
   * 那是**我的脚本的缺陷，不是产品的**：差一点就把它写成一条产品 bug 报上去。
   * 判据是"用户为了转写要装的那个"，所以推荐标签也必须在 role 内部找。
   */
  const asrModels = models.filter((m) => m.role === 'asr');
  const recommended =
    asrModels.find((m) => (m.tags ?? []).includes('recommended-default')) ?? asr[0]?.m ?? null;

  if (!recommended) {
    judge('模型安装链路', { ok: false, reason: '**没跑** —— 目录里挑不出可装的模型条目' });
  } else {
    say(`   挑中 ${recommended.id}（${(sizeOf(recommended) / 1048576).toFixed(0)} MB）`);
    const pr = await http('/api/models/pull', {
      method: 'POST',
      body: { id: recommended.id },
      timeoutMs: 60_000,
    });
    dump(`POST /api/models/pull {id:${recommended.id}}`, { status: pr.status, body: pr.body });
    const mj = pr.body?.jobId ?? pr.body?.uid ?? pr.body?.id;
    judge('POST 拉模型被受理（拿到 jobId）', {
      ok: Boolean(mj),
      reason: `HTTP ${pr.status}，jobId=${mj ?? '**没有**'}`,
    });
    if (mj) {
      let st = 'unknown';
      for (let i = 0; i < 1800; i += 1) {
        await sleep(1000);
        const jr = await http(`/api/jobs/${encodeURIComponent(mj)}`, { timeoutMs: 20_000 });
        const job = jr.body?.job ?? jr.body;
        if ((job?.jobId ?? job?.uid ?? job?.id) !== mj) {
          st = 'unknown';
          break;
        }
        if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
          st = job.state;
          if (st !== 'succeeded') dump('模型 job 失败全文', job.error ?? job, 1600);
          break;
        }
      }
      judge('模型真的装上了', { ok: st === 'succeeded', reason: st });
    }
  }

  /* ── 6. 终局：从零到「能用」了吗 ── */

  hdr('6. 终局：一个从零开始的用户，现在能用了吗');
  await stopDaemon();
  await startDaemon('final');
  const h3 = await http('/api/health');
  const missingFinal = h3.body?.pipeline?.missing ?? [];
  dump('最终 /api/health 的 pipeline', h3.body?.pipeline ?? {}, 1200);
  judge('★ 走完全程之后，「缺少工具」清单不再包含转写必需的那几项', {
    ok: !missingFinal.includes('asr-model') && !missingFinal.includes('whisper-cli'),
    reason: `最终 missing = ${JSON.stringify(missingFinal)}`,
  });

  const shimHits = [...bootLog.join('').matchAll(new RegExp(`${SHIM_MARK} (\\S+)`, 'g'))].map(
    (m) => m[1],
  );
  judge('全程没有借宿主的工具', {
    ok: shimHits.length === 0,
    reason: shimHits.length === 0 ? 'shim 零命中' : `借了：${[...new Set(shimHits)].join(', ')}`,
  });
} catch (e) {
  say('');
  say(`✘ e2e-coldstart 中断：${e.message}`);
  if (proc) say(`   daemon: exitCode=${proc.exitCode} signal=${proc.signalCode} pid=${proc.pid}`);
  if (bootLog.length) dump('daemon 最后的输出', bootLog.join('').split('\n').slice(-50).join('\n'));
  exitCode = 1;
} finally {
  await stopDaemon();
  hdr('结论台账');
  for (const e of ledger) {
    say(`   ${e.ok === null ? 'ⓘ' : e.ok ? '✔' : '✘'} ${e.name}`);
    say(`      ${String(e.reason).replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  const red = ledger.filter((x) => x.ok === false && x.fatal);
  say('');
  say(
    red.length === 0
      ? `✔ ${ledger.filter((x) => x.ok === true).length} 条关键断言全部成立`
      : `✘ ${red.length} 条不成立：${red.map((x) => x.name).join('；')}`,
  );
  say(`   数据目录 ${DATA_DIR} 留在 runner 上，随 runner 一起销毁。`);
}

process.exit(exitCode);
