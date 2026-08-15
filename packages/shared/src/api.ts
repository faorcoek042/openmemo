/**
 * HTTP API contract for the local daemon.
 *
 * Base: http://127.0.0.1:{port}/api   (ADR-003 decision 1 — 127.0.0.1 ONLY, never 0.0.0.0;
 * memo.ac's bundled whisper-server binds 0.0.0.0 and that is exactly the mistake we avoid.)
 *
 * Auth: the daemon mints a random token at startup; every request carries
 * `Authorization: Bearer <token>`. Without it any web page you visit could drive the
 * local API. Ollama leaves :11434 open by default and relies on OLLAMA_ORIGINS; we
 * close it from the start.
 */

import type { AsrEngineId, BackendPack, InstalledBackendPack } from './backends.js';
import type { AdvisoryGpuVerdict, Backend, HardwareInfo, Inapplicability } from './hardware.js';
import type { AnyJob } from './jobs.js';
import type {
  CatalogGroup,
  CatalogSource,
  InstalledModel,
  ModelEntry,
  ModelRole,
} from './models.js';
import type { FitResult } from './fitness.js';
import type { ProviderId } from './artifacts.js';
import type { Remediation } from './events.js';

/* ----------------------------- catalog ----------------------------------- */

export interface CatalogQuery {
  role?: ModelRole | 'all';
  refresh?: boolean;
  lang?: 'zh' | 'en';
}

/** A catalog variant with its server-computed fit verdict attached. */
export interface CatalogVariant extends ModelEntry {
  installed: boolean;
  /**
   * Computed server-side. The web UI renders this and MUST NOT recompute the rules —
   * a second implementation would drift from fitness.ts.
   */
  fitness: FitResult;
}

export interface CatalogGroupWithFitness extends Omit<CatalogGroup, 'variants'> {
  variants: CatalogVariant[];
}

export interface GetCatalogResponse {
  catalogVersion: string;
  source: CatalogSource;
  fetchedAt: string;
  /** True when serving a cached/bundled catalog; the UI shows an offline banner. */
  stale: boolean;
  /** Identifies the hardware snapshot the fit verdicts were computed against. */
  hardwareSnapshotId: string;
  groups: CatalogGroupWithFitness[];
}

/* ---------------------------- installed ---------------------------------- */

/**
 * **记为活动、但本机拿它的那个引擎加载不了。** 每个槽位一条，只在**确知**时才出现。
 *
 * ## 它修的是哪个用户症状（A-4 ②）
 *
 * 目录里 `role:'vad'` 底下躺着两个**互相加载不了**的条目
 * （`vad/silero-vad-onnx` 给 sherpa-onnx，`vad/silero-vad-ggml` 给 whisper.cpp），
 * 而自动激活是"先装的赢"、onnx 排在前面。于是同一台机器上两个消费方说相反的话：
 *
 *   · 激活态（`active` / 存储页的「使用中」）：这个 VAD **正在用**；
 *   · 流水线装配（按文件头四字节判）：whisper.cpp **读不了它** ⇒ 切分退回固定窗口，
 *     `[用户真机 2026-08-09, Windows]` 那条警告一次启动出现 **3 遍**。
 *
 * A-4 ① 让**新装**的机器不再产生这个矛盾；这一格是给**已经处在这个状态**的机器用的
 * —— 用户那台就是。改判据是修不了它的：`active.json` 里那一行已经写下了。
 *
 * ## 为什么不是把 `active` 改成"能用的那个"
 *
 * `active[role]` 回答的是「**用户/产品把哪个记成了活动**」，
 * 它同时是激活按钮的当前值、是 `POST /api/models/activate` 的写入目标。
 * 把它悄悄换成"实际能用的那个"，会让界面上的选择与盘上的记录不一致，
 * 而用户按下"激活"之后看到的仍然是原来那个 —— 那是另一句假话，不是修好。
 * **两件事分两格说**：`active` 说记录，这一格说后果。
 *
 * ## 缺失 ≠ 否
 *
 * 老 daemon 不发这个字段，客户端必须能表达"我不知道"。
 * 判据说不出的时候（例如 `asr` 由 `selectEngine()` 按语言现挑引擎，
 * 这个问题在一台机器上本来就没有唯一答案）同样**什么都不说**，
 * 而不是发一条"能用"。
 *
 * ⚠️ **不带人话句子**：只发事实（是哪个模型、哪个引擎读不了它），
 * 措辞交给有 i18n 的那一侧。daemon 控制台没有 i18n，把中文句子塞进契约
 * 就等于让英文用户在网页上也读中文 —— 那个坑 `pipeline/setup.ts` 里记着。
 */
/**
 * 「这台机器上转写实际用的是哪种切分，为什么」—— **机器可读**（#106）。
 *
 * ## 为什么它非在契约里不可
 *
 * `/api/health` 的 `pipeline.vad` 上一版**只有 `reasonZh` 一格，没有 `reasonEn`**。
 * 诊断页那一行（`DiagnosticsPage` 的"切分方式"）直接渲染它，于是
 * **英文界面上这一行必然是中文** —— 不是"有时漏"，是结构上没有别的东西可渲染。
 * 更难看的是它还会和后面那半句英文（`diagnostics.chunkingRuntimeFailure`）连起来，
 * 拼成一句一半中文一半英文的话。
 *
 * `apps/daemon/src/pipeline/setup.ts` 那段注释早就把结论写下了：
 * 「英文该去**有 i18n 的那一侧**（网页）…… 但那需要把 `reasonZh` 换成
 * reason **code** 再由前端翻译，是另一件事，**本轮没做**」。这就是那件事。
 *
 * ⚠️ **daemon 控制台那句中文保留、不动。** 那一侧没有 i18n（从启动横幅到每一条
 * `[daemon]` 都是中文），在那里插英文既不一致也救不了谁 —— 这条判断是上一轮
 * 实测之后写下的，本轮没有推翻它。变的只有**进契约、上网页**的那一份。
 */
export type VadChunkingReason =
  | {
      /** 没降级：真的在按静音切分。 */
      readonly kind: 'vad_active';
    }
  | {
      /** 一份 VAD 权重都没装 ⇒ 固定窗口。**装一个模型真能修好**的那一档。 */
      readonly kind: 'no_vad_model_installed';
    }
  | {
      /**
       * 盘上有 VAD 权重，但 whisper.cpp 一个都加载不了
       * （典型：装成了 sherpa 专用的 `silero_vad.onnx`）。
       */
      readonly kind: 'installed_weights_not_loadable';
      /** 被拒的那几份权重的**文件名**（数据，照实列，不翻译）。 */
      readonly rejected: readonly string[];
    }
  | {
      /**
       * 权重挑对了、二进制也在，**这一轮 VAD 真的跑失败了**（缺共享库、被杀、超时……）。
       *
       * ⚠️ **这一格刻意不带原始错误串。** 它在 `packages/pipeline` 里被包在一句中文
       * 里（`VAD 未能运行，本次已退回固定窗口切分（…）：<原文>`），要把 `<原文>` 单独
       * 取出来只能去劈那句中文 —— 拿散文当结构，正是本仓清过两次的形状。
       * 原始错误**没有丢**：它照旧进 daemon 日志与 job 结果里的 `warningsZh`。
       * 哪天 `planAudioChunks` 把它作为结构字段交出来，这一格再加一个 `detail`。
       */
      readonly kind: 'runtime_failure';
    };

