/**
 * 调度器：从持久化队列里取 job，占 lane，跑 runner。
 *
 * D-01 §4.2：**不设全局并发数**，按资源类别的 lane 信号量。
 * D-01 §4.6：lease + 续租，让"daemon 重启后判定这个 job 真的没人在跑"成立。
 */
import { describeRunnerError } from './errorText.js';
import { jobDoneEvent, jobFailedEvent, jobStateEvent } from './events.js';

import type { SseHub } from '../http/sse.js';
import type { Lane } from './lanes.js';
import type { LanePool } from './lanes.js';
import type { JobQueue, JobRow } from './queue.js';

export type JobHandler = (job: JobRow, signal: AbortSignal) => Promise<void>;

/**
 * 中止一个在跑任务的**三种意图**。
 *
 * 此前三者共用一个裸 `AbortController`，worker 停下来后一律按"用户取消"处理，
 * 造成两个严重后果：
 *   - **暂停 = 不可逆取消**：`state='paused'` 没有任何写入方，`resume()` 的
 *     `WHERE state='paused'` 永远匹配 0 行，接口却回 204 告诉用户成功了。
 *   - **正常退出杀死在跑任务**：daemon 优雅关闭把在跑的标成 `cancelled`，
 *     而崩溃恢复只捞 `running`/`leased` → **正常关闭反而不如 `kill -9` 能恢复**。
 *
 * abort 信号本身分不出意图，所以意图必须单独记，且在 worker 真正停下后据此收口状态。
 */
