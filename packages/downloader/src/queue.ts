/**
 * Job queue and lifecycle.
 *
 * Structure follows ComfyUI-Manager's model (FIFO queue drained by a bounded worker
 * pool, fire-and-forget enqueue returning immediately), with two corrections:
 *   - it runs a single worker thread, so a queued install waits behind an unrelated one;
 *     we allow a small configurable degree of parallelism
 *   - it has no cancel/retry/pause; we do
 *
 * Global concurrency defaults to 2. More parallel large downloads simply split the same
 * bandwidth, make every ETA wrong, and give the user a worse experience than finishing
 * one at a time. Per-file part parallelism (4) is a separate, orthogonal knob.
 */

import { EventEmitter } from 'node:events';
import type { DownloadJob, ErrorCode, JobState, JobStep } from '@openmemo/shared';
import {
  ERROR_MESSAGES_ZH,
  ERROR_RETRYABLE,
  TERMINAL_JOB_STATES,
  canTransition,
  jobTypeForKind,
  ulid,
} from '@openmemo/shared';

export interface QueueTaskContext {
  jobId: string;
  signal: AbortSignal;
  /** Report byte progress; throttling happens downstream. */
  progress: (p: {
    completedBytes: number;
    totalBytes: number;
    speedBps: number;
    etaSeconds: number | null;
  }) => void;
  /** Move the coarse lifecycle state (D-02 `jobs.state`). */
  setState: (s: JobState) => void;
  /** Set the fine-grained step (D-02 `jobs.current_step`), e.g. 'verifying'. */
  setStep: (s: JobStep) => void;
  setProvider: (p: string) => void;
  setFile: (name: string, index: number, count: number) => void;
}

export type QueueTask = (ctx: QueueTaskContext) => Promise<void>;

export interface EnqueueOptions {
  kind: 'model' | 'backend-pack';
  targetId: string;
  displayName: string;
  totalBytes: number;
  maxAttempts?: number;
}

interface Entry {
  job: DownloadJob;
  task: QueueTask;
  controller: AbortController;
  /** Resolved once the job reaches a terminal state. */
  done: Promise<void>;
  resolveDone: () => void;
}

/**
 * Events emitted by {@link DownloadQueue}, as a payload map.
 * Passed to EventEmitter's generic parameter so `on`/`emit` are type-checked without
 * class/interface declaration merging (which eslint flags as unsafe, correctly — merging
 * would let the declared signatures silently diverge from the implementation).
 */
export interface DownloadQueueEvents {
  'job.created': [DownloadJob];
  'job.progress': [DownloadJob];
  'job.state': [DownloadJob, JobState];
  'job.failed': [DownloadJob];
  'job.done': [DownloadJob];
  [k: string]: unknown[];
}

export class DownloadQueue extends EventEmitter<DownloadQueueEvents> {
  private entries = new Map<string, Entry>();
  private waiting: string[] = [];
  private running = new Set<string>();

  constructor(public concurrency = 2) {
    super();
  }

  list(): DownloadJob[] {
    return [...this.entries.values()].map((e) => e.job);
  }

  get(jobId: string): DownloadJob | null {
    return this.entries.get(jobId)?.job ?? null;
  }

  /**
   * Find an active job for a target.
   * Used for idempotent enqueue: Ollama documents that concurrent pulls of the same model
   * "share the same download progress", and duplicating a multi-GB transfer because the
   * user double-clicked would be indefensible.
   */
  findActiveByTarget(targetId: string): DownloadJob | null {
    for (const e of this.entries.values()) {
      if (e.job.targetId === targetId && !TERMINAL_JOB_STATES.includes(e.job.state)) {
        return e.job;
      }
    }
    return null;
  }

