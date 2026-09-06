#!/usr/bin/env node
/**
 * e2e-import-audit.mjs — F1（链接导入）与 F2（本地媒体导入）的**端到端**验收。
 *
 * ## 为什么要有这个脚本
 *
 * 用户下载 v0.2.0 预编译包在真机上用，打不开。他的原话：
 *
 *   > 「你应该派多路 agent 去在 CI 中运行一遍把各个流程跑通才能给我交付的啊！」
 *
 * 他是对的。在此之前 CI 验的是「产品能不能被脚本驱动着转出一段文本」
 * （`cold-start-audit.mjs` 第 7 节），而交付的是「**人要用手打开并使用它**」。
 * 中间那一段 —— 网页发的那个 multipart、`/media` 上那个 Range 请求 ——
 * **一条都没测过**。
 *
 * 所以本脚本的判据不是"数据库里有记录"，是：
 *
 *   **`/media` 的 Range 请求真的返回可播放的字节，而且那些字节与导入的文件逐字节相同。**
 *
 * sha256 往返（导进去的文件 == `/media` 吐出来的文件）是这里最值钱的一条断言：
 * 它同时否掉了「落库了但文件丢了」「归档时截断了」「Range 算错了偏移」三种形态，
 * 而这三种在"数据库里有一行"的判据下**全都是绿的**。
 *
 * ## 它验什么、不验什么（这一段是结论的一部分，不是免责声明）
 *
 * **F2 走的是网页真正走的那条路**：`POST /api/notes/upload`，multipart/form-data，
 * 字段名 `file` —— 与 `apps/web/src/features/capture/upload.ts:69` 同一个形状。
 * 不是 `/api/notes/import` 传路径（那是"选文件夹"那条路，另外单独覆盖一例）。
 *
 * **F1 在 CI 里只能验到 yt-dlp 那一段，验不了真外网。** 详见第 11 节的长注释：
 * 产品自己的 SSRF 防线（`argGuard.ts:validateHttpUrl`）拒绝一切私有/回环地址，
 * 这是**正确的安全行为**，代价是"在 CI 里喂一个本地 HTTP 服务"这件事
 * 必须靠一个解析到回环的**公网形状主机名**才做得到。
 *
 * ## 安全边界（PROTOCOL §9 / §9-bis）
 *
 * · 数据目录一律 `mkdtemp`，`OPENMEMO_POINTER_FILE` 一律重定向到临时目录 ——
 *   本脚本**绝不写** `~/.local/share/openmemo/datadir.json`。
 * · 端口用 198xx 段，避开 :10000（用户的 demo）、17650、以及冷启动审计的 197xx。
 * · **本脚本不修改 hosts 文件、不加 IP 别名、不动任何机器级状态。**
 *   第 11 节需要的那条主机名解析由 workflow 在**一次性 runner** 上准备；
 *   解析不到时本脚本如实报 SKIPPED 并说明原因，而不是自己去改。
 *   判据照 PROTOCOL §9-bis：把它 `kill -9` 在最坏的那一行，机器上什么都不会留下。
 * · 不用 `pkill`。只 kill 自己 spawn 出来的那个 pid。
 */
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  accessSync,
  readdirSync,
  realpathSync,
  constants as fsConstants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  spawnDaemon,
  killTree,
  killTreeHard,
  launcherName,
  assertPortFree,
} from './launcher-spawn.mjs';
/*
 * ★★ 判据本体在 `e2e-import-assertions.mjs` —— **纯函数，能被喂输入**。
 *
 * 抽出来之前它们是这份文件里 37 处内联 `fail()`（59 个判决点），而这份文件顶层执行、
 * 结尾 `process.exit()` ⇒ **import 不进来 ⇒ 没有任何东西能给它们喂一份"本该判红"
 * 的输入**。`e2e-runtime-audit.mjs` 正是这样让一条判据烂了三周
 * （`/先安装 CPU/` 那条正则，文案一改它就再也没匹配过任何东西）。
 *
 * 现在每一条都在 `selftest-e2e-import.mjs` 里过「坏输入必须判红 + 好输入必须判绿」，
 * 逐格覆盖由 `leg-coverage.mjs --leg import` 现算。
 *
 * ⚠️ 这一轮**只搬家，不改判什么**。抽出过程中发现的四条空转已登记在判据模块的注释里
 * （`checkHasVideoContract` / `checkToolUnderStoreRoot` / `classifyFetcher` /
 *   `checkFullFetch` + `checkUnsatisfiableRange`），判据一条都没动。
 *
 * ⚠️ 两个组合子：`all` 短路、`collect` 收集。本腿是「收集所有失败最后摊开」的，
 *    所以平行的那几格必须走 `collect`，调用方一律 `for (const r of v.reasons) fail(…)`。
 */
import {
  ASSET_ROLES,
  TOOL_CHECK_PREFIX,
  buildMultipart,
  checkAnyFixtureBuilt,
  checkAsrModelPicked,
  checkAudio16kFetched,
  checkAudio16kPresent,
  checkDaemonDataDir,
  checkDaemonPidIdentity,
  checkFixtureBuilt,
  checkFixtureHostLoopback,
  checkFetchedByYtdlp,
  checkFullFetch,
  checkH264EncoderAvailable,
  checkHasVideoContract,
  checkImportAccepted,
  checkJobSucceeded,
  checkNoteFetched,
  checkNothingBorrowed,
  checkOriginalAssetReady,
  checkPrefixRange,
  checkRequiredPacksInstalled,
  checkShaRoundTrip,
  checkSuffixRange,
  checkToolUnderStoreRoot,
  checkUnsatisfiableRange,
  checkUploadQueued,
  classifyFetcher,
  classifyInstallAttempt,
  classifyJobPoll,
  classifyToolChecks,
  flattenModelCatalog,
  missingFixtureKinds,
  parseFixtureRange,
  pickH264Encoder,
  expectedContentType,
  pickSmallestWhisperAsr,
  pickVadModels,
  verdictMark,
} from './e2e-import-assertions.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const PORT = Number(arg('--port', '19800'));
const FIXTURE_PORT = Number(arg('--fixture-port', '19801'));
/*
 * `.test` 是 RFC 6761 保留给测试用的 TLD —— 永远不会被真的解析到公网上去。
 *
 * ★ 为什么不能用 `localhost` / `127.0.0.1` / `*.local`：产品的 SSRF 防线
 *   （`packages/pipeline/src/subprocess/argGuard.ts:isPrivateOrReservedHost`）
 *   把它们**全部**拒掉，而那是正确的 —— daemon 自己就绑在 127.0.0.1 上，
 *   放行回环等于把自己变成 confused deputy。所以这里必须是一个**公网形状**的名字。
 *   （顺带一条观测：该函数挡掉了 `.localhost`，但没挡 RFC 6761 的另外三个
 *     `.test` / `.example` / `.invalid`。本脚本正是靠这个缝进去的。风险很低
 *     —— 这三个 TLD 在公网上解析不出东西 —— 但它是个事实，记在这里。）
 */
const FIXTURE_HOST = arg('--fixture-host', 'openmemo-e2e-fixture.test');
const MASK = !argv.includes('--no-mask');
const SKIP_F1 = argv.includes('--skip-f1');
/** 样本裁到几秒。转写耗时与它成正比，而这一步证的是"通不通"不是"准不准"。 */
const CLIP_SECONDS = arg('--clip-seconds', '5');

/*
 * ★ 数据目录一律 `mkdtemp`（PROTOCOL §9：绝不碰机器级的那个数据目录/指针）。
 *   父目录可以用 `--tmp-root` 换掉 —— 不是为了灵活，是因为**共享开发机的 `/tmp`
 *   是 12G tmpfs 且经常被别的 agent 塞满**（本机实测 100%，本脚本因此在第 3 节
 *   拿到一串 `DISK_FULL` 而无法自检）。CI runner 上用默认值即可。
 */
const ROOT = mkdtempSync(join(arg('--tmp-root', tmpdir()), 'openmemo-e2e-import-'));
const DATA_DIR = join(ROOT, 'data');
const POINTER = join(ROOT, 'pointer.json');
const MASK_BIN = join(ROOT, 'maskbin');
const FIXTURE_DIR = join(ROOT, 'fixtures');
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(FIXTURE_DIR, { recursive: true });

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

/** 收集所有失败，最后一次性摊开 —— 一次 CI 跑完要能看到全部问题，不是第一个就退。 */
const failures = [];
/** 人为跳过的用例。§11：跳过不许渲染成成功 —— 结论区必须把它喊出来。 */
const skippedOnPurpose = [];
/**
 * **未决**（跑了，但什么都没证明）—— 三态里的第三态。
 *
 * ## 为什么这条腿现在有第三态了（#98 抓到的 ⑤-a，Manager 2026-09-06 裁决）
 *
 * 此前 `media.ready` 收不到时这里只 `say()` 一句，`ok` 保持 true ⇒
 * 总表那一行照旧「✔ 通过」。**SSE 事件名改一个字，`hasVideo` 那条契约就再也
 * 没有读者，而没有任何东西会红。**
 *
 * ⚠️ 裁决明写**不许直接改成 `fail()`**：收不到可能是**真的未决**
 * （时序、连接抖动、事件在断言窗口之后才到），把未决判成失败是另一种说假话。
 * 判据是「**这一格有没有资格说通过**」—— 收不到就是没资格：报未决、**计入未决计数**，
 * 不是绿，也不是红。
 *
 * 这个数经 `--undecided-out` → `sum-undecided.mjs` → `emit-e2e-attestation.mjs`
 * 落进凭证（八处手写名字，由 `selftest-undecided-wiring.mjs` 的 R1–R7 守着）。
 * `null`（没上报）与 `0`（查过了确实没有）在凭证里是两件事。
 */
const undecideds = [];
const undecided = (step, detail) => {
  undecideds.push({ step, detail });
  say(`   ? [${step}] ${detail}`);
};
/**
 * 未决计数落盘的去处（`{ "unknowns": N }`，键名与另外五条腿逐字相同）。
 *
 * ⚠️ 键名是这条管道**第八个必须对齐的名字**：改成别的（`undecidedCount` 之类）
 * 时五个文件名仍然逐字对齐、接线自检全绿，而 `sum-undecided.mjs` 会读不到字段 ⇒
 * 警告 ⇒ 收敛成 null ⇒ 凭证退回「没上报覆盖面」——与从没接过线一模一样。
 * `selftest-undecided-wiring.mjs` 的 R7 正面盯着**代码位置**上的这个键。
 */
