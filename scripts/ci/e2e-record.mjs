#!/usr/bin/env node
/**
 * e2e-record.mjs — F3「**录音 → 转写 → 时间轴**」在**干净 runner** 上、
 * 用**用户下载的那个预编译包**、走**产品自己的 HTTP / WebSocket**跑一遍。
 *
 * ## 为什么要有这条腿（用户的原话）
 *
 * > 「你应该派多路 agent 去在 CI 中运行一遍把各个流程跑通才能给我交付的啊！」
 *
 * 他是对的。在这之前 CI 验的是「**产品能不能被脚本驱动着转出一段文本**」
 * （`cold-start-audit.mjs` 第 7 节：`POST /api/notes/import` → 拿到非空文本）。
 * 而交付出去的是「**人要用手打开并使用它**」—— 中间隔着：
 * 浏览器推上来的那条 WebSocket、落盘的资产、波形、时间轴、搜索深链。
 * 那些**一条都没有在 CI 上跑过**，v0.2.0 的包在真机上双击报错就是账单。
 *
 * **判据从此是：这条功能面在 CI 上、用预编译包、走产品自己的 HTTP/WS 路径，
 * 端到端真的能用。**
 *
 * ## 形状照抄 `cold-start-audit.mjs`，不另发明
 *
 * 屏蔽宿主 PATH、`--bundle` 指向包、用**包自带的 Node** 当解释器、
 * `OPENMEMO_POINTER_FILE` 重定向（PROTOCOL §9）、真下载真安装 ——
 * 逐条沿用。判据只要有两份实现就会漂成两条，而这里要证的恰恰是
 * 「用户下载的那个东西跟我们一直在测的那个东西一样能用」。
 *
 * ## 「CI 里没有麦克风」怎么办 —— 喂 PCM，但**一段服务端都不许绕过**
 *
 * 浏览器那一侧发的就是 **PCM16LE / 单声道 / 16 kHz 的裸字节**
 * （`apps/web/src/features/recorder/asrStream.ts`：AudioWorklet 把 Float32
 * 转成 Int16 直接 `ws.send`，没有容器、没有编码）。
 * 所以本脚本**做浏览器做的事**：连 `/ws/recorder`、等 `ready`、按真实节奏推帧、
 * 发 `{"type":"stop"}`。
 *
 * 被替掉的只有**麦克风**这一个物理设备。服务端从 upgrade 闸门、鉴权、
 * `RecorderSession`、落盘、WAV 头回填、资产入库、波形计算、离线重跑排队 ——
 * **一段都没绕过**，全部是产品自己的代码在真端口上跑。
 *
 * 音频用 whisper.cpp submodule 自带的 `samples/jfk.wav`（真人语音，11 秒），
 * 不是合成音 —— 后面要靠它真的转出词来。
 *
 * ## 「波形是真的吗」怎么证
 *
 * 本仓真实事故：写入方从来不存在，前端 `mockPeaks()` 凭空造正弦波，
 * **每位用户看到的每条波形都是编的**，界面上一个字不说。
 * 所以判据不能是"有波形数据"（正弦波也有）。
 * 本脚本手里有它推上去的**每一个字节**，于是可以**不经过服务端**独立算一遍峰值，
 * 再与 `/media/asset/<peaks uid>` 取回的 `.ompk` **逐桶逐值比对**。
 * 断言实现在 `e2e-record-assertions.mjs`，每一条都有变异证明
 * （`selftest-e2e-record.mjs`，含"送静音时该断言恒真"这种前提陷阱）。
 *
 * ## 安全边界
 *
 * · `OPENMEMO_POINTER_FILE` 一律指向临时目录 —— **绝不写** `~/.local/share/openmemo/datadir.json`（PROTOCOL §9）
 * · 数据目录走 `mkdtemp`，端口用 19790 段（避开 :10000 / 17650 / 冷启动的 19700）
 * · 不 `pkill`，只对自己 spawn 的子进程发信号
 */
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as A from './e2e-record-assertions.mjs';
import { wsConnect } from './ws-client.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const PORT = Number(arg('--port', '19790'));
const BUNDLE = arg('--bundle', null);
const MASK = !argv.includes('--no-mask');
const SAMPLE = arg('--sample', join(REPO, 'vendor', 'whisper.cpp', 'samples', 'jfk.wav'));
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const IS_WIN = process.platform === 'win32';

