/**
 * Functional self-check, as a library. **One implementation, two surfaces.**
 *
 * ADR-014 promotes this to the project-wide acceptance standard:
 *
 *   Verify that the FEATURE works, not that the COMPONENT loaded — because every layer
 *   degrades gracefully, and stacked graceful degradations are exactly how a product
 *   ends up running degraded with nobody aware.
 *
 * So: not "is libsimple loaded" but "does 用户 match in FTS5". Not "does whisper-cli
 * exist" but "is it executable at a path the daemon will actually resolve".
 *
 * ─── T-119: 真正同源 ───────────────────────────────────────────────────────────────
 * 这里曾经只是 `scripts/selfcheck.mjs` 的**真子集**：CLI 有硬件探测、数据目录自洽性、
 * 本地 LLM 探测、代理三条，端点没有 —— 于是**网页绿 ≠ CLI 绿**，而两个都自称"自检"。
 * 一个自检工具最不能出的问题就是它自己两个出口给的答案不一样。
 *
 * 现在检查项**全部**在这里，CLI 与 `GET /api/selfcheck` 调同一个 `runSelfCheck()`。
 * **差异只允许在渲染层**（CLI 上色分节、端点回 JSON），不允许在检查项。
 * `scripts/selfcheck.mjs --daemon …` 会把本地结果与端点结果**逐 id 比对**，
 * 任何漂移都会被报成 required 失败 —— 这条比"我保证同源"这句话可靠。
 *
 * ─── 为什么探针是注入的 ────────────────────────────────────────────────────────────
 * `packages/runtime` **刻意不 import `packages/pipeline`**：pipeline 已经依赖 runtime，
 * 反向就成环。所以凡是需要别的包才能回答的问题（工具路径、引擎候选、SQLite 扩展、
 * 本地 LLM 服务、代理配置），一律声明成回调由调用方注入。
 * `@openmemo/llm` 其实不成环（它只依赖 shared），但仍然走注入 —— 让 runtime 只保留
 * "硬件"这一件它真正拥有的事，是这个包能一直保持轻的原因。
 *
 * 未提供的探针**不会让检查项消失**，只会让那一条报 `warn: 未探测`。
 * 检查项列表在任何情况下都是同一份、同一个顺序 —— 否则"两边一致"就无从比对。
 */

import { access, constants, open, readdir, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/*
 * ★ 唯一一处 import 别的工作区包（`@openmemo/downloader` 早已在 package.json 的
 * dependencies 里，只是此前没被用过）。**刻意不在这里重写一份魔数判定**：
 * `store.ts` 里那条"两处实现必须手工保持同步"的注释就是前车之鉴 ——
 * 一条要靠人记得同步的规则，等价于一条迟早会漂移的规则。
 */
import {
  ArtifactStore,
  STORE_KINDS,
  findInstalledByRole,
  isGgmlModelFile,
} from '@openmemo/downloader';
/*
 * ★ T-174：断路器那几句话**搬到了 `@openmemo/shared`**，这里 import 回来。
 *
 * 起因：运行时页也要说同一件事，而 `@openmemo/runtime` 有 `node:fs` 依赖、浏览器打不进去，
 * 于是"前端再写一遍"成了唯一顺手的做法 —— 那正是本仓吃过很多次的那个形状。
 * 现在句子只有一份，**本文件下面那批断言（`/将在约 4 分钟后自动重试/` 等）
 * 就顺带成了它的守卫**：谁改坏了措辞，这里当场红。
 */
import { breakerDetail, breakerRemediation, breakerTripped } from '@openmemo/shared';

import { mediaAssetRoots, probeAssetFile } from './assetPaths.js';
import { detectCpu, detectMemory, detectOs } from './detect/system.js';
import { runProbe } from './probe/runProbe.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  /** Grouping for display: hardware / tools / models / llm / ext / datadir / engines / proxy. */
  layer: string;
  /** Stable id so the UI can map to a remediation, tests can assert, and the CLI can diff. */
  id: string;
  label: string;
  labelZh: string;
  status: CheckStatus;
  /** ⚠️ 历史包袱：`detail` 是**中文**（`label`/`labelZh` 那对却是英/中）。见 `detailEn`。 */
  detail: string;
  /** A failing required check means the product is broken, not merely degraded. */
  required: boolean;
  /** What the user should do. Null when nothing is wrong. */
  remediation: string | null;
  /**
   * `detail` 的英文版。**可选**，前端 `detailEn ?? detail` 回退。
   *
   * 为什么不是把 `detail` 改成英文、再加 `detailZh`（那才与 `label`/`labelZh` 一致）：
   * 那要改写全部 25 条检查项的字面量，而 locale/自检两块同时有别的 agent 在动。
   * 这里只承诺**新写的检查项两种语言都给**，不假装历史那 24 条也给了。
   *
   * `[T-174 已修]` 另有 5 条（`tool.ffmpeg` / `tool.ffprobe` / `tool.whisperCli` /
   * `tool.whisperVad` / `tool.ytDlp`）连 `label` 都写成了 `labelZh` 的值，
   * 英文界面上显示的是 `VAD 切分器` / `yt-dlp（可选，GPL）`。现已各给一份英文，
   * 并加了守卫「`label` / `detailEn` / `remediationEn` 里不许出现 CJK」——
   * 判据不是"中英字段不相等"（`ffmpeg` 本来就该相等），见 `selfcheck.test.ts`。
   */
  detailEn?: string;
  /** `remediation` 的英文版。同上。 */
  remediationEn?: string | null;
}

export interface SelfCheckReport {
  ok: boolean;
  ranAt: string;
  dataDir: string;
  storeRoot: string;
  extensionsDir: string;
  counts: { ok: number; warn: number; fail: number };
  results: CheckResult[];
}

export interface SelfCheckToolPaths {
  ffmpeg: string | null;
  ffprobe: string | null;
  whisperCli: string | null;
  whisperVad: string | null;
  vadModel: string | null;
  ytDlp: string | null;
}

export interface MediaAssetRef {
  role: string;
  relPath: string;
}

export interface DetectedLlmService {
  label: string;
  models: number;
}

export interface LlmKeyConfig {
  providerId: string | null;
  hasKey: boolean;
}

export interface ProxySummary {
  mode: string;
  /** Already redacted by the caller — credentials must never reach a self-check report. */
  activeUrl: string | null;
  /** `ffmpegProxySupport()` 的结论：SOCKS 下 ffmpeg 不走代理。 */
  ffmpegSupported: boolean;
  ffmpegReason: string | null;
}

export interface ProxyConnectivity {
  ok: boolean;
  probes: { target: string; result: string; viaProxy: boolean }[];
}

/**
 * 「跑的是哪个后端包」—— T-162 的可观测那一半。
 *
 * 在此之前，同时装了 CPU 包与加速包时用哪个**取决于 `readdir` 返回顺序**，
 * 而这件事在产品里没有任何出口能看出来：`/api/selfcheck` 只报了一条绝对路径，
 * 用户既不知道也影响不了。这个结构回答两个问题：**选的是谁**、**跑的是谁**。
 */
export interface BackendSelectionInfo {
  /** 用户在「运行时」页选中的后端；`null` = 从未选过（此时按 `priority` 挑）。 */
  selectedBackend: string | null;
  /** 实际提供 whisper-cli 的包 id；`null` = 不是从后端包来的（环境变量 / PATH）。 */
  packId: string | null;
  /** 该包声明的 backend。 */
  packBackend: string | null;
  /** true = 选中的后端有已装包，但同引擎里提供 whisper-cli 的是另一个包（已退档）。 */
  degraded: boolean;
}

/**
 * 断路器状态的**只读**投影（T-173）。
 *
 * 刻意用宽松的 `string` 而不是 `BreakerVerdict`：CLI 出口是从 HTTP JSON 里拿的，
 * 那边过来的就是任意字符串，装成联合类型只会把"字段变了"这件事藏进类型断言里。
 */
export interface BreakerStatusInfo {
  /** `closed` | `open` | `recover`。其它值一律当"停用中"处理，不静默放行。 */
  verdict: string;
  /** 此刻被停用的后端。空数组 = 没有被停用的。 */
  blacklistedBackends: string[];
  consecutiveFailures: number;
  threshold: number;
  /** 最近一次探测失败的原因；null = 没有失败记录。 */
  lastError: string | null;
  /** 冷却到期时刻（ISO）。 */
  retryAt: string | null;
  /** 是否有一发后台恢复探测正在跑。 */
  recovering: boolean;
}

