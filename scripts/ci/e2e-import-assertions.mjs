/**
 * F1（链接导入）+ F2（本地媒体导入）端到端断言 —— **纯函数，与网络无关**。
 *
 * ## 为什么非抽不可
 *
 * `e2e-import-audit.mjs` 抽出来之前是 **1,580 行、37 处内联 `fail()`（59 个判决点）、
 * 顶层执行、结尾 `process.exit()`** —— 和 `e2e-runtime-audit.mjs` 被抓那次一模一样的
 * 形状：**import 不进来 ⇒ 它内部的判据一条都没法被喂输入。**
 *
 * runtime 那条腿因此烂了三周没人发现：
 *
 * ```js
 * // e2e-runtime-audit.mjs（修复前）
 * /先安装 CPU/.test(String(p.inapplicableReason ?? ''))
 * ```
 *
 * 文案从「先安装 CPU」改成「先装 CPU」的那天起，它**再也没有匹配过任何东西**，
 * 而它看起来仍然像一条护栏。runtime / browser / record / notes 四条腿都已经照
 * 「抽判据模块 + 写变异自检」修过，**import 是最后一条**。
 *
 * ⚠️ 这条腿守的是章程里的两条主线功能（F1/F2），而且它**只在 schedule 与手动
 *    dispatch 时跑** —— 也就是说：它的判据坏掉的那一天，没有任何一个 PR 会红。
 *    notes 腿的 `modes.chineseTokenizer → modes.tokenizer` 就是这么烂掉的。
 *
 * ## 这里的每个函数都满足四条
 *
 *   1. **纯**：只吃数据、只回 `{ ok, reason }`（外加 `reasons[]`，见下），
 *      不发请求、不读盘、不看时钟；`Buffer` 的比较是纯的，照收。
 *   2. **可被喂坏数据**：`selftest-e2e-import.mjs` 对每一条都准备了「必须判红」的
 *      变异输入，**并且**准备了「必须判绿」的对照组 ——
 *      只拒不收的函数（恒假 ⇒ 恒红）和只收不拒的函数（恒真 ⇒ 恒绿）
 *      在门禁上的价值完全相同，都是零；
 *   3. **多条腿的判据，每条腿各有一个坏输入**：一条判据里 4 个格子，
 *      只喂一个坏输入只能证明其中一格有牙齿。抽掉任意一条修法，自检都要红。
 *      逐格证明由 `scripts/ci/leg-coverage.mjs --leg import` 现算。
 *   4. **契约字面量单独立出来**（`ASSET_ROLES` / `YTDLP_ADAPTER_ID` /
 *      `UPLOAD_ENDPOINT` …）：`.mjs` 拿不到 TS 的类型检查，所以
 *      `selftest-e2e-import.mjs` 里有一组**契约漂移守卫**，正面核这些字面量
 *      还在不在产品源码里。少了它，判据会静默退回"恒不触发"或"恒红"。
 *
 * ## ⚠️ 两个组合子，不是一个 —— `all` 与 `collect` 的区别是**行为等价**的要求
 *
 * notes / runtime 那几条腿的断言是 `ok()` **抛异常**的，天然短路，所以它们只需要
 * `all(…)`。**本腿不是**：`e2e-import-audit.mjs` 从第一天起就是
 * 「收集所有失败，最后一次性摊开」（文件里那句「一次 CI 跑完要能看到全部问题，
 * 不是第一个就退」）。把那些**互相独立的** `if` 收进短路的 `all(…)`，
 * 会让一次 CI 跑丢掉后面几条诊断 —— 判决不变，但读日志的人少拿到东西。
 *
 *   · `all(…)`     短路：原文是 `if / else if` 或 `return false` 的那些格
 *   · `collect(…)` 收集：原文是几个**平行的** `if`、各自 `fail()` 的那些格
 *
 * ⚠️ 这几处刻意写成 `all(…)` 而不是带方括号的那个写法：`leg-coverage.mjs` 是
 *    **纯文本**切格子的（不剥注释），注释里出现一次组合子开头就会多切出一"格"。
 *    那种格删掉不改变任何行为 ⇒ 恒"删了也绿" ⇒ 覆盖率里凭空多出几格假的空转。
 *
 * 调用方拿到的是同一个形状（`{ ok, reason, reasons }`），`reasons` 里是**全部**
 * 不成立的理由，顺序与抽出前逐字一致。
 *
 * ## ⚠️ 这一轮**只搬家，不改判什么**
 *
 * 抽的过程中发现的空转**一条都没有顺手改**，全部登记在各自函数的注释里，
 * 并在 `selftest-e2e-import.mjs` 的 ⑤ 那一节留了会说话的桩：
 * **修好的那天它们会红**，逼出一次显式的「删桩 + 更新报告」。
 *
 * 同理，这里**没有**给任何判据新增「非空虚前提」那样的格子（notes 腿加过几处）。
 * 新增一格 = 新增一个会红的条件 = 改了这条腿判什么。本轮要的地板一律放在
 * `selftest-e2e-import.mjs` 里（那里红了是"判据自己坏了"，不是"产品坏了"）。
 *
 * ## 关于第三态
 *
 * 本文件里**只有一个**函数回第三态：`checkHasVideoContract()` 的 `undecided`。
 * 它对应的是审计里那句「没收到 `media.ready` ⇒ 本例未验证」——
 * 那不是通过、也不是失败，而**今天的审计把它渲染成了通过**（见那个函数的注释，
 * 已登记为空转 ①）。给它一个有名字的第三态，是为了让那条缺口在类型上说得出口，
 * **不是**为了改判决：审计侧照旧只 `say()`。
 *
 * 证明在 `scripts/ci/selftest-e2e-import.mjs`：把这里任何一条判据抽掉，那边当场红。
 */

/*
 * ★ `classifyToolChecks` 是**跨腿共用的同一条判据**，不是这里再抄一份。
 *
 * notes 腿与本腿都要回答「`/api/selfcheck` 的 `tool.*` 里，哪几个是借宿主 PATH 的」，
 * 而且逐字是同一段逻辑。抄第二份正是本仓反复吃亏的那个形状
 * （`RECORD_SAMPLE_RATE` 两份、`SEGMENT_FLAG` 三份、`JobState` 手抄一遍 —— #89 收敛的那批）。
 *
 * ⚠️ 它今天靠**散文匹配**（`/PATH/i` 打在 daemon 写给人看的一句中文上），
 *    这是一条**已登记的空转**，条目在 `scripts/ci/check-pending-claims.mjs`。
 *    共用这一份的附带好处：那条条目只需要盯**一个**实现。
 *    ⚠️ 但两条腿的**后果不同** —— 见 `checkNothingBorrowed()` 的注释：
 *    notes 那边只 `say`，本腿那边是真的 `fail()`。
 */
