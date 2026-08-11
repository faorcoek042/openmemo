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

import { spawnDaemon, killTree, killTreeHard, launcherPath } from './launcher-spawn.mjs';
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
/**
 * ★ 覆盖面上报：把本轮**没能被评估**的断言条数落盘成一个小文件，供 `attest` job
 * 跨平台求和（`sum-undecided.mjs`）后传给 `emit-e2e-attestation.mjs --undecided`。
 * 文件形状 `{ "unknowns": N }` 与 runtime / browser 两条腿**逐字相同**，
 * 好让三条腿共用同一个求和脚本（它的 `--field` 默认就是 `unknowns`）。
 *
 * ⚠️ 只数 `kind === 'undecided'` 的条目，**不数 `note()`** —— 见上面台账那一段。
 */
const UNDECIDED_OUT = arg('--undecided-out', null);
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

/*
 * 判据台账 —— **三种条目，三个互不相通的写入口**。
 *
 * ## 为什么非要分成三个函数（这一段是判据，不是风格）
 *
 * 这里以前只有 `judge()` 和 `observe()` 两个入口，而 `observe()` 一个桶里
 * 装了**语义完全相反**的两类东西：
 *   · 「换模型重转」—— 上一步没排上队，**那条断言根本没被评估**；
 *   · 「流式识别结果 partial×N final×M」/「anchors 端点回了 200」
 *     —— 只是把观察到的事实记一笔，**本来就不是断言**。
 * 两者在台账里长得一模一样（都是 `ok: null`），区别只活在**人写的一句注释**里。
 *
 * 于是「本轮有几条断言没被验到」（凭证的 `undecided` 字段）没法从台账里算出来：
 * 照 `ok === null` 数会把「我记了一笔」算成「我没验到」——**报一个虚高的未决数
 * 比不报更糟，不报至少是诚实的空缺，虚高是一句假话。**
 *
 * ## 怎么让"混淆"写不出来，而不是靠约定
 *
 *   1. **三个函数，签名各不相同**：`undecided()` 强制你写出「被跳过的是哪条断言」
 *      和「前提为什么不成立」两句话——凑不出这两句，说明它压根不是未决，
 *      你要找的是 `note()`。
 *   2. **只有 `judge()` 写 `ok` 字段**。`undecided` / `note` 条目**根本没有 `ok`**，
 *      所以任何"只认识两种状态"的下游（`e.ok === true` / `=== false` / `!e.ok`）
 *      都不可能把它们误读成判决，也不可能从 `ok` 里数出未决——
 *      想数未决**只能**显式问 `kind === 'undecided'`。
 *      这正是这一周反复出现的那个病（三态值被二态层消费掉）在本文件里的解法：
 *      把第三态从那个二态字段里**搬走**，而不是在旁边写注释提醒别搞混。
 */
const ledger = [];
let exitCode = 0;
/** 一条**真的被评估过**的断言。只有它写 `ok`，也只有它决定红绿。 */
function judge(name, result, { fatal = true } = {}) {
  ledger.push({ kind: 'verdict', name, ok: result.ok, reason: result.reason, fatal });
  say(`   ${result.ok ? '✔' : '✘'} ${name}：${result.reason}`);
  if (!result.ok && fatal) exitCode = 1;
  return result.ok;
}
/**
 * 一条**没能被评估**的断言：前提在这台 runner / 这一轮里构造不出来。
 * 它进凭证的 `undecided` 计数 —— 那个数回答的问题是「这条腿跑绿了，
 * 但有几条断言其实什么都没证明」。
 *
 * @param skippedAssertion 被跳过的**那条断言**叫什么（不是"这一步"叫什么）
 * @param whyPremiseFailed 前提**为什么**不成立（要能让人判断它什么时候会变回可评估）
 */
function undecided(skippedAssertion, whyPremiseFailed) {
  ledger.push({
    kind: 'undecided',
    name: skippedAssertion,
    reason: `前提不成立，这条断言没有被评估：${whyPremiseFailed}`,
    fatal: false,
  });
  say(`   ？ ${skippedAssertion}：**未决** —— ${whyPremiseFailed}`);
}
/**
 * 纯描述性观测：把观察到的事实记一笔。
 * **它本来就不是断言**，所以既不决定红绿（与 cold-start-audit 第 6b 节同一条纪律），
 * 也**永远不计入 undecided** —— 没有"没能评估"这回事，因为压根没有要评估的东西。
 */