export interface SelfCheckProbes {
  /** Resolved native tool paths, as the pipeline would resolve them. */
  tools: () => Promise<SelfCheckToolPaths>;
  /**
   * 后端包的**选择**结果（T-162）。
   *
   * 可选，与 `probePath` 同一形状：探针没给就如实报"未探测"，而不是不出现
   * —— 少一条检查项与"这条通过了"在报告里长得一模一样。
   * daemon 与 CLI 两个出口都必须接上，否则 `--daemon` 的逐 id 比对会当场报漂移。
   */
  backendSelection?: () => Promise<BackendSelectionInfo | null>;
  /**
   * Installed artifact names by store **kind** (= directory).
   *
   * ⚠️ 只用来回答"那个目录里有什么文件"这种观测性问题（后端包、以及把
   * `model.asr` 的 detail 说具体）。**绝不能用它推断模型的 role** —— 目录名不是类型，
   * 那正是"只装了 VAD 却报 ASR 就绪"的成因。要按类型问，用 `installedByRole`。
   */
  installed: (kind: 'asr' | 'llm' | 'backend') => Promise<string[]>;
  /**
   * 按**安装记录里的 `role`** 列出已装模型（T-149）。
   *
   * 非可选：做成可选就等于留了一条"没实现时悄悄退回按文件名猜"的路，
   * 而那条路正是这次要拆掉的东西。两个入口（daemon 与 CLI）都必须给。
   */
  installedByRole: (role: string) => Promise<InstalledByRole>;
  /**
   * Run the four-word Chinese FTS5 test.
   * Returns hit counts, or null when the tokenizer could not even be loaded.
   */
  chineseSearch: () => Promise<Record<string, number> | null>;
  /** sqlite-vec version, or null when unavailable. */
  vecVersion: () => Promise<string | null>;
  /** ASR engine candidates with availability. */
  engines: () => Promise<{ id: string; available: boolean; reason?: string }[]>;
  /** Auto-selected engine per language; null when nothing is available. */
  selectFor: (language: string) => Promise<{ engineId: string; reason: string } | null>;

  /* ---- T-119：从 CLI 上移进来的四类 ---------------------------------------------- */

  /** `openmemo-probe` 的绝对路径。它藏在后端包里，只有 pipeline 的两层扫描找得到。 */
  probePath?: () => Promise<string | null>;
  /**
   * 加速后端断路器的**当前**状态（T-173）。
   *
   * 它是 daemon 的**进程内**状态（`apps/daemon/src/runtime/setup.ts` 的那张 Map），
   * 所以 CLI 出口只能向 daemon 要；拿不到就回 `null`，检查项照常出现并如实说拿不到
   * —— 与 `proxyConnectivity` 同一形状。
   *
   * ⚠️ 这个探针**必须是纯观测**：它一旦顺手跑一发探测，两个出口就会互相改变对方
   * 看到的状态，而 `meta.sameSource` 是 `required` 的。
   */
  breaker?: () => Promise<BreakerStatusInfo | null>;
  /** `media_assets` 的 (role, rel_path)。null = 读不到库（全新安装还没建库是正常的）。 */
  mediaAssets?: () => Promise<MediaAssetRef[] | null>;
  /** 档 2：本机已装且**真能用**的 LLM 服务（Ollama / LM Studio）。 */
  localLlmServices?: () => Promise<DetectedLlmService[] | null>;
  /** 档 1：配没配在线 provider + Key。**只读配置，绝不代发请求。** */
  llmKeyConfig?: () => Promise<LlmKeyConfig | null>;
  /** 代理配置摘要（URL 必须已脱敏）。 */
  proxy?: () => Promise<ProxySummary | null>;
  /** 真发一次外网请求验代理。只在 `proxyTest` 为真时被调用。 */
  proxyConnectivity?: () => Promise<ProxyConnectivity | null>;
}

export interface SelfCheckInput {
  dataDir: string;
  storeRoot: string;
  extensionsDir: string;
  /**
   * Injected so this module stays dependency-free — see the file header.
   */
  probes: SelfCheckProbes;
  /**
   * 真发一次外网请求验证代理。**默认 false**：自检必须能在离线环境跑完，
   * 否则"这台机器没网"会被渲染成"产品坏了"，那是另一种谎。
   */
  proxyTest?: boolean;
  /**
   * ★ T-168 ④：平台注入。**只给测试用；生产侧不传，行为与写死 `process.*` 逐字相同。**
   *
   * `asr.coreml` 只在 darwin/arm64 上产出（ANE 只有 Apple Silicon 有），
   * 于是它在 CI 的 Linux/Windows 上**一次都不会被执行** —— 而这一条现在
   * 会决定整份报告的红绿（`required: true`）。
   *
   * 一条决定红绿、却从来没被执行过的分支，正是本仓记过的"假绿灯 #8"形状：
   * 守卫看着对、从没跑过、谁也看不出来。`unpack.ts` 的 `lex(platform)` 用的是同一招
   * （那里的注释写得更长：「Not for portability — for testability」）。
   * 这里照抄它，**为的是让 macOS 的那三档在 Linux 上就能被跑红**，
   * 而不是等一次 1.17 GB 的 macOS CI 才知道。
   */
  platform?: NodeJS.Platform;
  arch?: string;
}

/** The words that were silently returning zero before libsimple shipped (T-035). */
export const CHINESE_PROBE_WORDS = ['用户', '推特', '中国', '服务'] as const;

/*
 * ★ T-149：这里曾经有两条按**文件名**判类型的正则，**两条都已删除**：
 *
 *   NON_ASR_NAME   = /silero|vad|punct|ct-transformer|speaker|diariz/i   （T-067）
 *   VAD_WEIGHT_NAME = /silero|vad/i                                      （T-148）
 *
 * 它们是给一个**早就修好的问题**打的补丁 —— `NON_ASR_NAME` 自己的注释里就写着
 * 「真正的修法是让安装记录带上 catalog 的 role」，而那条修法在 `9683ae3`
 * （`store.ts` 两条修正之②）就落地了，只是从来没人调用。
 *
 * 代价很具体：一个名字里带 `silero` 的**真** ASR 模型会被 `NON_ASR_NAME` 判成"不是 ASR"；
 * 每新增一个 role 都得回来改这条正则，改漏一次就是一盏假绿灯。
 * 现在类型一律由 `probes.installedByRole()` 回答 —— 它读安装记录里的 `role`，不看目录。
 */

/**
 * whisper.cpp 自己算 CoreML encoder 路径的规则 —— **逐条复刻，不另发明**。
 *
 * `vendor/whisper.cpp/src/whisper.cpp:3326-3348`（v1.9.1 / f049fff）：
 *   ① 去掉最后一个 `.` 之后的部分（`.bin`）
 *   ② 若结尾正好是 5 个字符的 `-qX_X`，**再去掉它**
 *   ③ 拼上 `-encoder.mlmodelc`
 *
 * ② 这一步很关键，它是上游**显式支持「量化模型 + CoreML encoder」**的证据：
 * `ggml-large-v3-turbo-q5_0.bin` 找的是 `ggml-large-v3-turbo-encoder.mlmodelc`，
 * 同一份 encoder 给该模型的所有量化档位共用 —— 所以"用 ANE 就得多发一份非量化模型"
 * 这个说法不成立。
 *
 * 导出是为了让测试能拿同一条规则钉住它（而不是把期望值抄成字面量）。
 */
export function coreMlEncoderNameFor(modelFileName: string): string {
  let s = modelFileName;
  const dot = s.lastIndexOf('.');
  if (dot !== -1) s = s.slice(0, dot);
  const dash = s.lastIndexOf('-');
  if (dash !== -1) {
    const sub = s.slice(dash);
    if (sub.length === 5 && sub[1] === 'q' && sub[3] === '_') s = s.slice(0, dash);
  }
  return `${s}-encoder.mlmodelc`;
}

/**
 * `asr.coreml` —— **这台 Mac 到底走没走神经引擎（ANE）？**
 *
 * ─── 为什么必须有这一条 ───────────────────────────────────────────────────────
 *
 * macOS 的核心 whisper 包从 T-146 起带 `-DWHISPER_COREML=ON`
 * **和 `-DWHISPER_COREML_ALLOW_FALLBACK=ON`**。后者的意思是：
 * `.mlmodelc` 加载失败时 whisper.cpp **打一行 ERROR 然后照常跑**（whisper.cpp:3440-3452）。
 *
 * 而那一行 ERROR **谁也看不见** —— `packages/pipeline/src/asr/whisperCpp.ts:101`
 * 传的是 `--no-prints`，whisper-cli 收到它做的第一件事就是
 * `whisper_log_set(cb_log_disable, NULL)`（examples/cli/cli.cpp:1039-1040），
 * 整个日志通道被关掉。
 *
 * 于是不加这一条的话，产品就会造出一个**新的假绿灯**：
 * 用户以为在用神经引擎，实际一直在 CPU/GPU 上跑，而且没有任何地方会告诉他。
 * 这正是本仓最贵的那类 bug（回退了却不说）的教科书形状 ——
 * **判据不是"能不能回退"，是"回退了看不看得见"。**
 *
 * ─── 三档分别对应什么 ────────────────────────────────────────────────────────
 *   ok    encoder 目录在，且里面有 `coremldata.bin`（= 真的是编译好的 mlmodelc）
 *   warn  没装 encoder → ANE 没用上，转写走 Metal/CPU（**功能正常，只是慢**）
 *   fail  目录在、但里面没有 `coremldata.bin` → **whisper 会静默回退**，
 *         用户看到的是"装了 ANE 却没有变快"，而没有任何东西会报错
 *
 * `fail` 那一档不是假想：`ArtifactFile.unpack` 把 `<X>.mlmodelc.zip` 解到
 * `by-name/asr/<X>.mlmodelc/`，而 zip 内部**自带一层同名顶层目录**，
 * 于是真实结构是 `<X>.mlmodelc/<X>.mlmodelc/coremldata.bin` —— 外层是个空壳。
 */
