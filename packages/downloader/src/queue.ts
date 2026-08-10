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
      /*
       * ★ 同 download.ts 那条：floating promise 的 reject = unhandled rejection =
       *   **整个 daemon 退出**。`run()` 内部确实有 try/catch，但它**只包住
       *   `await entry.task(ctx)`** —— 在它之前的 `transition()` / ctx 构造
       *   一旦抛出，就从这里漏成未捕获。
       *   一个任务起不来，代价上限是**这个任务失败**，不是所有页面一起变砖。
       */
      void this.run(entry).catch((e: unknown) => {
        this.running.delete(id);
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[downloader] 任务 ${id} 在启动阶段就失败了（已隔离，daemon 继续）：${msg}`);
        try {
          entry.job.error = {
            code: 'INTERNAL',
            message: msg,
            messageZh: `任务启动失败：${msg}`,
            retryable: false,
          };
          this.forceState(entry.job, 'failed');
        } catch {
          /* 连记录失败状态都失败了也不许再往上抛 —— 这里是最后一道 */
        }
      });
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
        /*
         * ★★ **`installing` 此前一次都没推过。**
         *
         * `setStep()` 原来只改字段、不发任何事件；`step` 是搭在 `job.progress` 里
         * 顺路走的 —— **而安装阶段没有字节进度，所以没有车可搭**。
         * 于是界面上最后一条消息永远停在下载/校验那一步，用户看到的是"卡住了"。
         *
         * 现在**只在 step 真的变了的时候**发一条。只在变化时发很要紧：
         * `setStep()` 也被下载进度回调按帧调用（`models.ts` 的 onProgress 里），
         * 每次都发就会把节流白白打掉。
         */
        const changed = job.step !== s;
        job.step = s;
        job.updatedAt = new Date().toISOString();
        if (changed) this.emit('job.step', job);
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
      /*
       * ★ 取消守卫（T-198）。**残余工作跑完了，也不许把状态改回去。**
       *
       * `abort()` 在 `resolving` / `verifying` / `unpacking` / `installing` 这些阶段
       * 目前是空操作（那些代码不接 `ctx.signal`），所以任务会一路跑到成功。
       * 没有这道守卫的话，用户点了取消、`cancel()` 刚落下 `cancelled`，
       * 几秒后残余工作又把它改成 `succeeded` —— 一个"取消不掉"的取消。
       *
       * 这条守卫是"可中断性还没做完"期间的**正确兜底**，不是临时补丁：
       * 即便将来每个阶段都认 signal，它也应该留着 —— 竞态窗口永远存在。
       */
      if (job.state === 'cancelled') return;
      job.step = null;
      this.transition(job, 'succeeded');
      this.emit('job.done', job);
    } catch (e) {
      // 同上：`cancel()` 已经落过终态了，残余的报错不许覆盖它（也不该再发一次事件）
      if (job.state === 'cancelled') return;
      if (entry.controller.signal.aborted && job.state !== 'failed') {
        // 这一支是 abort 真的把底层工作打断了的情况；step 同样要清
        job.step = null;
        this.forceState(job, 'cancelled');
      } else {
        const err = e as {
          code?: string;
          message?: string;
          retryable?: boolean;
          messageZh?: string;
        };
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
          /*
           * ★ 抛出方给了 `messageZh` 就**优先用它**，码表退居兜底。
           *   码表保证"任何码都有中文"，但它是「一个码一句固定的话」——
           *   于是 `PROVIDER_UNREACHABLE` 永远只说「下载源无法访问」，
           *   把主机名、失败在哪一步、下一步能做什么**全盖掉了**
           *   （`[用户真机 2026-08-08]` 看到的就是这句 + 一个 `(1/3)`）。
           *   现场信息只有抛出方有，所以由它给；码表仍然兜住没人给文案的那些码。
           */
          messageZh: err.messageZh ?? (zh && code !== 'INTERNAL' ? zh : detail),
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

  /**
   * Cancel a job. The `.partial` file is kept so it can be resumed later.
   *
   * ## ★ T-198：终态**必须无条件落**，不能只落在"还排在队里"那一支
   *
   * 修之前是这样的：
   *
   * ```ts
   * const idx = this.waiting.indexOf(jobId);
   * if (idx >= 0) {                       // ← 只覆盖仍在 waiting 里的 queued 任务
   *   this.waiting.splice(idx, 1);
   *   this.forceState(e.job, 'cancelled');  // ← 终态在这个 if 里面
   *   e.resolveDone();
   * }
   * return true;                          // ← 但无论如何都 return true → HTTP 204「成功」
   * ```
   *
   * **正在跑的任务早就被 `pump()` 的 `shift()` 挪出 waiting 了**，于是 `idx === -1`，
   * 终态那一句根本不执行 —— 而端点照样回 204「取消成功」。
   * `[用户真机 Windows v0.7.0]` 取消 ffmpeg 下载后，任务中心同屏自相矛盾：
   * 「进行中 (1)」+ 0% + 「正在选择下载源」，紧挨着「任务不存在或已结束」。
   *
   * 两条不变量，缺一不可：
   *
   * 1. **只要这次 cancel 返回 true，任务就一定已经在 `cancelled` 上**
   *    —— 端点回 204 与"状态真的变了"必须是同一件事，不能一个真一个假。
   * 2. **底层工作打不打得断，与状态诚不诚实是两件事。**
   *    `abort()` 在 `resolving` / `verifying` / `installing` 这些阶段目前是空操作
   *    （见 `run()` 里的取消守卫），残余工作还会继续跑完；
   *    但它**不许把状态改回去**。所以终态在这里就落，守卫在那边挡。
   */
  cancel(jobId: string): boolean {
    const e = this.entries.get(jobId);
    if (!e) return false;
    if (TERMINAL_JOB_STATES.includes(e.job.state)) return false;

    e.controller.abort();
    const idx = this.waiting.indexOf(jobId);
    if (idx >= 0) this.waiting.splice(idx, 1);

    /*
     * ★ `step` 必须一起清（T-198 第 ③ 条）。
     *
     * 成功路径 `run()` 里是 `job.step = null` 之后才 transition，
     * 取消路径原来没有这一句 —— 于是「正在选择下载源」被冻在终态之后，
     * 用户看到一条"已取消"的任务还在"选择下载源"。
     * 状态和阶段是同一条消息的两半，只改一半就是自相矛盾。
     */
    e.job.step = null;
    this.forceState(e.job, 'cancelled');
    e.resolveDone();

    /*
     * ⚠️ 刻意**不**从 `this.running` 里摘掉，也不在这里 `pump()`：
     * 残余工作还在真的占着资源，摘掉它会让并发上限变成一句空话
     * （立刻放进来的下一个任务和这个还没停下的任务同时在跑）。
     * `run()` 的 `finally` 会在残余工作结束时正常收尾。
     */
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