/**
 * 「这个 ASR 引擎为什么用不了」—— **机器可读**，措辞归 `apps/web` 的两份 locale（#112）。
 *
 * ## 为什么不是 `reason: string`
 *
 * `/api/health` 的 `pipeline.engines[].reason` 上一版是一格自由文本，而它有
 * **两个产出方，方向相反的两句谎**：
 *
 *   · `pipeline/setup.ts` 的 `unavailableEngines` 发**中文散文**
 *     （「未安装流式中文模型 —— 去「模型」页装 …」）；
 *   · `packages/pipeline` 的 `buildCandidates()` 发 `AsrAvailability.reason`，
 *     那是**英文散文**（`the streaming recognition component is not installed (…)`）。
 *
 * 三个渲染点（录音页的引擎芯片、模型页的 `EngineFitChip`、重转弹窗那一行）都是
 * 原样插值 —— 于是**英文界面上是半句中文，中文界面上是半句英文**，同一格两头漏。
 *
 * 这里把整条轴换掉：daemon 只说是哪一种 + 结构化字段，措辞在 locale 里，
 * 而 web 侧那张 `Record<EngineUnavailableReason['kind'], string>` 是总表 ——
 * 新增一种而没人写话，**构建当场就红**。形状照 {@link Inapplicability}（#106）。
 *
 * ⚠️ **参数不许拼进 kind**：`installed_but_files_incomplete` 的已装 id 列表、
 * `override_dir_incomplete` 的变量名与目录，都是**结构化字段**，由 web 插值。
 */
export type EngineUnavailableReason =
  | {
      /**
       * 这个引擎要的模型**一个都没装**。**装一个模型真能修好**的那一档 ——
       * 界面据此指向「模型」页，所以它必须与下面那一档分开。
       */
      readonly kind: 'model_not_installed';
    }
  | {
      /**
       * 装是装了，但目录里**缺文件**（sherpa 缺 encoder/decoder/joiner/tokens.txt 之一，
       * Paraformer 缺 `*.onnx` 或 `tokens.txt`）。
       *
       * ★ 与 `model_not_installed` 分开、不合并成"没装好"：**用户看得见的下一步不同** ——
       * 这一档要说的是"你装的那个是坏的/不全的，重装它"，而不是"去装一个"。
       * 让一个已经装过的人再去装一遍，正是本仓清过的那种「叫用户去做他刚做完的事」。
       */
      readonly kind: 'installed_but_files_incomplete';
      /** 已装、但文件不全的那几个模型 id（数据，照实列，不翻译）。 */
      readonly installedIds: readonly string[];
    }
  | {
      /**
       * 环境变量覆盖指向了一个**没有所需文件**的目录。开发/自检路径，
       * 但它必须说得出是**哪个变量**、指向**哪里** —— 否则排障时只知道"用不了"。
       */
      readonly kind: 'override_dir_incomplete';
      /** 例如 `OPENMEMO_SHERPA_STREAM_DIR`。 */
      readonly envVar: string;
      /** 那个变量当时的值（数据，不翻译）。 */
      readonly dir: string;
    }
  | {
      /**
       * 引擎**构造出来了**，但它自己的 `isAvailable()` 说不可用 —— 这一格装的是
       * `packages/pipeline` 那句**英文原话**（含 `err.message`）。
       *
       * ⚠️ **这一格刻意不枚举。** 落进来的是 `AsrAvailability.reason`：一个
       * **我们没有解读过、也没有边界**的集合（它自带 `require()` 抛回来的 message）。
       * 给它硬编一个枚举，是把「我不知道这是什么」塌成「我知道」。
       * 所以它如实进 `text`，界面上明说这一段是原文、不会被翻译 ——
       * 同 `UpstreamFailure.upstream_error_text` 与
       * `Inapplicability.backend_unavailable.detail` 的待遇。
       */
      readonly kind: 'engine_probe_text';
      readonly text: string;
    };

/**
 * `/ws/recorder` 的 error 帧「是哪一种错」—— **机器可读**（#112 第 19 处）。
 *
 * ## 这一处和另外五处不是一个病
 *
 * 其余几处都是「daemon 有中文、前端照抄」。这一格**连英文字段都没有**：
 * 帧上原来只有 `messageZh`，`RecorderPage` 直接 `setStreamError(msg.messageZh)`。
 * 也就是说**英文用户那条横幅无论怎么改前端都救不了** —— 必须从这一侧加字段。
 *
 * `messageZh` 已经从帧上**删掉**（同 #106 删 `pipeline.vad.reasonZh` 那一手）：
 * 留着它，前端就永远有一句中文可以回落，那张总表也就形同虚设。
 * 中文原话**没有丢**，它照旧进 daemon 控制台的 `console.error`（那一侧没有 i18n）。
 *
 * ⚠️ **web 侧渲染用的联合比这里多一格** `not_reported`（"对面这一版没说是哪一种"），
 * 它**刻意不在这个契约里** —— 那样 daemon 在类型上就发不出它，
 * 它只可能来自一个更旧的 daemon。见 `apps/web/src/features/recorder/recorderErrorText.ts`。
 */
export type RecorderErrorReason =
  | {
      /** 流式识别引擎不可用（未安装流式模型）。会话根本没开起来。 */
      readonly kind: 'stream_engine_unavailable';
    }
  | {
      /**
       * 录音**启动**失败。
       *
       * ⚠️ **阶段是知道的，成因不知道** —— `detail` 装的是 `err.message` 原样串。
       * 所以 `kind` 只说"卡在启动这一步"，成因如实标成不翻译的原文。
       * 给成因硬编一个枚举，是替一段没看懂的字符串背书。
       */
      readonly kind: 'start_failed';
      readonly detail: string;
    }
  | {
      /** 会话开着，识别引擎自己报错。同上：阶段知道、成因是原文。 */
      readonly kind: 'engine_error';
      readonly detail: string;
    }
  | {
      /**
       * 停止录音时的**收尾**失败（落盘路径算不出规范相对路径这类）。同上。
       *
       * ★ 与 `start_failed` 分开：**用户已经录到的东西在不在，两档的答案不同** ——
       * 启动失败时一行都没建，收尾失败时音频可能已经落了盘。
       */
      readonly kind: 'finalize_failed';
      readonly detail: string;
    }
  | {
      /** 上行的控制消息不是合法 JSON。 */
      readonly kind: 'control_message_not_json';
    }
  | {
      /** `/ws/asr-worker`：ADR-006 决策 3 已把 L0 降级为实验特性，v1 不实现。 */
      readonly kind: 'asr_worker_not_implemented';
    };