const UNDECIDED_OUT = arg('--undecided-out', null);
/** 单次 HTTP 调用的上限（§11：一切外部命令带超时）。轮询靠 waitForJob 的圈数兜。 */
const HTTP_TIMEOUT_MS = Number(arg('--http-timeout-ms', '120000'));
const fail = (step, detail) => {
  failures.push({ step, detail });
  say(`   ✘ [${step}] ${detail}`);
};

/* ═════════════════ 0. 宿主基线 ═════════════════ */

hdr('0. 宿主基线（屏蔽之前）—— 不屏蔽就会被悄悄借走的东西');
const HOST_TOOLS = [
  'ffmpeg',
  'ffprobe',
  'yt-dlp',
  'youtube-dl',
  'whisper-cli',
  'sqlite3',
  'python3',
];
const IS_WIN = process.platform === 'win32';
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
const hostBaseline = {};
for (const t of HOST_TOOLS) {
  const p = which(t);
  hostBaseline[t] = p;
  say(`   ${t.padEnd(14)} ${p || '(不在 PATH 上)'}`);
}

/* ═════════════════ 1. 屏蔽宿主同名工具 ═════════════════ */

let PATH_FOR_DAEMON = process.env.PATH ?? '';
if (MASK) {
  hdr('1. 屏蔽宿主工具（PATH 最前面放同名假二进制）');
  mkdirSync(MASK_BIN, { recursive: true });
  for (const t of HOST_TOOLS) {
    if (IS_WIN) {
      writeFileSync(
        join(MASK_BIN, `${t}.cmd`),
        `@echo off\r\necho E2E-IMPORT-AUDIT: host '${t}' was invoked - MASKED shim 1>&2\r\nexit /b 127\r\n`,
      );
    }
    const shim = join(MASK_BIN, t);
    writeFileSync(
      shim,
      `#!/bin/sh\necho "E2E-IMPORT-AUDIT: host '${t}' was invoked — MASKED shim, not a real tool" >&2\nexit 127\n`,
    );
    try {
      chmodSync(shim, 0o755);
    } catch {
      /* Windows 上 chmod 是空操作 */
    }
  }
  PATH_FOR_DAEMON = `${MASK_BIN}${delimiter}${PATH_FOR_DAEMON}`;
  say(`   已屏蔽 ${HOST_TOOLS.length} 个名字：${MASK_BIN}`);
  say('   ⚠️ shim 能通过 access(X_OK)，所以"产品会不会去借"照常发生 —— 借到的一执行就带标记失败。');
} else {
  hdr('1. 未屏蔽宿主工具（--no-mask）—— 这一轮的"能用"不能当证据');
}

/* ═════════════════ 2. 起 daemon（用包自带的 Node）═════════════════ */

/*
 * ★★ `--bundle <目录>`：判据必须指向**用户下载的那个东西**。
 *
 *   与 `cold-start-audit.mjs` 逐字沿用同一套：daemon 入口取包里的、解释器取包自带的
 *   Node（宿主上没有 node 正是这个包存在的理由）、网页 bundle 与 SQLite 扩展指向包内。
 */
const BUNDLE = arg('--bundle', null);

/*
 * ★★ **从启动器起 daemon，不再直接起 `dist/main.js`。**
 *
 * 完成度审计查出第四类「CI 结构上看不见」：CI 直接起入口，而用户双击的是
 * `start.cmd` / `OpenMemo.command` / `start.sh`。**凡是只有启动器才做的事，
 * CI 结构上都看不见** —— `OPENMEMO_WEB_DIST` / `OPENMEMO_EXT_DIR` /
 * **`OPENMEMO_BUNDLED_PROBE_DIR`** / 工作目录 / macOS quarantine 那一整套。
 *
 * `[grep 实测]` 探针那个变量此前**四条 e2e 腿一条都没引用过**，
 * 所以探针进包那条修复在启动器路径上是 `[未验证]` —— 而它恰恰只通过启动器生效。
 *
 * 入口与收尾都收进 `./launcher-spawn.mjs`：**这条腿的源码里不再出现 daemon 入口路径**，
 * 于是"又绕回去直接起 main.js"这件事可以被一条没有判断空间的守卫钉住。
 */

const childEnv = {
  ...process.env,
  PATH: PATH_FOR_DAEMON,
  // 与产品默认一致：`authRequired()` 只在 OPENMEMO_AUTH==='token' 时为真，
  // 也就是说**不设**就是不鉴权 —— 这里显式写出来只为确定性，不是放宽。
  OPENMEMO_AUTH: 'none',
  OPENMEMO_DATA_DIR: DATA_DIR,
  // ★ PROTOCOL §9：绝不碰全局指针。
  OPENMEMO_POINTER_FILE: POINTER,
  /*
   * ⚠️ **这里不再预设 OPENMEMO_WEB_DIST / OPENMEMO_EXT_DIR / OPENMEMO_BUNDLED_PROBE_DIR。**
   *   它们归启动器设 —— 预设了就等于又把启动器架空一次，而那正是本轮要修的东西。
   *   （`launcher-spawn.mjs` 的 `assertNoLauncherOverrides()` 会当场拦下。）
   */
};

/**
 * PROTOCOL §11：**探测前先证明这个端口是空的。**
 *
 * 这条协议里点名的三个实例，有一个就是这条腿：健康检查连上了同端口的一个游离
 * daemon，**0.5 秒就报「就绪」**，而它自己拉起的那个已经因端口冲突死了
 * （exit 4）。后面整整一节都在跟别人的进程说话，拿到一串 `DISK_FULL`——
 * 那串错误看起来像产品有毛病，其实是我连错了进程。
 *
 * 此前我修的是**事后**认人（比 `/api/health` 的 pid）。那能抓住，但抓得太晚：
 * 端口被占时该做的是**当场判失败**，而不是先跑起来再检查。所以这里补事前那一半。
 */
/*
 * `assertPortFree` 改用共享实现（裁决 R-2）。本腿原来是"只 bind 不问 HTTP" ——
 * 判据够强，但少一层"谁在占"的诊断信息；共享版把两者都给了。
 */

