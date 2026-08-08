/**
 * Download/install job model, state machine and error codes.
 *
 * Shared by model downloads AND backend-pack downloads (ADR-003 decision 6) —
 * `DownloadJob.kind` is what distinguishes them, everything else is identical.
 */

/**
 * Coarse job lifecycle.
 *
 * ALIGNED WITH D-02 §1.7 `jobs.state` (ADR-006 decision 5). An earlier draft of this file
 * used a download-specific vocabulary (`resolving`/`downloading`/`installing`/`done`)
 * that collided with the generic job table. Rather than maintain two vocabularies and a
 * lossy translation between them, the coarse lifecycle now matches D-02 exactly, and the
 * download-specific detail moved to `JobStep` below (D-02 `jobs.current_step`).
 *
 *   queued → leased → running → succeeded
 *              ↓        ↕ paused
 *           blocked     ↓ failed / cancelled
 */
export const JOB_STATES = [
  'queued',
  'blocked',
  'leased',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES: readonly JobState[] = ['succeeded', 'failed', 'cancelled'];

/**
 * Fine-grained step within `state === 'running'`. Persisted to D-02 `jobs.current_step`.
 *
 * `verifying` is a first-class step, not an afterthought: nothing is installed until its
 * SHA-256 matches (GPT4All's model — the only one of nine apps surveyed in R-04 that gets
 * this right). Ollama's download.go has no checksum step at all; ADR-004 decision 5
 * requires we not inherit that gap.
 */
/*
 * ★ T-172：`warming` 是装完之后的最后一步 —— macOS 上把 Metal 着色器缓存捂热。
 * 它必须**看得见**：实测这一步要 16 s 上下（真机 UNKNOWN），进度条上不说一句话，
 * 用户只会以为卡死了。只有 macOS 会出现这个步骤，其余平台直接从 `installing` 收尾。
 */
export const JOB_STEPS = [
  'resolving',
  'downloading',
  'verifying',
  'installing',
  'warming',
] as const;
export type JobStep = (typeof JOB_STEPS)[number];

export const JOB_KINDS = ['model', 'backend-pack'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Legal transitions. Exported so the daemon, the queue and tests share one source of truth. */
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['leased', 'running', 'blocked', 'cancelled'],
  blocked: ['queued', 'cancelled', 'failed'],
  leased: ['running', 'failed', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'paused', 'blocked'],
  paused: ['queued', 'running', 'cancelled'],
  succeeded: [],
  // Retry re-queues rather than jumping straight back into running.
  failed: ['queued'],
  cancelled: ['queued'],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** D-02 `jobs.type` values this package produces. */
export const DOWNLOAD_JOB_TYPES = ['download.model', 'download.backend'] as const;
export type DownloadJobType = (typeof DOWNLOAD_JOB_TYPES)[number];

export function jobTypeForKind(kind: JobKind): DownloadJobType {
  return kind === 'model' ? 'download.model' : 'download.backend';
}

/**
 * Error codes. `retryable` drives whether the downloader auto-retries and what the UI
 * offers the user.
 */
export const ERROR_CODES = [
  'NETWORK_TIMEOUT',
  'CONNECTION_RESET',
  'CHECKSUM_MISMATCH',
  'SIZE_MISMATCH',
  'DISK_FULL',
  'GATED_REPO',
  'RATE_LIMITED',
  'PROVIDER_UNREACHABLE',
  'INTEGRITY_ALL_SOURCES_FAILED',
  'RANGE_NOT_SUPPORTED',
  'CANCELLED',
  'UNPACK_FAILED',
  'PERMISSION_DENIED',
  'MODEL_IN_USE',
  'NOT_FOUND',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes emitted by the pipeline/job system rather than the downloader.
 *
 * The daemon already blocks jobs with these (`queue.block(id, 'MISSING_ASR_MODEL', …)`)
 * and the web app already has localized copy for them.
 */
export const PIPELINE_ERROR_CODES = [
  'MISSING_ASR_MODEL',
  'MISSING_LLM',
  'MISSING_BACKEND',
  'RESOURCE_DISK_FULL',
  'MISSING_API_KEY',
] as const;
export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[number];

export interface JobError {
  /**
   * Stable code the UI looks up for copy and remediation.
   *
   * Deliberately NOT closed to `ErrorCode`: that enum is download-specific, but `JobError`
   * is used by every job type, and pipeline jobs fail for reasons downloads never do
   * (no ASR model, no API key). Closing it here forced casts at every pipeline call site
   * and broke the build. The union keeps autocomplete for known codes while letting a
   * domain add its own without editing this file — new failure modes should not require a
   * change to a shared contract before they can be reported.
   */
  code: ErrorCode | PipelineErrorCode | (string & {});
  message: string;
  messageZh: string;
  retryable: boolean;
  /** Provider that produced the error, when applicable. */
  provider?: string;
}

export const ERROR_RETRYABLE: Record<ErrorCode, boolean> = {
  NETWORK_TIMEOUT: true,
  CONNECTION_RESET: true,
  // Retryable but only by switching mirrors — the current source served bad bytes.
  CHECKSUM_MISMATCH: true,
  SIZE_MISMATCH: true,
  DISK_FULL: false,
  GATED_REPO: false,
  RATE_LIMITED: true,
  PROVIDER_UNREACHABLE: true,
  INTEGRITY_ALL_SOURCES_FAILED: false,
  // Not retryable as-is; the downloader falls back to a single-stream download.
  RANGE_NOT_SUPPORTED: false,
  CANCELLED: false,
  UNPACK_FAILED: false,
  PERMISSION_DENIED: false,
  MODEL_IN_USE: false,
  NOT_FOUND: false,
  INTERNAL: false,
};

export const ERROR_MESSAGES_ZH: Record<ErrorCode, string> = {
  NETWORK_TIMEOUT: '网络超时',
  CONNECTION_RESET: '连接被重置',
  CHECKSUM_MISMATCH: '文件校验失败（内容与预期不符）',
  SIZE_MISMATCH: '文件大小与预期不符',
  DISK_FULL: '磁盘空间不足',
  GATED_REPO: '该模型需要登录并同意上游许可后才能下载',
  RATE_LIMITED: '下载源限流，请稍后重试',
  PROVIDER_UNREACHABLE: '下载源无法访问',
  INTEGRITY_ALL_SOURCES_FAILED: '所有下载源均失败',
  RANGE_NOT_SUPPORTED: '下载源不支持断点续传',
  CANCELLED: '已取消',
  UNPACK_FAILED: '解压失败',
  PERMISSION_DENIED: '没有写入权限',
  MODEL_IN_USE: '模型正在使用中，请先切换',
  NOT_FOUND: '未找到',
  INTERNAL: '内部错误',
};

/** Per-part progress, mirrored from the on-disk resume sidecar. */
export interface JobPart {
  index: number;
  start: number;
  end: number;
  completed: number;
}

export interface DownloadJob {
  /**
   * ULID. This is D-02 `jobs.uid` — the ONLY job identifier the API exposes.
   * The integer `jobs.id` primary key never leaves the daemon (ADR-006 decision 5:
   * FTS5 `content_rowid` and sqlite-vec both require integer rowids).
   */
  jobId: string;
  kind: JobKind;
  /** D-02 `jobs.type`. */
  type: DownloadJobType;
  /**
   * Catalog slug, e.g. "asr/whisper-large-v3-turbo-q5_0".
   * Deliberately NOT a ULID: it is a stable content identifier that must be identical
   * across machines and across reinstalls, and it is what D-02 `model_installs.model_id`
   * stores ("与 manifests/<role>/<id>.json 的 id 一致").
   */
  targetId: string;
  displayName: string;
  state: JobState;
  /** Fine-grained step; meaningful while state === 'running'. */
  step: JobStep | null;
  /** Provider currently in use; null before resolution. */
  provider: string | null;

  totalBytes: number;
  /**
   * Always present, even when zero.
   *
   * Ollama's API docs warn that `completed` "may not be included" until some data
   * arrives, which forces every client to handle undefined. We normalise server-side.
   */
  completedBytes: number;
  speedBps: number;
  etaSeconds: number | null;

  parts: JobPart[];
  currentFile: string | null;
  fileIndex: number;
  fileCount: number;

  attempt: number;
  maxAttempts: number;
  error: JobError | null;

  startedAt: string;
  updatedAt: string;
}

/* ------------------------------ pipeline jobs ----------------------------- */

/**
 * Pipeline job kinds. Doubles as the discriminant against {@link DownloadJob}
 * (`'model' | 'backend-pack'`), so the two literal unions must stay disjoint.
 *
 * Deliberately NOT added to `JOB_KINDS`: that constant means "kinds of download", and
 * every exhaustive switch over it (mirror selection, byte accounting, resume sidecars)
 * would become wrong the moment a transcribe job could appear in it.
 */
export const PIPELINE_JOB_KINDS = ['transcribe', 'mindmap'] as const;
export type PipelineJobKind = (typeof PIPELINE_JOB_KINDS)[number];

/**
 * A transcription / mindmap job, as the API and the SSE stream expose it.
 *
 * ## Why this type has to exist (T-130)
 *
 * `JobCreatedEvent.job` used to be `DownloadJob`, which is modelled for downloads:
 * `totalBytes`, `parts[]`, `fileIndex`, `provider`, a catalog-slug `targetId`. A
 * transcribe job has none of those. The daemon therefore — correctly — refused to fake
 * one and emitted **no `job.created` at all** for pipeline jobs
 * (`apps/daemon/src/jobs/events.ts` documents the decision).
 *
 * The client's job toaster, equally correctly, refuses to materialise a toast for a job
 * id it has never been introduced to (otherwise every reconnect replays historical jobs
 * as fresh toasts).
 *
 * Both decisions are right; together they meant **every state a pipeline job can reach —
 * `blocked` above all — was unreachable on screen**. Measured: importing media with no
 * ASR model installed returned 202, left the note at `processing`, and put not one word
 * on the page. The fix is not to relax either rule, it is to give a pipeline job an
 * honest shape to be introduced with.
 *
 * Everything here is a field the daemon actually has (D-02 §1.7 `jobs`). Byte counters,
 * parts and provider are **absent rather than zeroed** — a zero would render as
 * "0 B / 0 B" and read like a stalled download.
 */
export interface PipelineJob {
  /** D-02 `jobs.uid` (ULID). Same identifier space as `DownloadJob.jobId`. */
  jobId: string;
  /** Discriminant against `DownloadJob.kind`. */
  kind: PipelineJobKind;
  /** D-02 `jobs.type`, verbatim (`'transcribe' | 'mindmap'`). */
  type: string;
  /** What the user calls this thing — the note's title. Never the internal uid. */
  displayName: string;
  /** Owning note, so the UI can offer "open the note" without a lookup table. */
  noteUid: string | null;
  state: JobState;
  /**
   * D-02 `jobs.current_step`, e.g. "fetch" | "demux" | "vad" | "asr" | "structure".
   * Free-form on purpose: pipeline steps are owned by `packages/pipeline` and adding one
   * must not require editing a shared enum first.
   */
  step: string | null;
  /** 0..1. The only progress a compute job can honestly report. */
  progress: number;
  attempt: number;
  maxAttempts: number;
  error: JobError | null;
  /** D-02 `jobs.blocked_code`; non-null exactly when `state === 'blocked'`. */
  blockedCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Anything the job APIs and `job.*` events can carry. */
export type AnyJob = DownloadJob | PipelineJob;

export function isPipelineJob(job: AnyJob): job is PipelineJob {
  return (PIPELINE_JOB_KINDS as readonly string[]).includes(job.kind);
}

export function isDownloadJob(job: AnyJob): job is DownloadJob {
  return !isPipelineJob(job);
}