async function checkCoreMl(
  input: SelfCheckInput,
  realAsr: string[],
  add: (r: CheckResult) => void,
): Promise<void> {
  // ANE 只有 Apple Silicon 有。别的平台连这一项都不该出现，免得变成永久噪音。
  // 平台取自 input（默认宿主）—— 见 `SelfCheckInput.platform` 的注释。
  if ((input.platform ?? process.platform) !== 'darwin' || (input.arch ?? process.arch) !== 'arm64')
    return;

  const asrDir = join(input.storeRoot, 'by-name', 'asr');
  const emit = (
    status: CheckResult['status'],
    detail: string,
    remediation: string | null,
  ): void => {
    add({
      layer: 'models',
      id: 'asr.coreml',
      label: 'CoreML encoder (Apple Neural Engine)',
      labelZh: 'CoreML 编码器（神经引擎 ANE）',
      status,
      detail,
      /*
       * ★ T-168 ④：`required: false` → `true`（Manager 裁决）。
       *
       * ─── 原来那条理由错在哪 ──────────────────────────────────────────────────
       *
       * 原注释写的是：「没有 ANE 不影响能不能转写，标成 required 会让一台完全正常的
       * Mac 报红」。**前半句对，后半句不成立** —— 因为红的条件不是 `required`，
       * 是 `status === 'fail' && required`（本文件 `ok:` 那一行）。
       * 而一台"完全正常、只是没装 encoder"的 Mac 走的是上面那条 `warn` 分支，
       * **`warn` 永远不参与红绿**。所以 `required` 从来没有为它校准过。
       *
       * 它实际校准的是另一件事：把 `fail` 也一并静音了。而这两档的定义本来就分家：
       *
       *   warn = 没有 ANE，但**功能健康**（可选加速缺失）
       *   fail = 目录在、里面没有 `coremldata.bin` = **结构性损坏**
       *          → whisper 静默回退，用户付了 1.17 GB 却什么也不会被告知
       *
       * `required=false` 是按前者校准的，**从没为后者校准过**。
       * 于是它成了一条永远不会让任何东西变红的 `fail` —— 而那种东西
       * 唯一确定会做成的事，是**训练人忽略它**。
       *
       * ─── 为什么写成无条件常量 ────────────────────────────────────────────────
       *
       * 与 `backend.libLinks` 同一条规矩（见本文件 §「required 恒为 true」那段）：
       * `required` 是纯逻辑，不许随 storeRoot 漂移 —— `diffSelfCheckReports` 把
       * required 不一致直接判成"判据被改分叉了"，而 CLI 与 daemon 的 storeRoot 可以不同。
       * 环境差异全部由 `status` 承担。
       *
       * ⚠️ **已知后果，且是有意的**：解包那条 bug（T-168 ①）修好之前，
       * macOS 那一格会立刻变红。红是对的 —— 它今天就是坏的。
       * 不许为了绿把这条改回去。
       */
      required: true,
      remediation,
    });
  };

  if (realAsr.length === 0) {
    emit('warn', '还没有 ASR 模型，无从判断 ANE 是否可用', '先在「模型」页装一个语音识别模型');
    return;
  }

  /*
   * ★ 只有 whisper.cpp 的 ggml `.bin` 才谈得上 CoreML encoder。
   *
   * `by-name/asr` 下也躺着 sherpa 的 onnx 分片（`encoder-epoch-99-avg-1.int8.onnx` 之类）——
   * 第一次真跑时这一项就对着它算出了 `缺 decoder-epoch-99-avg-1.int8-encoder.mlmodelc`，
   * 一句**语法正确但毫无意义**的话。一条会对不相干的东西发表意见的检查，
   * 说对的时候也不该被相信。
   */
  const ggml = realAsr.filter((n) => n.toLowerCase().endsWith('.bin'));
  if (ggml.length === 0) {
    emit(
      'warn',
      `没有 whisper.cpp 的 ggml 模型，ANE 不适用（CoreML encoder 只服务 whisper.cpp；` +
        `当前 by-name/asr 下是：${realAsr.slice(0, 4).join(', ')}）`,
      null,
    );
    return;
  }

  const found: string[] = [];
  const shells: string[] = [];
  const missing: string[] = [];
  for (const bin of ggml) {
    const encName = coreMlEncoderNameFor(bin);
    const encDir = join(asrDir, encName);
    let entries: string[];
    try {
      entries = await readdir(encDir);
    } catch {
      missing.push(`${bin} → 缺 ${encName}`);
      continue;
    }
    /*
     * 判据是**目录里有没有 `coremldata.bin`**，不是"目录在不在"。
     * 「目录存在」正是那个空壳的表现 —— 只查存在性等于把 fail 读成 ok。
     */
    if (entries.includes('coremldata.bin')) found.push(`${bin} → ${encName}`);
    else
      shells.push(
        `${encName}（里面是 ${entries.slice(0, 3).join(', ') || '空'}，不是编译好的 mlmodelc）`,
      );
  }

  if (shells.length > 0) {
    emit(
      'fail',
      `CoreML encoder 目录结构不对，whisper 会**静默回退**到 Metal/CPU：${shells.join('；')}`,
      '删掉该目录重装；若重装后仍是这个结构，是解包多了一层同名目录（installer.ts 的 stripExt + zip 自带顶层目录）',
    );
    return;
  }
  if (found.length > 0) {
    emit(
      'ok',
      `ANE 已就绪（encoder 只接管 whisper 的 encoder 部分，decoder 仍走 Metal/CPU）：${found.join('；')}`,
      null,
    );
    return;
  }
  emit(
    'warn',
    `未启用 ANE —— 转写会走 Metal/CPU（功能正常，只是慢）：${missing.join('；')}`,
    '在「模型」页为该模型安装可选的 CoreML encoder（role=coreml-encoder）',
  );
}

/**
 * `hw.probe` 失败时**必须留下诊断线索**，否则下一个人只能从零查起。
 *
 * ─── 这条是一次真实的"查不下去"换来的 ──────────────────────────────────────────
 *
 * `cold-start-audit` run 31160171438 的 darwin-arm64 那一格报的是
 * `warn probe timed out after 10000ms` —— **然后就没有了**。
 * 一个会超时的子进程，日志里**一个字的 stderr 都没有**。于是这三种成因
 *   ① 10 秒对这台虚拟化 runner 太短   ② Metal 在虚拟化 macOS 上初始化会挂
 *   ③ 探针真有 bug
 * 在报告里长得**一模一样**，谁都分辨不出来 —— 而三者的处置完全不同。
 *
 * 关键在于：`runProbe()` **一直都在收 stderr**，超时路径也收
 * （`probe/runProbe.ts` 的 timeout 分支里就有 `stderr: tail(stderr)`）。
 * 是这一层把它丢掉了 —— 丢在了唯一会被人看到的地方。
 *
 * 两条信息各自独立有用，所以都带上：
 *   · **耗时** —— 区分「卡满整个超时窗口」（≈ timeout 值，像挂了）
 *     与「早早就退了」（远小于 timeout，像崩溃/加载失败）。
 *   · **stderr** —— ggml 在 `GGML_BACKEND_DL=ON` 下会逐个打印后端的加载/跳过决定，
 *     **最后一行就是它停住的地方**。
 *
 * ★ `stderr` 为空**本身就是结论**，不是"没信息"：它说明探针连第一个后端都没
 *   来得及打印就没了。所以空也要明写出来，不能省略成一片空白 ——
 *   那正是这条注释存在的原因。
 */
function probeFailureDetail(r: { message: string; stderr: string; durationMs: number }): string {
  const err = r.stderr.replace(/\s+/g, ' ').trim();
  const tail =
    err.length > 0 ? `stderr 尾部：${err.slice(-400)}` : 'stderr 为空（探针连一行都没来得及输出）';
  return `${r.message}（耗时 ${String(r.durationMs)}ms；${tail}）`;
}

async function exists(p: string | null | undefined, mode: number): Promise<boolean> {
  if (p === null || p === undefined || p.length === 0) return false;
  try {
    await access(p, mode);
    return true;
  } catch {
    return false;
  }
}

export interface SymlinkHealth {
  /** 相对 `by-name/backend/` 的路径 */
  rel: string;
  /** `readlink` 的原样结果 */
  target: string;
  /** 顺着链真的读到内容了吗 */
  readable: boolean;
  /** 读不到时的原因（errno），读得到时是首 4 字节的十六进制 */
  note: string;
}

