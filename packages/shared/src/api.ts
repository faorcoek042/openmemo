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

import type { BackendPack, InstalledBackendPack } from './backends.js';
import type { Backend, HardwareInfo } from './hardware.js';
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

export interface GetInstalledResponse {
  models: InstalledModel[];
  active: Record<ModelRole, string | null>;
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
     * 缺失时正确的行为是**什么档都不说**（只照抄 `inapplicableReason`），
     * 而不是默认成 `unsupported` —— 那会让界面替 daemon 说出一句它没说过的话。
     */
    inapplicableKind?: InapplicableKind;
    /** Why not applicable, when applicable=false. */
    inapplicableReason: string | null;
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