  enqueue(opts: EnqueueOptions, task: QueueTask): { job: DownloadJob; deduplicated: boolean } {
    const existing = this.findActiveByTarget(opts.targetId);
    if (existing) return { job: existing, deduplicated: true };

    const now = new Date().toISOString();
    const job: DownloadJob = {
      // ULID, not a random hex string: this is D-02 `jobs.uid`, and its embedded
      // timestamp makes the job list sort by creation order with no extra column.
      jobId: ulid(),
      kind: opts.kind,
      type: jobTypeForKind(opts.kind),
      targetId: opts.targetId,
      displayName: opts.displayName,
      state: 'queued',
      step: null,
      provider: null,
      totalBytes: opts.totalBytes,
      completedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      parts: [],
      currentFile: null,
      fileIndex: 0,
      fileCount: 1,
      attempt: 1,
      maxAttempts: opts.maxAttempts ?? 3,
      error: null,
      startedAt: now,
      updatedAt: now,
    };

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    this.entries.set(job.jobId, {
      job,
      task,
      controller: new AbortController(),
      done,
      resolveDone,
    });
    this.waiting.push(job.jobId);
    this.emit('job.created', job);
    queueMicrotask(() => this.pump());
    return { job, deduplicated: false };
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const entry = this.entries.get(id);
      if (!entry || entry.job.state === 'cancelled') continue;
      this.running.add(id);
      void this.run(entry);
    }
  }

  private async run(entry: Entry): Promise<void> {
    const { job } = entry;
    this.transition(job, 'running');
    job.step = 'resolving';

    const ctx: QueueTaskContext = {
      jobId: job.jobId,
      signal: entry.controller.signal,
      progress: (p) => {
        job.completedBytes = p.completedBytes;
        job.totalBytes = p.totalBytes || job.totalBytes;
        job.speedBps = p.speedBps;
        job.etaSeconds = p.etaSeconds;
        job.updatedAt = new Date().toISOString();
        this.emit('job.progress', job);
      },
      setState: (s) => this.transition(job, s),
      setStep: (s) => {
        job.step = s;
        job.updatedAt = new Date().toISOString();
      },
      setProvider: (p) => {
        job.provider = p;
      },
      setFile: (name, index, count) => {
        job.currentFile = name;
        job.fileIndex = index;
        job.fileCount = count;
      },
    };

    try {
      await entry.task(ctx);
      job.step = null;
      this.transition(job, 'succeeded');
      this.emit('job.done', job);
    } catch (e) {
      if (entry.controller.signal.aborted && job.state !== 'failed') {
        this.forceState(job, 'cancelled');
      } else {
        const err = e as { code?: string; message?: string; retryable?: boolean };
        const code = (err.code ?? 'INTERNAL') as NonNullable<DownloadJob['error']>['code'];
        const detail = err.message ?? String(e);
        /*
         * ★ `messageZh` 以前就是 `err.message` —— 也就是**把英文原样当成中文交出去**。
         *
         * 这不是"少翻译了一句"：`JobList.tsx:115` 是
         * `i18n.language.startsWith('zh') ? job.error.messageZh : job.error.message`，
         * 两个分支读的是同一个英文串。中文用户下载模型失败时看到的是
         * `All download sources failed` / `Access denied (403)` / `Disk full`。
         *
         * 而 `ERROR_MESSAGES_ZH` 这 16 条中文**从写下那天起就是零调用方** ——
         * 一份没有调用方的文案不会被任何东西证伪（与 T-151 那份"全仓零 import 的契约"同一形状）。
         *
         * `INTERNAL` 是刻意的例外：它的字面意思是"我不知道发生了什么"，
         * 这时 `detail` 就是**唯一**的信息，翻成"内部错误"是把仅有的线索换成一句废话。
         * 未登记的码同理走 detail。英文 `message` 一律保留原样，诊断信息不丢。
         */
        const zh = ERROR_MESSAGES_ZH[code as ErrorCode];
        job.error = {
          code,
          message: detail,
          messageZh: zh && code !== 'INTERNAL' ? zh : detail,
          // 抛出方没说 retryable 时，按码本查 —— 而不是一律当成"不可重试"。
          // 说错了的后果是可重试的失败（超时/限流/换源可救的校验失败）拿不到重试入口。
          retryable: err.retryable ?? ERROR_RETRYABLE[code as ErrorCode] ?? false,
        };
        this.forceState(job, 'failed');
        this.emit('job.failed', job);
      }
    } finally {
      this.running.delete(job.jobId);
      entry.resolveDone();
      this.pump();
    }
  }

  private transition(job: DownloadJob, to: JobState): void {
    if (job.state === to) return;
    if (!canTransition(job.state, to)) {
      // Illegal transitions indicate a logic bug; surface rather than silently allow.
      throw new Error(`Illegal job transition ${job.state} -> ${to}`);
    }
    this.forceState(job, to);
  }

  private forceState(job: DownloadJob, to: JobState): void {
    const prev = job.state;
    job.state = to;
    job.updatedAt = new Date().toISOString();
    this.emit('job.state', job, prev);
  }

  /** Cancel a job. The `.partial` file is kept so it can be resumed later. */
  cancel(jobId: string): boolean {
    const e = this.entries.get(jobId);
    if (!e) return false;
    if (TERMINAL_JOB_STATES.includes(e.job.state)) return false;
    e.controller.abort();
    const idx = this.waiting.indexOf(jobId);
    if (idx >= 0) {
      this.waiting.splice(idx, 1);
      this.forceState(e.job, 'cancelled');
      e.resolveDone();
    }
    return true;
  }

  /** Re-run a failed or cancelled job; resume state on disk makes this cheap. */
  retry(jobId: string): DownloadJob | null {
    const e = this.entries.get(jobId);
    if (!e) return null;
    if (!['failed', 'cancelled'].includes(e.job.state)) return null;
    e.controller = new AbortController();
    e.job.attempt++;
    e.job.error = null;
    e.job.speedBps = 0;
    this.forceState(e.job, 'queued');
    this.waiting.push(jobId);
    queueMicrotask(() => this.pump());
    return e.job;
  }

  async waitFor(jobId: string): Promise<DownloadJob | null> {
    const e = this.entries.get(jobId);
    if (!e) return null;
    await e.done;
    return e.job;
  }

  /** Drop terminal jobs from memory (the UI keeps its own history). */
  prune(): number {
    let n = 0;
    for (const [id, e] of this.entries) {
      if (TERMINAL_JOB_STATES.includes(e.job.state)) {
        this.entries.delete(id);
        n++;
      }
    }
    return n;
  }
}