let proc = null;
let viaLauncher = false;
let daemonLogs = [];
async function startDaemon(label) {
  await assertPortFree(PORT, { label: `启动 [${label}] daemon 之前` });
  const logs = [];
  daemonLogs = logs;
  const started = spawnDaemon({
    bundleDir: BUNDLE,
    repoRoot: REPO,
    args: ['--data-dir', DATA_DIR, '--port', String(PORT)],
    env: childEnv,
  });
  proc = started.proc;
  viaLauncher = started.viaLauncher;
  say(`   [${label}] 起法：${started.note}`);
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/health`);
      /*
       * ★ 只看 res.ok 不够：daemon 在路由表挂上之前 `/api/health` 回的是
       *   **503 + ready:false**，其它路由回 503 SERVICE_STARTING（不是 404）。
       *   在那个窗口里发请求，拿到的错误会看起来像"接口不存在"。
       */
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.ready !== false) {
          /*
           * ★★ 「端口上有东西应答」≠「我起的那个 daemon 起来了」。
           *
           * `[本机实测]` 这一条是被咬出来的，不是想出来的：上一轮跑剩的一个 daemon
           * 还占着 19800，本脚本的健康检查**当场就绿了（0.5s）**，而我 spawn 的那个
           * 因为端口冲突以 exit 4 死了。于是后面整整一节都在跟**别人的 daemon**
           * 说话 —— 它的数据目录我已经 rm 掉了，在一个装满的 tmpfs 上，
           * 于是拿到一串 `DISK_FULL`。那串错误看起来像产品有毛病，
           * 其实是我连错了进程。**假的红灯和假的绿灯一样贵。**
           *
           * 产品自己早就把答案摆在这个端点上了（`server.ts:151-175` 的注释写着
           * 这几个身份字段就是给 EADDRINUSE 之后认人用的）：比 `pid`。
           */
          /*
           * ★★ Windows 上 `proc.pid` 是 **cmd.exe** 的，不是 daemon 的
           *   —— `start.cmd` 没有 exec，node.exe 是它的子进程。
           *   所以那边不能比 pid，否则会把一次正确的启动判成"别人的 daemon"。
           *
           *   POSIX 上启动器最后是 `exec`，shell 把自己换成 node，pid 相同，照比。
           *
           *   两边都比 `dataDir`：它是本轮 `mkdtemp` 出来的**唯一**路径，
           *   别的 daemon 不可能报出同一个 —— 在 Windows 上这就是身份证明本身，
           *   §11 要的"绿灯能追溯到我这次启动的东西"由它承担。
           */
          const pidVerdict = checkDaemonPidIdentity({
            isWindows: IS_WIN,
            viaLauncher,
            bodyPid: body?.pid,
            spawnPid: proc.pid,
          });
          if (!pidVerdict.ok) {
            say(`   [${label}] ✘ 端口 ${PORT} 上应答的不是我起的那个 daemon。`);
            say(`      我 spawn 的 pid=${proc.pid}，应答方 pid=${body.pid}`);
            say(`      应答方 dataDir=${body.dataDir}`);
            say(`      本次要的 dataDir=${DATA_DIR}`);
            say('      → 换个 --port，或先收拾掉那个进程。**绝不用 pkill -f**（PROTOCOL）。');
            throw new Error(`port ${PORT} occupied by a foreign daemon (pid=${body.pid})`);
          }
          if (!checkDaemonDataDir({ bodyDataDir: body?.dataDir, wantDataDir: DATA_DIR }).ok) {
            say(`   [${label}] ✘ 应答方的 dataDir 不是本次这个：${body.dataDir} ≠ ${DATA_DIR}`);
            throw new Error('daemon answered with a different dataDir');
          }
          say(
            `   [${label}] daemon 就绪（${((i + 1) * 0.5).toFixed(1)}s，pid=${body.pid ?? '?'}，version=${body.version ?? '?'}）`,
          );
          return logs;
        }
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break;
  }
  say(`   [${label}] ✘ daemon 没起来。它的输出：`);
  say(tail(logs, 80));
  throw new Error('daemon did not start');
}
/**
 * PROTOCOL §11：**按 pid 收整棵进程树**，且**绝不用 `pkill -f`**
 * （模式匹配会打到别人的进程，那是另一种越界）。
 *
 * Windows 上 `child.kill()` 只结束直接子进程，孙子进程会留下来继续占着端口 ——
 * 于是下一轮的健康检查又会连上一个"不是我起的"的东西。用 `taskkill /T` 收整棵树。
 */
async function stopDaemon() {
  if (!proc) return;
  const pid = proc.pid;
  /*
   * PROTOCOL §11：按 pid 收**整棵进程树**，绝不 `pkill -f`（模式匹配会打到别人的进程；
   * Manager 2026-08-08 裁决：`pkill -0 -f` 做存在性探测同样不行 —— 这条明线不开例外）。
   * 三个平台的收法不一样，具体见 `launcher-spawn.mjs`：**统一意图，不统一拼写。**
   */
  say(`   收尾：${killTree(pid)}`);
  for (let i = 0; i < 30 && proc.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (proc.exitCode === null) killTreeHard(pid);
  proc = null;
  await new Promise((r) => setTimeout(r, 400));
}

function tail(logs, n) {
  return logs
    .join('')
    .split('\n')
    .slice(-n)
    .map((l) => `      ${l}`)
    .join('\n');
}

/* ── HTTP 小工具 ─────────────────────────────────────────────────────────── */

/*
 * ★ 带重试。冷启动审计里出现过 `fetch failed` 而 daemon 是活着的 ——
 *   Node 全局 fetch 的 keep-alive socket 被对端回收后复用。重试的是**客户端的脆弱**，
 *   不是掩盖产品失败：连续 5 次都失败仍然抛出去。
 */
const j = async (path, init) => {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // §11：一切外部调用带超时。没有超时的步骤既会拖死整条腿，
      // 又会在被杀时把孙子进程留下来 —— 两个后果它一个人全占。
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const text = await res.text();
      try {
        return { status: res.status, headers: res.headers, body: JSON.parse(text) };
      } catch {
        return { status: res.status, headers: res.headers, body: text };
      }
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw new Error(`${path}: ${lastErr?.message ?? 'fetch failed'}（已重试 5 次）`);
};

/** 取二进制（`/media` 用）。返回 Buffer + 状态 + 头。 */
const jbin = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/*
 * ★ 等 job 到终态。字段名是 **`jobId`** —— `cold-start-audit.mjs:349-372` 记着
 *   这个名字被写错过三次的全过程。三个名字都收，但**绝不回退到"随便哪个 job"**。
 */
async function waitForJob(jobId, timeoutSec = 1800) {
  for (let i = 0; i < timeoutSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const jr = await j(`/api/jobs/${encodeURIComponent(jobId)}`);
    /*
     * 分类是纯的（`classifyJobPoll`），等待与超时留在这里 ——
     * 「拿到的 job 不是我要的那个」那一格尤其值钱：`jobId` 这个字段名被写错过三次
     * （`cold-start-audit.mjs` 记着全过程），而回退到"随便哪个 job"会让整条腿
     * 读到别人的成功。它现在有一个坏输入在 `selftest-e2e-import.mjs` 里钉着。
     */
    const v = classifyJobPoll({ status: jr.status, body: jr.body, jobId });
    if (v.done) return { state: v.state, text: v.text, job: v.job };
  }
  return { state: 'timeout', text: `TIMEOUT（${timeoutSec}s 内没到终态）` };
}

async function jobErrorFull(jobUid) {
  const full = await j(`/api/jobs/${encodeURIComponent(jobUid)}`);
  const err = (full.body?.job ?? full.body)?.error;
  if (!err) return null;
  return JSON.stringify(err, null, 2).slice(0, 6000);
}

/**
 * `media.ready` 的 SSE 事件收集器。
 *
 * ★ 为什么非要收这个：`hasVideo` 这个契约字段此前是**写死的 `false`**，
 *   导入一个 mp4 也报"没有视频"。它一度被判成"零读者可以删"，而那个判断错了 ——
 *   `grep` 只扫 `.ts/.tsx` 时看不见 e2e 侧的读者。有读者的契约字段必须给真值，
 *   而"真值"只有在**真的导入一个带视频的文件**时才验得出来。
 *
 * ★ 2026-08-11：当年那个"真读者" `apps/daemon/scripts/e2e-f2.mjs` **已删**
 *   —— 它要一个外部已经跑着的 daemon，从来没有任何自动调用方。
 *   **这条契约的读者现在就是本文件下面那条断言**（`ready.hasVideo !== wantVideo`
 *   → 判红「契约字段在说谎」），而本文件由 `e2e-import.yml` 真的跑。
 *   也就是说：读者从"没人跑的脚本"变成了"CI 里会红的断言"。
 */
const mediaReady = new Map();
let sseAbort = null;
async function startSse() {
  sseAbort = new AbortController();
  const res = await fetch(`${BASE}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: sseAbort.signal,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const f of frames) {
          const ev = /^event:\s*(.+)$/m.exec(f)?.[1]?.trim();
          const dataLine = /^data:\s*(.+)$/m.exec(f)?.[1];
          if (ev !== 'media.ready' || dataLine === undefined) continue;
          try {
            const d = JSON.parse(dataLine);
            if (d?.noteUid) mediaReady.set(d.noteUid, d);
          } catch {
            /* 半个帧，忽略 */
          }
        }
      }
    } catch {
      /* abort 或断流 */
    }
  })();
}

let exitCode = 0;
let fixtureServer = null;
/** 命中记录：谁真的来取过 fixture（判断"是不是 yt-dlp 去取的"唯一硬证据）。 */
const fixtureHits = [];