export type StopIntent = 'cancel' | 'pause' | 'shutdown';

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
  /** jobId → 中止意图。只在中止时写入，worker 停下后读取并清除。 */
  readonly #intents = new Map<number, StopIntent>();

  constructor(private readonly deps: SchedulerDeps) {}

  get runningCount(): number {
    return this.#running.size;
  }

  start(): void {
    if (this.#timer) return;
    const tick = this.deps.tickMs ?? 250;
    /*
     * ★ `#pump()` 里**没有 try/catch**，而这里是 `void` 掉的 —— 它一旦 reject
     *   就是 unhandled rejection，Node 默认直接**退出进程**。
     *   而调度器每 250ms 跑一次、驱动所有任务：它把 daemon 带走的话，
     *   用户看到的是**所有页面同时失败**（"点按钮完全没反应"）。
     *
     *   同一形状 2026-08-08 在 `downloader` 里真的发作过一次
     *   （`writeSidecar` 的 ENOENT 挂在 `setInterval(() => void persist())` 上，
     *    `[CI 实测 run 31261593715, win32-x64]` daemon exitCode=1）。
     *   这里是**横扫时找到的同形第三处**，还没发作，先堵上。
     *
     *   代价上限：这一拍没调度成，250ms 后自然再来一次。
     */
    this.#timer = setInterval(() => {
      void this.#pump().catch((e: unknown) => {
        console.error(
          `[scheduler] 这一拍调度失败（已隔离，250ms 后重试，daemon 继续）：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      });
    }, tick);
    this.#timer.unref?.();
  }

  async stop(graceMs = 5000): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    // 软停：意图是**进程退出**，不是用户取消 —— 任务应被置回 queued，重启后自动续跑
    for (const [jobId, ac] of this.#running) {
      this.#intents.set(jobId, 'shutdown');
      ac.abort();
    }
    const deadline = Date.now() + graceMs;
    while (this.#running.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 取消一个 job（软取消：worker 在 chunk 边界停，已落库结果保留）。 */
  /** 用户取消：终态 `cancelled`，checkpoint 丢弃（已落库的段落仍保留）。 */
  cancel(jobId: number, hard = false): void {
    this.deps.queue.requestCancel(jobId, hard);
    this.#intents.set(jobId, 'cancel');
    this.#running.get(jobId)?.abort();
  }

  /**
   * 用户暂停：终态 `paused`，**可 resume**。
   *
   * 与 cancel 的唯一区别就是停下来之后置什么状态 —— 但这个区别决定了
   * 用户点的是"稍后继续"还是"前功尽弃"。
   */
  pause(jobId: number): boolean {
    const ac = this.#running.get(jobId);
    if (!ac) return false; // 没在跑的任务由调用方走 queue 层处理
    this.deps.queue.requestPause(jobId);
    this.#intents.set(jobId, 'pause');
    ac.abort();
    return true;
  }

  /**
   * worker 因 abort 停下之后，按意图收口状态。
   *
   * 默认按 `cancel` —— 意图缺失只可能是内部漏记，宁可当成用户取消（可见的终态），
   * 也不要留在 `running` 让任务永远转圈。
   */
  #settleAborted(job: JobRow): 'cancelled' | 'paused' | 'queued' {
    const intent = this.#intents.get(job.id) ?? 'cancel';
    if (intent === 'pause') {
      this.deps.queue.markPaused(job.id);
      return 'paused';
    }
    if (intent === 'shutdown') {
      // 进程退出不是用户意图：置回 queued，重启后调度器自动接走
      this.deps.queue.markInterrupted(job.id);
      return 'queued';
    }
    this.deps.queue.markCancelled(job.id);
    return 'cancelled';
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

    const renew = setInterval(
      () => queue.renewLease(job.id, this.deps.leaseTtlMs ?? 30_000),
      10_000,
    );
    renew.unref?.();

    try {
      queue.markRunning(job.id, process.pid);
      sse.publish(jobStateEvent(job.uid, 'running', 'leased'));

      const handler = handlers.get(job.type);
      if (!handler) {
        queue.fail(job.id, 'NO_HANDLER', `没有注册 job 类型 "${job.type}" 的处理器`, false);
        sse.publish(
          jobFailedEvent(
            job.uid,
            {
              code: 'NO_HANDLER',
              message: `no handler for job type "${job.type}"`,
              messageZh: `未知任务类型：${job.type}`,
              retryable: false,
            },
            false,
          ),
        );
        return;
      }

      await handler(job, ac.signal);

      const after = queue.byId(job.id);
      /*
       * ⚠️ 取消可能是"优雅"的：worker 在 chunk 边界看到 abort 后**正常返回**，不抛异常。
       * 那样就走不到下面的 catch，如果这里无脑 succeed()，
       * 一个被取消的任务会被记成**成功**。必须先看 abort 标志。
       */
      if (ac.signal.aborted) {
        // 优雅中止：worker 在 chunk 边界正常返回（不抛异常），走的是这条路
        const settled = this.#settleAborted(job);
        sse.publish(jobStateEvent(job.uid, settled, 'running'));
      } else if (after && (after.state === 'running' || after.state === 'leased')) {
        // runner 可能已自行置终态（succeed/block），别覆盖
        queue.succeed(job.id);
      }
      const final = queue.byId(job.id);
      if (final?.state === 'succeeded') {
        /*
         * ★ `job.state(succeeded)` 与 `job.done` **都要发**（T-130）。
         *
         * 下载队列两条都发（`rest/state.ts` 的 bridge），流水线这边原来只发 `job.done` ——
         * 而全局 toast 层的"完成"分支是挂在 `job.state === 'succeeded'` 上的。
         * 结果：一条转写任务跑完了，右下角那条提示会**永远停在"转写中"**。
         * 两个队列对同一套事件各发一半，谁都不算错，合起来就是个假状态。
         */
        sse.publish(jobStateEvent(job.uid, 'succeeded', 'running'));
        sse.publish(jobDoneEvent(job.uid, resultUidOf(final.result_json), resultKindOf(job.type)));
      }
    } catch (err) {
      const aborted = ac.signal.aborted;
      /*
       * ★ 这一行原来是 `const message = err instanceof Error ? err.message : String(err)`
       *   —— 也就是**只取 message，其余一律丢掉**（#98 ③）。
       *
       * 代价具体在哪：`NoMediaSourceError.message` 是一个**写死的常量**
       * （`no media source can handle this input`），信息量为零；真正有用的
       * 「换直链 / 换 RSS / 从本机导入」以及「每个候选适配器分别为什么不行」
       * 全在它的 `remediation` 字段里，是 `media/registry.ts` 认真算出来的。
       * 它在这一行被丢掉，之后**再也找不回来** —— 落库只剩两个 TEXT 列。
       * 用户最终看到的是一句既看不懂、也做不了任何事的英文。
       *
       * `describeRunnerError()` 负责在**错误还是对象**的时候把该救的救出来，
       * 并同时给出中文那一份（原来这里的 `messageZh` 是把英文串套进
       * `任务失败：${message}` —— 好过 `events.ts` 那边直接交英文原文，
       * 但两处各写各的，迟早分叉）。
       */
      const desc = describeRunnerError(err);
      // 用户取消不算失败
      // 中止：worker 已经停了，这里按**意图**把状态收口。
      // 只置 cancel_requested 而不改 state，任务会永远卡在 running（T-049 实测）。
      const state = aborted
        ? this.#settleAborted(job)
        : queue.fail(job.id, desc.code, desc.message, desc.retryable);

      /*
       * 三种中止意图**不能都报成 job.failed/已取消**：
       *   - 暂停 → 是 job.state(paused)，用户还要 resume，报"失败"会吓到他
       *   - 进程退出 → 是 job.state(queued)，重启会自动接着跑，同样不是失败
       * 只有真正的用户取消与运行错误才走 job.failed。
       */
      if (!aborted && state === 'queued') {
        /*
         * ★ 退避重试**是一次失败**，只是还会再试（T-130）。
         *
         * `queue.fail()` 在可重试时把状态置回 `queued` 并返回 'queued'，这里原先与
         * "进程退出导致的中断"走同一条分支，只发一个 `job.state(queued)`。
         * 于是 `JobFailedEvent.willRetry` 这个字段、以及前端「正在自动重试（第 n/m 次）」
         * 那句文案，对流水线 job **永远不会出现** —— 用户看到的是任务莫名回到排队，
         * 不知道刚刚失败过、也不知道它还会自己再来一次。
         * 这与"重试中的失败不要打扰用户"不冲突：契约里 `willRetry` 存在的意义就是
         * 让前端**降级显示**而不是丢弃。
         */
        sse.publish(
          jobFailedEvent(
            job.uid,
            {
              code: desc.code,
              message: desc.message,
              /*
               * 「还会再试」是**附加**在那句话后面，不是把它包起来。
               * 包起来会得到「任务失败，正在自动重试：任务失败：…」这种套娃 ——
               * 而 `desc.messageZh` 已经是一句完整的话了。
               */
              messageZh: `${desc.messageZh}（正在自动重试）`,
              retryable: true,
            },
            true,
          ),
        );
      } else if (state === 'paused' || state === 'queued') {
        sse.publish(jobStateEvent(job.uid, state, 'running'));
      } else {
        sse.publish(
          jobFailedEvent(
            job.uid,
            {
              code: aborted ? 'CANCELLED' : desc.code,
              message: aborted ? 'cancelled by user' : desc.message,
              messageZh: aborted ? '任务已取消' : desc.messageZh,
              retryable: false,
            },
            false,
          ),
        );
      }
    } finally {
      clearInterval(renew);
      this.#running.delete(job.id);
      this.#intents.delete(job.id);
      release();
    }
  }
}

/** 从 result_json 里取出结果实体的 uid（没有就 null）。 */
function resultUidOf(resultJson: string | null): string | null {
  if (!resultJson) return null;
  try {
    const r = JSON.parse(resultJson) as Record<string, unknown>;
    for (const k of ['transcriptUid', 'mindmapUid', 'noteUid']) {
      const v = r[k];
      if (typeof v === 'string') return v;
    }
  } catch {
    /* 结果不是 JSON 就当没有 */
  }
  return null;
}

/** job 类型 → 结果实体种类（契约的 resultKind 枚举）。 */
function resultKindOf(
  type: string,
): 'note' | 'transcript' | 'mindmap' | 'model' | 'backend' | null {
  if (type === 'transcribe') return 'transcript';
  if (type === 'mindmap') return 'mindmap';
  return null;
}

/*
 * ⚠️ `isRetryable()` 搬去了 `./errorText.ts`（判据一个字没改）。
 *
 * 理由不是整理：**"哪些错误算终态"和"终态错误该怎么说给用户听"必须在同一处对得上。**
 * `notes.status` 的读时自愈判的正是 `jobs.state === 'failed'`，而只有这个函数
 * 回 false 时才会真的落到那个状态。两者分居两个文件的话，改其中一个不会有
 * 任何东西提醒你另一个的含义也跟着变了。
 */