/**
 * 检查后端包里的符号链接**是不是真的能用**。
 *
 * ─── 为什么这条检查必须存在（T-128）──────────────────────────────────────────────
 * 用户移动数据目录后，whisper.cpp 的 8 条 `.so` 链接全部悬空（`fs.cp` 把相对链接
 * 改写成了指向旧位置的绝对路径），转写完全不可用 —— 而**产品里没有任何地方会发现它**：
 * 安装记录里没有链接的痕迹，模型校验只比 sha256（链接不是文件），
 * 目录结构看起来完好无损。除了真去跑一次转写，无人知晓。
 *
 * ─── 判据为什么必须是"真的读到内容"────────────────────────────────────────────────
 * **不能用 `lstat()`**：它根本不跟随链接，对一条彻底悬空的链接**照样返回成功**。
 * **也不用 `access()`**：它虽然跟随链接、悬空时确实会失败，但它只回答"能不能"，
 * 不产生任何可核对的证据。这里 `open()` + 读**首 4 字节**：
 * 悬空 → ENOENT；指向空文件/被截断 → 读不满 4 字节。代价是常数级，不受 `.so` 体积影响。
 *
 * 这是 ADR-014 那条标准在这个位置的具体形态：**验功能可用，不验组件存在**。
 */
export async function checkBackendSymlinks(storeRoot: string): Promise<SymlinkHealth[]> {
  const root = join(storeRoot, 'by-name', 'backend');
  const out: SymlinkHealth[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // 目录不存在 = 没装后端包，交给调用方判断，不在这里假装成功
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        const target = await readlink(p).catch(() => '<readlink 失败>');
        let readable = false;
        let note: string;
        let fh;
        try {
          // open() 跟随符号链接 —— 悬空链接在这里就会抛 ENOENT
          fh = await open(p, 'r');
          const buf = Buffer.alloc(4);
          const { bytesRead } = await fh.read(buf, 0, 4, 0);
          readable = bytesRead === 4;
          note = readable ? buf.toString('hex') : `只读到 ${bytesRead} 字节（文件为空或被截断）`;
        } catch (err) {
          note = (err as NodeJS.ErrnoException).code ?? String(err);
        } finally {
          await fh?.close().catch(() => {});
        }
        out.push({ rel: p.slice(root.length + 1), target, readable, note });
      } else if (e.isDirectory()) {
        await walk(p);
      }
    }
  };
  await walk(root);
  return out;
}

/**
 * 悬空链接指向的是不是"另一个数据目录"。
 *
 * 用来把 remediation 说准：如果断掉的目标里出现了 `by-name/backend`，
 * 那几乎可以肯定是**搬过家**留下的（旧位置已被删），而不是安装本身出了错。
 */
function looksLikeMovedDataDir(links: SymlinkHealth[]): boolean {
  return links.some((l) => !l.readable && isAbsolute(l.target) && l.target.includes('by-name'));
}

function libSuffix(): string {
  if (process.platform === 'win32') return '.dll';
  if (process.platform === 'darwin') return '.dylib';
  return '.so';
}

