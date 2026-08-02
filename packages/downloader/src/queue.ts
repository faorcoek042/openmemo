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

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DownloadJob, JobState } from '@openmemo/shared';
import { canTransition } from '@openmemo/shared';

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
  /** Move the job to a new state, e.g. 'verifying'. */
  setState: (s: JobState) => void;
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

export declare interface DownloadQueue {
  on(e: 'job.created', l: (j: DownloadJob) => void): this;
  on(e: 'job.progress', l: (j: DownloadJob) => void): this;
  on(e: 'job.state', l: (j: DownloadJob, prev: JobState) => void): this;
  on(e: 'job.failed', l: (j: DownloadJob) => void): this;
  on(e: 'job.done', l: (j: DownloadJob) => void): this;
  on(e: string, l: (...a: never[]) => void): this;
}

export class DownloadQueue extends EventEmitter {
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
      if (
        e.job.targetId === targetId &&
        !['done', 'failed', 'cancelled'].includes(e.job.state)
      ) {
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
      jobId: `job_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      kind: opts.kind,
      targetId: opts.targetId,
      displayName: opts.displayName,
      state: 'queued',
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
    this.transition(job, 'resolving');

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
      this.transition(job, 'done');
      this.emit('job.done', job);
    } catch (e) {
      if (entry.controller.signal.aborted && job.state !== 'failed') {
        this.forceState(job, 'cancelled');
      } else {
        const err = e as { code?: string; message?: string; retryable?: boolean };
        job.error = {
          code: (err.code as DownloadJob['error'] extends null ? never : string) ?? 'INTERNAL',
          message: err.message ?? String(e),
          messageZh: err.message ?? String(e),
          retryable: err.retryable ?? false,
        } as DownloadJob['error'];
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
    if (['done', 'failed', 'cancelled'].includes(e.job.state)) return false;
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
      if (['done', 'failed', 'cancelled'].includes(e.job.state)) {
        this.entries.delete(id);
        n++;
      }
    }
    return n;
  }
}