/**
 * 一次卸载里**我们拒绝去删**的一个条目（#109 / T-107）。
 *
 * ⚠️ `reason` 是解析层抛回来的**英文技术原话**（带绝对路径与允许的根），
 * **不翻译**，界面必须让人看得出哪一段是原文 —— 同
 * `Inapplicability.backend_unavailable.detail` 的待遇。
 *
 * ★ 这里**没有**把它收成枚举，是刻意的：它由 `packages/downloader/src/store.ts`
 * 里四条不同的 `throw` 汇流而成，而那四条的措辞是给排障的人看的、随时会加第五条。
 * 收成枚举就得替每一条决定"它属于哪一格"，而**用户要读的那一句不在这里** ——
 * 在 `filesNotRemoved` 那句话本身（记录已清 + 有几个没删掉 + 它们在哪儿）。
 */
export interface RefusedFileReport {
  /** 安装记录里那个文件的名字，用户在界面上对得上号的那个。 */
  readonly name: string;
  /** 解析层的英文原话。**不翻译。** */
  readonly reason: string;
}

/**
 * 一次卸载里**我们试着删了、但删不动**的那一格（#113）。
 *
 * ## 🔴 它为什么必须与 {@link RefusedFileReport} 分开，而不是并进 `refused[]`
 *
 * 两者的**下一步动作不同**，这是分档唯一的判据：
 *
 *   · `refused`（#107）—— 我们**知道**有这么个文件，但**不肯**按那条记录去 `rm`
 *     （记录越界，那些字节不属于我们）。产品这边没有任何东西会变，
 *     用户要么自己去删，要么就让它留着。**再试一次也还是拒绝。**
 *   · `failed`（本类型）—— 我们**试了**，`fs.rm` **抛了**。
 *     这一档**可能会变**：句柄放开了、权限改了，下一次就删得掉。
 *     Windows 上「进程还占着」正是这一格，而它的解药是一次重启 ——
 *     那是一句**可执行的建议**，塞进 `refused` 就说不出来了。
 *
 * ## 这一档在 #113 之前是**被吞掉**的
 *
 * `state.ts::dropInstalledFiles()` 里那句 `fs.rm(...).catch(() => undefined)`
 * 把失败整个咽了，而且咽完**照样 `removed += 1`** —— 于是 `removed` 在数它
 * 没删掉的东西，用户拿到一个干净的成功，文件还在盘上。
 * `e2e-runtime` 的 `A-UNINSTALL-BYTES-GONE` 在 win32 上如实报 UNKNOWN
 * 用的就是这个理由（linux/darwin 两条腿 PASS）。
 */
export interface FailedFileReport {
  /** 安装记录里那个文件的名字（目录那几条是派生出来的目录名）。 */
  readonly name: string;
  /**
   * 我们试图删除的**绝对路径** —— 「那个文件到底在哪儿」的答案。
   *
   * ⚠️ 这一格不是可选的装饰：这一档的用户动作是**他自己去删**，
   * 而没有路径他就无从下手。`refused` 那一格靠 `reason` 里的原话带出路径
   * （解析层的异常正好带着它），这一格的异常来自 `fs.rm`，
   * 里面**不一定**有完整路径，所以必须单独带一格出来。
   */
  readonly path: string;
  /** 分档 —— 措辞归两份 locale，界面按**全量 `Record`** 渲染（少一格构建当场红）。 */
  readonly kind: RemovalFailureKind;
  /**
   * 系统/Node 抛回来的**原话**（英文）。**不翻译。**
   *
   * ⚠️ 与 `RefusedFileReport.reason` 同一条待遇，理由也一样：它是 errno + syscall +
   * 路径的自由文本，不是一个我们枚举得完的集合。`kind === 'unknown'` 时它是我们
   * 唯一能说的东西 —— 那时界面必须**如实说「原因我们没弄清」并把这段原话摆出来**，
   * 不许替它编一个成因。
   */
  readonly detail: string;
}

/**
 * 「删不动」的成因分档。**判据是「用户的下一步动作不同」，不是 errno 好看。**
 *
 * ⚠️ 只有三格，而且刻意**没有**按 errno 一一对应：多分一格却给不出不同的建议，
 * 就是拿分类学冒充信息。加第四格之前先回答「用户看到它会做一件别的事吗」。
 */
export type RemovalFailureKind =
  /**
   * 文件正被占用（`EBUSY` / `ETXTBSY`）。
   *
   * ★ 这一格存在的全部理由：**它有解药，而且用户做得到** —— 关掉占着它的程序、
   * 或者重启一次。Windows 上这是最常见的一档（后端包里的 `.dll` 可能正被
   * 推理进程加载着），而它恰恰是最值得说出口的一档。
   */
  | 'in_use'
  /**
   * 系统不允许我们删（`EACCES` / `EPERM`）。
   *
   * ⚠️ 在 Windows 上，一个**被程序打开着**的文件也会报到这一档
   * （`STATUS_CANNOT_DELETE` → `ERROR_ACCESS_DENIED`）。所以这一格的措辞
   * **两种可能都要说**，不许只挑一种讲得像我们查清楚了。
   */
  | 'permission_denied'
  /**
   * **我们不认识这个错。**
   *
   * 🔴 这一格是有意留白的：`fs.rm` 能抛的东西没有边界，而**编一个成因比沉默更坏**。
   * 界面在这一格上说的是「没删掉、它在这儿、原因我们没弄清」＋ `detail` 原话，
   * 不给任何我们证明不了的建议。
   */
  | 'unknown';

/**
 * `DELETE /api/models/:id` 与 `DELETE /api/backends/:id` 在**有拒绝时**的 200 响应体。
 *
 * ## 为什么它非在契约里不可（#109）
 *
 * `795f091` 让这两个端点在有拒绝时回 `200 + filesNotRemoved`，**但那只到服务端边界**：
 * 响应体 + 一条 `console.warn`，**界面上一个字都没有**。而两个 web 调用方都是
 * `api<void>(…)` —— body 被整个丢掉。**一个只到 API 的字段就是「有人写没人读」。**
 *
 * ⚠️ 干净路径仍然是 **204**，body 是 `undefined` —— 客户端
 * （`lib/api/client.ts:212`）已经替我们把两条路分开了，所以调用方读到
 * `undefined` 就是"全删干净了"，读到这个对象才需要说话。
 *
 * 🔴 **界面上那句话必须先说「记录已经清掉了」。** 用户点卸载看到「有 N 个文件没能删」，
 * 最自然的解读是「卸载失败了，我再点一次」—— 而记录其实已经走了，**再点会拿到 404**。
 * 同理 tone 是**信息级不是故障级**：卸载成功了，只是有残留。
 *
 * ## ★ #113：这条 200 现在有**两个**来源，而它们不是同一件事
 *
 * `filesNotRemoved`（我们**不肯**删）与 `filesFailedToRemove`（我们**没删动**）
 * 各自都能单独把响应从 204 抬到 200。**两格都空才是 204。**
 *
 * ⚠️ 于是「`filesNotRemoved` 在 200 上一定非空」这条旧不变式**不再成立** ——
 * 一次纯粹的 rm 失败会给出 `filesNotRemoved: []` + 非空的 `filesFailedToRemove`。
 * `scripts/ci/e2e-runtime-assertions.mjs` 里那条形状检查已经按这条改过；
 * 谁要是把它改回「200 ⇒ `filesNotRemoved` 非空」，第三档就会被判成契约漂移。
 */