/** 录音采样率 —— 与 `apps/daemon/src/ws/recorder.ts` 的 `RECORD_SAMPLE_RATE` 必须一致。 */
const SAMPLE_RATE = 16_000;
/** 与浏览器 AudioWorklet 一帧的量级同数量级；20 ms = 640 字节。 */
const FRAME_MS = 20;

const ROOT = mkdtempSync(join(tmpdir(), 'openmemo-e2e-record-'));
const DATA_DIR = join(ROOT, 'data');
const POINTER = join(ROOT, 'pointer.json');
const MASK_BIN = join(ROOT, 'maskbin');
mkdirSync(DATA_DIR, { recursive: true });

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

/* 判据台账：每条关键断言的结论都记在这里，最后统一摊开并决定退出码。 */
const ledger = [];
let exitCode = 0;
function judge(name, result, { fatal = true } = {}) {
  ledger.push({ name, ok: result.ok, reason: result.reason, fatal });
  say(`   ${result.ok ? '✔' : '✘'} ${name}：${result.reason}`);
  if (!result.ok && fatal) exitCode = 1;
  return result.ok;
}
/** 观测项：照报，但**没有资格**决定红绿（与 cold-start-audit 第 6b 节同一条纪律）。 */
function observe(name, text) {
  ledger.push({ name, ok: null, reason: text, fatal: false });
  say(`   ⓘ ${name}：${text}`);
}

/* ═════════════════ 0. 宿主基线 ═════════════════ */

hdr('0. 宿主基线（屏蔽之前）—— 不屏蔽就会被悄悄借走的东西');
const HOST_TOOLS = ['ffmpeg', 'ffprobe', 'yt-dlp', 'youtube-dl', 'whisper-cli', 'sox', 'python3'];
const PATHEXT = IS_WIN ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
function which(tool, pathStr = process.env.PATH ?? '') {
  for (const dir of pathStr.split(delimiter).filter(Boolean)) {
    for (const ext of PATHEXT) {
      const full = join(dir, tool + ext);
      try {
        accessSync(full, fsConstants.X_OK);
        return full;
      } catch {
        /* 下一个 */
      }
    }
  }
  return null;
}
for (const t of HOST_TOOLS) say(`   ${t.padEnd(14)} ${which(t) || '(不在 PATH 上)'}`);

/* ═════════════════ 1. 屏蔽宿主工具 ═════════════════ */

/**
 * 标记串。它出现在 daemon 的输出里 = **产品真的去借了宿主的工具**。
 * 这一条比"自检说没借"覆盖面大：自检只认识它登记过的那几个名字。
 */
const SHIM_MARK = 'E2E-RECORD-SHIM-INVOKED';
let PATH_FOR_DAEMON = process.env.PATH ?? '';
if (MASK) {
  hdr('1. 屏蔽宿主工具（PATH 最前面放同名假二进制）');
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
      /* Windows 上 chmod 是空操作 */
    }
  }
  PATH_FOR_DAEMON = `${MASK_BIN}${delimiter}${PATH_FOR_DAEMON}`;
  say(`   已屏蔽 ${HOST_TOOLS.length} 个名字 → ${MASK_BIN}`);
  say('   shim 能通过 access(X_OK)，所以"产品会不会去借"照常发生 —— 借用变可见，不是被消除。');
} else {
  hdr('1. 未屏蔽宿主工具（--no-mask）—— 这一轮的"能用"不能当证据');
}

/* ═════════════════ 2. 起 daemon（包自带的 Node） ═════════════════ */

if (!BUNDLE) {
  console.error(
    '✘ --bundle <预编译包目录> 是**必填**的。\n' +
      '  这条腿存在的全部理由就是"用用户手里那个包跑一遍"，' +
      '拿源码树跑出来的绿灯证明不了它。',
  );
  process.exit(2);
}
const DAEMON = join(BUNDLE, 'app', 'daemon', 'dist', 'main.js');
const NODE_BIN = join(BUNDLE, 'runtime', IS_WIN ? 'node.exe' : 'node');
for (const [what, p] of [
  ['daemon 入口', DAEMON],
  ['包自带的 Node', NODE_BIN],
]) {
  if (!existsSync(p)) {
    console.error(`✘ 找不到${what}：${p} —— --bundle 指向的目录不像一个预编译包`);
    process.exit(2);
  }
}

