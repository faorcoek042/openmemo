/**
 * 调度器：从持久化队列里取 job，占 lane，跑 runner。
 *
 * D-01 §4.2：**不设全局并发数**，按资源类别的 lane 信号量。
 * D-01 §4.6：lease + 续租，让"daemon 重启后判定这个 job 真的没人在跑"成立。
 */
import type { SseEvent } from '@openmemo/shared';
import { makeEvent, topics } from '@openmemo/shared';

import type { SseHub } from '../http/sse.js';
import { LanePool, type Lane } from './lanes.js';
import type { JobQueue, JobRow } from './queue.js';

export type JobHandler = (job: JobRow, signal: AbortSignal) => Promise<void>;

export interface SchedulerDeps {
  readonly queue: JobQueue;
  readonly lanes: LanePool;
  readonly sse: SseHub;
  /** job.type → handler。未注册的类型会被标 failed，而不是静默卡住。 */
  readonly handlers: ReadonlyMap<string, JobHandler>;
  readonly tickMs?: number;
  readonly leaseTtlMs?: number;
}

const ALL_LANES: Lane[] = [
  'net.download',
  'net.llm',
  'cpu.media',
  'gpu.asr',
  'gpu.llm',
  'io.local',
];

export class Scheduler {
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  readonly #running = new Map<number, AbortController>();

  constructor(private readonly deps: SchedulerDeps) {}

  get runningCount(): number {
    return this.#running.size;
  }

  start(): void {
    if (this.#timer) return;
    const tick = this.deps.tickMs ?? 250;
    this.#timer = setInterval(() => void this.#pump(), tick);
    this.#timer.unref?.();
  }

  async stop(graceMs = 5000): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    // 软停：置 abort，worker 在 chunk 边界退出并保留 checkpoint（D-01 §4.4）
    for (const ac of this.#running.values()) ac.abort();
    const deadline = Date.now() + graceMs;
    while (this.#running.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 取消一个 job（软取消：worker 在 chunk 边界停，已落库结果保留）。 */
  cancel(jobId: number, hard = false): void {
    this.deps.queue.requestCancel(jobId, hard);
    this.#running.get(jobId)?.abort();
  }

  async #pump(): Promise<void> {
    if (this.#stopped) return;
    // 每个 tick 只尝试领一个，避免一次把所有 lane 占满导致高优先级排不进来
    const lanesWithRoom = ALL_LANES.filter(
      (l) => this.deps.lanes.inUseOf(l) < this.deps.lanes.capacityOf(l),
    );
    if (lanesWithRoom.length === 0) return;

    const job = this.deps.queue.peekRunnable(lanesWithRoom);
    if (!job) return;

    const release = this.deps.lanes.tryAcquire(job.lane);
    if (!release) return; // lane 刚被别人抢走，下个 tick 再说

    if (!this.deps.queue.lease(job.id, this.deps.leaseTtlMs ?? 30_000)) {
      release();
      return; // 条件 UPDATE 失败 = 别人先领走了
    }

    void this.#execute(job, release);
  }

  async #execute(job: JobRow, release: () => void): Promise<void> {
    const { queue, sse, handlers } = this.deps;
    const ac = new AbortController();
    this.#running.set(job.id, ac);

    const renew = setInterval(() => queue.renewLease(job.id, this.deps.leaseTtlMs ?? 30_000), 10_000);
    renew.unref?.();

    try {
      queue.markRunning(job.id, process.pid);
      sse.publish(
        makeEvent('job.state', topics.job(job.uid), {
          jobUid: job.uid,
          state: 'running',
        } as never) as SseEvent,
      );

      const handler = handlers.get(job.type);
      if (!handler) {
        queue.fail(job.id, 'NO_HANDLER', `没有注册 job 类型 "${job.type}" 的处理器`, false);
        sse.publish(
          makeEvent('job.failed', topics.job(job.uid), {
            jobUid: job.uid,
            code: 'NO_HANDLER',
            messageZh: `未知任务类型：${job.type}`,
            retryable: false,
          } as never) as SseEvent,
        );
        return;
      }

      await handler(job, ac.signal);

      const after = queue.byId(job.id);
      // runner 可能已自行置终态（succeed/block），别覆盖
      if (after && (after.state === 'running' || after.state === 'leased')) {
        queue.succeed(job.id);
      }
      const final = queue.byId(job.id);
      if (final?.state === 'succeeded') {
        sse.publish(
          makeEvent('job.done', topics.job(job.uid), {
            jobUid: job.uid,
            result: final.result_json ? (JSON.parse(final.result_json) as unknown) : null,
          } as never) as SseEvent,
        );
      }
    } catch (err) {
      const aborted = ac.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      // 用户取消不算失败
      const state = aborted
        ? (queue.requestCancel(job.id), 'cancelled')
        : queue.fail(job.id, 'RUNNER_ERROR', message, isRetryable(err));
      sse.publish(
        makeEvent('job.failed', topics.job(job.uid), {
          jobUid: job.uid,
          code: aborted ? 'CANCELLED' : 'RUNNER_ERROR',
          messageZh: aborted ? '任务已取消' : `任务失败：${message}`,
          retryable: state === 'queued',
        } as never) as SseEvent,
      );
    } finally {
      clearInterval(renew);
      this.#running.delete(job.id);
      release();
    }
  }
}

/** 瞬时错误可重试；参数/格式类错误不重试（D-01 §4.7）。 */
function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EBUSY|socket hang up|timeout/i.test(msg)) return true;
  if (/not found|unsupported|invalid|forbidden|refused|guard/i.test(msg)) return false;
  return false;
}