function note(name, text) {
  ledger.push({ kind: 'note', name, reason: text, fatal: false });
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
/*
 * ★★ 从**启动器**起 daemon（`start.cmd` / `OpenMemo.command` / `start.sh`），
 *   不再直接起 `dist/main.js`。完成度审计查出的第四类「CI 结构上看不见」：
 *   凡是只有启动器才做的事（WEB_DIST / EXT_DIR / **BUNDLED_PROBE_DIR** / 工作目录 /
 *   macOS quarantine），CI 直接起入口时**结构上都看不见**。
 *   入口与收尾都在 `./launcher-spawn.mjs`，本文件因此不再出现 daemon 入口路径。
 */
const NODE_BIN = join(BUNDLE, 'runtime', IS_WIN ? 'node.exe' : 'node');
for (const [what, p] of [
  // 用户双击的就是启动器 —— 它不在，这个包对用户来说打不开。
  ['启动器', launcherPath(BUNDLE)],
  ['包自带的 Node', NODE_BIN],
]) {
  if (!existsSync(p)) {
    console.error(`✘ 找不到${what}：${p} —— --bundle 指向的目录不像一个预编译包`);
    process.exit(2);
  }
}

/*
 * ⚠️ D-20 §11.2（5d3cc8c）之后，daemon **每次启动**都会把随包出厂的模型
 * 自动导入 ArtifactStore（`state.ts:565-566` → `reconcileModels()`），VAD 也在
 * 那一批里 —— "新建一个空数据目录"不再等于"没有 VAD"，第 7 节原来靠这个假设
 * 造"没装 VAD"的现场，现在造不出来了（实际 chunking 变成 vad，不是 fixed）。
 *
 * 这里不是产品行为的问题（§11.2 是设计如此），是这条判据的前提过时了。
 * ⚠️ 判据本身不能删 —— "没装 VAD 时必须明确降级到固定窗口、不能静默出别的错"
 * 仍然是真实的、必须守住的行为。
 *
 * 修法：`OPENMEMO_BUNDLED_MODELS_DIR` 是既有的、非启动器专属的环境变量
 * （`modelReconcile.ts:106`，与 `OPENMEMO_BUNDLED_WHISPER_DIR` 同一族），
 * 指向一个存在但空的目录时，`resolveBundledModelsDir()` 原样返回它，
 * 随包模型逐个 `fs.stat` 全部 ENOENT → 静默跳过、不导入任何东西
 * （`modelReconcile.ts:148-151` 的 `catch { break }` + `:186` 的
 * `if (!sawSomething) continue`，这本来就是"开发树里没有随包模型"这个
 * 分支要处理的合法状态，不是新造的后门）。全程 childEnv 共用同一个对象，
 * cold/warm 两次重启都吃得到这个空目录，第 9 节显式 `/api/models/pull`
 * 装 VAD 时走的是下载安装那条路径，不受这个变量影响，互不干扰。
 * 不在 `launcher-spawn.mjs` 的 `LAUNCHER_OWNED_ENV` 里，预设不会被
 * `assertNoLauncherOverrides()` 拦。
 */
const EMPTY_BUNDLED_MODELS_DIR = join(ROOT, 'empty-bundled-models');
mkdirSync(EMPTY_BUNDLED_MODELS_DIR, { recursive: true });

const childEnv = {
  ...process.env,
  PATH: PATH_FOR_DAEMON,
  OPENMEMO_AUTH: 'none',
  OPENMEMO_DATA_DIR: DATA_DIR,
  // PROTOCOL §9：绝不碰全局指针。模块级设定，窗口为零。
  OPENMEMO_POINTER_FILE: POINTER,
  OPENMEMO_BUNDLED_MODELS_DIR: EMPTY_BUNDLED_MODELS_DIR,
  // ⚠️ WEB_DIST / EXT_DIR / BUNDLED_PROBE_DIR 归**启动器**设 —— 这里预设就等于又把它架空。
};

let proc = null;
let daemonLogs = [];
async function startDaemon(label) {
  const logs = [];
  daemonLogs = daemonLogs.concat(logs);
  const _started = spawnDaemon({
    bundleDir: BUNDLE,
    args: ['--data-dir', DATA_DIR, '--port', String(PORT)],
    env: childEnv,
  });
  say(`   起法：${_started.note}`);
  proc = _started.proc;
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
  // PROTOCOL §11：按 pid 收整棵树。Windows 上 cmd.exe 底下的 node.exe 只有 /T 带得走。
  say(`   收尾：${killTree(proc.pid)}`);
  await sleep(1500);
  if (proc.exitCode === null) killTreeHard(proc.pid);
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
function httpOnce(path, { method = 'GET', body = null, headers = {}, raw = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        /*
         * ★ `agent: false` —— **不复用连接**。
         *
         * 第一次真跑（run 31246863443）就死在这条上：装到第 3 个后端包时
         * `read ECONNRESET`，而 daemon **是活着的**（exitCode=null，日志停在「就绪」）。
         * Node 19 起全局 agent 默认 `keepAlive: true`，于是一个被对端回收的空闲 socket
         * 被拿来发下一个请求 —— 典型的 keep-alive 竞态。
         * cold-start-audit 当时是靠重试盖过去的；这里连成因一起去掉：
         * 每个请求一条新连接。请求量只有几十个，代价可以忽略，
         * 而**"测试客户端自己的脆弱"绝不该被记成产品的失败**。
         * （`apps/daemon/src/http/media.test.ts` 里为同一个理由也写了 `agent: false`。）
         */
        agent: false,
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

/**
 * 带重试的版本。**重试的是网络层的抖动，不是产品的失败**：
 * 只对连接类错误重试，任何拿到了 HTTP 状态码的响应（哪怕 500）都原样返回 ——
 * 把 500 重试掉才是真的在掩盖问题。连续 4 次都连不上仍然抛出去。
 */
async function http(path, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await httpOnce(path, opts);
    } catch (e) {
      const code = e?.code ?? '';
      const transient =
        ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(code) ||
        /socket hang up/i.test(String(e?.message ?? ''));
      if (!transient) throw e;
      lastErr = e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw new Error(`${path}: ${lastErr?.message ?? '连不上'}（已重试 4 次；daemon 可能已经死了）`);
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
   * ★ 地面真相：**不信 job 的自述**，另问一次"到底装上了哪些"。
   *
   * 这一步不是保险起见。`cold-start-audit.mjs` 有过一次真实的假绿：
   * 119 MB 的下载报 `succeeded (1.0s)`，而 1.0s 恰好是轮询间隔 ——
   * 也就是说它第一次轮询就"看到成功了"。那次的成因是取 job 时
   * `?? arr[0]` 拿别人的成功顶了上来。
   * 这里的 `waitForJob` 认不出就如实报认不出、绝不回退，但**"我没写那个 bug"
   * 不是一条证据**。所以照样用一个独立来源核对一遍。
   */
  const inst = await http('/api/backends/installed');
  const instArr = Array.isArray(inst.body)
    ? inst.body
    : (inst.body?.packs ?? inst.body?.installed ?? []);
  const installedIds = new Set(instArr.map((x) => x.id ?? x.packId));
  say('');
  say(`   ── 独立核对：/api/backends/installed 返回 ${instArr.length} 条 ──`);
  for (const p of packs) {
    say(`   ${p.id.padEnd(32)} ${installedIds.has(p.id) ? '✅ 真的在已安装列表里' : '❌ 不在'}`);
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

  // 同上：模型也要独立核对一次，而不是只信 job 说它成功了。
  const minst = await http('/api/models/installed');
  const minstArr = Array.isArray(minst.body)
    ? minst.body
    : (minst.body?.models ?? minst.body?.installed ?? []);
  const minstIds = new Set(minstArr.map((m) => m.id ?? m.modelId));
  say('');
  say(`   ── 独立核对：/api/models/installed 返回 ${minstArr.length} 条 ──`);
  for (const id of [MODELS.stream, MODELS.asrA, MODELS.asrB]) {
    say(`   ${id.padEnd(32)} ${minstIds.has(id) ? '✅ 真的在已安装列表里' : '❌ 不在'}`);
  }
  /*
   * 这三个模型是后面每一步的前提：流式模型决定 `/ws/recorder` 起不起得来，
   * 两个 whisper 决定"换模型重转"有没有第二个模型可换。
   * 缺了就**当场说清楚**，而不是让后面的失败去替它背锅。
   */
  judge('三个模型都真的装上了（独立核对，不信 job 自述）', {
    ok: [MODELS.stream, MODELS.asrA, MODELS.asrB].every((id) => minstIds.has(id)),
    reason: [MODELS.stream, MODELS.asrA, MODELS.asrB]
      .map((id) => `${id}=${minstIds.has(id) ? '在' : '**不在**'}`)
      .join('，'),
  });

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
  /*
   * 这是 `note()` 不是 `undecided()`：它下面**没有任何一条断言被跳过**。
   * 这一步该判的东西上一行已经判完了（`checkRecorderSession`）；
   * 这里只是把"服务端到底吐了几条 partial/final、排没排重跑"记进台账，
   * 好让日后看日志的人知道那一轮的现场长什么样。识别内容本来就不作判据
   * （流式模型是中文的、样本是英语），所以不存在"没能评估"这回事。
   */
  note(
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

  /*
   * ★★ 这一条从"观测"翻成了**判据**。
   *
   * 它原本是 `observe()` —— 只打印、不变红。当时的理由是：三平台都红，而修它要动
   * 引擎/模型选型，不该由我单方面决定。Manager 裁了「修」，修完之后这条就没有理由
   * 继续只打印了 —— 一条只打印不变红的东西，下次退化没有人会知道。
   *
   * 它守的是用户视角最直白的那句话：**录完音，产品自己发起的那次转写必须成功。**
   * 用户没做错任何事，这一步失败他甚至看不到原因（在修复前只有一行
   * `whisper-cli exited with code 3`）。
   */
  if (stopped?.rerunJobUid) {
    const st = await waitForJob(stopped.rerunJobUid);
    if (st.state !== 'succeeded') {
      const full = await http(`/api/jobs/${encodeURIComponent(stopped.rerunJobUid)}`);
      const err = (full.body?.job ?? full.body)?.error;
      if (err) {
        say('   ── 自动重跑 job.error 全文 ──');
        for (const line of JSON.stringify(err, null, 2).slice(0, 4000).split('\n')) {
          say(`      ${line}`);
        }
      }
    }
    judge('★ 停止录音后，产品自己发起的那次离线重跑必须成功', {
      ok: st.state === 'succeeded',
      reason:
        st.state === 'succeeded'
          ? 'succeeded'
          : `${st.state} —— ${st.detail || '(无 error 详情)'}；` +
            `用户录完音什么都没做错，这一步失败他只会看到一条转写任务挂了`,
    });
  } else {
    judge('★ 停止录音后必须自动排一次离线重跑', {
      ok: false,
      reason:
        `没有排（stopped.segmentCount=${stopped?.segmentCount ?? '?'}）。` +
        `recorder.ts 只在流式产出 ≥1 段时才排 —— 所以这里红有两种读法：` +
        `要么排队那一段坏了，要么流式引擎这一轮一段都没识别出来。两种都要查。`,
    });
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
    /*
     * 失败时把 job.error **全文**再取一次。`waitForJob` 截到 400 字符，
     * 对轮询摘要够用，对定位远远不够 —— 第一轮真跑就正好断在最关键的那个字上
     * （`whisper-cli exited with code 3\nload_backend: lo` …）。
     */
    if (st.state !== 'succeeded') {
      const full = await http(`/api/jobs/${encodeURIComponent(r.body.jobUid)}`);
      const err = (full.body?.job ?? full.body)?.error;
      if (err) {
        say(`   [${label}] ── job.error 全文 ──`);
        for (const line of JSON.stringify(err, null, 2).slice(0, 4000).split('\n')) {
          say(`      ${line}`);
        }
      }
    }
    /*
     * ★ 每转一次都把资产列表重新摊开，并**再确认一次原始录音还播得出来**。
     *
     * 这不是凑数：第一轮真跑（run 31247324575）里，macOS 与 Windows 上
     * **第一次重转成功、之后每一次都 `no media source can handle this input`**，
     * 而 Linux 三次全过。两者的差别很可能在
     * `archiveIntoMedia` 那句「已经在 media/ 里就别动它」——
     * 它是拿 `relative()` 做**字符串**判断，而 macOS 的 `/var` 是指向
     * `/private/var` 的符号链接、Windows 的 tmpdir 是 8.3 短名（`RUNNER~1`）。
     * 判断落空的话，录音会被 `rename()` 搬走，于是它自己的 `input_url` 指空。
     *
     * 但这仍然只是**假设**。所以这里不写结论，写一个能分辨真假的探针：
     * 如果录音被搬走了，`/media/asset/<uid>` 会当场取不到字节 —— 那就是证据。
     * 顺带它本身也是一条用户可见的性质：**重转一次不许把原始录音弄丢**。
     */
    const after = (await http(`/api/notes/${noteUid}`)).body;
    say(`   [${label}] 转写后的资产：`);
    for (const a of after?.assets ?? []) {
      say(`      role=${String(a.role).padEnd(10)} state=${a.state} bytes=${a.bytes} url=${a.url}`);
    }
    const orig = (after?.assets ?? []).find((x) => x.role === 'original');
    if (orig) {
      const probe = await http(orig.url, { raw: true, headers: { range: 'bytes=0-43' } });
      judge(`[${label}] 重转之后原始录音仍然取得到字节（rel_path 没有被搬空）`, {
        ok: probe.status === 206 && probe.body.length === 44,
        reason:
          probe.status === 206
            ? `HTTP 206，WAV 头 44 字节取得到`
            : `HTTP ${probe.status} —— 录音文件不在 rel_path 指的位置了；` +
              `这正是后续「重新转写」报 no media source can handle this input 的成因候选`,
      });
    } else {
      /*
       * ★ 这个 `else` 以前**不存在**，而它是本条腿里**唯一一处能在"整轮全绿"里
       *   发生的空缺** —— 其余的跳过都被某条 judge 判红兜住了，这一处没有。
       *
       *   走到这里意味着：第 6 节确认过 `role=original` 存在（否则
       *   `checkAudioAsset` 当场判红），而重转之后它**从笔记上消失了**。
       *   上面那条探针是专门去分辨"录音被 archiveIntoMedia 搬走了"的，
       *   资产行整个不见时它就跳过了，而后面第 10 节拿 `audio2?.durationMs ?? 算出来的值`
       *   有兜底、不会红 —— 于是这一轮会**绿着走完，却少验了一条**。
       *   记成未决，让它出现在凭证的 undecided 里；改成判红是另一个决定
       *   （会改变这条腿的红绿口径），不在本次范围内。
       */
      undecided(
        `[${label}] 重转之后原始录音仍然取得到字节（rel_path 没有被搬空）`,
        `重转之后笔记上已经没有 role=original 的资产了（现有：` +
          `${(after?.assets ?? []).map((x) => x.role).join(',') || '(空)'}）—— ` +
          `探针没有对象可探，"录音还在不在原位"这句话既没被证实也没被证伪`,
      );
    }
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
  } else {
    /*
     * ★ 这个 `else` 以前**不存在** —— `runA` 没排上队时，上面两条断言
     *   （词级时间戳、没装 VAD 时明确降级）就这么**从台账里凭空消失**，
     *   一行痕迹都不留。那比未决更难查：未决至少说得出"我没验到"，
     *   而消失连"这里本该有两条"都说不出来。
     *   这一步不改判决（这一轮早已被上面那条 judge 判红），只是把空缺记下来。
     */
    undecided(
      '★ 词级时间戳真的落库并发得出来',
      '第 7 节的重转没排上队，一份稿子都没拿到，"词级时间戳在不在"无从谈起',
    );
    undecided(
      '★ 没装 VAD 时是**明确降级**，不是静默出错',
      '"明确降级"的判据里包含"降级之后仍然转得出文本"，而这一轮压根没转成，' +
        '分不出是"降级坏了"还是"重转本身就没排上"',
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
    /*
     * 这一条是**真·未决**，不是观测：`checkRetranscribeKeptWords` 要的前提
     * （第 7 节那次重转排上了队、产出了一份带词级时间戳的基线稿）根本不存在，
     * 所以它没有被评估过 —— 既不是通过也不是失败。
     * ⚠️ 走到这里时第 7 节的 `judge('录音笔记可以被「重新转写」…')` **已经判红**，
     *    所以这一条只会出现在一次注定失败的运行里（这条性质见 e2e-record.yml
     *    attest job 的注释，它决定了绿跑里这个数是不是恒为 0）。
     */
    undecided(
      '★ 模型真的换了 **且** 词级时间戳还在',
      '第 7 节的重转就没排上队（HTTP 非 202），没有第一份稿子可以拿来比对，' +
        '"换没换成"与"词有没有丢"两句话都无从谈起',
    );
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
  /*
   * 同样是 `note()`：这里**没有断言**，连"锚点应该有几个"这句话都没写下来过，
   * 所以也就不存在"没能评估"。它是一笔留给日后的观测——哪天要给锚点写判据，
   * 这一行的历史输出就是"当时到底是什么样"的现场。
   * ⚠️ 反过来说：它今天**不保证任何事**。要是有人把它读成"锚点验过了"，
   *   那是读错了；真要验就得写成 `judge()`。
   */
  note(
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
  /* 标记按 `kind` 走，**不按 `ok`** —— 只有 verdict 条目有 `ok` 这个字段。 */
  const NON_VERDICT_MARK = { undecided: '？', note: 'ⓘ' };
  for (const e of ledger) {
    const mark = e.kind === 'verdict' ? (e.ok ? '✔' : '✘') : NON_VERDICT_MARK[e.kind];
    say(`   ${mark} ${e.name}`);
    say(`      ${String(e.reason).replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  const verdicts = ledger.filter((e) => e.kind === 'verdict');
  const undecideds = ledger.filter((e) => e.kind === 'undecided');
  const notes = ledger.filter((e) => e.kind === 'note');
  const red = verdicts.filter((e) => e.ok === false && e.fatal);
  say('');
  say(
    red.length === 0
      ? `✔ ${verdicts.filter((e) => e.ok === true).length} 条关键断言全部成立`
      : `✘ ${red.length} 条关键断言不成立：${red.map((e) => e.name).join('；')}`,
  );
  /*
   * 三个桶分开报。**"未决 N 条"与"观测 M 条"必须是两句话** ——
   * 合成一句"其他 N+M 条"正是这次要拆掉的那个桶。
   */
  say(
    `   台账：判决 ${verdicts.length} 条（成立 ${verdicts.filter((e) => e.ok === true).length}／` +
      `不成立 ${verdicts.filter((e) => e.ok === false).length}）· ` +
      `**未决 ${undecideds.length} 条**（跑了，但什么都没证明）· ` +
      `观测 ${notes.length} 条（本来就不是断言，不计入未决）`,
  );
  if (undecideds.length > 0) {
    say('   ── 没被评估的断言 ──');
    for (const u of undecideds) say(`     ？ ${u.name}`);
  }

  /*
   * 覆盖面落盘。**包在 try 里**：这是纯展示用的统计，
   * 它自己出故障绝不该连累这条腿的判定（`sum-undecided.mjs` 顶部那段裁决同一条理由 ——
   * 一个统计脚本挂掉把凭证一起带走，比"凭证在、但 undecided=null"更糟）。
   */
  if (UNDECIDED_OUT) {
    try {
      mkdirSync(dirname(UNDECIDED_OUT), { recursive: true });
      writeFileSync(UNDECIDED_OUT, `${JSON.stringify({ unknowns: undecideds.length }, null, 2)}\n`);
      say(`   覆盖面已写到 ${UNDECIDED_OUT}（unknowns=${undecideds.length}）`);
    } catch (err) {
      say(`   ⚠️ 覆盖面写不出去（${String(err?.message ?? err)}）—— 不影响本腿判定，`);
      say('      下游 sum-undecided.mjs 会因为少一格而如实收敛成 null，不会拼凑一个数。');
    }
  }
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