export interface UninstallWithRefusalsResponse {
  /** 这次真的回收了多少字节。 */
  readonly freedBytes: number;
  /**
   * 我们**拒绝**去删的条目（越界 / 记录损坏）。
   *
   * ⚠️ **可以是空数组**（#113 之后）：另一格非空时这条 200 照样会发出来。
   */
  readonly filesNotRemoved: readonly RefusedFileReport[];
  /**
   * 我们**试着删了、没删动**的条目（`fs.rm` 抛了）。同样**可以是空数组**。
   *
   * 🔴 **不许把它并进 `filesNotRemoved`。** 两者对用户的下一步动作不同 ——
   * 详见 {@link FailedFileReport} 的文件头。
   */
  readonly filesFailedToRemove: readonly FailedFileReport[];
}

export interface ActiveSlotUnusable {
  /** 记在这个槽位里的模型 id —— 与 `active[role]` 同值，便于调用方不用回查。 */
  modelId: string;
  /** 本机上负责加载这个 role 的引擎，也就是"读不动它"的那一个。 */
  engine: AsrEngineId;
  /**
   * **同一个 role 下，本机已经装了的、这个引擎读得动的另一份。**
   *
   * ## 为什么这一格是承重的
   *
   * 「加载不了」这句话对用户的下一步动作**有两种完全不同的答案**：
   *   · 能用的那份**已经装了**、只是没被激活 ⇒ 他该做的是**激活它**（零下载）；
   *   · 本机**一份能用的都没有** ⇒ 他该做的是**装一个**。
   * 把两者糊成一句"去装吧"，会让已经装好的人被送去重下一遍；
   * 糊成"去激活吧"，会让没装的人在列表里找一个不存在的东西。
   * 这一周删掉的正是那种"按钮点得动、跳得走、就是到不了能修的那一页"。
   *
   * ## 三态，**分不出来就说不出来**
   *
   *   · `string`   —— 已装且读得动的那一份的 id（**确知**，逐个验过文件内容）；
   *   · `null`     —— 逐个验过，**确知一份都没有**；
   *   · 字段缺失   —— **说不出**：候选里有记录指不到文件（旧记录 / 文件被挪走），
   *                   那时既不能说"有"也不能说"没有"。客户端此时**只报事实、不给动作**。
   *
   * ⚠️ 判据仍然是文件内容（`canEngineLoad`），**不是目录的 `engines` 字段** ——
   *    安装记录里根本没有那个字段，按它过滤等于按不存在的东西过滤。
   */
  usableInstalled?: string | null;
}

export interface GetInstalledResponse {
  models: InstalledModel[];
  active: Record<ModelRole, string | null>;
  /** 见 {@link ActiveSlotUnusable}。**可选**：缺失 = 没算/算不出，不是"都能用"。 */
  activeUnusable?: Partial<Record<ModelRole, ActiveSlotUnusable>>;
}

/* ------------------------------- pull ------------------------------------ */

export interface PullRequest {
  /** Model id or backend-pack id. */
  id: string;
  kind?: 'model' | 'backend-pack';
  /** Force a specific source; "auto" runs the probe-ranked list. */
  provider?: ProviderId | 'auto';
  /** Optional file roles to include, e.g. ["coreml-encoder"]. */
  includeOptional?: string[];
  activateOnSuccess?: boolean;
  /**
   * Required when the model's license has requiresAcceptance/gated set.
   * ADR-004 decision 2: we never re-host restricted weights, so the user must confirm
   * they have accepted upstream terms.
   */
  licenseAccepted?: boolean;
}

export interface PullResponse {
  jobId: string;
  state: string;
  targetId: string;
  totalBytes: number;
  eventsUrl: string;
  /** True when an existing job for this target was returned instead of a new one. */
  deduplicated: boolean;
}

/* ------------------------------- jobs ------------------------------------ */

/**
 * The task centre's source of truth.
 *
 * `jobs` is `AnyJob[]`, not `DownloadJob[]`: this endpoint used to serve the download
 * queue only, so a transcription that was `blocked` waiting for a model appeared
 * **nowhere** — not in the list, and not behind the "view tasks" button that the blocked
 * toast itself offers. A remediation button that leads to an empty page is worse than no
 * button (T-130).
 */
export interface GetJobsResponse {
  jobs: AnyJob[];
  /** Global concurrent-download limit currently in force. */
  concurrencyLimit: number;
}

/* ------------------------------ activate --------------------------------- */

export interface ActivateRequest {
  role: ModelRole;
  /** null clears the slot. */
  id: string | null;
}

export interface ActivateResponse {
  role: ModelRole;
  active: string | null;
  previous: string | null;
  /** Inference process must reload before the change takes effect. */
  reloadRequired: boolean;
}

export interface GetActiveResponse {
  active: Record<ModelRole, string | null>;
  /**
   * 见 {@link ActiveSlotUnusable}。**两个端点都发**：
   * 只在 `/api/models/installed` 上发的话，任何只问"现在用的是哪个"的调用方
   * （这个端点存在的全部理由）都会拿到一个**没有下文的 id** ——
   * 而这一格要说的恰恰是"那个 id 有下文"。
   */
  activeUnusable?: Partial<Record<ModelRole, ActiveSlotUnusable>>;
}

/* ------------------------------ storage ---------------------------------- */

export interface StorageBreakdownItem {
  id: string;
  kind: 'model' | 'backend-pack';
  displayName: string;
  bytes: number;
  active: boolean;
}

export interface GetStorageResponse {
  modelsRoot: string;
  volume: { freeBytes: number; totalBytes: number };
  usedBytes: number;
  breakdown: StorageBreakdownItem[];
  reclaimable: {
    orphanBlobsBytes: number;
    stalePartialsBytes: number;
    inactiveModelsBytes: number;
    /**
     * 「无法识别的残留」—— `by-name/**` 下没有任何安装记录认领、
     * **且产品自己的解析器确认当前没在用**的那些字节。
     *
     * `[用户真机实测 2026-08-10]` 他机器上有 33.6 MB 这样的东西
     * （08-02 装的上游包，08-07 同一个 id 换成自建包之后没人认领）——
     * 明细里查不到、界面上删不掉、GC 也不扫。他看到的就是"说不清也删不掉的 9.4 MB"。
     *
     * **可选**：老 daemon 不发这个字段，客户端必须能表达"我不知道"。
     */
    unclaimedBytes?: number;
  };
}