export { TOOL_CHECK_PREFIX, classifyToolChecks } from './e2e-notes-assertions.mjs';

/* ────────────────────────── 通用小工具 ────────────────────────── */

/**
 * 统一的返回形态。`ok:false` 必须带上**能定位**的理由，不要只说"不匹配"。
 *
 * ⚠️ 不返回布尔：一个裸 `false` 到了调用方就只剩「这条红了」，
 * 而 CI 日志里读到它的人需要的是「红在哪一格、期望什么、实得什么」。
 *
 * `reasons` 是 `collect()` 用的**全部**理由；`all()` / 单格判据下它恒为
 * `[]`（绿）或 `[reason]`（红），于是调用方可以一律写
 * `for (const r of v.reasons) fail(tag, r)`，两种组合子共用一条接线。
 */
const no = (reason) => ({ ok: false, reason, reasons: [reason] });
const yes = () => ({ ok: true, reason: '', reasons: [] });

/** 逐条跑，**第一条不成立就回它** —— 对应原文里 `if / else if` 与 `return false` 那些格。 */
function all(steps) {
  for (const step of steps) {
    const r = typeof step === 'function' ? step() : step;
    if (!r.ok) return r;
  }
  return yes();
}

/**
 * 逐条**全跑**，把所有不成立的理由都收回来 —— 对应原文里几个平行 `if` 各自 `fail()`。
 *
 * ⚠️ 顺序**必须**与抽出前的 `if` 顺序一致：CI 日志里那几行是按这个顺序读的。
 */
function collect(steps) {
  const reasons = [];
  for (const step of steps) {
    const r = typeof step === 'function' ? step() : step;
    if (!r.ok) reasons.push(r.reason);
  }
  return reasons.length === 0 ? yes() : { ok: false, reason: reasons.join('；'), reasons };
}

/** `ok()` 的纯函数版。 */
function must(cond, reason) {
  return cond ? yes() : no(reason);
}

/**
 * 转字符串并**截断**。
 *
 * ⚠️ PROTOCOL §8：断言失败时 `util.inspect` 会顺着 `parentNode` / `parent`
 * 指针把整棵树展开（实测涨到 10.5 GB，表现成"脚本炸了"而不是"断言变红"）。
 * 所以这里一律先转成字符串再比、再截断。
 */