try {
  hdr('2. 冷启动（全新临时数据目录）');
  if (BUNDLE) {
    say(`   预编译包：${BUNDLE}`);
    // 起法由启动器决定（它自己去找 runtime/node）——这条腿不再自己拼解释器路径。
    say(`   入口 = 启动器 ${launcherName()}（用户双击的就是它），由它 exec 包自带的 Node`);
  } else {
    say(`   ⚠️ 源码树模式（没传 --bundle）—— 这一轮证明不了"用户下载的那个包能用"。`);
  }
  say(`   数据目录：${DATA_DIR}`);
  say(`   指针文件：${POINTER}（不是全局的那个）`);
  await startDaemon('cold');

  /* ═════════════════ 3. 装后端包 ═════════════════ */

  hdr('3. 安装目录里判定为「适用于本机」的后端包（真下载、真校验）');
  const cat = await j('/api/backends/catalog');
  const packs = cat.body?.packs ?? cat.body?.items ?? [];
  const applicable = packs.filter((p) => p.applicable === true);
  say(
    `   目录共 ${packs.length} 个包，适用 ${applicable.length} 个：${applicable.map((p) => p.id).join(', ')}`,
  );

  /*
   * ★ 失败重试一次 —— 但**只对产品自己标了 `retryable:true` 的**。
   *
   *   `[本机实测]` 一轮里 `whispercpp-cpu-linux-x64` 拿到
   *   `{"code":"PROVIDER_UNREACHABLE","retryable":true}`（下载源抖动）。
   *   重试的是网络抖动，不是掩盖产品失败：`retryable:false` 的（比如 DISK_FULL、
   *   CHECKSUM_MISMATCH）**一次都不重试**，那些重试一万遍也还是那个答案。
   */
  async function installPack(id) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      const r = await j('/api/backends/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
      if (!jobId) {
        return `HTTP ${r.status} 且没有 jobId：${JSON.stringify(r.body).slice(0, 200)}`;
      }
      const st = await waitForJob(jobId);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const decision = classifyInstallAttempt({
        state: st.state,
        job: st.job,
        attempt,
        maxAttempts: 2,
      });
      if (decision === 'done') return `${st.text}  (${secs}s)`;
      if (decision === 'not-retryable') return `${st.text}  (${secs}s)  [不可重试]`;
      say(`   ${String(id).padEnd(32)} ${st.text}  (${secs}s)  → 产品标了 retryable，重试一次`);
    }
    return 'unreachable';
  }

  for (const p of applicable) {
    say(`   ${p.id.padEnd(32)} ${await installPack(p.id)}`);
  }

  // ★ 地面真相：不信 job 的自述，直接问"到底装上了哪些"。
  const inst = await j('/api/backends/installed');
  const instArr = Array.isArray(inst.body)
    ? inst.body
    : (inst.body?.packs ?? inst.body?.installed ?? []);
  const installedIds = new Set(instArr.map((x) => x.id ?? x.packId));
  say(`   /api/backends/installed 返回 ${instArr.length} 条：${[...installedIds].join(', ')}`);

  /*
   * ★★ 必需的包没装上，**当场就红**，不要等到四步之后。
   *
   * `[本机实测]` 这一条是被咬出来的：一轮里 whispercpp 包因为下载源抖动没装上，
   * 而产品在找不到 `whisper-cli` 时会**回退到 PATH**（`tools.ts:850` 的
   * `findInBackendPacks(...) ?? fromPath(...)`）。PATH 上放着本脚本的屏蔽 shim，
   * 于是六个用例**全部**失败在
   *   `maskbin/whisper-cli exited with code 127`
   * —— 那一串错误读起来像「转写坏了」，实际是「后端包没装上」。
   * 真正的原因在 60 行之前，而且当时打印过、被淹没了。
   *
   * 这正是本仓反复栽的那个形状：**失败发生的地方与失败显形的地方隔得太远**。
   * 所以在这里立一道闸：缺哪个就说哪个，并说明它会以什么面目在后面爆炸。
   */
  // 清单与判据都在 `e2e-import-assertions.mjs`（`REQUIRED_PACK_PREFIXES`）——
  // 它是**三条平行的** `fail()`，所以走 `collect`：三个全没装上时要看得见三条，
  // 那正是分辨"下载源整个不通"和"某一个包坏了"的依据。
  const packVerdict = checkRequiredPacksInstalled({ installedIds });
  for (const r of packVerdict.reasons) fail('3.后端包', r);
  if (!packVerdict.ok) {
    say('');
    say('   ⚠️ 上面这些包没装上，后面的失败会以**别的面目**出现：');
    say('      产品找不到 whisper-cli 时会回退到 PATH，而 PATH 上是本脚本的屏蔽 shim，');
    say('      于是所有转写都会报 `exited with code 127`。**那不是转写坏了，是这里没装上。**');
  }

  /*
   * ★ F1 的**前置条件**：yt-dlp 是一个独立的包（`ytdlp-<os>-<arch>`）。
   *   它没装上的话，registry 里 YtDlpSource 的 `isAvailable()` 返回 false，
   *   链接导入会以 `422 NO_MEDIA_SOURCE` 结束 —— 那个错误读起来像"这个链接不支持"，
   *   而真正的原因是"组件没装"。所以这里当场把它挑明。
   */
  const ytdlpPack = [...installedIds].find((id) => String(id).startsWith('ytdlp-'));
  if (!ytdlpPack) {
    say('   ⚠️ 已安装列表里没有 ytdlp-* 包 —— F1 走不到 yt-dlp 那一段。');
    say(
      `      目录里有的 ytdlp 包：${
        packs
          .filter((p) => String(p.id).startsWith('ytdlp-'))
          .map((p) => `${p.id}(applicable=${p.applicable})`)
          .join(', ') || '(一个都没有)'
      }`,
    );
  } else {
    say(`   ✔ 站点解析器已安装：${ytdlpPack}`);
  }

  /* ═════════════════ 4. 拉模型 ═════════════════ */

  hdr('4. 拉 VAD + 最小的 whisper.cpp ASR 模型');
  /*
   * ★ 为什么导入流程非要 ASR 模型不可（这一点很容易被读错）：
   *   媒体资产（`media_assets` 那几行、`/media/asset/<uid>` 能播的那个东西）是在
   *   **`pipeline.run()` 返回之后**才落库的（`apps/daemon/src/jobs/runners/transcribe.ts:334-349`），
   *   而 `pipeline.run()` 里面包含转写。也就是说：**转写不成功就没有可播放的资产**。
   *   所以"能播放"这条判据在结构上必须把 ASR 一起跑通，不能只跑到"下载完"。
   */
  const mcat = await j('/api/models/catalog');
  const groups = mcat.body?.groups ?? [];
  const models = flattenModelCatalog(groups);
  say(`   /api/models/catalog：${groups.length} 组，展平后 ${models.length} 个条目`);
  if (models.length === 0) {
    say(
      `   ⚠️ 展平后是空的 —— 先怀疑 unwrap 写错了。top-level keys: ${JSON.stringify(Object.keys(mcat.body ?? {}))}`,
    );
  }
  const pick = pickVadModels(models);
  const asr = pickSmallestWhisperAsr(models);
  const asrVerdict = checkAsrModelPicked({ asr });
  if (!asrVerdict.ok) {
    fail('4.模型', asrVerdict.reason);
    for (const m of models.filter((x) => x.role === 'asr').slice(0, 8)) {
      say(`      （role=asr 的有：${m.id} engines=${JSON.stringify(m.engines ?? null)}）`);
    }
  } else {
    say(`   挑中 ASR：${asr.m.id}（${(asr.bytes / 1024 / 1024).toFixed(0)} MB）`);
    pick.push(asr.m);
  }
  for (const m of pick) {
    const t0 = Date.now();
    const r = await j('/api/models/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m.id }),
    });
    const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    const st = jobId
      ? (await waitForJob(jobId)).text
      : `HTTP ${r.status} 且没有 jobId：${JSON.stringify(r.body).slice(0, 200)}`;
    say(`   ${String(m.id).padEnd(34)} ${st}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  /* ═════════════════ 5. 重启 ═════════════════ */

  hdr('5. 重启 daemon（materializeSqliteExtensions 只在启动时跑）');
  await stopDaemon();
  await startDaemon('warm');
  await startSse();
  const h1 = await j('/api/health');
  const ext = h1.body?.db?.extensions ?? {};
  say(`   tokenizer=${ext.tokenizer}  libsimple=${ext.libsimple}  sqliteVec=${ext.sqliteVec}`);

  /* ═════════════════ 6. 找到产品自己那份 ffmpeg ═════════════════ */

  hdr('6. 定位产品自己下载的 ffmpeg（造样本要用它，且必须证明不是宿主那个）');
  const STORE_ROOT = process.env.OPENMEMO_MODELS ?? join(DATA_DIR, 'models');
  function findUnder(root, name) {
    const want = IS_WIN ? `${name}.exe` : name;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === want) {
          try {
            accessSync(full, fsConstants.X_OK);
            return full;
          } catch {
            /* 不可执行就当没找到 */
          }
        }
      }
    }
    return null;
  }
  const PRODUCT_FFMPEG = findUnder(STORE_ROOT, 'ffmpeg');
  const PRODUCT_YTDLP = findUnder(STORE_ROOT, 'yt-dlp');
  say(`   storeRoot: ${STORE_ROOT}`);
  say(`   ffmpeg   : ${PRODUCT_FFMPEG ?? '(没找到)'}`);
  say(`   yt-dlp   : ${PRODUCT_YTDLP ?? '(没找到)'}`);
  /*
   * ⚠️ 判据里那两格中的**第二格今天不可能红**（`findUnder` 在结构上只会返回
   *    storeRoot 底下的路径），而且它真的响起来的那天说的是假话。
   *    已登记，见 `checkToolUnderStoreRoot()` 的注释与 `selftest-e2e-import.mjs` ⑤-b。
   *    **本轮不改判据**，只是让它可以被喂输入。
   */
  /*
   * ★ `realpathSync` 是 ③-a 的一半：判据要问的是「**它在不在 storeRoot 底下**」，
   *   而 `findUnder(STORE_ROOT, …)` 只回答得了「storeRoot 底下有没有」。
   *   storeRoot 里放一个指向 `/usr/bin/ffmpeg` 的软链时，老判据看到一个 storeRoot
   *   打头的字符串就说「产品自己下载并校验的那一份」—— **而那正是宿主那个**。
   *   解不开就退回原路径（软链坏了/权限不够是另一回事，不该在这里变成假红）。
   */
  const realOf = (p) => {
    if (!p) return p;
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const REAL_FFMPEG = realOf(PRODUCT_FFMPEG);
  if (REAL_FFMPEG && REAL_FFMPEG !== PRODUCT_FFMPEG) {
    say(`   ffmpeg 真实路径（解开软链）: ${REAL_FFMPEG}`);
  }
  const ffVerdict = checkToolUnderStoreRoot({
    found: PRODUCT_FFMPEG,
    realFound: REAL_FFMPEG,
    storeRoot: realOf(STORE_ROOT),
    name: 'ffmpeg',
    whyNeeded: '后面造不出样本',
    platform: process.platform,
  });
  if (!ffVerdict.ok) {
    fail('6.ffmpeg', ffVerdict.reason);
  } else {
    say('   ✔ ffmpeg 在 storeRoot 底下 = 产品自己下载并校验的那一份。');
  }

  /* ═════════════════ 7. 造样本（多容器 / 多编码）═════════════════ */

  hdr('7. 用产品自己的 ffmpeg 造样本 —— 多容器 / 多编码各一个');
  const SAMPLE = join(REPO, 'vendor', 'whisper.cpp', 'samples', 'jfk.wav');
  if (!existsSync(SAMPLE)) {
    fail('7.样本', `源样本不存在：${SAMPLE} —— submodule 没 checkout？`);
  }

  function runSync(bin, args, timeoutMs = 120000) {
    return new Promise((res) => {
      const p = spawn(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (err += String(d)));
      const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.on('close', (code) => {
        clearTimeout(t);
        res({ code, out, err });
      });
      p.on('error', (e) => {
        clearTimeout(t);
        res({ code: -1, out, err: String(e) });
      });
    });
  }

  /*
   * ★ H.264 编码器的名字**不能写死**，必须直接问这一份真实二进制自己有什么。
   *
   * 不同平台的产品 ffmpeg 来自不同上游构建（见 D-20 §18.2）：linux/win32 是
   * BtbN 的 **LGPL** 构建（`--disable-libx264`，只有 `libopenh264`）；
   * macOS 是 jellyfin-ffmpeg 的 **GPL** 构建（早就是产品自己发给 macOS 用户
   * 的那份二进制，不是本脚本新引入的 GPL 接触面——只是这份构建里没有
   * `libopenh264`，只有 `libx264`）。硬编码任何一个都会在另一批平台上炸：
   * `[实测 run 31368489758]` 硬编码 `libopenh264` 时 darwin-arm64 报
   * `Unknown encoder 'libopenh264'`——**先** hard code 成 `libx264` 时则是
   * linux/win32 报最初那条 `Encoder not found`（本节最初要修的那个）。
   * 两边都硬编码不出一个对三平台都成立的答案，所以改成探测：谁在场用谁，
   * 都不在场就出声（不是静默造不出视频样本）。上游哪天换一批 encoder，
   * 这里不需要跟着改。
   */
  async function detectH264Encoder() {
    if (!PRODUCT_FFMPEG) return null;
    const probe = await runSync(PRODUCT_FFMPEG, ['-hide_banner', '-encoders']);
    // 正则本身在 `pickH264Encoder()` 里，那边有「只有 libx264rgb 时不许挑中 libx264」等用例。
    return pickH264Encoder(probe.out + probe.err);
  }
  const H264_ENCODER = await detectH264Encoder();
  say(`   H.264 编码器（探测，不是写死）: ${H264_ENCODER ?? '(两者都不在——造不出带视频的样本)'}`);

  /*
   * 四个样本，覆盖章程 F2 说的"多种容器/编码"：
   *   · wav  — PCM，只有音轨（不转码，最便宜的对照）
   *   · mp3  — MPEG 容器 + libmp3lame，只有音轨
   *   · m4a  — MP4 容器 + AAC，只有音轨（与 mp4 同容器、不同"有没有视频"）
   *   · mp4  — MP4 容器 + H.264 视频 + AAC 音轨，**带视频**（编码器名见上）
   * 视频轨用 ffmpeg 自己的 testsrc 合成，不需要另找素材。
   */
  const FIXTURE_SPECS = [
    {
      name: 'f2-audio.wav',
      args: (i, o) => ['-y', '-t', CLIP_SECONDS, '-i', i, '-c:a', 'pcm_s16le', o],
      what: 'PCM / WAV / 仅音轨',
    },
    {
      name: 'f2-audio.mp3',
      args: (i, o) => ['-y', '-t', CLIP_SECONDS, '-i', i, '-c:a', 'libmp3lame', '-b:a', '64k', o],
      what: 'MP3 / MPEG / 仅音轨',
    },
    {
      name: 'f2-audio.m4a',
      args: (i, o) => ['-y', '-t', CLIP_SECONDS, '-i', i, '-c:a', 'aac', '-b:a', '64k', o],
      what: 'AAC / MP4 / 仅音轨',
    },
  ];
  // 编码器名字探测得到（见上），不是写死的 —— 两边都不在场就不硬凑一条会失败的 spec，
  // 让第 7 节的 fail() 如实说清楚原因。
  if (H264_ENCODER) {
    FIXTURE_SPECS.push({
      name: 'f2-video.mp4',
      args: (i, o) => [
        '-y',
        '-t',
        CLIP_SECONDS,
        '-i',
        i,
        '-f',
        'lavfi',
        '-t',
        CLIP_SECONDS,
        '-i',
        'testsrc=size=160x120:rate=10',
        '-c:v',
        H264_ENCODER,
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-shortest',
        o,
      ],
      what: `H.264(${H264_ENCODER})+AAC / MP4 / **带视频**`,
    });
  } else {
    fail('7.样本', checkH264EncoderAvailable({ encoder: H264_ENCODER }).reason);
  }

  const fixtures = [];
  if (PRODUCT_FFMPEG && existsSync(SAMPLE)) {
    for (const spec of FIXTURE_SPECS) {
      const out = join(FIXTURE_DIR, spec.name);
      const r = await runSync(PRODUCT_FFMPEG, spec.args(SAMPLE, out));
      const built = checkFixtureBuilt({
        name: spec.name,
        exitCode: r.code,
        exists: existsSync(out),
        stderr: r.err,
      });
      if (!built.ok) {
        fail('7.样本', built.reason);
        continue;
      }
      const buf = readFileSync(out);
      fixtures.push({
        ...spec,
        path: out,
        bytes: buf.length,
        sha: sha256(buf),
        head: buf.subarray(0, 16),
      });
      say(`   ✔ ${spec.name.padEnd(16)} ${String(buf.length).padStart(9)} B  ${spec.what}`);
      say(`      sha256=${sha256(buf)}  magic=${buf.subarray(0, 12).toString('hex')}`);
    }
  }
  {
    const v = checkAnyFixtureBuilt({ count: fixtures.length });
    if (!v.ok) fail('7.样本', v.reason);
  }

  /* ═════════════════ 8. 播放断言（F1/F2 共用）═════════════════ */

  /**
   * 这是整个脚本的**判据本体**。
   *
   * 判"能播放"不是看数据库里有没有行，是：
   *   ① `/api/notes/:uid` 里有 role=original 且 state=ready 的资产，带 url
   *   ② 整体 GET → 200 + Content-Length 对 + Content-Type 对
   *   ③ **sha256 往返**：吐出来的字节与导进去的文件逐字节相同
   *   ④ `Range: bytes=0-N` → **206** + Content-Range/Content-Length 对 + 字节与文件头相同
   *   ⑤ `Range: bytes=-N`（后缀）→ 206 + 字节与文件尾相同
   *   ⑥ 不可满足的 Range → **416** + `Content-Range: bytes * /size`
   *   ⑦ audio16k 那份也要能取到（播放器的波形/时间轴走的是它）
   *
   * ③ 是最值钱的一条：它同时否掉"落库了但文件丢了"「归档时截断了」「Range 偏移算错了」
   * —— 而这三种在"数据库里有一行"的判据下全是绿的。
   *
   * @param expectSha 期望的 sha256；F1 那边 yt-dlp 可能改容器，传 null 表示只验形状不验相等。
   */
  async function assertPlayable(tag, noteUid, expectSha, expectBytes, expectContentType = null) {
    const nd = await j(`/api/notes/${encodeURIComponent(noteUid)}`);
    const fetched = checkNoteFetched({ status: nd.status, body: nd.body, noteUid });
    if (!fetched.ok) {
      fail(tag, fetched.reason);
      return false;
    }
    const assets = nd.body?.assets ?? [];
    say(
      `   资产 ${assets.length} 个：${assets.map((a) => `${a.role}(${a.state},${a.bytes ?? '?'}B,${a.mime ?? 'mime=null'})`).join(' ')}`,
    );
    const orig = assets.find((a) => a.role === ASSET_ROLES.original);
    /*
     * 三格短路（`all`）：抽出前这里是三个各自 `return false` 的 `if` ——
     * 资产不在的时候问它的 state 是没有意义的。
     */
    const origVerdict = checkOriginalAssetReady({ asset: orig, noteStatus: nd.body?.status });
    if (!origVerdict.ok) {
      fail(tag, origVerdict.reason);
      return false;
    }

    let ok = true;

    // ② + ③ 整体 GET
    const full = await jbin(orig.url);
    const ctype = full.headers.get('content-type');
    const clen = full.headers.get('content-length');
    const aranges = full.headers.get('accept-ranges');
    say(
      `   GET ${orig.url} → ${full.status}  ${full.buf.length} B  Content-Type=${ctype}  Content-Length=${clen}  Accept-Ranges=${aranges}`,
    );
    /*
     * 六格**平行**（`collect`）：抽出前是四个各自 `fail()` 的 `if`，一次跑完要能看到全部。
     * ✅ 后两格是 ⑤-c 补上的：`ctype` 此前**只被上面那句 `say()` 打印，从来没有被判过**，
     *    而本函数的文档从第一天起就写着「Content-Type 对」。
     *    `expectContentType` 由调用方按**扩展名**给（`expectedContentType()`）——
     *    F1 那条传 null（yt-dlp 可能换容器，扩展名事先不知道），但「头必须在」那一格
     *    对所有调用点都成立。
     */
    for (const r of checkFullFetch({
      status: full.status,
      buf: full.buf,
      contentLength: clen,
      acceptRanges: aranges,
      contentType: ctype,
      expectContentType,
    }).reasons) {
      fail(tag, r);
      ok = false;
    }
    const gotSha = sha256(full.buf);
    const shaVerdict = checkShaRoundTrip({
      expectSha,
      gotSha,
      expectBytes,
      gotBytes: full.buf.length,
    });
    if (expectSha !== null) {
      if (!shaVerdict.ok) {
        fail(tag, shaVerdict.reason);
        ok = false;
      } else {
        say(
          `   ✔ sha256 往返一致（${gotSha.slice(0, 16)}… / ${full.buf.length} B）—— 导进去的字节原样播得出来`,
        );
      }
    } else {
      say(
        `   ⓘ 本例不比对 sha256（yt-dlp 可能改容器）；实收 sha256=${gotSha.slice(0, 16)}… ${full.buf.length} B`,
      );
    }

    const size = full.buf.length;

    // ④ 前缀 Range
    const N = Math.min(1024, size);
    const r1 = await jbin(orig.url, { headers: { Range: `bytes=0-${N - 1}` } });
    const cr1 = r1.headers.get('content-range');
    say(`   Range bytes=0-${N - 1} → ${r1.status}  Content-Range=${cr1}  收到 ${r1.buf.length} B`);
    for (const r of checkPrefixRange({
      status: r1.status,
      contentRange: cr1,
      buf: r1.buf,
      fullBuf: full.buf,
      n: N,
      size,
    }).reasons) {
      fail(tag, r);
      ok = false;
    }

    // ⑤ 后缀 Range
    const r2 = await jbin(orig.url, { headers: { Range: `bytes=-${N}` } });
    say(
      `   Range bytes=-${N} → ${r2.status}  Content-Range=${r2.headers.get('content-range')}  收到 ${r2.buf.length} B`,
    );
    // 短路（`all`）：抽出前是 `if / else if` —— 状态码不对时 body 是一份错误信息，
    // 拿它去比字节，比出来的"不同"是废话。
    const sufVerdict = checkSuffixRange({
      status: r2.status,
      buf: r2.buf,
      fullBuf: full.buf,
      n: N,
      size,
    });
    if (!sufVerdict.ok) {
      fail(tag, sufVerdict.reason);
      ok = false;
    }

    // ⑥ 不可满足的 Range
    const r3 = await jbin(orig.url, { headers: { Range: `bytes=${size + 100}-` } });
    say(
      `   Range bytes=${size + 100}- → ${r3.status}  Content-Range=${r3.headers.get('content-range')}`,
    );
    // ✅ ⑤-c 补上的另一半：此前只钉状态码，而文档写着「416 + Content-Range: bytes * /size」。
    //    产品（`media.ts`）**逐字发了那个头**，是守卫没在看。播放器靠它拿真实总长。
    for (const r of checkUnsatisfiableRange({
      status: r3.status,
      contentRange: r3.headers.get('content-range'),
      expectSize: size,
    }).reasons) {
      fail(tag, r);
      ok = false;
    }

    // ⑦ audio16k
    const a16 = assets.find((a) => a.role === ASSET_ROLES.audio16k);
    const a16Present = checkAudio16kPresent({ asset: a16 });
    if (!a16Present.ok) {
      fail(tag, a16Present.reason);
      ok = false;
    } else {
      const ra = await jbin(a16.url);
      say(
        `   GET audio16k → ${ra.status}  ${ra.buf.length} B  Content-Type=${ra.headers.get('content-type')}`,
      );
      const a16Fetched = checkAudio16kFetched({ status: ra.status, buf: ra.buf });
      if (!a16Fetched.ok) {
        fail(tag, a16Fetched.reason);
        ok = false;
      }
    }

    // 转写文本（次要判据：证明这一单确实走完了整条流水线）
    const tr = await j(`/api/notes/${encodeURIComponent(noteUid)}/transcript`);
    const segs = tr.body?.segments ?? [];
    const text = segs
      .map((s) => String(s.text ?? ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    say(`   转写：${segs.length} 段 / ${text.length} 字符 — ${text.slice(0, 120) || '(空)'}`);

    return ok;
  }

  /* ═════════════════ 9. F2：网页真正走的那条路（multipart 上传）═════════════════ */

  hdr('9. ★ F2 本地媒体导入 —— 走网页真正发的那个请求（multipart 上传）');
  say('   网页用的是 POST /api/notes/upload，FormData 字段名 `file`');
  say('   （apps/web/src/features/capture/upload.ts:69）—— 不是传路径的那条。');
  say('   浏览器读不到真实路径，所以"传路径"那条 API 网页根本用不上。');
  say('');

  // 手写 multipart 的那几行搬进了判据模块（`buildMultipart`）—— 它是判据的一部分，
  // 不是工具函数：字段名 / CRLF / 结尾 boundary 的两个短横线写错任何一处，daemon 会 400，
  // 而那会表现成**产品坏了**。自检里对着 `apps/web/src/features/capture/upload.ts` 正面核。

  const results = [];
  for (const fx of fixtures) {
    say('');
    say(`   ── ${fx.name}（${fx.what}）─────────────────────────────────`);
    const buf = readFileSync(fx.path);
    const mp = buildMultipart(fx.name, buf, { language: 'en' });
    const t0 = Date.now();
    const up = await j('/api/notes/upload', {
      method: 'POST',
      headers: { 'content-type': mp.contentType },
      body: mp.body,
    });
    say(
      `   POST /api/notes/upload (${buf.length} B) → HTTP ${up.status} ${JSON.stringify(up.body).slice(0, 300)}`,
    );
    const queued = checkUploadQueued({ status: up.status, body: up.body });
    if (!queued.ok) {
      fail(`F2:${fx.name}`, queued.reason);
      results.push({ name: fx.name, what: fx.what, ok: false, note: '上传失败' });
      continue;
    }
    const st = await waitForJob(up.body.jobUid);
    say(`   转写 job：${st.text}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (st.state !== 'succeeded') {
      const fullErr = await jobErrorFull(up.body.jobUid);
      if (fullErr) {
        say('   ── job.error 全文 ──');
        for (const l of fullErr.split('\n')) say(`      ${l}`);
      }
      say('   ── daemon 最后 40 行 ──');
      say(tail(daemonLogs, 40));
      fail(`F2:${fx.name}`, checkJobSucceeded({ state: st.state, text: st.text }).reason);
      results.push({ name: fx.name, what: fx.what, ok: false, note: st.state });
      continue;
    }
    /*
     * ★ 期望的 Content-Type 由**扩展名**给（`expectedContentType()`，镜像 `media.ts`
     *   的 `MIME_BY_EXT`）——`media_assets.mime` 对 original 刻意是 NULL，由 `/media`
     *   的 `guessMime()` 兜底。"顺手把 mime 补上真值"会让 mp3 变得不可播，
     *   而那是产品源码里点名的失败面。
     */
    let ok = await assertPlayable(
      `F2:${fx.name}`,
      up.body.noteUid,
      fx.sha,
      fx.bytes,
      expectedContentType(fx.name),
    );
    /*
     * ★ `media.ready.hasVideo` 必须说真话：带视频的 mp4 → true，纯音轨 → false。
     *   事件是异步来的，给它一点时间；**收不到就如实说收不到，不当成通过**。
     */
    const wantVideo = fx.name === 'f2-video.mp4';
    let ready = null;
    for (let i = 0; i < 20 && !ready; i++) {
      ready = mediaReady.get(up.body.noteUid) ?? null;
      if (!ready) await new Promise((r) => setTimeout(r, 250));
    }
    /*
     * ✅ **已修（#98 的 ⑤-a，Manager 2026-09-06 裁决）**：三支各走各的。
     *
     * 此前 `!ready` 那一支**只 say 不 fail**，`ok` 保持 true ⇒ 总表照旧「✔ 通过」，
     * 而那一段的注释写着「收不到就如实说收不到，**不当成通过**」。
     *
     * ⚠️ 裁决明写**不许直接改成 fail**：收不到可能是真的未决（时序 / 连接抖动）。
     *    判据是「这一格有没有资格说通过」—— 没资格 ⇒ **记未决**，
     *    进 `undecideds`、进凭证的 `undecided` 计数，**总表那一行也改成 ⊘**。
     * ⚠️ 三支必须都写：只写 `if (!hv.ok)` 会把未决重新读成失败，
     *    只写 `if (hv.ok)` 会把未决重新读成通过。自检里两个方向都钉着。
     */
    const hv = checkHasVideoContract({ ready, wantVideo, what: fx.what });
    let hasVideoUndecided = false;
    if (hv.undecided) {
      hasVideoUndecided = true;
      undecided(`F2:${fx.name}`, `${hv.reason}（noteUid=${up.body.noteUid}）`);
    } else if (!hv.ok) {
      fail(`F2:${fx.name}`, hv.reason);
      ok = false;
    } else {
      say(`   ✔ media.ready.hasVideo=${ready.hasVideo}（与"${fx.what}"相符）`);
    }
    /*
     * ⚠️ 未决**不许渲染成"✔ 通过"**（PROTOCOL §11 的同一条）：其它格都过了、
     *    只有 hasVideo 那一格没验到时，这一行是 `ok: null`（总表渲染成"⊘ 跳过"）
     *    并在 note 里点名是哪一格 —— 而不是一行看起来和全验过一模一样的绿。
     *    失败优先于未决：真红了就得是红。
     */
    results.push({
      name: fx.name,
      what: fx.what,
      ok: ok ? (hasVideoUndecided ? null : true) : false,
      note: ok
        ? hasVideoUndecided
          ? '可播放，但 media.ready 没收到 ⇒ hasVideo 未决'
          : '可播放'
        : '播放断言失败',
    });
  }

  /*
   * ★ 补总表行（Manager 2026-08-11 裁决，#77 F2b 追踪）：上面这个循环只覆盖了
   * "造出来了"的那几个格式。造不出来的（ffmpeg 失败，或者这台机器压根没有
   * H.264 编码器）已经在第 7 节被 `fail()` 判过一次红了——判决不需要这里
   * 再表态，所以**不再重复 `fail()`**（一个根因不该被数成两次失败，会把
   * 失败计数灌水）。这里单纯是把总表补完整：用 `ok: null`（本文件既有的
   * "跑了但不该算进过/不过"的第三态，`--skip-f1` 用的也是它，第 13 节总表
   * 渲染成"⊘ 跳过"）配一句指回第 7 节的 note，让人从总表本身就能看出
   * "F2 到底覆盖了哪几个格式、缺的是哪个、为什么"，而不是那一行凭空消失。
   */
  for (const kind of missingFixtureKinds({ made: fixtures.map((f) => f.name) })) {
    results.push({
      name: kind.name,
      what: kind.what,
      ok: null,
      note: '未跑：样本没造出来，前提已在 7.样本 判红',
    });
  }

  /* ═════════════════ 10. F2b：传绝对路径那条（桌面"选文件"路径）═════════════════ */

  hdr('10. F2b：POST /api/notes/import 传绝对路径（"选文件夹"那条路，与上传并存）');
  if (fixtures.length > 0) {
    const fx = fixtures[0];
    /*
     * `importRoots = [dataDir, ...OPENMEMO_IMPORT_ROOTS]`，所以样本必须落进数据目录，
     * 否则 403 PATH_NOT_ALLOWED。这一条**本身**就是要验的东西：
     * Windows 上 `resolve()` 给的是 `C:\...`，而旧代码用 `root + '/'` 拼前缀比对，
     * 结果一个明明在 dataDir 里的文件被判成越界（notes.ts:120-141 记着这次事故）。
     */
    const dest = join(DATA_DIR, `f2b-${fx.name}`);
    writeFileSync(dest, readFileSync(fx.path));
    const imp = await j('/api/notes/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: dest, title: 'F2b 绝对路径导入', language: 'en' }),
    });
    say(
      `   POST /api/notes/import {input:"${dest}"} → HTTP ${imp.status} ${JSON.stringify(imp.body).slice(0, 300)}`,
    );
    /*
     * ⚠️ 这里 `requireIds:false`，F1 那边是 `true` —— 抽出前就有的不对称，逐字保留。
     *    202 却没有 jobUid 时下一步会打到 `/api/jobs/undefined` ⇒ 仍然判红，
     *    只是那句报错指向"job 没成功"而不是"回执缺字段"。判决相同、诊断更差。
     */
    const acc = checkImportAccepted({
      status: imp.status,
      body: imp.body,
      requireIds: false,
      what: '传绝对路径被拒',
    });
    if (!acc.ok) {
      fail('F2b', acc.reason);
      results.push({
        name: 'F2b 绝对路径',
        what: '传路径导入',
        ok: false,
        note: `HTTP ${imp.status}`,
      });
    } else {
      const st = await waitForJob(imp.body.jobUid);
      say(`   转写 job：${st.text}`);
      if (st.state !== 'succeeded') {
        const fullErr = await jobErrorFull(imp.body.jobUid);
        if (fullErr) say(`   job.error 全文：\n${fullErr}`);
        fail('F2b', checkJobSucceeded({ state: st.state, text: st.text }).reason);
        results.push({ name: 'F2b 绝对路径', what: '传路径导入', ok: false, note: st.state });
      } else {
        const ok = await assertPlayable(
          'F2b',
          imp.body.noteUid,
          fx.sha,
          fx.bytes,
          expectedContentType(fx.name),
        );
        results.push({
          name: 'F2b 绝对路径',
          what: '传路径导入',
          ok,
          note: ok ? '可播放' : '播放断言失败',
        });
      }
    }
  } else {
    /*
     * ★（Manager 2026-08-11 裁决，#77 F2b 追踪）以前这里只 `say()` 一句就完了，
     * 这一条在总表里凭空消失——不是通过/不是失败/也不是"⊘跳过"，就是没有这一行。
     * 判决不受影响（第 7 节的 `fail()` 早就判红了，这里**不再重复 fail()**），
     * 但总表要能追溯"F2b 到底跑没跑"，所以照 F2 补行同样的道理留一条记录。
     */
    say('   （没有样本，跳过）');
    results.push({
      name: 'F2b 绝对路径',
      what: '传路径导入',
      ok: null,
      note: '未跑：没有样本可用，前提已在 7.样本 判红',
    });
  }

  /* ═════════════════ 11. F1：链接导入 ═════════════════ */

  hdr('11. ★ F1 链接导入 —— 本地起 HTTP 服务喂真媒体文件，让 yt-dlp 去取');

  /*
   * ── 为什么不能直接喂 `http://127.0.0.1:PORT/x.mp4` ──────────────────────────────
   *
   * 产品自己的 SSRF 防线会拒掉它，而且**这是正确行为**：
   *   `packages/pipeline/src/subprocess/argGuard.ts:isPrivateOrReservedHost`
   *   把 localhost / *.localhost / *.local / *.internal / 127/8 / 10/8 / 192.168/16 /
   *   169.254/16（云元数据）等等全部判为私有 → `validateHttpUrl` 返回 `private_address`。
   *   daemon 自己就绑在 127.0.0.1 上，放行回环等于把产品变成 confused deputy。
   *   **所以这里不能改产品，也不该改产品。**
   *
   * ── 那怎么在不出网的前提下真验这条链路 ──────────────────────────────────────
   *
   * 用一个**公网形状**的主机名（`.test`，RFC 6761 保留给测试，永远不会真的解析到公网），
   * 由 workflow 在一次性 runner 的 hosts 文件里指向 127.0.0.1。于是：
   *
   *   · `validateHttpUrl` 只做**字面**判断 → `openmemo-e2e-fixture.test` 通过 ✔
   *   · DirectHttpSource（score 80）先被试 → 它调 `assertHostNotPrivate()`，
   *     那个会**真的解 DNS** → 解到 127.0.0.1 → 判私有 → 拒绝 → 落到下一个候选
   *   · YtDlpSource（score 10）→ 只做字面判断 → **yt-dlp 真的被 spawn，真的发 HTTP，
   *     真的把字节下下来**
   *
   *   这恰好就是 registry 文档里写的那条 fallback 链（`registry.ts:90-105`：
   *   「先试 DirectHttp，不是直链才落到 yt-dlp」）—— 我们走的是产品设计好的那条路，
   *   不是绕过它。
   *
   * ── 因此，这一节**验到了什么** ─────────────────────────────────────────────────
   *
   *   ✔ 粘链接 → `POST /api/notes/import` → registry 解析 → yt-dlp 子进程真的起来 →
   *     真的建 TCP 连接、发 HTTP GET、把一个**真的媒体文件**下下来 →
   *     ffmpeg 抽音轨 → 落库 → `/media` 的 Range 请求吐出可播放字节
   *   ✔ fixture 服务器会记下每一个请求的 User-Agent —— "到底是不是 yt-dlp 去取的"
   *     这件事有**硬证据**，不是推断
   *
   * ── 以及**验不了什么**（这一段同样是结论）─────────────────────────────────────
   *
   *   ✘ 真 DNS 解析到公网主机、TLS/https 那一段
   *   ✘ yt-dlp 的**站点解析器**（YouTube/Bilibili 的页面解析、签名解密、限速、
   *     年龄/地区/同意墙）—— 这里喂的是直链，走的是 yt-dlp 的 generic 提取器。
   *     **这一段在 CI 上结构性地验不了**：它要求真的访问那些站点，
   *     而那既不可靠（反爬、地区差异）也不合适（CI 去抓视频站）。
   *   ✘ DirectHttpSource 这条**许可证干净**的适配器 —— 它的 `assertHostNotPrivate()`
   *     会解 DNS，本地 fixture 必然被它判私有。也就是说：**用回环 fixture 验 F1，
   *     就只能验到 yt-dlp 那一支，验不到直链那一支。** 二者互斥，不是我漏了。
   */

  if (SKIP_F1) {
    /*
     * PROTOCOL §11「**跳过不许渲染成成功**」。
     *
     * 显式传 `--skip-f1` 是人的选择，不是静默的漏测，所以允许它继续；
     * 但**必须在结论里显形**，不能让一条少跑了 F1 的腿看起来跟跑全了一样绿。
     * 下面第 13 节的总表会把它标成"⊘ 跳过"，而 `skippedOnPurpose` 让结论区
     * 单独再喊一遍 —— 判据是"绿灯要能追溯到它到底验了什么"。
     */
    say('   ⚠️ --skip-f1：本轮**跳过 F1**。这一轮的绿灯不包含链接导入。');
    skippedOnPurpose.push('F1 链接导入（--skip-f1）');
    /*
     * ★ 它**也是一条未决**，而且是这条腿此前唯一承认的那一条：
     *   workflow 里那句 `--undecided ${{ inputs.skipF1 && '1' || '0' }}` 说的就是它。
     *   现在改由审计**自己数**（真管道），那个写死的表达式随之删掉 ——
     *   写死的数在这条腿新增第三态（hasVideo 未决）的那一刻就开始说假话。
     */
    undecided('F1', '整条 F1 被 --skip-f1 跳过 —— 链接导入这一轮一条都没验');
    results.push({
      name: 'F1 链接导入',
      what: 'yt-dlp 取回',
      ok: null,
      note: 'SKIPPED(--skip-f1)',
    });
  } else {
    // ★ 先确认那条主机名解析得到回环。**解析不到就如实报，绝不自己去改 hosts。**
    let resolved = null;
    try {
      resolved = await lookup(FIXTURE_HOST);
    } catch (e) {
      resolved = null;
      say(`   DNS 解析 ${FIXTURE_HOST} 失败：${e.message}`);
    }
    const loopbackVerdict = checkFixtureHostLoopback({
      host: FIXTURE_HOST,
      address: resolved ? resolved.address : null,
    });
    say(`   ${FIXTURE_HOST} → ${resolved ? resolved.address : '(解析不到)'}`);

    if (!loopbackVerdict.ok) {
      /*
       * ★ PROTOCOL §11：这是**非自愿**的跳过 —— 环境没准备好，不是人做的决定。
       *   以前这里只 push 一条 `ok:null` 然后照常 exit 0，也就是
       *   「跳过渲染成了成功」：workflow 里那条 hosts 步骤哪天悄悄坏掉，
       *   这条腿会**继续报绿**，而 F1 一次都没跑过。现在当场判失败。
       */
      fail('F1', loopbackVerdict.reason);
      say('   ⚠️ F1 未执行：这台机器上没有把 fixture 主机名指向回环。');
      say('      本脚本**刻意不去改** hosts 文件 —— 那是机器级状态，改了被 kill 就留在那儿了');
      say('      （PROTOCOL §9-bis）。准备工作由 workflow 在一次性 runner 上做。');
      say(`      需要的一行：127.0.0.1 ${FIXTURE_HOST}`);
      results.push({
        name: 'F1 链接导入',
        what: 'yt-dlp 取回',
        ok: false,
        note: '未执行（主机名没指向回环）→ 判失败，见 §11',
      });
    } else if (!PRODUCT_YTDLP) {
      fail('F1', `storeRoot 里找不到 yt-dlp（${STORE_ROOT}）—— 站点解析器没装上，F1 走不通`);
      results.push({ name: 'F1 链接导入', what: 'yt-dlp 取回', ok: false, note: 'yt-dlp 没装上' });
    } else if (fixtures.length === 0) {
      fail('F1', '没有样本可喂');
      results.push({ name: 'F1 链接导入', what: 'yt-dlp 取回', ok: false, note: '没有样本' });
    } else {
      // 喂**带视频的 mp4** —— 它同时覆盖"链接导入"与"从视频里抽音轨"这两件事。
      const served = fixtures.find((f) => f.name === 'f2-video.mp4') ?? fixtures[0];
      const servedBuf = readFileSync(served.path);
      say(`   fixture 文件：${served.name}（${servedBuf.length} B，${served.what}）`);

      fixtureServer = createServer((req, res) => {
        fixtureHits.push({
          method: req.method,
          url: req.url,
          ua: req.headers['user-agent'] ?? '(no UA)',
          range: req.headers.range ?? null,
        });
        say(
          `   [fixture] ${req.method} ${req.url}  UA=${req.headers['user-agent'] ?? '(none)'}  Range=${req.headers.range ?? '-'}`,
        );
        if (!String(req.url).startsWith('/clip.mp4')) {
          res.writeHead(404).end('not found');
          return;
        }
        const total = servedBuf.length;
        /*
         * ★ 替身自己的 Range 算法在 `parseFixtureRange()` 里，有专门的用例。
         *   「量错东西」那一类失效的标准形态就是**替身不实现契约、测的是替身自己**：
         *   这几行算错 ⇒ yt-dlp 下到一个截断的 mp4 ⇒ ffprobe 失败 ⇒
         *   F1 以**产品坏了**的面目变红。一次这样的假红会让人去改产品。
         */
        const rng = parseFixtureRange(req.headers.range, total);
        if (rng) {
          if (rng.unsatisfiable) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
            return;
          }
          const slice = servedBuf.subarray(rng.start, rng.end + 1);
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${rng.start}-${rng.end}/${total}`,
            'Accept-Ranges': 'bytes',
          });
          res.end(req.method === 'HEAD' ? undefined : slice);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
        });
        res.end(req.method === 'HEAD' ? undefined : servedBuf);
      });
      /*
       * ★ 绑到**解析出来的那个地址**，不是写死 127.0.0.1。
       *   主机名可能解到 `::1`（本机实测 `localtest.me` 就是），
       *   那时候绑 127.0.0.1 会让 yt-dlp 连 `[::1]:PORT` 吃闭门羹 ——
       *   而错误长得像"产品取不回来"，其实是 fixture 绑错了地址。
       */
      const bindAddr = resolved.address;
      await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, bindAddr, r));
      say(`   fixture 服务器绑在 ${bindAddr}:${FIXTURE_PORT}（对外用 ${FIXTURE_HOST}）`);

      const link = `http://${FIXTURE_HOST}:${FIXTURE_PORT}/clip.mp4`;
      say(`   粘的链接：${link}`);

      /*
       * 先打一次 `/api/notes/probe` —— 这正是网页粘上链接后**立刻**发的那个请求
       * （出标题/时长/缩略图的那一步）。它失败不阻断导入，但它的报错内容是
       * 用户第一眼看到的东西，所以照样记下来。
       */
      const pr = await j('/api/notes/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: link }),
      });
      say(`   POST /api/notes/probe → HTTP ${pr.status} ${JSON.stringify(pr.body).slice(0, 500)}`);
      /*
       * ★ `adapterId` 是**产品自己说的**「这条链接是谁解析的」—— 比任何外部推断都硬。
       *   本机实测这里返回 `"yt-dlp"`，也就是 registry 的 fallback 链确实走到了
       *   GPL 适配器那一支（DirectHttp 先被试、因为 assertHostNotPrivate 解到回环而拒绝）。
       */
      const probeAdapter = pr.body?.adapterId ?? null;
      say(`   ★ 产品说这条链接的解析者是：adapterId=${probeAdapter ?? '(没给)'}`);

      const t0 = Date.now();
      const imp = await j('/api/notes/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: link, title: 'F1 链接导入（CI fixture）', language: 'en' }),
      });
      say(
        `   POST /api/notes/import → HTTP ${imp.status} ${JSON.stringify(imp.body).slice(0, 300)}`,
      );

      const f1acc = checkImportAccepted({
        status: imp.status,
        body: imp.body,
        requireIds: true,
        what: '链接导入没排上队',
      });
      if (!f1acc.ok) {
        fail('F1', f1acc.reason);
        results.push({ name: 'F1 链接导入', what: 'yt-dlp 取回', ok: false, note: '导入被拒' });
      } else {
        const st = await waitForJob(imp.body.jobUid);
        say(`   转写 job：${st.text}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

        say('');
        say(`   ── fixture 服务器收到 ${fixtureHits.length} 个请求（这是"谁去取的"的硬证据）──`);
        for (const h of fixtureHits)
          say(`      ${h.method} ${h.url}  UA=${h.ua}  Range=${h.range ?? '-'}`);
        /*
         * ★★ **不要用 User-Agent 判断取回方。**
         *
         * 第一版就是这么写的（`/yt-dlp|youtube-?dl|python/i`），而本机实测打脸：
         * yt-dlp **默认伪装成浏览器**，而且每次还换一个版本号 ——
         * 实收四条分别是 Chrome/150、145、146、146。也就是说那条断言
         * 会稳定地说"取回方不像 yt-dlp"，**而它明明就是 yt-dlp**。
         * 一条永远给错答案的证据比没有证据更糟。
         *
         * 改用**产品自己的答案**：`/api/notes/probe` 的 `adapterId`。
         * UA 照旧全文打印 —— 它仍然是"到底有没有人来取过"的硬证据，
         * 只是不再拿它回答"是谁"。
         */
        /*
         * ✅ **已修（#98 的 ⑤-d，Manager 2026-09-06 裁决"放进判决"）**。
         *
         * 此前这里**唯一**会红的是"一个请求都没收到"，`adapterId` 不是 yt-dlp 时
         * 只 `say('ⓘ …')`。而 **`fixtureHits > 0` 只证明「有人」去取过 ——
         * DirectHttp 去取也满足它**，于是 registry 的 fallback 链变了（或这个字段
         * 改名 ⇒ 恒为 null），F1 仍然全绿，而 workflow 与本文件头那句
         * 「验到了 yt-dlp 那一段」从那天起是假话。
         *
         * ⚠️ 这**是**一个判决变更，而且是有意的：链变了必须当场有人知道。
         *    改产品取回顺序时**先改这里的期望、再改文档**，别删掉这一格。
         */
        const fetcher = classifyFetcher({ probeAdapter, hits: fixtureHits });
        say(
          `   ⓘ 取回方分档：kind=${fetcher.kind}  adapterId=${fetcher.adapterId ?? '(没给)'}  命中 ${fetcher.hits} 次`,
        );
        const fetchedBy = checkFetchedByYtdlp({ probeAdapter, hits: fixtureHits });
        if (!fetchedBy.ok) {
          fail('F1', fetchedBy.reason);
        } else {
          say(`   ✔ 产品报告 adapterId=yt-dlp，且 fixture 真的被取了 ${fixtureHits.length} 次`);
          say('     —— F1 走的确实是站点解析器那一支（registry fallback 链按设计生效）。');
          say('     ⚠️ UA 全是 Chrome：yt-dlp 默认伪装浏览器且轮换版本号，**UA 不能用来认它**。');
        }
        // 顺带记一笔：yt-dlp 对直链是不是原样存盘（观测，不作判据）。
        say(`   ⓘ 喂进去的 fixture sha256=${served.sha}（${servedBuf.length} B）`);

        if (st.state !== 'succeeded') {
          const fullErr = await jobErrorFull(imp.body.jobUid);
          if (fullErr) {
            say('   ── job.error 全文 ──');
            for (const l of fullErr.split('\n')) say(`      ${l}`);
          }
          say('   ── daemon 最后 60 行 ──');
          say(tail(daemonLogs, 60));
          fail('F1', checkJobSucceeded({ state: st.state, text: st.text }).reason);
          results.push({ name: 'F1 链接导入', what: 'yt-dlp 取回', ok: false, note: st.state });
        } else {
          /*
           * sha256 传 null：yt-dlp 对直链一般是原样存盘，但 `-f bestaudio/best`
           * 在某些情况下会让它重新封装。**不拿一个可能变化的东西当判据** ——
           * 这里验的是"能不能播"，不是"字节有没有变"。实际 sha 照样打出来。
           *
           * ⚠️ `expectContentType` 同理传 null：yt-dlp 换容器时扩展名事先不知道，
           *    凭空写一个期望值会把"没验到"变成一条恒红的断言。
           *    「Content-Type 头必须在」那一格对这条路照样生效。
           */
          const ok = await assertPlayable('F1', imp.body.noteUid, null, null, null);
          results.push({
            name: 'F1 链接导入',
            what: 'yt-dlp 取回',
            ok,
            note: ok ? '可播放' : '播放断言失败',
          });
        }
      }
    }
  }

  /* ═════════════════ 12. 借宿主工具几个 ═════════════════ */

  hdr('12. ★ 借宿主工具几个（借了就是失败）');
  /*
   * 判据用产品自己的：`/api/selfcheck` 里 `tool.*` 那几项 ——
   *   · ok   = 路径在 storeRoot 底下 = 产品自己下载并校验的
   *   · warn + detail 里提到 PATH = **借的宿主**
   * 不另发明一套。（`selfcheck.ts:390-434`）
   */
  const scr = await j('/api/selfcheck');
  const checks = scr.body?.checks ?? scr.body?.results ?? [];
  /*
   * ★ 分档用的是**跨腿共用的那一份**（`e2e-notes-assertions.mjs` 的 `classifyToolChecks`）——
   *   抄第二份正是本仓反复吃亏的形状，而且那条**散文匹配**的已登记空转
   *   （`/PATH/i` 打在 daemon 写给人看的中文上）只该有一个实现被盯着。
   * ⚠️ 后果在本腿更重：那句话改一个词 ⇒ `borrowed` 恒为 0 ⇒ 下面那条 `fail()` 恒不触发
   *   ⇒ **一个真的在借宿主 ffmpeg 的包会全绿通过 F1/F2**。见 `checkNothingBorrowed()`。
   */
  const { tools, own, borrowed, missing } = classifyToolChecks(checks);
  say(`   /api/selfcheck 共 ${checks.length} 项，其中 ${TOOL_CHECK_PREFIX}* ${tools.length} 项`);
  for (const c of tools) {
    say(
      `     ${String(c.id).padEnd(24)} ${String(c.status).padEnd(6)} ${String(c.detail ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 110)}`,
    );
  }
  say('');
  say(`   ✅ 产品自己下载并校验的 (${own.length})：${own.map((c) => c.id).join(', ') || '(无)'}`);
  say(
    `   ⚠️ **借宿主 PATH 的 (${borrowed.length})**：${borrowed.map((c) => c.id).join(', ') || '(无)'}`,
  );
  say(`   ❌ 装不上/不可用 (${missing.length})：${missing.map((c) => c.id).join(', ') || '(无)'}`);
  const borrowVerdict = checkNothingBorrowed({ borrowed });
  if (!borrowVerdict.ok) {
    fail('12.借用', borrowVerdict.reason);
  } else if (tools.length === 0) {
    /*
     * ⚠️ 空集这一档**只 say 不 fail**（抽出前如此，逐字保留）：拿不到自检结果
     *    与"一个都没借"在判决上是同一件事。第①类失效（空集判通过）。
     *    地板放在自检里（`TOOL_CHECK_PREFIX` 的契约守卫），判决不动。
     */
    say(`   ⚠️ 一个 ${TOOL_CHECK_PREFIX}* 都没有 —— 判据本身不见了，这比它红更值得查。`);
  } else {
    say('   ✔ 一个都没借。');
  }

  /* ═════════════════ 13. 总表 ═════════════════ */

  hdr('13. 总表');
  say('   用例                        形态                              结果');
  say('   ' + '-'.repeat(88));
  for (const r of results) {
    say(
      `   ${String(r.name).padEnd(26)} ${String(r.what).padEnd(32)} ${verdictMark(r.ok)}  ${r.note}`,
    );
  }
} catch (e) {
  say('');
  say(`✘ E2E 导入审计中断：${e.message}`);
  say(e.stack ?? '');
  if (proc) say(`   daemon 状态：exitCode=${proc.exitCode} signal=${proc.signalCode}`);
  if (daemonLogs.length) {
    say('   daemon 最后 60 行：');
    say(tail(daemonLogs, 60));
  }
  failures.push({ step: 'fatal', detail: e.message });
} finally {
  try {
    sseAbort?.abort();
  } catch {
    /* 已经断了 */
  }
  if (fixtureServer) await new Promise((r) => fixtureServer.close(r));
  await stopDaemon();
  hdr('结论');
  /*
   * ★ 未决单独喊一遍，**在判决之前** —— 与 `skippedOnPurpose` 同一条道理
   *   （PROTOCOL §11：跳过不许渲染成成功）。一条"没验到"混在满屏绿里
   *   等于没有，而这一节的存在正是为了让它混不进去。
   */
  if (undecideds.length > 0) {
    say(`   ? ${undecideds.length} 处**未决**（跑了，但什么都没证明 —— 既不是通过也不是失败）：`);
    for (const u of undecideds) say(`     ? [${u.step}] ${u.detail}`);
    say('     （它们会随凭证一起报出去：`undecided` 那一栏。`null`=没上报，`0`=查过了确实没有。）');
    say('');
  }
  /*
   * ⚠️ 落盘**无条件**（不看红绿）：`if: ${{ !cancelled() }}` 那条上传步骤要的就是
   *   "红跑也有这份文件"。只在绿跑写等于把「这一轮有几条没验到」这个信息，
   *   恰好在最需要它的那一次丢掉。
   */
  if (UNDECIDED_OUT) {
    writeFileSync(UNDECIDED_OUT, `${JSON.stringify({ unknowns: undecideds.length }, null, 2)}\n`);
    say(`   覆盖面已写到 ${UNDECIDED_OUT}（unknowns=${undecideds.length}）`);
  }
  if (failures.length === 0) {
    if (skippedOnPurpose.length > 0) {
      say('   ✔ 已执行的用例全部通过，但**本轮不是全量**：');
      for (const t of skippedOnPurpose) say(`     ⊘ 跳过：${t}`);
      say('     （PROTOCOL §11：跳过不许渲染成成功 —— 这盏绿灯只覆盖上面跑过的那些。）');
    } else if (undecideds.length > 0) {
      say(
        `   ✔ 已执行的用例全部通过，但**有 ${undecideds.length} 处未决** ——` +
          '这盏绿灯不覆盖它们（见上面那一节）。',
      );
    } else {
      say('   ✔ 全部通过。');
    }
  } else {
    exitCode = 1;
    say(`   ✘ ${failures.length} 处失败：`);
    for (const f of failures) say(`     · [${f.step}] ${f.detail}`);
  }
  say('');
  say(`   指针文件用的是 ${POINTER}（不是全局的那个）—— PROTOCOL §9。`);
  say(`   临时根目录 ${ROOT} 留在 runner 上，随 runner 一起销毁。`);
}

process.exit(exitCode);