export interface GcRequest {
  /**
   * `unclaimed_files`（T-193）：清「无法识别的残留」。
   *
   * ⚠️ 它与前两个不同 —— 前两个只删 `blobs/` 里内容寻址的东西，
   * 而这一个删的是 `by-name/**` 下的真实文件，**那正是产品的发现路径**。
   * 所以 daemon 侧有第二道闸：`discoverTools()` 当前解析到的路径一律不删，
   * 解析器本身失败时**一个都不删**。见 `RestState.collectUnclaimed()`。
   */
  targets: ('orphan_blobs' | 'stale_partials' | 'unclaimed_files')[];
}

export interface GcResponse {
  freedBytes: number;
  removedFiles: number;
}

/* ------------------------------ sources ---------------------------------- */

export interface SourceProbe {
  id: ProviderId;
  ok: boolean;
  ttfbMs: number | null;
  throughputKbps: number | null;
  probedAt: string;
  error: string | null;
}

export interface GetSourcesResponse {
  /** User preference; "auto" means use probe ranking. */
  selected: ProviderId | 'auto';
  /** Provider actually in use right now. */
  effective: ProviderId | null;
  probes: SourceProbe[];
  /**
   * Providers that the model catalog actually has mirrors for.
   *
   * ★ T-157 ④: without this the UI cannot offer a source picker at all. It would have to
   * either hardcode a provider list (a second source of truth that drifts from the
   * manifests, and offers sources no file is actually served from) or show nothing until
   * the user has run a probe. Both were rejected; the daemon already computes this exact
   * set for probing, so it says it out loud.
   *
   * Scope is the MODEL catalog, matching where the picker lives. Backend packs carry
   * their own mirrors (`github`) and are installed from a different page.
   */
  available: ProviderId[];
}

export interface SelectSourceRequest {
  /**
   * ⚠️ `"custom"` is rejected with 400 — see `apps/daemon/src/http/rest/models.ts`.
   * Nothing in the download path ever resolved a user-supplied base URL, so the
   * accompanying `baseUrl` field was removed in T-171 (A-6) rather than left as a
   * value the daemon stores and no code reads.
   */
  provider: ProviderId | 'auto';
}

/* ------------------------------- verify ---------------------------------- */

export interface VerifyRequest {
  id: string;
}

/* ------------------------------- import ---------------------------------- */

export type ImportRequest =
  | { kind: 'local_file'; path: string; role: ModelRole }
  | { kind: 'hf_repo'; repo: string; file: string; role: ModelRole; revision?: string };

/* ------------------------------ migrate ---------------------------------- */

export interface MigrateTargetCheckResponse {
  ok: boolean;
  path: string;
  freeBytes: number;
  requiredBytes: number;
  writable: boolean;
  sameVolume: boolean;
  reason: string | null;
}

export interface MigrateRequest {
  path: string;
}

/* ------------------------------ backends --------------------------------- */

/**
 * 「不可用」的三种含义 —— **不能用同一个 `applicable=false` 表达**。
 *
 * 用户看到"不可用"会以为自己的机器不支持，然后就不装了。但在干净机器上，
 * 绝大多数情况其实是**我们还没法判断**：probe 可执行文件装在后端包里，
 * 包没装 → probe 跑不了 → 加速后端一律显示"不可用"。
 * 这跟"探测完成、确认你没有这块卡"是完全不同的两件事，UI 该说的话也不同。
 *
 * ── ★ T-165：为什么这个类型必须住在 `shared` ────────────────────────────────
 *
 * 它原来只声明在 `apps/daemon/src/http/rest/backends.ts` 里，而 daemon 一直
 * **真的把它发出去**。契约类型里没有它 ⇒ 前端拿到的 `pack` 上根本不存在这个属性，
 * 于是「精心区分了三档」与「界面零消费」可以长期共存，**编译器一个字都不会说**。
 * `progress-audit §4⑪` 记的就是这一格：它想防的正是"用户以为自己机器不支持"，
 * 而它自己被同一种沉默挡住了。
 *
 * 与「写得进读不回 / 前后端键名对不上」是同一族：**发送方与接收方之间没有共享的类型，
 * 就没有任何东西在守这条线。**
 */
export type InapplicableKind =
  /** 可装 */
  | 'applicable'
  /** os/arch 就对不上，换台机器也没用 */
  | 'platform'
  /** **尚未探测**（probe 没跑成）——「检测中/待检测」，不是"不支持" */
  | 'undetermined'
  /** 探测完成，确认本机没有可用设备 */
  | 'unsupported';