export async function runSelfCheck(input: SelfCheckInput): Promise<SelfCheckReport> {
  const results: CheckResult[] = [];
  const add = (r: CheckResult): void => {
    results.push(r);
  };
  /** 探针没给 → 检查项照常出现，只是如实说"没测"。列表必须两边一样长。 */
  const notProbed = (layer: string, id: string, label: string, labelZh: string): void =>
    add({
      layer,
      id,
      label,
      labelZh,
      status: 'warn',
      detail: '未探测（本次运行未提供该探针）',
      detailEn: 'not probed (this run did not supply that probe)',
      required: false,
      remediation: null,
    });

  // ---- hardware ---------------------------------------------------------------------
  // runtime 自己就拥有硬件探测，这里不需要任何注入。
  const os = detectOs();
  add({
    layer: 'hardware',
    id: 'hw.os',
    label: 'OS / arch',
    labelZh: 'OS / 架构',
    status: 'ok',
    detail: `${os.platform}/${os.arch} ${os.version}`,
    required: false,
    remediation: null,
  });

  const cpu = await detectCpu();
  add({
    layer: 'hardware',
    id: 'hw.cpu',
    label: 'CPU instruction sets',
    labelZh: 'CPU 指令集',
    status: cpu.features.length > 0 ? 'ok' : 'warn',
    detail: `${cpu.brand} · ${cpu.physicalCores}核 · ${cpu.features.slice(0, 6).join(',') || '未检出'}`,
    required: false,
    remediation:
      cpu.features.length > 0 ? null : '未检出指令集 → 只能用最保守的 CPU 后端，推理会明显更慢',
  });

  const ram = detectMemory();
  add({
    layer: 'hardware',
    id: 'hw.memory',
    label: 'memory',
    labelZh: '内存',
    status: 'ok',
    detail: `${ram.totalMB} MB total`,
    required: false,
    remediation: null,
  });

  /*
   * 设备枚举必须由**子进程**回答。
   *
   * 磁盘上躺着一个 loader 什么都不证明 —— ggml 在 `GGML_BACKEND_DL=ON` 下会 dlopen
   * 一堆后端并静默跳过不能用的那些，所以"文件在"和"这台机器能用它"是两回事。
   * 而且 whisper.cpp 在没有可用 CPU 后端时会 `ggml_abort()` → SIGABRT，
   * 所以它只能在子进程里问，不能在 daemon 进程里问。
   */
  if (input.probes.probePath === undefined) {
    notProbed('hardware', 'hw.probe', 'device enumeration (subprocess)', 'probe 子进程枚举设备');
  } else {
    const probePath = await input.probes.probePath();
    if (probePath === null || !(await exists(probePath, constants.X_OK))) {
      add({
        layer: 'hardware',
        id: 'hw.probe',
        label: 'device enumeration (subprocess)',
        labelZh: 'probe 子进程枚举设备',
        status: 'warn',
        detail: 'openmemo-probe 未安装（后端能力未知）',
        required: false,
        remediation: '安装后端包后会带上 openmemo-probe；在此之前只能按 CPU 保守选择',
      });
    } else {
      const r = await runProbe({ probePath, backendDir: dirname(probePath) });
      add({
        layer: 'hardware',
        id: 'hw.probe',
        label: 'device enumeration (subprocess)',
        labelZh: 'probe 子进程枚举设备',
        status: r.ok ? 'ok' : 'warn',
        detail: r.ok
          ? `${r.output.deviceCount} 个设备, ggml ${r.output.ggmlVersion}`
          : probeFailureDetail(r),
        required: false,
        remediation: r.ok ? null : '探测失败 → 加速后端不可判定，会退回 L1 CPU',
      });
    }
  }

  /*
   * ---- hw.breaker（T-173）------------------------------------------------------------
   *
   * ★ 这一条是本次修复里**比冷却期本身更重要**的一半。
   *
   * 断路器跳闸此前是**零报错的静默降级**：探针不再被调用，GPU 加速"就是不工作"，
   * 而全仓没有任何一个出口说得出这件事发生过 —— `runtime.breaker` 确实随
   * `/api/runtime/hardware` 发出去，但前端把响应断言成窄契约 `GetHardwareResponse`，
   * 那个字段在类型边界上就被丢掉了（apps/web/src/lib/api/hardware.ts）。
   *
   * 一个能自愈、但用户不知道发生过什么的系统，和一个坏了不吭声的系统，在用户那里是一样的。
   */
  if (input.probes.breaker === undefined) {
    notProbed('hardware', 'hw.breaker', 'accelerator circuit breaker', '加速后端断路器');
  } else {
    const b = await input.probes.breaker();
    if (b === null) {
      add({
        layer: 'hardware',
        id: 'hw.breaker',
        label: 'accelerator circuit breaker',
        labelZh: '加速后端断路器',
        status: 'warn',
        detail: '取不到断路器状态 —— 它是 daemon 的进程内状态，需要 daemon 正在运行',
        detailEn:
          'breaker state unavailable — it lives inside the running daemon process, so the daemon must be up',
        required: false,
        remediation: '启动 daemon 后重跑自检；只看这一条的话：GET /api/runtime/breaker',
        remediationEn:
          'Start the daemon and run the self-check again; for this check alone: GET /api/runtime/breaker',
      });
    } else if (!breakerTripped(b.verdict, b.blacklistedBackends)) {
      add({
        layer: 'hardware',
        id: 'hw.breaker',
        label: 'accelerator circuit breaker',
        labelZh: '加速后端断路器',
        status: 'ok',
        detail: '未跳闸 —— 加速后端正常参与选择',
        detailEn: 'closed — accelerator backends are eligible',
        required: false,
        remediation: null,
        remediationEn: null,
      });
    } else {
      /*
       * "停用了什么 / 为什么 / 多久之后重试" —— 三件事必须凑齐，否则用户仍然不知道
       * 该等还是该动手。造句在 `@openmemo/shared`，**运行时页用的是同一个函数**。
       */
      const text = breakerDetail(b);
      const fix = breakerRemediation();
      add({
        layer: 'hardware',
        id: 'hw.breaker',
        label: 'accelerator circuit breaker',
        labelZh: '加速后端断路器',
        // warn 不是 fail：CPU 兜底仍在，产品能用，只是没有加速。fail 会让 CLI EXIT=1。
        status: 'warn',
        detail: text.zh,
        detailEn: text.en,
        required: false,
        remediation: fix.zh,
        remediationEn: fix.en,
      });
    }
  }

  // ---- tools ------------------------------------------------------------------------
  const tools = await input.probes.tools();
  const backendPacks = await input.probes.installed('backend');

  add({
    layer: 'tools',
    id: 'backend.packs',
    label: 'installed backend packs',
    labelZh: '已安装后端包',
    status: backendPacks.length > 0 ? 'ok' : 'warn',
    detail: backendPacks.length > 0 ? backendPacks.join(', ') : '无',
    required: false,
    remediation: backendPacks.length > 0 ? null : '在「运行时」页安装 CPU 基础包',
  });

  /*
   * ★ T-162：**上面那条只说"装了哪些"，不说"跑的是哪个"。**
   *
   * 两个包同时装着时，此前用哪个由 `readdir` 的返回顺序决定 ——
   * `[实测]` 装了 Vulkan 包，跑的仍是 CPU 包里的 whisper-cli，**两种安装顺序结果相同**。
   * 那个状态在报告里长得和"一切正常"一模一样，因为报告里根本没有这个问题。
   */
  if (input.probes.backendSelection === undefined) {
    notProbed('tools', 'backend.selection', 'backend pack in use', '实际生效的后端包');
  } else {
    const sel = await input.probes.backendSelection();
    if (sel === null) {
      add({
        layer: 'tools',
        id: 'backend.selection',
        label: 'backend pack in use',
        labelZh: '实际生效的后端包',
        status: 'warn',
        detail: 'whisper-cli 不是从后端包解析出来的（环境变量覆盖 / 系统 PATH / 未找到）',
        required: false,
        remediation: '在「运行时」页安装后端包，让产品自己的安装通道提供 whisper-cli',
      });
    } else {
      const chosen = sel.selectedBackend ?? '未选择（按 priority 挑）';
      add({
        layer: 'tools',
        id: 'backend.selection',
        label: 'backend pack in use',
        labelZh: '实际生效的后端包',
        status: sel.degraded ? 'warn' : 'ok',
        detail:
          `选中 ${chosen} → 实际使用 ${sel.packId ?? '(来源不明，无安装记录)'}` +
          `（backend=${sel.packBackend ?? '未知'}）`,
        required: false,
        remediation: sel.degraded
          ? '选中的后端包里没有 whisper-cli，已退回另一个包 —— 加速不会生效。' +
            '重装该后端包，或在「运行时」页改选一个真的能用的后端'
          : null,
      });
    }
  }

  /*
   * 「找到了」和「装上了」是两件事。
   *
   * `discoverTools()` 的第 3 顺位是 PATH，那是**开发便利**，不是产品路径。
   * 开发机上有 `/usr/bin/ffmpeg`，于是这条一直是绿的 —— 但用户机器上没有，
   * 而 ffmpeg 目前**没有任何 HTTP 安装通道**（T-093 实测三个安装端点全拒）。
   * 报绿等于把"这台开发机恰好有"当成"产品能装上"，正是自检要防的那种假绿灯。
   *
   * 判据：装在 storeRoot 里 = ok；只在系统 PATH 上 = warn（能跑，但不可分发）；没有 = fail。
   */
  const fromStore = (p: string | null): boolean => p !== null && p.startsWith(input.storeRoot);
  /*
   * ★ T-174：这个元组以前只有 `labelZh` 一列，三个分支都写 `label: labelZh` ——
   * **英文界面上这 5 条显示的是中文**（`VAD 切分器`、`yt-dlp（可选，GPL）`，连括号逗号都是全角）。
   *
   * 为什么能写错还没人发现：前三条的 `label` 与 `labelZh` 恰好都是 `ffmpeg` 这类工具名，
   * 中英本来就同形 —— 于是"`label` 拿中文"这件事在多数条目上**没有可观测后果**，
   * 只有最后两条露馅，而没人用英文界面翻自检页。
   * 守卫见 `selfcheck.test.ts` 的「英文字段里不许出现中文」：判据不是"两个字段不相等"
   * （`ffmpeg` 本来就该相等），是"**`label` 里不许有 CJK**"。
   */
  for (const [id, label, labelZh, path, required] of [
    ['tool.ffmpeg', 'ffmpeg', 'ffmpeg', tools.ffmpeg, true],
    ['tool.ffprobe', 'ffprobe', 'ffprobe', tools.ffprobe, true],
    ['tool.whisperCli', 'whisper-cli', 'whisper-cli', tools.whisperCli, true],
    ['tool.whisperVad', 'VAD splitter', 'VAD 切分器', tools.whisperVad, false],
    ['tool.ytDlp', 'yt-dlp (optional, GPL)', 'yt-dlp（可选，GPL）', tools.ytDlp, false],
  ] as const) {
    const found = await exists(path, constants.X_OK);
    if (!found) {
      add({
        layer: 'tools',
        id,
        label,
        labelZh,
        status: required ? 'fail' : 'warn',
        detail: '未找到',
        required,
        remediation: '在「运行时」页安装对应组件',
      });
    } else if (fromStore(path)) {
      add({
        layer: 'tools',
        id,
        label,
        labelZh,
        status: 'ok',
        detail: path as string,
        required,
        remediation: null,
      });
    } else {
      add({
        layer: 'tools',
        id,
        label,
        labelZh,
        status: 'warn',
        detail: `${path as string}（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）`,
        // 借来的工具能跑，所以不算"坏了"；但它不可分发，所以也不能算 ok。
        required: false,
        remediation: '产品自带的安装通道尚未覆盖该工具，当前依赖系统里已有的版本',
      });
    }
  }

  /*
   * ---- 后端 .so 符号链接（T-128）---------------------------------------------------
   *
   * `required: true` 是**无条件**的，不随环境变化 —— 判据是一句纯逻辑：
   * "后端的 .so 链断了 = 转写不能用"。环境差异全部由 status 承担。
   * 这一点对同源比对很要紧：`diffSelfCheckReports` 把 required 不一致直接判为
   * "判据被改分叉了"，所以 required 不能写成依赖 storeRoot 内容的条件表达式
   * （CLI 与 daemon 的 storeRoot 可以不同）。
   */
  const soLinks = await checkBackendSymlinks(input.storeRoot);
  const brokenLinks = soLinks.filter((l) => !l.readable);
  add({
    layer: 'tools',
    id: 'backend.libLinks',
    label: 'backend shared-library symlinks resolve',
    labelZh: '后端 .so 符号链接可解析',
    status:
      backendPacks.length === 0
        ? 'warn'
        : brokenLinks.length > 0
          ? 'fail'
          : soLinks.length === 0
            ? 'warn'
            : 'ok',
    detail:
      backendPacks.length === 0
        ? '未安装后端包，无可检查的链接'
        : brokenLinks.length > 0
          ? `${brokenLinks.length}/${soLinks.length} 条链接读不到目标：` +
            brokenLinks
              .slice(0, 3)
              .map((l) => `${l.rel}→${l.target}(${l.note})`)
              .join('  ')
          : soLinks.length === 0
            ? '该后端包不含符号链接（未做检查，不代表后端可用）'
            : `${soLinks.length} 条链接全部可读到目标内容`,
    required: true,
    remediation:
      brokenLinks.length === 0
        ? null
        : looksLikeMovedDataDir(brokenLinks)
          ? '这些链接指向的是旧数据目录（多半是移动数据目录后留下的）。在「运行时」页重新安装该后端包即可修复；数据与笔记不受影响。'
          : '在「运行时」页重新安装该后端包 —— 链接的目标文件已不存在，whisper 会报 "cannot open shared object file" 而无法加载。',
  });

  /*
   * ★ T-148 —— 这条以前查的是 `access(R_OK)`，也就是**"有没有一个文件"**。
   *
   * 而 `by-name/asr` 底下合法地同时躺着两个 VAD 权重：
   * `ggml-silero-v6.2.0.bin`（whisper.cpp 用）与 `silero_vad.onnx`（sherpa 用），
   * 两条清单条目自己都写着"另一个引擎加载不了我"。存在性检查对这两者一视同仁 ——
   * 于是 daemon 把 ONNX 交给 whisper 的 VAD 二进制、整单转写死掉的同时，
   * **这条自检是绿的**（`[CI 实测]` run 31039460495）。
   *
   * 现在判据换成"whisper.cpp 真的能加载它吗"（读头四字节比 GGML 魔数，
   * 与 `whisper_vad_init_with_params` 的第一步逐字对应）。三档的分工：
   *   ok   —— 是 ggml 权重，按静音切分
   *   warn —— 一个都没装：**正常状态**，退回固定窗口，功能可用只是断句差
   *   fail —— 装了、文件也在，但 whisper.cpp 加载不了。**这一档才是本次要抓的那格**，
   *           它比 warn 更糟：用户以为自己装好了。
   */
  const vadPresent = await exists(tools.vadModel, constants.R_OK);
  const vadLoadable = await isGgmlModelFile(tools.vadModel);
  /*
   * 兜底观测：即使解析器已经拒绝交出坏文件（tools.vadModel === null），
   * by-name/asr 里那份 ONNX 仍然在，用户仍然需要知道"你装的那个 whisper 用不了"。
   * 只看 tools.vadModel 会让这条永远说"未安装"，那是一句正确但没用的话。
   */
  const vadInstalled = await input.probes.installedByRole('vad');
  const strandedVad = vadLoadable ? [] : vadInstalled.names;
  add({
    layer: 'tools',
    id: 'model.vad',
    label: 'VAD model',
    labelZh: 'VAD 模型',
    /*
     * `fail` 只留给"解析器把一个加载不了的文件当成了 VAD 权重交出来" ——
     * 修好之后这一档在正常运行里不可达，它存在的意义是**反向验证时会红**，
     * 以及万一将来又有人绕过解析器时当场出声。
     * 「装错了那一个」是 `warn`：功能仍然可用（退回固定窗口），
     * 而且只装 sherpa ONNX 对流式用户是完全合法的选择 —— 报红会是假红灯。
     */
    status: vadLoadable ? 'ok' : vadPresent ? 'fail' : 'warn',
    detail: vadLoadable
      ? (tools.vadModel as string)
      : vadPresent
        ? `${tools.vadModel as string} 不是 ggml 格式，whisper.cpp 加载不了（会报 bad magic）→ 切分降级为固定窗口`
        : strandedVad.length > 0
          ? /*
             * ⚠️ T-149 订正：这句原来写的是「…（${名字}，**那是 sherpa 引擎的 ONNX 格式**）」。
             * 那是一句**猜出来的具体话**：走到这里只说明"解析器没能交出一份 whisper 能加载的
             * ggml 权重"，并不说明已装的那份就是 ONNX —— 它也可能是 ggml 但文件读不到、
             * 被截断、或权限不对。`[本机实测]` 用一条 role=vad 的 ggml 记录跑 CLI 自检，
             * 旧文案当场把 `ggml-silero-v6.2.0.bin` 说成"sherpa 引擎的 ONNX 格式"。
             * **一句描述得很具体的错话，比不说更能把人带偏**（HANDOFF D-bis）。
             * 现在只说观测到的事实：这些装了，而 whisper 一个都加载不了。
             */
            `已装的 VAD 权重 whisper.cpp 一个都加载不了（已装：${strandedVad.join('、')}）→ 切分降级为固定窗口`
          : '未安装 → 切分降级为固定窗口',
    required: false,
    /*
     * ★ T-149：这条以前写的是「在「模型」页安装 `vad/silero-vad-ggml`」，
     * 而当时 `/models` 的列表只渲染 `role === 'asr'` —— 用户照做会**空手而归**，
     * 然后怀疑是自己的问题。**一条具体但无法执行的指引，比没有指引更糟。**
     *
     * `frontend-truth` 已经把渲染那半补上了（D-10 #9/#10/#29）：
     * `asrSections.ts` 的 `splitAsrSections()` 按 `g.role === 'vad' || 'punctuation'`
     * 把它们收进转写 Tab 的**「实时字幕组件」**一组（i18n `models.section.realtime`），
     * **没有混进 ASR 列表** —— 它们是一条链路上的零件，不是 ASR 的替代品。
     * 所以这句话现在指得出一个真实的落点：**分组名与用户看见的字逐字一致**，
     * 否则"去某某组找"又会变成另一条找不到的指引。
     *
     * 直达地址仍然保留：那是不依赖列表分组的第二条路，且 `ModelDetailPage`
     * 查的是 `catalog('all')`、不过滤 role，任何时候都打得开。
     */
    remediation: vadLoadable
      ? null
      : '在「模型」页→转写→**「实时字幕组件」**一组里安装 `vad/silero-vad-ggml`' +
        '（直达：`/models/vad%2Fsilero-vad-ggml`）。' +
        '两个 VAD 变体体积与量化都一样，差别在**引擎**：ggml 那个给 whisper.cpp，' +
        '`vad/silero-vad-onnx` 给 sherpa 流式，**两者不能互换**。',
  });

  /* ---- models ---------------------------------------------------------------------
   *
   * ★ T-149：判据从「`by-name/asr/` 下的文件名，减去一条正则」换成
   * **「安装记录里 `role === 'asr'`」**。那条正则
   * （`/silero|vad|punct|ct-transformer|speaker|diariz/i`）是给一个已经修好的问题
   * 打的补丁，代价是一个名字里带 `silero` 的**真** ASR 模型会被判成不是 ASR。
   * 现在同一个问题由 role 回答，而 role 是安装时从目录抄进记录的事实。
   */
  const asrInstalled = await input.probes.installedByRole('asr');
  const realAsr = asrInstalled.names;
  const otherRoleFiles = (await input.probes.installed('asr')).filter((n) => !realAsr.includes(n));
  /*
   * 「跳过了几条」必须说出来，不能吞：没写 `role` 的老记录一律不猜（`store.ts` 的规矩），
   * 但那不等于"你什么都没装" —— 不报出来的话，一个装满模型的旧库会被说成"无"。
   */
  const skipNote =
    asrInstalled.skippedWithoutRole > 0
      ? `；另有 ${asrInstalled.skippedWithoutRole} 条安装记录没写 role，一律不猜类型（重装一次即可补上）`
      : '';
  add({
    layer: 'models',
    id: 'model.asr',
    label: 'ASR models',
    labelZh: 'ASR 模型',
    status: realAsr.length > 0 ? 'ok' : 'fail',
    detail:
      realAsr.length > 0
        ? `${realAsr.join(', ')}${skipNote}`
        : otherRoleFiles.length > 0
          ? `无可用 ASR 模型（by-name/asr 下的文件都不是 ASR 角色：${otherRoleFiles.join(', ')}）${skipNote}`
          : `无${skipNote}`,
    required: true,
    /*
     * ⚠️ T-149：这条 remediation 说的是「模型」页，而那一页**目前只渲染 role='asr'**
     * （`ModelsPage.tsx` 的 `.filter(g => g.role === role)`，role 写死 'asr'）。
     * 对 ASR 来说这条指引是可执行的 —— 用户去那一页确实找得到 ASR 模型。
     * **`model.vad` 那条不是**，见上面那一条的注释。
     */
    remediation: realAsr.length > 0 ? null : '在「模型」页下载一个语音识别模型',
  });

  await checkCoreMl(input, realAsr, add);

  /*
   * ---- LLM（ADR-016 之后只剩在线）------------------------------------------------
   *
   * 这里原来查的是 `by-name/llm` 下有没有 GGUF。ADR-016 砍掉内置 llama.cpp 之后，
   * 那条判据查的是一个**产品已经不再提供的东西**，永远 warn —— 纯噪音，
   * 而且会让用户以为"再装个本地模型就好了"，其实根本没这个入口。
   *
   * 两档的**可自检性完全不同**，所以拆成两条、不合并：
   *   档 1（BYO Key）：**没法自检**。唯一的验法是拿用户的 Key 发一次真请求 ——
   *                    那要花他的钱，还可能在他不知情时把 Key 发出去。
   *                    所以只报"配没配"，并在文案里明写这不等于"能用"。
   *   档 2（本机 Ollama / LM Studio）：**能真验**。探针会真发 `/v1/models` 并要求
   *                    至少有一个模型 —— 端口开着但没下模型不算可用。纯本机请求。
   */
  if (input.probes.llmKeyConfig === undefined) {
    notProbed('llm', 'llm.tier1', 'online LLM configured', '档 1 在线 LLM 已配置');
  } else {
    const cfg = await input.probes.llmKeyConfig();
    const configured = cfg !== null && cfg.providerId !== null && cfg.hasKey;
    add({
      layer: 'llm',
      id: 'llm.tier1',
      label: 'online LLM configured',
      labelZh: '档 1 在线 LLM 已配置',
      status: configured ? 'ok' : 'warn',
      detail: configured
        ? `${cfg.providerId as string} + 已存 Key（★ 只表示配了，未代发请求验证可用性）`
        : `未配置（provider=${cfg?.providerId ?? '无'} key=${cfg?.hasKey ? '有' : '无'}）`,
      required: false,
      remediation: configured
        ? null
        : '在设置页填一个在线模型的 API Key，否则 F4 思维导图会转 blocked',
    });
  }

  if (input.probes.localLlmServices === undefined) {
    notProbed('llm', 'llm.tier2', 'local LLM services', '档 2 本机已装服务');
  } else {
    const svc = await input.probes.localLlmServices();
    add({
      layer: 'llm',
      id: 'llm.tier2',
      label: 'local LLM services',
      labelZh: '档 2 本机已装服务',
      status: svc !== null && svc.length > 0 ? 'ok' : 'warn',
      detail:
        svc !== null && svc.length > 0
          ? svc.map((s) => `${s.label}(${s.models} 模型)`).join(', ')
          : '未探测到 Ollama / LM Studio（正常：用户没装就没有）',
      required: false,
      remediation: null,
    });
  }

  // ---- extensions: tested by FEATURE ------------------------------------------------
  /*
   * 词典缺失**不是**致命的：libsimple 没有 jieba 词典仍然工作，只是退化成按字切分
   * （仍然远好于 trigram 完全搜不到双字词）。所以这条是 warn，不是 fail。
   */
  const dictDir = join(input.extensionsDir, 'dict');
  const hasDict = await exists(join(dictDir, 'jieba.dict.utf8'), constants.R_OK);
  add({
    layer: 'ext',
    id: 'ext.jiebaDict',
    label: 'jieba dictionary',
    labelZh: 'jieba 词典',
    status: hasDict ? 'ok' : 'warn',
    detail: hasDict ? dictDir : '缺失 → 分词退化为字符切分（仍优于 trigram）',
    required: false,
    remediation: hasDict ? null : '重新安装中文分词扩展 libsimple（上游包自带 dict/）',
  });

  const hits = await input.probes.chineseSearch();
  if (hits === null) {
    add({
      layer: 'ext',
      id: 'ext.chineseSearch',
      label: 'Chinese two-character search',
      labelZh: '中文双字词可搜索',
      status: 'fail',
      detail: '分词器不可用，未能测试',
      required: true,
      remediation: '安装中文分词扩展（libsimple）',
    });
  } else {
    const misses = Object.entries(hits)
      .filter(([, n]) => n === 0)
      .map(([w]) => w);
    add({
      layer: 'ext',
      id: 'ext.chineseSearch',
      label: 'Chinese two-character search',
      labelZh: '中文双字词可搜索',
      status: misses.length === 0 ? 'ok' : 'fail',
      detail: Object.entries(hits)
        .map(([w, n]) => `${w}:${n}`)
        .join(' '),
      required: true,
      remediation:
        misses.length === 0
          ? null
          : `这些词搜不到：${misses.join('、')}。多半是分词器退回 trigram（无法匹配 3 字以下）`,
    });
  }

  const vec = await input.probes.vecVersion();
  add({
    layer: 'ext',
    id: 'ext.sqliteVec',
    label: 'sqlite-vec',
    labelZh: '向量检索扩展',
    status: vec !== null ? 'ok' : 'warn',
    detail: vec ?? '不可用 → 语义检索关闭',
    required: false,
    remediation: vec !== null ? null : '安装向量检索扩展',
  });

  /*
   * ---- 数据目录自洽性 -------------------------------------------------------------
   *
   * 用户的要求原话是"数据存放是独立文件夹且描述清楚，删除不要影响程序本体运行"。
   * 反过来说：**程序自己的引用也不许跑到那个文件夹外面**，
   * 否则"搬走数据目录"就等于"弄坏数据"，而这两件事在用户眼里毫不相干。
   *
   * 这条查的是真东西：把 `media_assets` 每条路径**按播放端那份规则**解析出来
   * （`assetPaths.ts`，T-136 起同源），看它落不落在 dataDir 内、内容读不读得到。
   * T-093 就是靠它坐实了 `audio16k` 存的是**绝对路径**且指向
   * `<dataDir>/tmp/job-*` —— 移动数据目录后该资产直接 403，而设置页还把 tmp
   * 描述成「可随时删」。只看目录结构、不看数据库引用，这种问题永远查不出来。
   */
  if (input.probes.mediaAssets === undefined) {
    notProbed(
      'datadir',
      'datadir.assetsContained',
      'assets inside dataDir',
      'media_assets 路径全在 dataDir 内',
    );
    notProbed('datadir', 'datadir.assetsPresent', 'asset files present', 'media_assets 文件都在');
  } else {
    const rows = await input.probes.mediaAssets();
    if (rows === null) {
      add({
        layer: 'datadir',
        id: 'datadir.assetsContained',
        label: 'assets inside dataDir',
        labelZh: 'media_assets 路径全在 dataDir 内',
        status: 'warn',
        detail: '读不到数据库（全新安装尚未建库时属正常）',
        required: false,
        remediation: null,
      });
      add({
        layer: 'datadir',
        id: 'datadir.assetsPresent',
        label: 'asset files present',
        labelZh: 'media_assets 文件都在',
        status: 'warn',
        detail: '读不到数据库',
        required: false,
        remediation: null,
      });
    } else {
      /*
       * ★ T-136：解析基准与**播放端完全同一份**（`assetPaths.ts`）。
       *
       * 上一版这里写死 `resolve(<dataDir>/media, relPath)` 一个基准，而 `rel_path`
       * 实际有三种历史形态（见 `assetPaths.ts` 的表）。后果不是漏报，是**说错话**：
       * 用户库里 3 条相对 `<dataDir>` 存的记录被算成 `…/media/media/legacy/…`，
       * 于是报「3 条文件已不存在」「对应的媒体文件已被删除」——
       * **那 3 个文件一个没少，全在盘上。** 用户会去翻备份、会怀疑自己删过东西。
       *
       * 判据也从 `access()` 换成**真的打开并读首 4 字节**（与 T-128 同一条标准）：
       * `access` 只回答"能不能"，不产生任何可核对的证据；现在 detail 里给的是
       * 真读到的字节，以及**程序到底找过哪几个位置**。
       */
      const roots = mediaAssetRoots(input.dataDir);
      const escaped: string[] = [];
      const dangling: string[] = [];
      let evidence = '';
      for (const r of rows) {
        const probe = await probeAssetFile(roots, r.relPath);
        if (probe.tried.length === 0) {
          escaped.push(`${r.role}→${r.relPath}`);
        } else if (probe.abs === null && probe.escaped.length > 0) {
          /*
           * ★ T-143 ①：候选**落在根内**，但顺着符号链接解析出去了。
           * 这必须算进"越界"这一档，不能算"读不到"—— 否则
           * `assetsContained` 会一边报 "全部落在 dataDir 内" 一边指着一条
           * 指向 /etc 的软链，那正是本项目定义的最贵的一种假红灯：**结论对、理由假**。
           */
          escaped.push(`${r.role}→${r.relPath}（软链指向根外：${probe.escaped.join('、')}）`);
        } else if (probe.abs === null) {
          dangling.push(`${r.role}→${r.relPath}（找过：${probe.tried.join('、')}）`);
        } else if (probe.bytesRead === 0) {
          dangling.push(`${r.role}→${r.relPath}（${probe.abs} 是 0 字节，播不了）`);
        } else if (evidence === '') {
          evidence = `${r.relPath} → ${probe.abs} 首 4 字节 ${probe.note}`;
        }
      }
      add({
        layer: 'datadir',
        id: 'datadir.assetsContained',
        label: 'assets inside dataDir',
        labelZh: 'media_assets 路径全在 dataDir 内',
        status: escaped.length === 0 ? 'ok' : 'fail',
        detail:
          escaped.length === 0
            ? `${rows.length} 条资产全部落在 ${input.dataDir} 内`
            : `${escaped.length}/${rows.length} 条指向 dataDir 外（移动数据目录后会失效）：${escaped.slice(0, 3).join(' ')}`,
        required: true,
        remediation:
          escaped.length === 0
            ? null
            : '这些资产存的是绝对路径或落在 dataDir 之外，搬家后会取不到；需要把文件收进 <dataDir>/media 并改存相对路径',
      });
      add({
        layer: 'datadir',
        id: 'datadir.assetsPresent',
        label: 'asset files present',
        labelZh: 'media_assets 文件都在',
        status: dangling.length === 0 ? 'ok' : 'warn',
        detail:
          dangling.length === 0
            ? rows.length === 0
              ? '没有媒体资产'
              : `${rows.length} 条资产都真的读到了内容（例：${evidence}）`
            : `${dangling.length}/${rows.length} 条读不出来：${dangling.slice(0, 3).join('；')}`,
        required: false,
        /*
         * 措辞是这条检查最要命的地方 —— 旧文案直接断言"已被删除"，而实测中
         * 更常见的成因是**记录里的路径和文件实际位置对不上**。
         * 一句说错的红灯会让用户去翻备份、怀疑自己误删，还会淹没真正丢了的那条。
         */
        remediation:
          dangling.length === 0
            ? null
            : '⚠️ 这**不等于**文件被删除：更常见的是记录里的路径与文件实际位置对不上（括号里就是程序真正找过的位置，可以自己去核对）。重启 daemon 会跑一次路径迁移，能自动修好一部分；仍然报的才需要找回文件。',
      });
    }
  }

  // ---- engines ----------------------------------------------------------------------
  for (const e of await input.probes.engines()) {
    add({
      layer: 'engines',
      id: `engine.${e.id}`,
      label: e.id,
      labelZh: e.id,
      status: e.available ? 'ok' : 'warn',
      detail: e.available ? '可用' : (e.reason ?? '不可用'),
      required: false,
      remediation: e.available ? null : '安装该引擎所需的后端包与模型',
    });
  }

  for (const [lang, labelZh] of [
    ['zh', '中文自动选择'],
    ['en', '英文自动选择'],
  ] as const) {
    const sel = await input.probes.selectFor(lang);
    add({
      layer: 'engines',
      id: `engine.select.${lang}`,
      label: `auto engine (${lang})`,
      labelZh,
      status: sel !== null ? 'ok' : 'fail',
      detail: sel !== null ? `${sel.engineId}（${sel.reason}）` : '无可用引擎',
      required: true,
      remediation: sel !== null ? null : '安装 CPU 基础包与一个语音识别模型',
    });
  }

  // ---- proxy ------------------------------------------------------------------------
  if (input.probes.proxy === undefined) {
    notProbed('proxy', 'proxy.config', 'proxy configuration', '代理配置');
    notProbed('proxy', 'proxy.ffmpeg', 'proxy covers ffmpeg', '代理覆盖 ffmpeg');
  } else {
    const px = await input.probes.proxy();
    add({
      layer: 'proxy',
      id: 'proxy.config',
      label: 'proxy configuration',
      labelZh: '代理配置',
      status: 'ok',
      detail:
        px === null
          ? '未配置（off=直连 / system=继承环境变量 / manual=手填）'
          : `mode=${px.mode}${px.activeUrl ? ` → ${px.activeUrl}` : ''}`,
      required: false,
      remediation: null,
    });

    /*
     * 这条是**别处没人会说**的功能性事实，所以哪怕默认不联网也要报：
     * ffmpeg 不支持 SOCKS（libavformat 的 http 协议只读 `http_proxy`，不认 `ALL_PROXY`）。
     * 配了 SOCKS 的用户会以为"全都走代理了"，直到在线拉流直连失败也想不到是这个原因。
     */
    const ffOk = px === null || px.ffmpegSupported;
    add({
      layer: 'proxy',
      id: 'proxy.ffmpeg',
      label: 'proxy covers ffmpeg',
      labelZh: '代理覆盖 ffmpeg',
      status: ffOk ? 'ok' : 'warn',
      detail: ffOk ? '当前代理形态 ffmpeg 可用' : (px?.ffmpegReason ?? 'ffmpeg 不走当前代理'),
      required: false,
      remediation: ffOk
        ? null
        : '模型下载与站点解析仍走代理；若要在线拉流也走代理，请改填 HTTP 代理地址',
    });
  }

  if (input.proxyTest === true && input.probes.proxyConnectivity !== undefined) {
    const px = input.probes.proxy === undefined ? null : await input.probes.proxy();
    const rep = await input.probes.proxyConnectivity();
    const manual = px?.mode === 'manual';
    const detail =
      rep === null
        ? '探测失败'
        : rep.probes
            .map((p) => `${p.target}:${p.result}${p.viaProxy ? '(经代理)' : '(直连)'}`)
            .join(' ') || '无探针结果';
    /*
     * 只有 mode=manual 时才算"必需项"。
     * 用户明确填了代理却连不上 = 配置坏了，下载一定会失败，该红。
     * 而 off/system 下探针失败可能只是**这台机器没网** —— 把"离线"渲染成"产品坏了"
     * 和"绿灯不代表能用"是同一个病的两面。
     */
    add({
      layer: 'proxy',
      id: 'proxy.connectivity',
      label: 'proxy reachability',
      labelZh: '代理实连测试',
      status: rep?.ok === true ? 'ok' : manual ? 'fail' : 'warn',
      detail: detail + (manual ? '' : '（未配代理：失败可能只是本机离线）'),
      required: manual,
      remediation: rep?.ok === true ? null : '检查代理地址与端口，或先确认本机能出网',
    });
  }

  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
  };

  return {
    // "ok" means no REQUIRED check failed. Warnings are degradations the user chose or
    // has not got to yet; failures mean something is actually broken.
    ok: results.every((r) => !(r.status === 'fail' && r.required)),
    ranAt: new Date().toISOString(),
    dataDir: input.dataDir,
    storeRoot: input.storeRoot,
    extensionsDir: input.extensionsDir,
    counts,
    results,
  };
}