export function brief(v) {
  let s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = String(s ?? '');
  return s.length > 300 ? `${s.slice(0, 300)}…(共 ${s.length} 字符)` : s;
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 契约字面量 —— `.mjs` 拿不到类型检查，所以它们由自检正面核                    */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 判据里用到的两个**媒体资产角色**。与 `packages/shared/src/notes.ts` 的
 * `MEDIA_ASSET_ROLES` 逐字对应。
 *
 * ⚠️ 这两个字面量改名而这里没跟，`assets.find(a => a.role === 'original')`
 * 会**永远找不到** ⇒ `没有 role='original' 的资产` 变成一条**恒红**的断言，
 * 而它红的那句话会指向产品。自检里有契约漂移守卫。
 */
export const ASSET_ROLES = Object.freeze({
  /** 用户导进来的那个文件本体。sha256 往返比的就是它。 */
  original: 'original',
  /** 16k 单声道音轨 —— 播放器的波形/时间轴（F5）走的是这一份。 */
  audio16k: 'audio16k',
});

/**
 * 资产**可用**的那一档（`media_assets.state`，`MEDIA_ASSET_STATES` 四格之一）。
 *
 * ⚠️ 已经栽过一次的形状（`packages/shared/src/notes.ts:295` 记着）：
 * 手抄的镜像与服务端各自演化 ⇒ `a.state === 'ready'` **恒 false**。
 */
export const ASSET_STATE_READY = 'ready';

/** 网页真正发的那个上传端点（`apps/web/src/features/capture/upload.ts` 的 `UPLOAD_ENDPOINT`）。 */
export const UPLOAD_ENDPOINT = '/api/notes/upload';

/**
 * multipart 里那个文件字段的名字。
 *
 * ⚠️ 这个字符串是**本腿存在的理由的一半**：F2 的全部价值在于"走网页真正走的那条路"。
 * 字段名对不上 ⇒ daemon 400 ⇒ 会表现成"上传坏了"，而坏的是夹具。
 */
export const UPLOAD_FILE_FIELD = 'file';

/**
 * yt-dlp 适配器的 id（`packages/pipeline/src/media/types.ts` 的 `MediaSourceId` 四格之一）。
 *
 * 这是**产品自己说的**「这条链接是谁解析的」，比任何外部推断都硬 ——
 * 尤其比 User-Agent 硬：yt-dlp 默认伪装成浏览器且每次轮换版本号（审计里有实测现场）。
 */
export const YTDLP_ADAPTER_ID = 'yt-dlp';

/** HTTP：Range 请求成功那一档。 */
export const STATUS_PARTIAL_CONTENT = 206;
/** HTTP：Range 越界那一档（`apps/daemon/src/http/media.ts` 明写 `416` + `bytes * /size`）。 */
export const STATUS_RANGE_NOT_SATISFIABLE = 416;
/** HTTP：导入/上传**排上队**那一档（异步任务，不是 200）。 */
export const STATUS_ACCEPTED = 202;

/** 回环地址的两种写法。⚠️ `::1` 不是多余的：本机实测 `localtest.me` 就解到它。 */
export const LOOPBACK_ADDRESSES = Object.freeze(['127.0.0.1', '::1']);

/**
 * job 的**终态**三格（`packages/shared` 的 `JOB_STATES` 的子集）。
 *
 * ⚠️ `blocked` **不在**这里，它单独一档：它不是终态，但**永远不会自己好**
 * （缺 ASR 模型 / 缺工具时 job 就停在这）。一直轮询到超时的话，
 * 日志里只有一句 TIMEOUT，看不出是缺东西。
 */
export const JOB_TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled']);

/**
 * H.264 编码器的两个名字。**探测，不写死** —— 不同平台的产品 ffmpeg 来自不同上游构建：
 * linux/win32 是 BtbN 的 LGPL 构建（只有 `libopenh264`），macOS 是 jellyfin-ffmpeg 的
 * GPL 构建（只有 `libx264`）。`[实测 run 31368489758]` 两边硬编码都在另一批平台上炸过。
 *
 * ⚠️ 顺序有意义：`libx264` 优先（与抽出前逐字一致）。
 */
export const H264_ENCODERS = Object.freeze(['libx264', 'libopenh264']);

/**
 * 后面每一步都指着的**必需后端包**。
 *
 * ★ 这份清单是「失败发生的地方与失败显形的地方隔得太远」的解药：
 * `[本机实测]` 一轮里 whispercpp 包因为下载源抖动没装上，产品在找不到
 * `whisper-cli` 时**回退到 PATH**（`tools.ts` 的 `findInBackendPacks(...) ?? fromPath(...)`），
 * 而 PATH 上放着本脚本的屏蔽 shim，于是六个用例**全部**失败在
 * `maskbin/whisper-cli exited with code 127` —— 那一串错误读起来像「转写坏了」。
 */
export const REQUIRED_PACK_PREFIXES = Object.freeze([
  { prefix: 'media-tools-', why: 'ffmpeg/ffprobe —— 造样本、抽音轨、归一化全靠它' },
  {
    prefix: 'whispercpp-',
    why: 'whisper-cli/whisper-vad —— 没有它转写必失败，而资产要转写成功才落库',
  },
  { prefix: 'ytdlp-', why: 'yt-dlp —— F1 链接导入的取回方' },
]);

/**
 * F2/F2b 总表补行用的**完整期望名单**。
 *
 * ⚠️ 独立于审计里那份 `FIXTURE_SPECS`：后者在没有 H.264 编码器的机器上**压根不包含**
 * `f2-video.mp4`。补行只按 `FIXTURE_SPECS` 算"缺了谁"的话，「没编码器」这种缺法
 * 会跟「造样本失败」一样在总表里**悄悄消失** —— 同一个陷阱换了个触发路径。
 */
export const ALL_FIXTURE_KINDS = Object.freeze([
  { name: 'f2-audio.wav', what: 'PCM / WAV / 仅音轨' },
  { name: 'f2-audio.mp3', what: 'MP3 / MPEG / 仅音轨' },
  { name: 'f2-audio.m4a', what: 'AAC / MP4 / 仅音轨' },
  { name: 'f2-video.mp4', what: 'H.264+AAC / MP4 / 带视频' },
]);

/* ══════════════════════════════════════════════════════════════════════════ */
/* §2/§5 起 daemon —— 「端口上有东西应答」≠「我起的那个 daemon 起来了」          */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 应答方是不是**我 spawn 的那个进程**（按 pid）。
 *
 * ## 事故原形（PROTOCOL §11 点名的三个实例之一，就是这条腿）
 *
 * 上一轮跑剩的一个 daemon 还占着 19800，本脚本的健康检查**当场就绿了（0.5s）**，
 * 而我 spawn 的那个因为端口冲突以 exit 4 死了。于是后面整整一节都在跟**别人的
 * daemon** 说话 —— 它的数据目录我已经 rm 掉了，在一个装满的 tmpfs 上，
 * 于是拿到一串 `DISK_FULL`。**假的红灯和假的绿灯一样贵。**
 *
 * ## ⚠️ Windows 上**不能**比 pid（这一格最容易被"顺手统一"掉）
 *
 * `start.cmd` 没有 `exec`，`node.exe` 是 cmd.exe 的**子进程** ⇒ `proc.pid` 是
 * cmd.exe 的。那边比 pid 会把一次**正确的**启动判成"别人的 daemon"。
 * POSIX 上启动器最后是 `exec`，shell 把自己换成 node，pid 相同，照比。
 *
 * ⇒ 所以 Windows + 经启动器 那一格**刻意恒绿**，身份证明由
 *   `checkDaemonDataDir()` 承担（`dataDir` 是本轮 `mkdtemp` 出来的唯一路径）。
 *   自检里有一条对照用例正面钉住这个豁免**只**在那一格生效。
 */
export function checkDaemonPidIdentity({ isWindows, viaLauncher, bodyPid, spawnPid }) {
  const canComparePid = !isWindows || !viaLauncher;
  return must(
    !(canComparePid && bodyPid !== undefined && bodyPid !== spawnPid),
    `端口上应答的不是我起的那个 daemon：我 spawn 的 pid=${brief(spawnPid)}，应答方 pid=${brief(bodyPid)}`,
  );
}

/**
 * 应答方的 `dataDir` 是不是本轮 `mkdtemp` 出来的那一个。
 *
 * ★ **在 Windows 上这就是身份证明本身**（见上）：那条路径别的 daemon 不可能报出来。
 *
 * ⚠️ `undefined` 那一档**放过**，与抽出前逐字一致：老版本 daemon 的 `/api/health`
 * 不发这个字段，把"没发"判成"不是我的"会让这条腿在旧包上恒红。
 */
export function checkDaemonDataDir({ bodyDataDir, wantDataDir }) {
  return must(
    bodyDataDir === undefined || bodyDataDir === wantDataDir,
    `应答方的 dataDir 不是本次这个：${brief(bodyDataDir)} ≠ ${brief(wantDataDir)}`,
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §3/§4/§9/§10/§11 job 轮询 —— 「这是不是我要的那个 job」                      */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一次 `/api/jobs/:id` 轮询的**分类**（纯函数；等待与超时留在审计里）。
 *
 * ★ 字段名是 **`jobId`** —— `cold-start-audit.mjs` 记着这个名字被写错过三次的全过程。
 *   三个名字都收（`jobId` / `uid` / `id`），但**绝不回退到"随便哪个 job"**：
 *   拿到的 job 不是我要的那个 ⇒ 当场 `error`，不是继续轮询。
 *   少了这一格，一个"永远返回队列里第一个 job"的实现会让整条腿读到别人的成功。
 *
 * @returns {{done: boolean, state?: string, text?: string, job?: object}}
 *          `done:false` = 还没到终态，接着轮询。
 */
export function classifyJobPoll({ status, body, jobId }) {
  if (status !== 200) return { done: true, state: 'error', text: `轮询得到 HTTP ${status}` };
  const job = body?.job ?? body;
  const gotId = job?.jobId ?? job?.uid ?? job?.id;
  if (!job || gotId !== jobId) {
    return {
      done: true,
      state: 'error',
      text: `端点返回的不是这个 job（要 ${jobId}，拿到 ${gotId}；keys=${JSON.stringify(
        Object.keys(job ?? {}),
      ).slice(0, 200)}）`,
    };
  }
  if (JOB_TERMINAL_STATES.includes(job.state)) {
    return {
      done: true,
      state: job.state,
      text: `${job.state}${job.error ? ` — ${JSON.stringify(job.error).slice(0, 400)}` : ''}`,
      job,
    };
  }
  /*
   * `blocked` 不是终态，但它**永远不会自己好**。一直轮询到超时的话，
   * 日志里只有一句 TIMEOUT，看不出是缺东西。当场说清楚。
   */
  if (job.state === 'blocked') {
    return {
      done: true,
      state: 'blocked',
      text: `blocked（blockedCode=${job.blockedCode ?? 'null'}）`,
      job,
    };
  }
  return { done: false };
}

/** 这一单的转写 job 真的**成功**了（F2 / F2b / F1 三处共用）。 */
export function checkJobSucceeded({ state, text }) {
  return must(state === 'succeeded', `job 没成功：${text}`);
}

/**
 * 装包失败之后**要不要重试** —— 只对产品自己标了 `retryable:true` 的重试。
 *
 * `[本机实测]` 一轮里 `whispercpp-cpu-linux-x64` 拿到
 * `{"code":"PROVIDER_UNREACHABLE","retryable":true}`（下载源抖动）。
 * 重试的是网络抖动，不是掩盖产品失败：`retryable:false` 的（DISK_FULL、
 * CHECKSUM_MISMATCH）**一次都不重试** —— 那些重试一万遍也还是那个答案。
 *
 * @returns {'done'|'not-retryable'|'retry'}
 */
export function classifyInstallAttempt({ state, job, attempt, maxAttempts = 2 }) {
  if (state === 'succeeded' || attempt >= maxAttempts) return 'done';
  if (job?.error?.retryable !== true) return 'not-retryable';
  return 'retry';
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §3 后端包                                                                   */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 必需的后端包**全都装上了**。
 *
 * ⚠️ 这里刻意用 `collect`：三个包各缺各的，抽出前也是三条独立的 `fail()`。
 * 换成短路的 `all` 会让"三个全没装上"只报一条 —— 而那三条正是给读日志的人
 * 分辨"下载源整个不通"和"某一个包坏了"的依据。
 */
export function checkRequiredPacksInstalled({ installedIds, required = REQUIRED_PACK_PREFIXES }) {
  const ids = [...(installedIds ?? [])];
  return collect(
    (required ?? []).map(
      (r) => () =>
        must(
          ids.some((id) => String(id).startsWith(r.prefix)),
          `必需的 ${r.prefix}* 没装上 —— ${r.why}`,
        ),
    ),
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §4 模型目录                                                                 */
/* ══════════════════════════════════════════════════════════════════════════ */

/** `/api/models/catalog` 的 `groups` 展平成条目（`role` / `tags` 从组上继承）。 */
export function flattenModelCatalog(groups) {
  return (groups ?? []).flatMap((g) =>
    (g?.variants ?? []).map((v) => ({
      ...v,
      role: v.role ?? g.role,
      tags: v.tags ?? g.tags ?? [],
    })),
  );
}

/** 一个模型条目的总字节数（多文件相加）。 */
export function modelSizeBytes(m) {
  return (m?.files ?? []).reduce((n, f) => n + (f?.sizeBytes ?? 0), 0);
}

/**
 * whisper.cpp **加载得动**的那些条目。
 *
 * 两条判据取并集不是冗余：`engines` 是契约字段（新目录有），`asr/whisper-` 前缀是
 * 老目录的兜底。只留前者 ⇒ 老目录上挑不出模型；只留后者 ⇒ 换了命名就瞎。
 */
export function isWhisperCppModel(m) {
  return (m?.engines ?? []).includes('whisper.cpp') || /^asr\/whisper-/.test(String(m?.id ?? ''));
}

/**
 * 挑**最小的**那个 whisper.cpp ASR 模型（转写耗时与它成正比，这一步证的是"通不通"）。
 *
 * ⚠️ `bytes > 0` 那一格不是洁癖：目录里有条目会把 `files` 写成空数组（尺寸未知），
 * 排序时它会稳定地排在最前面 ⇒ **永远挑中一个下不下来的东西**，
 * 而失败会以「pull job failed」的面目出现在四步之后。
 *
 * @returns {{m: object, bytes: number}|undefined}
 */
export function pickSmallestWhisperAsr(models) {
  return (models ?? [])
    .filter((m) => m?.role === 'asr' && isWhisperCppModel(m))
    .map((m) => ({ m, bytes: modelSizeBytes(m) }))
    .filter((x) => x.bytes > 0)
    .sort((a, b) => a.bytes - b.bytes)[0];
}

/** 目录里**挑得出**一个 ASR 模型 —— 挑不出来的话后面所有转写都会失败。 */
export function checkAsrModelPicked({ asr }) {
  return must(!!asr, '目录里挑不出任何 whisper.cpp 能加载的 asr 模型 —— 先怀疑 unwrap，再怀疑目录');
}

/** VAD 那一档：小于等于 250 MB 的都要（与抽出前逐字一致）。 */
export function pickVadModels(models, maxBytes = 250 * 1024 * 1024) {
  return (models ?? []).filter((m) => m?.role === 'vad' && modelSizeBytes(m) <= maxBytes);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §6 产品自己那份工具                                                         */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 造样本用的 ffmpeg 是**产品自己下载并校验的那一份**，不是宿主借的。
 *
 * ## 🔴 已登记空转（②）：**第二格今天不可能红**
 *
 * `PRODUCT_FFMPEG` 是 `findUnder(STORE_ROOT, 'ffmpeg')` 的返回值，而 `findUnder`
 * 的每一个候选都是 `join(<STORE_ROOT 下的某个目录>, name)` —— **它在结构上只会
 * 返回 storeRoot 底下的路径**。于是 `found.startsWith(storeRoot)` 恒真，
 * 那句「这就是"借宿主的"」的报错**一次都不可能打印出来**。
 *
 * 「产品真的借了宿主的 ffmpeg」这个缺陷状态，落到这条判据上长的是**第一格**的样子
 * （storeRoot 里找不到）。也就是说第二格不是错的，是**多余的**，而它写得像一条护栏。
 * 第①类失效：断言的东西在缺陷状态下也成立。
 *
 * ⚠️ 更糟的一半：它**真的响起来的那一天，说的是假话**。`storeRoot` 来自
 * `process.env.OPENMEMO_MODELS ?? join(dataDir, 'models')` —— 走 env 那一支时
 * 它**没有被 `join` 归一化过**。Windows 上 `OPENMEMO_MODELS=C:/x/models` 会让
 * `join` 产出 `C:\x\models\…`，前缀比对当场为假 ⇒ 报「借宿主的」，而它就在 storeRoot 里。
 * **这正是 `notes.ts:120-141` 记着的那次事故**（`root + '/'` 拼前缀比对），
 * 同一个坑，出现在**守卫**这一侧。
 *
 * ⇒ 修法要么删掉第二格、要么改成 `resolve()` 之后再比（或 `relative()` 不以 `..` 开头）。
 *   两者都是「改判什么」，**本轮不改**，等 owner 裁。桩在 `selftest-e2e-import.mjs` ⑤-b。
 */
export function checkToolUnderStoreRoot({ found, storeRoot, name, whyNeeded }) {
  return all([
    () => must(!!found, `storeRoot 里找不到 ${name} —— ${whyNeeded}。storeRoot=${storeRoot}`),
    () =>
      must(
        String(found).startsWith(String(storeRoot)),
        `找到的 ${name} 不在 storeRoot 底下（${found}）—— 这就是"借宿主的"`,
      ),
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §7 造样本                                                                   */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 从 `ffmpeg -encoders` 的输出里**探测** H.264 编码器名。
 *
 * ## 为什么它是判据而不是脚手架
 *
 * 这个正则一旦对不上真实二进制的输出，**整条 F2 的"带视频"那一格会以
 * "这台机器没有编码器"的形状消失** —— 而总表里那一行会写着
 * 「⊘ 跳过：样本没造出来」，读起来像环境问题，其实是探测器瞎了。
 *
 * ⚠️ `\b` 是必须的：`ffmpeg -encoders` 的输出里 `libx264rgb` 与 `libx264` 同时在场，
 * 不加词边界会在只有 `libx264rgb` 的构建上挑中一个不存在的名字。
 * （⚠️ 这里的 `\b` 是 **JS 正则**，与 `check-locale-ratchet.mjs` 那条
 *   在 `git grep -E` 的 POSIX ERE 里退化成字面 `b` 的 `\b` 不是一回事 —— #96。）
 */
export function pickH264Encoder(encoderListText) {
  const listed = String(encoderListText ?? '');
  for (const name of H264_ENCODERS) {
    if (new RegExp(`\\b${name}\\b`).test(listed)) return name;
  }
  return null;
}

/** 两个编码器至少在场一个，否则造不出带视频的样本。 */
export function checkH264EncoderAvailable({ encoder }) {
  return must(!!encoder, 'PRODUCT_FFMPEG 既没有 libx264 也没有 libopenh264 —— 造不出带视频的样本');
}

/**
 * 一个样本**真的造出来了**。
 *
 * ⚠️ `exists` 与 `exitCode === 0` 缺一不可：ffmpeg 有一批分支会**退 0 却不写文件**
 * （比如输出路径不可写时的某些容器），只看退出码会让下一步拿到 `ENOENT`。
 */
export function checkFixtureBuilt({ name, exitCode, exists, stderr }) {
  return must(
    exitCode === 0 && exists === true,
    `造 ${name} 失败（exit=${exitCode}）：${String(stderr ?? '').slice(-800)}`,
  );
}

/** 一个样本都没造出来 ⇒ F2 无从谈起。 */
export function checkAnyFixtureBuilt({ count }) {
  return must(Number(count) > 0, '一个样本都没造出来 —— F2 无从谈起');
}

/**
 * 期望名单里**没造出来**的那些（总表补行用）。
 *
 * 判决不在这里（第 7 节的 `fail()` 早判过一次红了）—— 一个根因不该被数成两次失败。
 * 这里单纯是让人从总表本身就能看出「F2 覆盖了哪几个格式、缺的是哪个、为什么」，
 * 而不是那一行**凭空消失**。
 */
export function missingFixtureKinds({ made, all: kinds = ALL_FIXTURE_KINDS }) {
  const got = new Set(made ?? []);
  return (kinds ?? []).filter((k) => !got.has(k.name));
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §9 F2：网页真正走的那条路（multipart 上传）                                 */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 手写 `multipart/form-data` —— 不引依赖，且这样才知道网页那一串字节到底长什么样。
 *
 * ★ 它是判据的一部分，不是工具函数：字段名、CRLF、结尾 boundary 的两个短横线
 * 任何一处写错，daemon 会 400，而那会表现成**产品坏了**。
 * 自检里对着 `apps/web/src/features/capture/upload.ts` 正面核字段名与端点。
 *
 * @returns {{body: Buffer, contentType: string, boundary: string}}
 */
export function buildMultipart(fileName, fileBuf, fields = {}, boundary) {
  const b = boundary ?? `----OpenMemoE2E${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="${UPLOAD_FILE_FIELD}"; filename="${fileName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    fileBuf,
    Buffer.from(`\r\n--${b}--\r\n`),
  );
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${b}`,
    boundary: b,
  };
}

/**
 * 上传**排上队了**：202 + 两个 uid 都在。
 *
 * ⚠️ 三格合成一条报错（与抽出前逐字一致）：抽出前这里就是一个 `||` 串起来的 `if`，
 * 拆成三条会多出两行 CI 日志 —— 判决不变，但这一轮是搬家，不是重写。
 */
export function checkUploadQueued({ status, body }) {
  return must(
    status === STATUS_ACCEPTED && !!body?.noteUid && !!body?.jobUid,
    `上传没排上队：HTTP ${status} ${JSON.stringify(body).slice(0, 500)}`,
  );
}

/**
 * `media.ready.hasVideo` 必须说真话：带视频的 mp4 → true，纯音轨 → false。
 *
 * ## ★ 这条契约字段的**唯一读者**就是这一格
 *
 * `hasVideo` 此前是**写死的 `false`**，导入一个 mp4 也报"没有视频"。当年那个"真读者"
 * （`apps/daemon/scripts/e2e-f2.mjs`）已删 —— 它要一个外部已经跑着的 daemon，
 * 从来没有任何自动调用方。
 *
 * ## 🔴 已登记空转（①）：**收不到事件 = 悄悄算通过**
 *
 * 审计里那句注释写着「**收不到就如实说收不到，不当成通过**」，而代码是：
 *
 * ```js
 * if (!ready) { say('⚠️ 没收到 media.ready …—— hasVideo 本例未验证'); }   // ← 只 say，不 fail
 * else if (ready.hasVideo !== wantVideo) { fail(…); ok = false; }
 * ```
 *
 * `ok` 保持为 true ⇒ 总表那一行照旧是「✔ 通过」。也就是说：
 * **SSE 的事件名改一个字（或 payload 里 `noteUid` 换个名字），`mediaReady` 永远是空的，
 * 这条契约就再也没有读者了，而没有任何东西会红。** 第①类失效（空集判通过），
 * 叠加**注释型断言**（注释声称的行为与代码不符）。
 *
 * ⇒ 修法是把 `!ready` 那一支接进 `fail()`（或接进 `--undecided` 那条管道）。
 *   两者都是「改判什么」，**本轮不改**。这里给它一个有名字的第三态，
 *   让缺口在类型上说得出口；审计侧照旧只 `say()`，行为逐字不变。
 *   桩在 `selftest-e2e-import.mjs` ⑤-a。
 *
 * @returns {{ok: boolean, undecided?: boolean, reason: string, reasons: string[]}}
 */
export function checkHasVideoContract({ ready, wantVideo, what }) {
  if (!ready) {
    return {
      ok: false,
      undecided: true,
      reason: `没收到 media.ready —— hasVideo 本例未验证（${what}）`,
      reasons: [],
    };
  }
  return must(
    ready.hasVideo === wantVideo,
    `media.ready.hasVideo=${ready.hasVideo}，期望 ${wantVideo}（${what}）—— 契约字段在说谎`,
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §8 播放断言（F1/F2 共用）—— **整个脚本的判据本体**                          */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 笔记详情取得回来（后面每一格的前提）。
 *
 * ⚠️ 这一格不成立时调用方**当场 return**，不再往下问 —— 与抽出前逐字一致。
 */
export function checkNoteFetched({ status, body, noteUid }) {
  return must(
    status === 200,
    `GET /api/notes/${noteUid} → HTTP ${status}：${JSON.stringify(body).slice(0, 400)}`,
  );
}

/**
 * `role='original'` 的资产在、ready、且带 url。
 *
 * 三格各堵一种"看起来成功了"：
 *   · 资产不在   ⇒ 转写走完了但媒体根本没落库；
 *   · 不是 ready ⇒ 落了一行但文件还没到位（`pending` / `missing` / `failed`）；
 *   · 没有 url   ⇒ 网页拿不到播放地址，用户看到的是一个点不动的播放器。
 *
 * ⚠️ 用 `asset?.state` 而不是 `asset.state`：抽出前这三格是 `return false` 串起来的，
 * 后两格在第一格不成立时**根本不会被求值**。写成可选链之后，逐格覆盖扫描器
 * （`leg-coverage.mjs`）删掉第一格时，第二格会**如实判红**而不是抛 TypeError ——
 * 一个"删掉就崩"的格子在那个工具里判不了，而判不了的格子会被误读成没覆盖。
 */
export function checkOriginalAssetReady({ asset, noteStatus }) {
  return all([
    () =>
      must(
        !!asset,
        `没有 role='${ASSET_ROLES.original}' 的资产 —— 媒体没落库。note.status=${noteStatus}`,
      ),
    () =>
      must(
        asset?.state === ASSET_STATE_READY,
        `role='${ASSET_ROLES.original}' 的 state=${asset?.state}（不是 ${ASSET_STATE_READY}）`,
      ),
    () => must(!!asset?.url, `role='${ASSET_ROLES.original}' 没有 url 字段 —— 网页拿不到播放地址`),
  ]);
}

/**
 * 整体 GET：200 + 非空 + `Accept-Ranges: bytes` + `Content-Length` 对得上。
 *
 * ⚠️ 四格**平行**（`collect`）：抽出前是四个各自 `fail()` 的 `if`。
 *
 * ## ⚠️ 这里**没有** Content-Type 那一格 —— 而 `assertPlayable()` 的文档说有
 *
 * 抽出前那段文档写着「② 整体 GET → 200 + Content-Length 对 + **Content-Type 对**」，
 * 而代码里 `ctype` **只被 `say()` 打印，从来没有被判过**。
 * 第④类失效（注释型断言：注释声称一件从没发生的事）。
 * **本轮不补**（补一格 = 改这条腿判什么），登记在 ⑤-c，文档那句话也原样留着 ——
 * 顺手改掉注释会让这条缺口在下一次审计里消失，而缺口本身还在。
 *
 * ## ⚠️ `Content-Length` 那一格是**有条件**的（`clen === null` 就放过）
 *
 * 一个从此不再发 `Content-Length` 的 daemon 会静默通过这一格。它守的是"发了但发错"，
 * 守不住"不发了"。抽出前如此，这里逐字保留。
 */
export function checkFullFetch({ status, buf, contentLength, acceptRanges }) {
  const len = buf?.length ?? 0;
  return collect([
    () =>
      must(
        status === 200,
        `整体 GET 期望 200，拿到 ${status}：${String(buf?.subarray?.(0, 400) ?? '')}`,
      ),
    () => must(len !== 0, `整体 GET 返回 0 字节 —— 有记录但没有可播放的内容`),
    () =>
      must(
        acceptRanges === 'bytes',
        `Accept-Ranges 期望 'bytes'，拿到 ${acceptRanges} —— 播放器无法拖动进度条`,
      ),
    () =>
      must(
        contentLength === null || Number(contentLength) === len,
        `Content-Length=${contentLength} 与实收 ${len} 不符`,
      ),
  ]);
}

/**
 * ★★ **sha256 往返** —— 整条腿最值钱的一条。
 *
 * 导进去的文件与 `/media` 吐出来的字节**逐字节相同**。它同时否掉三种形态：
 * 「落库了但文件丢了」「归档时截断了」「Range 算错了偏移」——
 * 而这三种在"数据库里有一行"的判据下**全都是绿的**。
 *
 * ⚠️ `expectSha === null` = **本例不比对**（F1 走这一支：yt-dlp 的
 * `-f bestaudio/best` 在某些情况下会重新封装容器，拿一个可能变化的东西当判据
 * 会让这条腿随上游版本随机变红）。那一支下这条判据**恒绿** ——
 * 自检里同时有「null ⇒ 必须绿」与「非 null 且不等 ⇒ 必须红」两个方向，
 * 少了前者，有人把 F2 也改成传 null 时不会有任何东西说话。
 */
export function checkShaRoundTrip({ expectSha, gotSha, expectBytes, gotBytes }) {
  if (expectSha === null) return yes();
  return must(
    gotSha === expectSha,
    `★ sha256 往返不符：导入 ${expectSha}（${expectBytes} B），/media 吐出 ${gotSha}（${gotBytes} B）`,
  );
}

/**
 * 前缀 Range（`bytes=0-N`）：206 + `Content-Range` 逐字对 + 字节与整体 GET 的前 N 字节相同。
 *
 * ⚠️ 第三格是**唯一**能抓住"偏移算错了"的那一格：一个把 `start` 算成 1 的实现
 * 照样能回 206、照样能拼出一个自洽的 `Content-Range`（因为它是按自己算的值填的），
 * 只有**逐字节比对**分得开。
 */
export function checkPrefixRange({ status, contentRange, buf, fullBuf, n, size }) {
  return collect([
    () =>
      must(
        status === STATUS_PARTIAL_CONTENT,
        `前缀 Range 期望 206，拿到 ${status} —— 播放器的分段请求会失败`,
      ),
    () =>
      must(
        contentRange === `bytes 0-${n - 1}/${size}`,
        `Content-Range 期望 'bytes 0-${n - 1}/${size}'，拿到 '${contentRange}'`,
      ),
    () =>
      must(
        buf?.length === n && buf.equals(fullBuf.subarray(0, n)),
        `前缀 Range 的字节与整体 GET 的前 ${n} 字节不同（收到 ${buf?.length} B）`,
      ),
  ]);
}

/**
 * 后缀 Range（`bytes=-N`）：206 + 字节与文件尾 N 字节相同。
 *
 * ⚠️ 短路（`all`）：抽出前是 `if (…) {} else if (…) {}` —— 状态码不是 206 时
 * 不比字节，因为那时候 body 是一份错误信息，比出来的"不同"是废话。
 *
 * ★ 后缀 Range 单独验，不是与前缀重复：`bytes=-N` 走的是 `parseRange` 里
 *   **另一条分支**（`total - N`），而那条分支算错的表现是"拖到结尾播不出" ——
 *   前缀那一格完全看不见它。
 */
export function checkSuffixRange({ status, buf, fullBuf, n, size }) {
  return all([
    () => must(status === STATUS_PARTIAL_CONTENT, `后缀 Range 期望 206，拿到 ${status}`),
    () => must(buf.equals(fullBuf.subarray(size - n)), `后缀 Range 的字节与文件尾 ${n} 字节不同`),
  ]);
}

/**
 * 不可满足的 Range（`bytes=<size+100>-`）→ **416**。
 *
 * ## ⚠️ 只钉状态码 —— `Content-Range: bytes * /size` 那一半**没有被验**
 *
 * `assertPlayable()` 的文档写着「⑥ 不可满足的 Range → **416** +
 * `Content-Range: bytes * /size`」，而代码只比了 `r3.status !== 416`。
 * 与 Content-Type 那一格同族（第④类：注释型断言）。
 * `apps/daemon/src/http/media.ts` 今天确实发了那个头 —— 也就是说这是一条
 * **产品做对了、而守卫没在看**的边。**本轮不补**，登记在 ⑤-c。
 */
export function checkUnsatisfiableRange({ status }) {
  return must(status === STATUS_RANGE_NOT_SATISFIABLE, `越界 Range 期望 416，拿到 ${status}`);
}

/** `role='audio16k'` 的资产在（波形/时间轴联动 F5 的素材）。 */
export function checkAudio16kPresent({ asset }) {
  return must(
    !!asset,
    `没有 role='${ASSET_ROLES.audio16k}' 的资产 —— 波形/时间轴联动（F5）没有素材`,
  );
}

/** 那份 audio16k **取得回来且非空**。 */
export function checkAudio16kFetched({ status, buf }) {
  const len = buf?.length ?? 0;
  return must(status === 200 && len !== 0, `audio16k 取不到（HTTP ${status}，${len} B）`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §10 F2b / §11 F1 的导入入口                                                 */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * `POST /api/notes/import` 被**受理**了（202）。
 *
 * ⚠️ `requireIds` 两处**不一样**，这是抽出前就有的不对称，逐字保留：
 *   · F1（链接）  `requireIds: true`  —— 连 `noteUid`/`jobUid` 一起要；
 *   · F2b（路径） `requireIds: false` —— 只看状态码。
 *
 * F2b 那一支拿到 `202` 却没有 `jobUid` 时，下一步 `waitForJob(undefined)` 会打到
 * `/api/jobs/undefined` ⇒ 404 ⇒ `classifyJobPoll` 回 `error` ⇒ 仍然判红，
 * 只是那句报错指向"job 没成功"而不是"回执缺字段"。**判决相同、诊断更差**，
 * 所以它不是空转，只是一处值得统一的粗糙 —— 统一它也是「改判什么」，本轮不动。
 */
export function checkImportAccepted({ status, body, requireIds = false, what }) {
  const idsOk = !requireIds || (!!body?.noteUid && !!body?.jobUid);
  return must(
    status === STATUS_ACCEPTED && idsOk,
    `${what}：HTTP ${status} ${JSON.stringify(body).slice(0, 500)}`,
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §11 F1：链接导入                                                            */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * fixture 主机名**真的指向回环**。
 *
 * ## ⚠️ 解析不到 = 判**失败**，不是跳过（PROTOCOL §11）
 *
 * 以前这里只 push 一条 `ok:null` 然后照常 exit 0，也就是「跳过渲染成了成功」：
 * workflow 里那条 hosts 步骤哪天悄悄坏掉，这条腿会**继续报绿**，而 F1 一次都没跑过。
 *
 * ★ 为什么必须是一个**公网形状**的名字（`.test`，RFC 6761）：产品的 SSRF 防线
 * （`packages/pipeline/src/subprocess/argGuard.ts` 的 `isPrivateOrReservedHost`）
 * 把 `localhost` / `127.0.0.1` / `*.local` 全部拒掉，而那是**正确的** ——
 * daemon 自己就绑在 127.0.0.1 上，放行回环等于把产品变成 confused deputy。
 */
export function checkFixtureHostLoopback({ host, address }) {
  return must(
    LOOPBACK_ADDRESSES.includes(address),
    `fixture 主机名 ${host} 没有指向回环（实测解析到 ${address ?? '(解析不到)'}）——` +
      ' F1 一次都没跑。这是环境没准备好，不是"本轮不需要"，所以判失败而不是跳过。',
  );
}

/**
 * fixture 服务器**自己**的 Range 实现（替身，不是产品）。
 *
 * ## 为什么替身的这几行必须被测
 *
 * 「量错东西」那一类失效的标准形态就是**替身不实现契约，测的是替身自己**：
 * 这个服务器把 `bytes=a-b` 算错 ⇒ yt-dlp 下到一个截断的 mp4 ⇒ ffprobe 失败 ⇒
 * F1 以**产品坏了**的面目变红。一次这样的假红会让人去改产品。
 *
 * ⚠️ 逐字保留抽出前的语义，**包括它的粗糙处**：`bytes=-N` 且 `N > total` 时
 * `start` 是负数 ⇒ 回 416，而 RFC 7233 说该夹到 0（回整个文件）。
 * yt-dlp 不发这种请求，所以今天不影响判决；改它是改夹具行为，本轮不动。
 *
 * @returns {null|{unsatisfiable: true, total: number}|{start: number, end: number, total: number}}
 *          `null` = 没有 Range 头（或形状不认识）⇒ 回整个文件。
 */
export function parseFixtureRange(rangeHeader, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader ?? ''));
  if (!m) return null;
  const start = m[1] === '' ? total - Number(m[2]) : Number(m[1]);
  const end = m[1] === '' ? total - 1 : m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  if (start >= total || start < 0) return { unsatisfiable: true, total };
  return { start, end, total };
}

/**
 * **有人真的来取过这个链接** —— 「产品到底有没有出去取」的硬证据。
 *
 * ⚠️ 这是 §11 里**唯一**会 `fail()` 的一格。见下面 `classifyFetcher()`。
 */
export function checkFixtureWasFetched({ hits }) {
  return must(
    (hits ?? []).length > 0,
    '★ fixture 服务器一个请求都没收到 —— 产品根本没去取这个链接',
  );
}

/**
 * 取回方是谁 —— **今天只是观测，不进判决**。
 *
 * ## 🔴 已登记空转（③）：这一格看起来像判据，其实一个字都不判
 *
 * 抽出前那段注释写着「**改用产品自己的答案**：`/api/notes/probe` 的 `adapterId`」，
 * 读起来像是判据从 UA 换成了 `adapterId`。**没有。** 代码是：
 *
 * ```js
 * if (fixtureHits.length === 0) fail(…);              // ← 只有这一条会红
 * else if (probeAdapter === 'yt-dlp') say('✔ …');
 * else say(`ⓘ 产品报告的解析者是 ${probeAdapter} …`);   // ← 不是 yt-dlp 也照样绿
 * ```
 *
 * 于是：registry 的 fallback 链哪天变了（或者 `adapterId` 这个字段改名 ⇒ 恒为
 * `null`），F1 仍然全绿，而 workflow 与审计文件头里那句「**验到了 yt-dlp 那一段**」
 * 会从那天起是假话。第①类（缺陷状态下断言照样成立）叠第④类（注释声称的判据不存在）。
 *
 * ⚠️ 这条腿在 CI 上的唯一价值就是「粘链接 → 站点解析器真的被 spawn 起来取回」。
 *    `fixtureHits > 0` 只证明了**有人**去取过 —— DirectHttpSource 去取也满足它。
 *
 * ⇒ 修法是把 `kind !== 'ytdlp'` 接进 `fail()`。**本轮不改**（改了这条腿在
 *   fallback 链变化时会红，那是一个判决变更）。桩在 `selftest-e2e-import.mjs` ⑤-d。
 *
 * @returns {{kind: 'none'|'ytdlp'|'other', adapterId: string|null, hits: number}}
 */
export function classifyFetcher({ probeAdapter, hits }) {
  const n = (hits ?? []).length;
  const adapterId = probeAdapter ?? null;
  if (n === 0) return { kind: 'none', adapterId, hits: n };
  return { kind: adapterId === YTDLP_ADAPTER_ID ? 'ytdlp' : 'other', adapterId, hits: n };
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §12 借了宿主几个 —— 用产品自己的判据                                        */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * **一个宿主工具都没借**（借了就是失败）。
 *
 * ## ⚠️ 这一格与 notes 腿的**后果不同**，别照抄结论
 *
 * `classifyToolChecks()`（从 `e2e-notes-assertions.mjs` 共用的那一份）今天靠
 * `/PATH/i` 匹配 daemon 写给人看的一句中文
 * （`packages/runtime/src/selfcheck.ts`：「…（来自系统 PATH，非本产品安装 ——
 * 用户机器上不一定有）」）。那是一条**已登记**的空转（`check-pending-claims.mjs`）。
 *
 * 在 notes 腿上，那句话改一个词的后果是**审计末尾印出一句假话**（只 `say`，不判）。
 * **在本腿上后果更重**：`borrowed` 恒为 0 ⇒ 下面这条判据恒绿 ⇒
 * **一个真的在借宿主 ffmpeg 的包会全绿通过 F1/F2** —— 而"产品自带全部依赖"
 * 正是这个包存在的理由。同一条散文匹配，在这里是从"说假话"升级成"放行缺陷"。
 *
 * ⚠️ 另一半（抽出前就有，逐字保留）：`tools.length === 0` 时审计只
 * `say('一个 tool.* 都没有 —— 判据本身不见了')`，**不 fail**。
 * 于是「拿不到自检结果」与「一个都没借」在判决上是同一件事 ——
 * 第①类（空集判通过）。地板放在自检里（`TOOL_CHECK_PREFIX` 的契约守卫），
 * 判决不动。
 */
export function checkNothingBorrowed({ borrowed }) {
  const b = borrowed ?? [];
  return must(
    b.length === 0,
    `借了宿主 ${b.length} 个工具：${b.map((c) => c.id).join(', ')} —— 用户机器上不一定有`,
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* §13 总表                                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 总表里一行的记号。**三态**：`ok:null` = 跑了但不该算进过/不过。
 *
 * ⚠️ `null` 与 `false` 分开不是修辞：`--skip-f1` 与「样本没造出来」都走 `null`，
 * 而结论区会把它们**再喊一遍**（PROTOCOL §11：跳过不许渲染成成功）。
 * 把它们并进 `false` 会让"没跑"和"跑了没过"在总表上分不开。
 */
export function verdictMark(ok) {
  return ok === null ? '⊘ 跳过' : ok ? '✔ 通过' : '✘ 失败';
}