export interface GetBackendCatalogResponse {
  catalogVersion: string;
  source: CatalogSource;
  stale: boolean;
  packs: (BackendPack & {
    installed: boolean;
    /** This pack matches the detected hardware. */
    applicable: boolean;
    /**
     * 不可用属于哪一档。
     *
     * **可选**是刻意的：老 daemon 不发这个字段，而客户端**必须**能表达"我不知道"。
     * 缺失时正确的行为是**什么档都不说**（只照抄 `inapplicability`），
     * 而不是默认成 `unsupported` —— 那会让界面替 daemon 说出一句它没说过的话。
     */
    inapplicableKind?: InapplicableKind;
    /**
     * Why not applicable, when applicable=false. **机器可读**（#106）。
     *
     * 这一格原来叫 `inapplicableReason`，类型是 `string | null`，里面装的是
     * `applicability.ts` 写死的中文散文；`BackendPackCard` 把它原样渲染在英文那句
     * 档位说明底下 —— 英文界面上「具体卡在哪」整行是中文。改名是**刻意的**：
     * 类型换了，字段名也换，这样任何还在读老字段的地方都会当场编译不过，
     * 而不是静默地拿到 `undefined` 渲染成空白。
     *
     * ⚠️ 与 `inapplicableKind` **不重复**：后者是"要不要给按钮 / 该说哪一档"的
     * 粗分（三档，前端排序与折叠用），这一格是"具体卡在哪"（含结构化参数）。
     * 两格由 daemon 的同一次判断同时产出（`rest/backends.ts` 的 `applicability()`）。
     */
    inapplicability: Inapplicability | null;
    recommended: boolean;
    /**
     * 装是装了，但**装的不是目录里现在这一版**（同一个 id，字节不同）。
     *
     * ## 为什么需要这一格：`installed` 只回答了半个问题
     *
     * `[用户真机实测 2026-08-09]` 目录里 `whispercpp-cpu-linux-x64` 在 T-167 从
     * 上游归档换成了我们自建的那一份（**多了 `openmemo-probe`**），而用户机器上
     * 08-02 装的还是上游那份。`installed` 按 **id** 算 ⇒ 恒为 `true` ⇒
     * 界面说"已安装"、没有任何地方说它是旧的，而硬件探测整条链是死的。
     *
     * 更糟的是**他在界面上无路可走**：已安装分支只有 设为活动 / 自测 / 卸载，
     * 而卸载对 `backend === 'cpu'` 的包是禁用的（load-bearing）。
     * 也就是说产品在教他做一件他做不到的事。
     *
     * **可选**是刻意的，与 `inapplicableKind` 同一条理由：老 daemon 不发这个字段，
     * 客户端必须能表达"我不知道"。缺失时正确的行为是**什么都不说**
     * （按老行为渲染），而不是默认成 `false` —— 那会让界面替 daemon
     * 说出一句"你装的就是最新版"，而它并不知道。
     */
    updateAvailable?: boolean;
    /**
     * **没有安装记录，但这个包该提供的东西，本机现在正从别处用着。**
     *
     * ## 它修的是哪个用户症状（T-197）
     *
     * `[实测 :10000]` `/runtime` 对**正在被使用的** ffmpeg 显示「安装 119 MB」，
     * 点下去把它再下一遍。同一时刻 `/api/selfcheck` 的 `tool.ffmpeg` 是绿的、
     * 流水线正拿它跑转码 —— 盘上那份是 **7.1.5**，而目录已经升到 **8.1.2**：
     * 归档文件名都不同，对账按目录声明的名字去找，**根本找不到痕迹**，
     * 于是它既不在 `installed` 里，也不在对账的 skipped 里。
     *
     * ## 为什么是新增一格，不是把 `installed` 改成"或"
     *
     * `backendReconcile.ts:22-38` 已经论证过：改成「有 manifest **或** 文件都在」
     * 会造出**第三个答案** —— `GET /api/backends/installed` 仍然列不出它、
     * `DELETE` 仍然 404、`installedVersion` 仍然 null、`recordSelfTest()` 仍然写不进。
     * 判据是"同一台机器上，装没装只准有一个回答的人"。
     * 所以 `installed` 的含义**一个字没动**，这一格只是把**另一件事**说出来。
     *
     * 也**不是**复用 {@link updateAvailable}：那一格按 manifest 比字节，
     * 而这里的前提正是**根本没有 manifest**，它算不出来。
     *
     * ## **可选**：缺失 ≠ 否
     *
     * 老 daemon 不发这个字段，客户端必须能表达"我不知道"。
     * 缺失时正确的行为是**什么都不说**，而不是渲染成"没有别处的副本"。
     */
    installedOnDiskButUnrecorded?: {
      /** 这个包声明提供、而本机确实正在用的那个文件名（如 `ffmpeg`）。 */
      file: string;
      /** 它当前被解析到的绝对路径 —— 证据本身，不是我们的推断。 */
      path: string;
    } | null;
    /**
     * **机器上那一份**的引擎版本与体积。`null` = 没装（或老记录里没有）。
     *
     * ## 为什么这两格必须单独存在（T-193 ③）
     *
     * 卡片上那行副标题渲染的一直是 `pack.engineVersion` / `pack.totalSizeBytes` ——
     * **目录里的值**。装过之后目录被换了新版（正是 `updateAvailable` 要说的那件事），
     * 于是屏幕上出现的是：
     *
     * > `已安装 · ffmpeg n8.1.2-… · 112 MB`   ← 而机器上跑的是 **n7.1.5**
     *
     * 「已安装」这三个字 + 一个**它并不拥有**的版本号，连起来读就是一句假话。
     * 唯一的提示只有旁边多了个「更新」按钮 —— 而那要求用户先意识到
     * "版本号说的不是我这台"，可屏幕上没有任何东西这么说过。
     *
     * 这与 `updateAvailable` 是**同一个根**的两半：界面在显示"目录说的"，
     * 不是"机器上的"。`updateAvailable` 回答了"要不要动"，这两格回答
     * "**我现在手里是哪一份**" —— 少了后者，前者是一条没有主语的建议。
     *
     * **可选**同上：老 daemon 不发 ⇒ 客户端表达"我不知道" ⇒ 按老行为渲染，
     * 而不是默认成"和目录一样"（那正是今天这句假话的来源）。
     */
    installedEngineVersion?: string | null;
    installedSizeBytes?: number | null;
    /**
     * 这个包提供的某个二进制，**系统里已经有一份正在被我们用**（借宿主 PATH 的那一档）。
     *
     * ## 它消掉的是一句跨页矛盾（#87 / 轴1③）
     *
     * 解析器（A 侧，`tools.ts` 的 `RESOLUTION_PLANS`）有三档 `pack | bundle | path`，
     * **`path` 那一档是活的**：用户 `brew install ffmpeg` 之后，流水线真的会用
     * `/usr/bin/ffmpeg`，于是 `ReadinessBanner` 读的 `pipeline.missing` 是空的、不报警。
     * 而安装记录（B 侧）只认 manifest —— 于是同一台机器上 `/components` 与 `/runtime`
     * 显示「可安装 · 145 MB」，**邀请用户把已经有的东西再下一遍**。
     *
     * ## ⚠️ 这一格**不是**"已安装"，两侧一个都没合并
     *
     * `backendReconcile.ts` 已经逐条论证过：把 `installed` 改成"有 manifest **或**
     * 文件都在"会造出**第三个答案**（`/backends/installed` 列不出它、`DELETE` 404、
     * `installedVersion` 仍是 null、`recordSelfTest()` 写不进）。那段论证仍然成立。
     * 系统 ffmpeg **本来就不该**被认领成我们的包 —— 它不是我们装的，我们也无权删它。
     * 所以这里只**加信息**：装按钮照旧在，只是旁边多一句实话。
     *
     * ## 与三个相邻概念的区别（别再合并它们）
     *
     * | 字段 | 说的是 |
     * |---|---|
     * | `installedOnDiskButUnrecorded` | **我们自己 store 里**有一份没登记的副本 |
     * | `InstalledBackendPack.source: 'bundled'` / `BackendStatus.bundled` | **包内自带**那一档（是我们的东西） |
     * | 本字段 | **借宿主 PATH 的**那一档（**不是**我们的东西） |
     *
     * 判据与 `selfcheck.ts` 那条同源、且是**结构性**的：既不在 store 里、也不在
     * `bundledRuntimeDir()` 底下 ⇒ 那就是借来的。不读解析器的"档位"，因为
     * `resolveByOrder()` 把命中的档位丢掉了（只返回路径）——
     * 与其为此加一条新数据通路，不如按路径落在哪儿当场判，**证据就是那条路径本身**。
     *
     * ## **可选**：缺失 ≠ 否
     *
     * 老 daemon 不发；解析器抛了也**什么都不说**（保持缺失）。
     * 「我问不出来」不等于「系统里没有」—— 把 UNKNOWN 渲染成"没有"就是又一句假话。
     */
    servedFromSystemPath?: {
      /** 这个包声明提供、而系统里已经有一份的那个文件名（如 `ffmpeg`）。 */
      file: string;
      /** 它当前被解析到的绝对路径 —— 证据本身，不是我们的推断。 */
      path: string;
    } | null;
    /**
     * 这个包**随应用一起出厂**，因此**卸不掉**（`DELETE /api/backends/:id` 会回
     * 409 `BUNDLED_NOT_REMOVABLE`）。取自安装记录的
     * {@link InstalledBackendPack.source} `=== 'bundled'`。
     *
     * ## 它修的是"一颗亮着、点了必然失败的按钮"
     *
     * 服务端那道闸门是**安全**那一半（没有它，一次点击就抹掉 ~230 MB 属于
     * **应用本体**的字节）。但只有闸门的话，用户看到的仍然是一颗亮按钮 +
     * 一个泛泛的确认框，点下去才拿到一句拒绝 —— 而本仓已经为同一个形状写过
     * 好几次判据：**点了必然失败的按钮，要在按下之前就说清楚**
     * （`BackendPackCard` 里 `pendingCi` / `other-platform` 两档都是这么处理的）。
     *
     * ## 为什么发的是**派生布尔**，不是把 `source` 原样送出去
     *
     * 界面要回答的是「**这颗按钮能不能点**」，不是「这份字节的来路」。
     * 送 `source` 等于请前端再实现一遍"哪些来路不许删"的规则，而那条规则的唯一
     * 权威在 daemon（它才是真正执行 `fs.rm` 的那一个）——两处各写一份必然漂移。
     *
     * ⚠️ 它与 `isLoadBearingPack()` 是**两条轴**，不许合并：
     * 那条说的是「删了会让推理进程 SIGABRT」（ADR-003 附录 A.3），
     * 这条说的是「这些字节根本不在数据目录里」。理由不同 ⇒ 对用户说的话也不同。
     *
     * ## **可选**：缺失 ≠ 否
     *
     * 老 daemon 不发这个字段。缺失时客户端**不许**替它渲染成"可以卸载" ——
     * 那不是它说过的话；正确的行为是保持老样子，真点下去仍由服务端那道闸门兜底。
     */
    bundledWithApp?: boolean;
  })[];
}