/** List installed artifact names under `<storeRoot>/by-name/<kind>/`. */
export async function listByName(storeRoot: string, kind: string): Promise<string[]> {
  try {
    return (await readdir(join(storeRoot, 'by-name', kind))).sort();
  } catch {
    return [];
  }
}

/** 一个 role 的安装情况：文件名 + 那些"记录里没写 role"的条数。 */
export interface InstalledByRole {
  /** 该 role 下已装的权重文件名（去重、排序）。 */
  names: string[];
  /**
   * **没写 `role` 字段的记录条数**（全部桶合计）。
   *
   * 必须报出来，不能吞掉：这类记录一律**不猜**（`store.ts` 的规矩 ——
   * 从目录名猜 role 正是"whisper 拿到 VAD 网络而自检全绿"的成因）。
   * 但"我跳过了 N 条"和"这里什么都没有"在用户那儿是两件事，
   * 所以把跳过的范围如实带进返回值（HANDOFF ⑤A 规矩 6）。
   */
  skippedWithoutRole: number;
}

/**
 * 按**安装记录里的 `role`** 列出已装模型 —— 不看它躺在哪个目录。
 *
 * ## 为什么不能看目录（T-149）
 *
 * 这条判据以前是「`by-name/asr/` 下的文件名，再用一条正则
 * `/silero|vad|punct|ct-transformer|speaker|diariz/i` 把非 ASR 的剔出去」。
 * 那条正则是给一个**已经修好的问题**打的补丁：`store.ts` 的两条修正之②
 * （role 写进安装记录）早就落地了，只是没人用它。它的代价很具体：
 * 一个名字里带 `silero` 的**真** ASR 模型会被判成"不是 ASR"，
 * 而每新增一个 role（说话人分离、标点…）都要回来改这条正则，改漏了就是一盏假绿灯。
 *
 * ## 复用 downloader 的 `findInstalledByRole()`，**不另写一份规则**
 *
 * 那个函数已经把规则定死了：扫**全部**桶、`role` 缺失就跳过（不猜）、
 * `integrity !== 'ok'` 不算数。这里只加一件它没做的事 —— **把"跳过了几条"数出来**，
 * 因为「我跳过了 N 条」和「这里什么都没有」在用户那儿是两件事（HANDOFF ⑤A 规矩 6）。
 */
