/**
 * Download/install job model, state machine and error codes.
 *
 * Shared by model downloads AND backend-pack downloads (ADR-003 decision 6) —
 * `DownloadJob.kind` is what distinguishes them, everything else is identical.
 */

/**
 * Job lifecycle.
 *
 *   queued → resolving → downloading → verifying → installing → done
 *                            ↕ paused
 *                            ↓ cancelled            ↓ failed (retryable → resolving)
 *
 * `verifying` is a first-class state, not an afterthought: nothing is installed until
 * its SHA-256 matches (GPT4All's model, the only one of nine surveyed apps that gets
 * this right). Ollama's download.go has no checksum step at all — we do not inherit that.
 */
export const JOB_STATES = [
  'queued',
  'resolving',
  'downloading',
  'verifying',
  'installing',
  'done',
  'failed',
  'cancelled',
  'paused',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES: readonly JobState[] = ['done', 'failed', 'cancelled'];

export const JOB_KINDS = ['model', 'backend-pack'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Legal state transitions. Exported so the daemon and tests share one source of truth. */
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['resolving', 'cancelled'],
  resolving: ['downloading', 'failed', 'cancelled'],
  downloading: ['verifying', 'paused', 'failed', 'cancelled'],
  verifying: ['installing', 'resolving', 'failed', 'cancelled'],
  installing: ['done', 'failed'],
  paused: ['resolving', 'downloading', 'cancelled'],
  done: [],
  failed: ['resolving'],
  cancelled: ['resolving'],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
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

export interface JobError {
  code: ErrorCode;
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
  jobId: string;
  kind: JobKind;
  /** Model id or backend-pack id. */
  targetId: string;
  displayName: string;
  state: JobState;
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