export interface GetInstalledBackendsResponse {
  packs: InstalledBackendPack[];
  selectedBackend: Backend;
}

/* ------------------------------ hardware --------------------------------- */

/**
 * `GET /api/runtime/hardware` 里**除硬件本身之外**的诊断字段（T-174）。
 *
 * ★ 为什么它现在才出现在契约里：daemon 从 T-172 起就一直在发这个 `runtime` 对象，
 * 但前端把响应断言成不含它的 `GetHardwareResponse`，**字段在类型边界上就被丢掉了** ——
 * 全仓对 `breaker` / `blacklistedBackends` / `degradationChain` 的前端引用数曾是 **0**。
 * 于是断路器跳闸时用户只看到"GPU 加速就是不工作"，唯一的解释躺在他不会去看的自检页里。
 *
 * 这里**故意比 daemon 侧的 `RuntimeDiagnostics` 窄**：只收录前端真的要用的字段。
 * daemon 那个类型 `extends` 本接口所在的响应，多出来的字段（`paths` 等）结构上照样通过，
 * 但契约不为它们背书 —— 契约只承诺"前端读得到的这些"。
 */
export interface HardwareRuntimeDiagnostics {
  /** 探针诊断。前端只用 `timeoutMs`：手动重试的等待上限要按 daemon 自己报的预算显示，不许前端硬编一个 10 秒。 */
  readonly probe: { readonly timeoutMs: number };
  readonly breaker: {
    readonly consecutiveFailures: number;
    readonly threshold: number;
    readonly open: boolean;
    readonly lastError: string | null;
    /** 三态裁决，见 `BreakerVerdict`。 */
    readonly verdict: string;
    /** 冷却到期时刻（ISO）。null = 没跳闸。**跳闸了它就不可能是 null**。 */
    readonly retryAt: string | null;
    readonly recovering: boolean;
    /** 正在跑的那一发恢复探测的起跑时刻（ISO）；没在跑就是 null。 */
    readonly recoveryStartedAt: string | null;
    /** 恢复那一发的预算（ms）。**发出来就是为了让界面别硬编那个 90。** */
    readonly recoveryTimeoutMs: number;
  };
  /** 断路器停用的后端（cpu 永不入列）。 */
  readonly blacklistedBackends: Backend[];
  /**
   * **advisory 探测**（nvidia-smi / sysfs DRM / `Get-CimInstance Win32_VideoController`）
   * 认为本机可能支持的后端 —— 取所有探到的显示适配器的 `candidateBackends` 并集。
   *
   * ## 为什么前端需要它（T-195）
   *
   * 「这台机器有没有 GPU」和「我们枚举到了 GPU 吗」是**两个问题**，而
   * `HardwareInfo.gpus` 只回答后者：它**完全由 probe 的枚举结果构造**
   * （`buildHardwareInfo`），而 probe 只能通过**已经装好的那一个后端包目录**里的
   * ggml 库去枚举。没装 GPU 后端包 ⇒ 没有库可加载 ⇒ `gpus: []` ——
   * 这与"这台机器没有显卡"是完全不同的两件事，而界面此前把它们说成同一句话。
   *
   * advisory 是**唯一不依赖"包已经装了"的证据**：它直接问操作系统要显示适配器清单。
   * 有了它，界面才说得出第三种状态：**「系统说你有一块能跑 Vulkan 的卡，
   * 但我们这轮没有加载任何能枚举它的后端」**。
   *
   * ⚠️ 它**不是**"这个后端能用"的结论 —— 那只能来自 probe。
   * **空数组的含义是"没有独立证据"，不是"本机没有 GPU"**（powershell 失败、
   * `/sys/class/drm` 读不到，都会让它是空的）。这一点必须在渲染时体现出来。
   */
  readonly advisoryBackends?: Backend[];
  /**
   * advisory **逐块看见的**显示适配器。**可选**（老 daemon 不发）。
   *
   * ⚠️ 它与 `HardwareInfo.gpus` **不是同一件事，也不许被当成同一件事用**：
   * 那个是 probe 真枚举到、可以拿来算显存与后端可用性的设备；这个只是
   * 「操作系统说这台机器上插着什么」。**只用来说话，不参与任何判定。**
   * （`detect/gpu.ts` 抬头有两个实测反例：库在但无 GPU；lavapipe 报一个 CPU 设备。）
   */
  readonly advisoryGpus?: readonly {
    readonly name: string;
    readonly vendor: string;
    /**
     * ★ #86：这块适配器**能不能拿来做 GPU 加速**的结论 —— 三态。
     *
     * 这里原本是 `candidateBackends: readonly Backend[]`（两态：有 = 可能支持，
     * 空 = 不支持），于是**虚拟机里的显示适配器只能被说成「可能支持 Vulkan」** ——
     * `[CI 实测 run 31389910051]` `Microsoft Hyper-V Video` 就是这么被说的
     * （v0.7.1 已知边界第 7 条）。
     *
     * 而它**不能被翻成"不支持"**：本仓两台 macOS runner 的 GPU 都是虚拟适配器
     * `Apple Paravirtual device`，Metal 在上面**实测能跑**；何况 probe 是唯一权威，
     * 而 probe 要先装包才能跑，说"不支持"会连求证的路一起断掉。
     *
     * 所以是三态。**渲染方必须分别对待，不许 `?? []` 折回两态**：
     * `undetermined` 时要说的是"我们判断不了"，不是"可能支持"，也不是"没有显卡"。
     */
    readonly verdict?: AdvisoryGpuVerdict;
    readonly source: string;
  }[];
}