export async function listInstalledNamesByRole(
  storeRoot: string,
  role: string,
): Promise<InstalledByRole> {
  const store = new ArtifactStore(storeRoot);
  const recs = await findInstalledByRole(store, role, { requireIntegrityOk: true });

  const names = new Set<string>();
  for (const rec of recs) {
    for (const f of (rec as { files?: { name?: unknown }[] }).files ?? []) {
      if (typeof f?.name === 'string') names.add(f.name);
    }
  }

  // 同一条规则的另一半：记录里没写 role 的，`findInstalledByRole` 会静默丢掉，这里把它数出来。
  let skippedWithoutRole = 0;
  for (const kind of STORE_KINDS) {
    if (kind === 'backend') continue;
    for (const rec of await store.listManifests<{ role?: unknown }>(kind)) {
      if (rec && typeof rec === 'object' && rec.role == null) skippedWithoutRole += 1;
    }
  }

  return { names: [...names].sort(), skippedWithoutRole };
}

/** `<extensionsDir>/libsimple.so` 等的平台后缀。CLI 与 daemon 都要用同一份。 */
export function extensionFileName(base: 'libsimple' | 'vec0'): string {
  return `${base}${libSuffix()}`;
}

/* ------------------------------------------------------------------------------------ */
/* 同源校验：把两份报告逐 id 比对                                                          */
/* ------------------------------------------------------------------------------------ */

