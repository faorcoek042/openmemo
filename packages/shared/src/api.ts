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
  };
}

export interface GcRequest {
  targets: ('orphan_blobs' | 'stale_partials')[];
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
  provider: ProviderId | 'auto';
  /** Base URL override, required when provider is "custom". */
  baseUrl?: string;
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
  })[];
}

export interface GetInstalledBackendsResponse {
  packs: InstalledBackendPack[];
  selectedBackend: Backend;
}

/* ------------------------------ hardware --------------------------------- */

export interface GetHardwareResponse {
  hardware: HardwareInfo;
  snapshotId: string;
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