const childEnv = {
  ...process.env,
  PATH: PATH_FOR_DAEMON,
  OPENMEMO_AUTH: 'none',
  OPENMEMO_DATA_DIR: DATA_DIR,
  // PROTOCOL §9：绝不碰全局指针。模块级设定，窗口为零。
  OPENMEMO_POINTER_FILE: POINTER,
  OPENMEMO_WEB_DIST: join(BUNDLE, 'app', 'apps', 'web', 'dist'),
  OPENMEMO_EXT_DIR: join(BUNDLE, 'ext'),
};

let proc = null;
let daemonLogs = [];
async function startDaemon(label) {
  const logs = [];
  daemonLogs = daemonLogs.concat(logs);
  proc = spawn(NODE_BIN, [DAEMON, '--data-dir', DATA_DIR, '--port', String(PORT)], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (d) => {
    logs.push(String(d));
    daemonLogs.push(String(d));
  };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        say(`   [${label}] daemon 起来了（${((i + 1) * 0.5).toFixed(1)}s）`);
        return;
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break;
  }
  say(`   [${label}] ✘ daemon 没起来，它的输出：`);
  say(
    logs
      .join('')
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n'),
  );
  throw new Error('daemon did not start');
}
async function stopDaemon() {
  if (!proc) return;
  proc.kill('SIGTERM');
  await sleep(1500);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  proc = null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═════════════════ HTTP / WS 客户端 ═════════════════ */

/**
 * 会话 cookie。
 *
 * ★ **即使 `OPENMEMO_AUTH=none`，`/ws/recorder` 的升级仍然强制要凭据** ——
 * `http/ws.ts` 那一行没有 `authRequired()` 判断（REST 主路径有）。
 * 所以这里照浏览器的做法先握一次手换 cookie，而不是去改产品放宽它。
 */
let cookie = '';
let csrf = '';

/** 发一次真实 HTTP 请求。**Host 必须是 IP 字面量** —— `localhost` 会被闸门 403。 */
function http(path, { method = 'GET', body = null, headers = {}, raw = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        headers: {
          host: `${HOST}:${PORT}`,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
          ...(cookie ? { cookie } : {}),
          ...(csrf ? { 'x-openmemo-csrf': csrf } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            const sid = /om_sid=[^;]+/.exec(setCookie.join(';'));
            if (sid) cookie = sid[0];
          }
          if (raw) {
            resolvePromise({ status: res.statusCode, headers: res.headers, body: buf });
            return;
          }
          const text = buf.toString('utf8');
          let parsed = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* 不是 JSON 就原样给 */
          }
          resolvePromise({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
/*
 * WebSocket 客户端在 `./ws-client.mjs`。
 *
 * 抽出去而不是写在这里的理由：它是这条腿里**最容易写错、又最不容易被发现写错**
 * 的一段（掩码位、扩展长度、分片、控制帧），而写错的表现是"连不上/收不到消息"
 * —— 与"产品坏了"长得一模一样。单独成模块之后它能被单独 smoke
 * （`node scripts/ci/ws-client.smoke.mjs` 对着真 daemon 跑），
 * 而不是只能靠整条腿的成败去反推。
 */

/* ═════════════════ job 轮询 ═════════════════ */

/**
 * 等一个 job 到终态。
 *
 * **绝不回退到"随便哪个 job"** —— `cold-start-audit.mjs` 在这里栽过：
 * `?? arr[0]` 让 119 MB 的下载报出 `succeeded (1.0s)`，而 1.0s 正是轮询间隔。
 * 字段名是 `jobId`（`packages/shared/src/jobs.ts`），三个名字都收但认不出就如实报。
 */
async function waitForJob(jobId, timeoutSec = 1800) {
  for (let i = 0; i < timeoutSec; i += 1) {
    await sleep(1000);
    const r = await http(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (r.status !== 200) return { state: 'unknown', detail: `HTTP ${r.status}` };
    const job = r.body?.job ?? r.body;
    const gotId = job?.jobId ?? job?.uid ?? job?.id;
    if (!job || gotId !== jobId) {
      return { state: 'unknown', detail: `端点返回的不是这个 job（要 ${jobId}，拿到 ${gotId}）` };
    }
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
      return {
        state: job.state,
        detail: job.error ? JSON.stringify(job.error).slice(0, 400) : '',
      };
    }
  }
  return { state: 'timeout', detail: `${timeoutSec}s 内没到终态` };
}

async function pullModel(id, timeoutSec = 1800) {
  const r = await http('/api/models/pull', { method: 'POST', body: { id } });
  const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
  if (!jobId) return { state: 'unknown', detail: `HTTP ${r.status} 且没有 jobId` };
  return await waitForJob(jobId, timeoutSec);
}

/* ═════════════════════════ 主流程 ═════════════════════════ */

try {
  hdr('2. 冷启动（全新数据目录）—— 解释器是**包自带的** Node');
  say(`   包：${BUNDLE}`);
  say(`   Node：${NODE_BIN}（不是宿主的 ${process.execPath}）`);
  say(`   数据目录：${DATA_DIR}（mkdtemp）`);
  say(`   指针：${POINTER}（PROTOCOL §9：绝不写全局那一份）`);
  await startDaemon('cold');

  const hs = await http('/api/auth/session', { method: 'POST', body: {} });
  csrf = hs.body?.csrf ?? '';
  say(
    `   POST /api/auth/session → HTTP ${hs.status}，authMode=${hs.body?.authMode ?? '?'}，cookie=${cookie ? '已拿到' : '**没拿到**'}`,
  );
  if (!cookie) {
    say('   ⚠️ 没拿到 om_sid —— /ws/recorder 的升级会 401（它那条路径不看 authRequired()）');
  }

  /* ── 3. 真下载：后端包 + 模型 ── */

  hdr('3. 真下载：后端包（whisper.cpp / media-tools）+ 模型');
  const cat = await http('/api/backends/catalog');
  const packs = (cat.body?.packs ?? cat.body?.items ?? []).filter((p) => p.applicable === true);
  say(`   目录里适用于本机的包 ${packs.length} 个`);
  for (const p of packs) {
    const t0 = Date.now();
    const r = await http('/api/backends/install', { method: 'POST', body: { id: p.id } });
    const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    const st = jobId ? await waitForJob(jobId) : { state: 'unknown', detail: `HTTP ${r.status}` };
    say(
      `   ${p.id.padEnd(32)} ${st.state} ${st.detail}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }

  /*
   * 模型三件套，每一件都有非它不可的理由：
   *   · sherpa 流式 —— **不装它 `/ws/recorder` 根本起不来**
   *     （`setup.ts:537` 拿不到 sherpa 就 `openStream` 返回 undefined，
   *      会话回 `ASR_STREAM_UNAVAILABLE` 并被服务端关掉）。目录里只有这一个流式 ASR。
   *   · whisper tiny（多语）—— 离线转写这一遍，词级时间戳从它来。
   *   · whisper tiny.en —— **换模型重转**那一步的第二个模型。
   *     两个都是 31 MB，挑最小的一对：这一步证的是"换得掉且不丢词级时间戳"，
   *     不是"哪个模型准"。
   * VAD **故意先不装** —— 第 7 节要先看"没装时是不是明确降级"。
   */
  const MODELS = {
    stream: 'asr/sherpa-streaming-zh-14m',
    asrA: 'asr/whisper-tiny-q5_1',
    asrB: 'asr/whisper-tiny-en-q5_1',
    vadGgml: 'vad/silero-vad-ggml',
  };
  for (const id of [MODELS.stream, MODELS.asrA, MODELS.asrB]) {
    const t0 = Date.now();
    const st = await pullModel(id);
    say(
      `   ${id.padEnd(32)} ${st.state} ${st.detail}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }

  hdr('4. 重启 daemon —— 装完不重启，pipeline 还是冷启动那一份');
  await stopDaemon();
  await startDaemon('warm');
  await http('/api/auth/session', { method: 'POST', body: {} });

  const health0 = await http('/api/health');
  const pipe = health0.body?.pipeline ?? {};
  say(`   pipeline.streamAvailable=${pipe.streamAvailable}  streamModelId=${pipe.streamModelId}`);
  say(`   pipeline.vad=${JSON.stringify(pipe.vad ?? null)}`);
  if (pipe.streamAvailable !== true) {
    say('   ⚠️ 流式引擎不可用 —— /ws/recorder 会在 ready 之前被关掉，下面整条录音链都走不成。');
  }

  /* ── 5. ★ 录音：真 WebSocket，真 PCM ── */

  hdr('5. ★ 录音：连 /ws/recorder，按浏览器的方式推 PCM16');
  if (!existsSync(SAMPLE)) {
    throw new Error(`样本不存在：${SAMPLE} —— submodule 没 checkout？`);
  }
  const wav = readFileSync(SAMPLE);
  /*
   * jfk.wav 是 16 kHz 单声道 PCM16，头 44 字节。取它的 PCM 段直接当上行内容 ——
   * 这正是浏览器 AudioWorklet 会送上来的东西（Int16 裸字节，无容器）。
   * 末尾补 1 秒静音：真实录音的收尾本来就有静音，而流式引擎靠它判句尾。
   */
  const speech = wav.subarray(44);
  const tail = Buffer.alloc(SAMPLE_RATE * 2);
  const PCM = Buffer.concat([speech, tail]);
  say(`   样本 ${SAMPLE}`);
  say(
    `   上行 PCM ${PCM.length} 字节 = ${(PCM.length / 2 / SAMPLE_RATE).toFixed(2)} 秒（含 1.00 秒收尾静音）`,
  );

  const ws = await wsConnect({
    host: HOST,
    port: PORT,
    path: `/ws/recorder?language=en&title=${encodeURIComponent('CI 录音 e2e')}`,
    cookie,
  });
  const messages = [];
  let closed = false;
  ws.onMessage((opcode, payload) => {
    if (opcode !== 0x1) return;
    try {
      messages.push(JSON.parse(payload.toString('utf8')));
    } catch {
      messages.push({ type: 'unparsable', raw: payload.toString('utf8').slice(0, 200) });
    }
  });
  ws.onClose(() => {
    closed = true;
  });

  // ★ 必须等 ready 再推流：ready 之前到达的二进制帧被服务端**静默丢弃**（http/ws.ts）
  const readyAt = Date.now();
  while (!messages.some((m) => m.type === 'ready') && Date.now() - readyAt < 20_000 && !closed) {
    await sleep(20);
  }
  const ready = messages.find((m) => m.type === 'ready');
  if (!ready) {
    judge('录音会话', A.checkRecorderSession({ messages }));
    throw new Error('没等到 ready —— 录音链后面的每一步都无从谈起');
  }

  const frameBytes = (SAMPLE_RATE * 2 * FRAME_MS) / 1000;
  let sent = 0;
  const t0 = Date.now();
  for (let off = 0; off < PCM.length; off += frameBytes) {
    const frame = PCM.subarray(off, Math.min(off + frameBytes, PCM.length));
    ws.sendBinary(frame);
    sent += frame.length;
    // 按真实时间节奏推 —— 流式识别的端点检测依赖时间，灌太快不是浏览器的行为
    const due = t0 + (sent / 2 / SAMPLE_RATE) * 1000;
    const lag = due - Date.now();
    if (lag > 0) await sleep(lag);
  }
  say(`   推完 ${sent} 字节 / ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  ws.sendText(JSON.stringify({ type: 'stop' }));
  const stopAt = Date.now();
  while (!messages.some((m) => m.type === 'stopped') && Date.now() - stopAt < 120_000 && !closed) {
    await sleep(50);
  }
  ws.close();

  const stopped = messages.find((m) => m.type === 'stopped');
  judge(
    '录音会话协议（ready → partial/final → stopped，零 overrun 零 error）',
    A.checkRecorderSession({ messages, sampleRate: SAMPLE_RATE }),
  );
  const noteUid = ready.noteUid;
  observe(
    '流式识别结果',
    `partial×${messages.filter((m) => m.type === 'partial').length} final×${messages.filter((m) => m.type === 'final').length}；` +
      `segmentCount=${stopped?.segmentCount ?? '?'}；rerunJobUid=${stopped?.rerunJobUid ?? 'null'}` +
      `（流式模型是中文的、样本是英语 —— 识别内容不作判据，这一步证的是"音频真的被收到并处理了"）`,
  );

  /* ── 6. ★ 资产、Range、波形 ── */

  hdr('6. ★ 落盘资产 / Range 回放 / **波形是不是真的**');
  const detail = (await http(`/api/notes/${noteUid}`)).body;
  say(
    `   GET /api/notes/${noteUid} → kind=${detail?.kind} status=${detail?.status} 资产 ${(detail?.assets ?? []).length} 条`,
  );
  for (const a of detail?.assets ?? []) {
    say(`     role=${String(a.role).padEnd(10)} state=${a.state} bytes=${a.bytes} url=${a.url}`);
  }
  judge('录音落盘成可播放的资产', A.checkAudioAsset({ detail, sentPcmBytes: PCM.length }));

  const audioAsset = (detail?.assets ?? []).find((a) => a.role === 'original');
  if (audioAsset) {
    const total = PCM.length + 44;
    const full = await http(audioAsset.url, { raw: true });
    judge('整段音频取得回来', {
      ok: full.status === 200 && full.body.length === total,
      reason: `HTTP ${full.status}，${full.body.length} 字节（期望 ${total}）`,
    });
    judge('落盘的 PCM 与推上去的逐字节相同', {
      ok: full.status === 200 && full.body.subarray(44).equals(PCM),
      reason:
        full.status === 200 && full.body.subarray(44).equals(PCM)
          ? `${PCM.length} 字节一致`
          : '读回来的音频内容与推上去的不同 —— 中途被改写或丢帧',
    });

    // Range：播放器拖进度条走的就是这条路
    const start = 44 + 2 * SAMPLE_RATE; // 第 1.0 秒处
    const end = start + 32_000 - 1; // 取 1 秒
    const part = await http(audioAsset.url, {
      raw: true,
      headers: { range: `bytes=${start}-${end}` },
    });
    judge(
      '按时间偏移做 Range 回放（转写稿片段 → 音频位置的协议落点）',
      A.checkRangeSlice({
        status: part.status,
        headers: part.headers,
        body: part.body,
        expected: PCM.subarray(start - 44, end - 44 + 1),
        start,
        end,
        totalBytes: total,
      }),
    );
  }

  const peaksAsset = (detail?.assets ?? []).find((a) => a.role === 'peaks');
  if (!peaksAsset) {
    judge('波形是真的从音频算出来的', {
      ok: false,
      reason: '笔记上没有 role=peaks 的资产 —— 前端只能画一条基线（历史上它就是靠这个缺口在造假）',
    });
  } else {
    const ompk = (await http(peaksAsset.url, { raw: true })).body;
    judge(
      '★ 波形是真的从音频算出来的（逐桶与独立计算比对）',
      A.checkPeaksAreRealAudio({ ompk, pcm: PCM }),
    );
  }

  /* ── 7. ★ 转写 + 词级时间戳（此时 VAD 未装 → 应当明确降级）── */

  hdr('7. ★ 转写：真 whisper-cli 子进程 → 分段 → 词级时间戳（VAD 尚未安装）');

  if (stopped?.rerunJobUid) {
    const st = await waitForJob(stopped.rerunJobUid);
    observe('停止录音后自动排的离线重跑', `${st.state} ${st.detail}`);
  } else {
    observe(
      '停止录音后自动排的离线重跑',
      '没有排（`recorder.ts` 只在流式产出 ≥1 段时才排）—— 下面改用产品自己的「重新转写」通道',
    );
  }

  /**
   * 走**产品自己的重新转写端点**，显式指定模型。
   * 不用 `/api/notes/import` 另建一条笔记：那样验的就不是"录音这条笔记能不能重转"了，
   * 而这正是本轮要问的东西之一。
   */
  async function retranscribe(modelId, label) {
    const r = await http(`/api/notes/${noteUid}/retranscribe`, {
      method: 'POST',
      body: { modelId, language: 'en' },
    });
    say(
      `   POST /api/notes/${noteUid}/retranscribe {modelId:${modelId}} → HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`,
    );
    if (r.status !== 202) {
      return { ok: false, status: r.status, body: r.body };
    }
    const st = await waitForJob(r.body.jobUid);
    say(`   [${label}] 转写 job：${st.state} ${st.detail}`);
    const tr = (await http(`/api/notes/${noteUid}/transcript`)).body;
    return { ok: true, status: r.status, job: st, transcript: tr };
  }

  const runA = await retranscribe(MODELS.asrA, 'A');
  judge('录音笔记可以被「重新转写」（input_url 不为空）', {
    ok: runA.ok,
    reason: runA.ok
      ? 'HTTP 202，job 排上了'
      : `HTTP ${runA.status} ${JSON.stringify(runA.body).slice(0, 200)} —— ` +
        `409/NO_SOURCE_INPUT 意味着这个包里 media_sources.input_url 是 NULL，` +
        `于是每一条录音笔记的「重新转写」都永久不可用（canRetranscribe 恒 false）`,
  });

  let segsA = [];
  if (runA.ok) {
    segsA = runA.transcript?.segments ?? [];
    say(
      `   转写稿：engine=${runA.transcript?.transcript?.engineId} model=${runA.transcript?.transcript?.modelId} 段数=${segsA.length}`,
    );
    const text = segsA
      .map((s) => String(s.text ?? ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    say(`   文本（前 200 字）：${text.slice(0, 200) || '(空)'}`);
    judge('★ 词级时间戳真的落库并发得出来', A.checkWordTimestamps(segsA));

    const vad0 = (await http('/api/health')).body?.pipeline?.vad;
    judge(
      '★ 没装 VAD 时是**明确降级**，不是静默出错',
      A.checkVadDegradedExplicitly({ vad: vad0, segments: segsA }),
    );
  }

  /* ── 8. ★ 换模型重转：词级时间戳不许丢 ── */

  hdr('8. ★ 换一个模型再转一次 —— 词级时间戳不许丢（T-164 ④ 的回归护栏）');
  if (runA.ok) {
    const runB = await retranscribe(MODELS.asrB, 'B');
    if (!runB.ok) {
      judge('换模型重转', { ok: false, reason: `HTTP ${runB.status}` });
    } else {
      say(
        `   转写稿：model=${runB.transcript?.transcript?.modelId} 段数=${(runB.transcript?.segments ?? []).length}`,
      );
      judge(
        '★ 模型真的换了 **且** 词级时间戳还在',
        A.checkRetranscribeKeptWords({
          before: { transcript: runA.transcript?.transcript, segments: segsA },
          after: {
            transcript: runB.transcript?.transcript,
            segments: runB.transcript?.segments ?? [],
          },
        }),
      );
      segsA = runB.transcript?.segments ?? segsA;
    }
  } else {
    observe('换模型重转', '上一步就没排上队，这一步无从谈起（不当绿灯记）');
  }

  /* ── 9. ★ 装上 VAD 再跑一遍 ── */

  hdr('9. ★ 装上 whisper.cpp 能加载的 VAD 权重，再转一次');
  const vadPull = await pullModel(MODELS.vadGgml);
  say(`   ${MODELS.vadGgml} ${vadPull.state} ${vadPull.detail}`);
  await stopDaemon();
  await startDaemon('vad');
  await http('/api/auth/session', { method: 'POST', body: {} });
  const vadOn = (await http('/api/health')).body?.pipeline?.vad;
  judge('★ 装了 VAD 之后真的按静音切分', A.checkVadActive(vadOn));

  const runC = await retranscribe(MODELS.asrA, 'VAD');
  if (runC.ok) {
    const segsC = runC.transcript?.segments ?? [];
    judge('VAD 切分下转写照样跑通并保留词级时间戳', {
      ok: runC.job.state === 'succeeded' && A.checkWordTimestamps(segsC).ok,
      reason: `job=${runC.job.state}；${A.checkWordTimestamps(segsC).reason}`,
    });
    segsA = segsC.length > 0 ? segsC : segsA;
  } else {
    judge('VAD 切分下转写照样跑通', { ok: false, reason: `重转没排上：HTTP ${runC.status}` });
  }

  /* ── 10. ★ 时间轴联动 + 搜索 ?t= ── */

  hdr('10. ★ 时间轴联动（片段 ↔ 音频）与搜索结果的 ?t= 深链');
  const detail2 = (await http(`/api/notes/${noteUid}`)).body;
  const audio2 = (detail2?.assets ?? []).find((a) => a.role === 'original');
  const audioDurationMs = audio2?.durationMs ?? Math.round((PCM.length / 2 / SAMPLE_RATE) * 1000);
  judge(
    '★ 段落与音频在同一条时间轴上、有序不重叠（双向定位的前提）',
    A.checkTimelineSegments({ segments: segsA, audioDurationMs }),
  );

  const anchors = await http(`/api/notes/${noteUid}/anchors`);
  observe(
    'GET /api/notes/:uid/anchors',
    `HTTP ${anchors.status}，${(anchors.body?.anchors ?? []).length} 个锚点`,
  );

  /*
   * 搜索深链：前端 `SearchPage.tsx` 拼的是 `/notes/<uid>?t=<hit.startMs>`。
   * 服务端这一侧要成立的是「命中带 startMs，且它真的是某一段的起点」。
   * 检索词从**转出来的文本里现取**，不写死 —— 写死的词一旦模型换了就永远搜不到，
   * 那种红是我的夹具红，不是产品红。
   */
  const needle = pickNeedle(segsA);
  if (!needle) {
    judge('搜索结果带 ?t= 跳到时间点', {
      ok: false,
      reason: '转写稿里挑不出可检索的词 —— 前提不成立',
    });
  } else {
    const sr = await http(`/api/search?q=${encodeURIComponent(needle)}&limit=20`);
    say(
      `   GET /api/search?q=${needle} → HTTP ${sr.status}，${(sr.body?.hits ?? []).length} 条命中`,
    );
    judge(
      '★ 搜索命中带得出 ?t= 要用的时间点，且它落在真实段落起点上',
      A.checkSearchSeek({ hits: sr.body?.hits ?? [], noteUid, segments: segsA, needle }),
    );
  }

  /* ── 11. 网页壳 ── */

  hdr('11. 网页壳真的发得出来（用户抱怨的"界面打不开"的服务端一侧）');
  const index = await http('/', { raw: true, headers: { accept: 'text/html' } });
  const html = index.body.toString('utf8');
  const assetRefs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  let assetOk = 0;
  for (const ref of assetRefs.slice(0, 8)) {
    const r = await http(ref, { raw: true });
    if (r.status === 200 && r.body.length > 0) assetOk += 1;
  }
  judge('网页 bundle 由 daemon 真的发得出来', {
    ok: index.status === 200 && assetRefs.length > 0 && assetOk === Math.min(assetRefs.length, 8),
    reason: `GET / → HTTP ${index.status}，${html.length} 字节 HTML，引用 ${assetRefs.length} 个 /assets/*，取样 ${Math.min(assetRefs.length, 8)} 个成功 ${assetOk} 个`,
  });

  /* ── 12. 借宿主工具：一个都不许 ── */

  hdr('12. ★ 借宿主工具：一个都不许');
  const sc = await http('/api/selfcheck');
  const checks = sc.body?.checks ?? sc.body?.results ?? [];
  const logText = daemonLogs.join('');
  const shimHits = [...logText.matchAll(new RegExp(`${SHIM_MARK} (\\S+)`, 'g'))].map((m) => m[1]);
  say(`   GET /api/selfcheck → HTTP ${sc.status}，${checks.length} 项`);
  for (const c of checks.filter((x) => String(x.id).startsWith('tool.'))) {
    say(
      `     ${String(c.id).padEnd(22)} ${String(c.status).padEnd(6)} ${String(c.detail ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 90)}`,
    );
  }
  judge('★ 一个宿主工具都没借', A.checkNoBorrowedTools({ checks, shimHits }));
} catch (e) {
  say('');
  say(`✘ e2e-record 中断：${e.message}`);
  if (proc) say(`   daemon: exitCode=${proc.exitCode} signal=${proc.signalCode}`);
  if (daemonLogs.length) {
    say('   daemon 最后 60 行：');
    say(
      daemonLogs
        .join('')
        .split('\n')
        .slice(-60)
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
  exitCode = 1;
} finally {
  await stopDaemon();

  hdr('结论台账');
  for (const e of ledger) {
    const mark = e.ok === null ? 'ⓘ' : e.ok ? '✔' : '✘';
    say(`   ${mark} ${e.name}`);
    say(`      ${String(e.reason).replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  const red = ledger.filter((e) => e.ok === false && e.fatal);
  say('');
  say(
    red.length === 0
      ? `✔ ${ledger.filter((e) => e.ok === true).length} 条关键断言全部成立`
      : `✘ ${red.length} 条关键断言不成立：${red.map((e) => e.name).join('；')}`,
  );
  say(`   数据目录 ${DATA_DIR} 留在 runner 上，随 runner 一起销毁。`);
}

/** 从转写稿里挑一个够长、够独特的词当检索词。挑不出来就返回 null（**不编一个**）。 */
function pickNeedle(segments) {
  const counts = new Map();
  for (const s of segments) {
    for (const w of String(s.text ?? '').split(/[^\p{L}\p{N}]+/u)) {
      if (w.length < 5) continue;
      counts.set(w.toLowerCase(), (counts.get(w.toLowerCase()) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[0].length - a[0].length);
  return sorted.length > 0 ? sorted[0][0] : null;
}

process.exit(exitCode);