export interface GetHardwareResponse {
  hardware: HardwareInfo;
  snapshotId: string;
  /**
   * **可选**：`/api/runtime/hardware` 带它，而 `models.ts` 里那条同名兜底路由不带
   * （那条路由拿不到 `AppPaths`，凑不出断路器状态）。前端必须按"可能没有"处理，
   * 不能假设它一定在 —— 假设它一定在，兜底路由生效时就是一个白屏。
   */
  runtime?: HardwareRuntimeDiagnostics;
}

/**
 * `GET /api/runtime/breaker` —— **纯观测**的断路器状态。
 *
 * ★ 为什么运行时页读这个而不是复用上面那个 `runtime.breaker`：
 * `/api/runtime/hardware` 的 daemon 侧**带进程内缓存**（探测要 spawn，不能每请求跑一遍），
 * 所以它的 `retryAt` / `recovering` 是**拍快照那一刻**的值。拿它做倒计时会一路数到负数，
 * 然后永远停在"冷却已到期"上 —— 一个一直在说谎的倒计时比不显示更糟。
 * 本端点每次都读进程内的实时 state，且**不跑探测、不起恢复、不改任何状态**。
 */
export interface GetBreakerResponse {
  readonly backendDir: string;
  readonly breaker: {
    readonly consecutiveFailures: number;
    readonly blacklistedAt: string | null;
    readonly lastError: string | null;
    readonly retryAt: string | null;
  };
  readonly open: boolean;
  readonly threshold: number;
  readonly blacklistedBackends: Backend[];
  readonly verdict: string;
  readonly retryAt: string | null;
  readonly recovering: boolean;
  /**
   * 正在跑的那一发恢复探测的**起跑时刻**（ISO）；没在跑就是 null。
   *
   * ★ 界面拿它算"已经等了多久"。**记在服务端而不是前端**：那一发最长 90 s，
   * 用户完全可能切走再回来（或者本来就在另一个标签页）。进度记在前端就会归零重数 ——
   * 那是编一个进度出来，而不是报告一个进度。
   */
  readonly recoveryStartedAt: string | null;
  /** 恢复那一发的预算（ms）= `PROBE_RECOVERY_TIMEOUT_MS`。界面显示"最长约 N 秒"用它。 */
  readonly recoveryTimeoutMs: number;
}

/* ------------------------------ errors ----------------------------------- */

/**
 * Error envelope.
 *
 * Shape is `{error:{code,message,messageZh,retryable,remediation}}` — deliberately not
 * RFC 9457, because the client keys off `code` and needs `remediation` as a first-class
 * field rather than an extension member.
 *
 * Copy policy (ADR-007 decision 3): the frontend looks `code` up in its own message table
 * first and falls back to `messageZh`/`message`. The server strings exist so a code the
 * frontend has never seen still renders something useful.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    messageZh: string;
    retryable: boolean;
    /**
     * Machine-readable corrective action (ADR-007 decision 2).
     *
     * This field is what makes charter requirement 2.1 — "the user never touches a
     * command line" — actually achievable. An error without it leaves the user with
     * prose they cannot act on; with it the UI renders a button that fixes the problem
     * ("Install the CUDA backend", "Free up disk", "Switch download source").
     */
    remediation?: Remediation | null;
    details?: unknown;
  };
}

/**
 * Endpoint table. Kept as data so the OpenAPI document, the daemon router and the
 * frontend client can be checked against one list rather than drifting apart.
 */
export const ENDPOINTS = [
  { method: 'GET', path: '/api/models/catalog', name: 'getCatalog' },
  { method: 'GET', path: '/api/models/installed', name: 'getInstalled' },
  { method: 'GET', path: '/api/models/:id', name: 'getModel' },
  { method: 'POST', path: '/api/models/pull', name: 'pullModel' },
  { method: 'DELETE', path: '/api/models/:id', name: 'deleteModel' },
  { method: 'POST', path: '/api/models/activate', name: 'activateModel' },
  { method: 'GET', path: '/api/models/active', name: 'getActive' },
  { method: 'POST', path: '/api/models/verify', name: 'verifyModel' },
  { method: 'POST', path: '/api/models/import', name: 'importModel' },
  { method: 'GET', path: '/api/models/storage', name: 'getStorage' },
  { method: 'POST', path: '/api/models/gc', name: 'runGc' },
  { method: 'GET', path: '/api/models/sources', name: 'getSources' },
  { method: 'POST', path: '/api/models/sources/probe', name: 'probeSources' },
  { method: 'POST', path: '/api/models/sources/select', name: 'selectSource' },
  { method: 'GET', path: '/api/jobs', name: 'getJobs' },
  { method: 'GET', path: '/api/jobs/:jobId', name: 'getJob' },
  { method: 'POST', path: '/api/jobs/:jobId/cancel', name: 'cancelJob' },
  { method: 'POST', path: '/api/jobs/:jobId/retry', name: 'retryJob' },
  { method: 'POST', path: '/api/jobs/:jobId/pause', name: 'pauseJob' },
  { method: 'POST', path: '/api/jobs/:jobId/resume', name: 'resumeJob' },
  { method: 'GET', path: '/api/backends/catalog', name: 'getBackendCatalog' },
  { method: 'GET', path: '/api/backends/installed', name: 'getInstalledBackends' },
  { method: 'POST', path: '/api/backends/install', name: 'installBackend' },
  { method: 'DELETE', path: '/api/backends/:id', name: 'removeBackend' },
  { method: 'POST', path: '/api/backends/select', name: 'selectBackend' },
  { method: 'GET', path: '/api/runtime/hardware', name: 'getHardware' },
  /*
   * T-153 —— ADR-003 档 2（复用已装的本地 LLM）与 D-10 #26 的「刷新模型列表」。
   * 这两条此前**只有契约的名字、没有实现**：`detectLocalBackends()` 只在
   * mindmap runner 与 selfcheck 内部被调用，前端够不着；`/api/llm/models` 全仓不存在，
   * 于是「刷新模型列表」按钮**做出来也按不动**（frontend-truth T-150 §7 因此没做它）。
   * 响应形状见 `./llm.js` 的 `LlmDetectResponse` / `LlmModelsResponse`。
   */
  { method: 'POST', path: '/api/llm/detect', name: 'detectLocalLlm' },
  { method: 'POST', path: '/api/llm/models', name: 'listProviderModels' },
  { method: 'GET', path: '/api/events', name: 'events' },
] as const;