export interface SelfCheckDiffEntry {
  id: string;
  /**
   * `missing-here`  对方有、我没有
   * `missing-there` 我有、对方没有
   * `status`        结论不同
   * `required`      必需性不同 —— 纯逻辑，两边**永远**不该不一样
   */
  kind: 'missing-here' | 'missing-there' | 'status' | 'required';
  here: string | null;
  there: string | null;
}

/**
 * 比对两份自检报告。**这才是"同源"的证据** —— 光在注释里保证是不算数的。
 *
 * 比 id、status 和 required：
 *   - id 集合  —— 检查项必须完全一致，这是"网页绿 ≠ CLI 绿"的直接成因；
 *   - status   —— 同样的机器同样的判据，结论必须一样；
 *   - required —— 纯逻辑推导，不受环境影响，两边不同就是判据被改分叉了。
 *
 * 刻意**不比 detail**：detail 里有绝对路径、设备数、版本号这类本来就会不同的东西
 * （CLI 在仓库根跑，daemon 在自己的进程里跑）。拿它们做判据只会制造假报警，
 * 而一条经常误报的红线，很快就等于没有这条线。
 */
export function diffSelfCheckReports(
  here: SelfCheckReport,
  there: SelfCheckReport,
): SelfCheckDiffEntry[] {
  const a = new Map(here.results.map((r) => [r.id, r]));
  const b = new Map(there.results.map((r) => [r.id, r]));
  const out: SelfCheckDiffEntry[] = [];

  for (const [id, ra] of a) {
    const rb = b.get(id);
    if (rb === undefined) {
      out.push({ id, kind: 'missing-there', here: ra.status, there: null });
      continue;
    }
    if (rb.status !== ra.status) {
      out.push({ id, kind: 'status', here: ra.status, there: rb.status });
    }
    if (rb.required !== ra.required) {
      out.push({
        id,
        kind: 'required',
        here: `required=${String(ra.required)}`,
        there: `required=${String(rb.required)}`,
      });
    }
  }
  for (const [id, rb] of b) {
    if (!a.has(id)) out.push({ id, kind: 'missing-here', here: null, there: rb.status });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}
