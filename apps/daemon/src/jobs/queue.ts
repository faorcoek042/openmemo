/**
 * 任务队列的**持久化与调度骨架**（D-01 §4.5 / §4.6，表定义见 D-02 §1.7）。
 *
 * ⚠️ **边界**：本文件只负责「队列状态怎么存、怎么选下一个、崩溃后怎么修复」。
 * **step 的执行逻辑归 `gpu-runtime`（`packages/pipeline`）** —— 见 BOARD 文件所有权表。
 * 两边的接口约定见 `JobRunner`。
 *
 * 队列**完全持久化在 SQLite**，不做内存队列 + 定期落盘（那在崩溃时必丢）。
 */
import type { DatabaseHandle } from '@openmemo/db';
import { ulid } from '@openmemo/shared';

import type { Lane } from './lanes.js';

export type JobState =
  'queued' | 'blocked' | 'leased' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRow {
  id: number;
  uid: string;
  type: string;
  plan_version: number;
  /**
   * 归属笔记（D-02 §1.7 的 `jobs.note_id`）。
   *
   * 列一直都在、`SELECT *` 也一直带着它，只是这个接口没声明 —— 于是**类型上看不见**，
   * 谁要用就得再查一次库或者自己 `as`。`job.created` 要给用户看的名字（笔记标题）
   * 正是靠它取的，声明出来才能让编译器帮忙。
   */
  note_id: number | null;
  priority: number;
  lane: Lane;
  state: JobState;
  attempt: number;
  max_attempts: number;
  next_run_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  worker_pid: number | null;
  worker_started_at: number | null;
  progress: number;
  current_step: string | null;
  payload_json: string;
  result_json: string | null;
  error_code: string | null;
  error_detail: string | null;
  blocked_code: string | null;
  cancel_requested: number;
  pause_requested: number;
  created_at: number;
  updated_at: number;
}

export interface EnqueueParams {
  readonly type: string;
  readonly lane: Lane;
  readonly payload?: unknown;
  readonly priority?: number;
  readonly noteId?: number | undefined;
  readonly planVersion?: number;
  /** 幂等键（D-01 §3.2 规则 3）：24h 内同键返回同一个 job。 */
  readonly idempotencyKey?: string | undefined;
  readonly maxAttempts?: number;
}

/** worker 侧要实现的接口 —— 由 `packages/pipeline`（gpu-runtime）提供实现。 */
export interface JobRunner {
  readonly type: string;
  run(job: JobRow, ctx: JobRunnerContext): Promise<void>;
}

export interface JobRunnerContext {
  /** 上报进度（0..1）。调度器负责节流后推 SSE。 */
  reportProgress(fraction: number, step?: string): void;
  /** worker 每完成一个 chunk 应调用一次；返回 true 表示应主动让出 lane（有更高优先级在等）。 */
  shouldYield(): boolean;
  /** 用户是否请求了取消/暂停。worker 应在 chunk 边界检查。 */
  readonly signal: AbortSignal;
}

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export class JobQueue {
  /**
   * @param onCreated 新 job 落库后回调一次（**幂等命中已有 job 时不回调**）。
   *
   * 为什么是构造参数而不是让 5 个入队点各自发事件：入队点分散在
   * `rest/notes.ts`（导入）、`rest/content.ts`（重跑 / 导图）、`http/upload.ts`（拖拽上传）、
   * `ws/recorder.ts`（录音后离线重跑），**第 6 个迟早会有人加**。
   * 靠"记得也发一条 job.created"是君子协议，而 T-130 的教训正是：漏掉的那一条
   * 不会让任何东西报错，只会让整条任务在界面上**不存在** —— 用户点了导入，页面一个字都没有。
   * 放在这里，忘不掉。
   */
  constructor(
    private readonly db: DatabaseHandle,
    private readonly instanceId: string,
    private readonly onCreated?: (job: JobRow) => void,
  ) {}

  /** 入队。带 idempotencyKey 时，24h 内重复提交返回原 job（D-01 §3.2）。 */
  enqueue(p: EnqueueParams): JobRow {
    const now = Date.now();
    let inserted = false;
    const row = this.db.transaction(() => {
      if (p.idempotencyKey) {
        const existing = this.db
          .prepare<JobRow>(
            `SELECT * FROM jobs WHERE idempotency_key = :k AND created_at > :since
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get({ k: p.idempotencyKey, since: now - IDEMPOTENCY_WINDOW_MS });
        if (existing) return existing;
      }
      inserted = true;

      const uid = ulid(now);
      const res = this.db
        .prepare(
          `INSERT INTO jobs (uid, type, plan_version, note_id, idempotency_key, priority, lane,
                             state, payload_json, max_attempts, next_run_at, created_at, updated_at)
           VALUES (:uid, :type, :planVersion, :noteId, :idem, :priority, :lane,
                   'queued', :payload, :maxAttempts, 0, :now, :now)`,
        )
        .run({
          uid,
          type: p.type,
          planVersion: p.planVersion ?? 1,
          noteId: p.noteId ?? null,
          idem: p.idempotencyKey ?? null,
          priority: p.priority ?? 10,
          lane: p.lane,
          payload: JSON.stringify(p.payload ?? {}),
          maxAttempts: p.maxAttempts ?? 5,
          now,
        });
      return this.byId(res.lastInsertRowid) as JobRow;
    });
    // 事务提交之后才通知：订阅者可能立刻回头查库（`job.created` 的消费方就会），
    // 在事务里发会让它读到尚未提交的状态。
    if (inserted) this.onCreated?.(row);
    return row;
  }

  byId(id: number): JobRow | undefined {
    return this.db.prepare<JobRow>('SELECT * FROM jobs WHERE id = :id').get({ id });
  }

  byUid(uid: string): JobRow | undefined {
    return this.db.prepare<JobRow>('SELECT * FROM jobs WHERE uid = :uid').get({ uid });
  }

  /**
   * 选出下一个可跑的 job。
   * 顺序：`priority ASC, created_at ASC`（D-01 §4.3）。
   * 只看 `queued` 且退避时间已到的。
   */
  peekRunnable(lanes: readonly Lane[], now = Date.now()): JobRow | undefined {
    if (lanes.length === 0) return undefined;
    const placeholders = lanes.map((_, i) => `:l${i}`).join(',');
    const params: Record<string, string | number> = { now };
    lanes.forEach((l, i) => (params[`l${i}`] = l));
    return this.db
      .prepare<JobRow>(
        `SELECT * FROM jobs
         WHERE state = 'queued' AND next_run_at <= :now AND lane IN (${placeholders})
         ORDER BY priority ASC, created_at ASC LIMIT 1`,
      )
      .get(params);
  }

  /**
   * 领取（lease）。用条件 UPDATE 保证原子性 —— 即使将来拆出多 worker 进程也不会重复领取。
   * @returns 是否领取成功
   */
  lease(id: number, ttlMs = 30_000, now = Date.now()): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET state='leased', lease_owner=:owner, lease_expires_at=:exp,
                         started_at=COALESCE(started_at,:now), updated_at=:now
         WHERE id=:id AND state='queued'`,
      )
      .run({ id, owner: this.instanceId, exp: now + ttlMs, now });
    return r.changes === 1;
  }

  /** 续租。worker 每 10s 调一次，续 30s（D-01 §4.6）。 */
  renewLease(id: number, ttlMs = 30_000, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET lease_expires_at=:exp, updated_at=:now
         WHERE id=:id AND lease_owner=:owner AND state IN ('leased','running')`,
      )
      .run({ id, exp: now + ttlMs, now, owner: this.instanceId });
  }

  markRunning(id: number, pid: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='running', worker_pid=:pid, worker_started_at=:now, updated_at=:now
         WHERE id=:id`,
      )
      .run({ id, pid, now });
  }

  setProgress(id: number, fraction: number, step?: string, now = Date.now()): void {
    this.db
      .prepare(`UPDATE jobs SET progress=:p, current_step=:s, updated_at=:now WHERE id=:id`)
      .run({ id, p: Math.max(0, Math.min(1, fraction)), s: step ?? null, now });
  }

  succeed(id: number, result?: unknown, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='succeeded', progress=1, result_json=:r, finished_at=:now,
                         updated_at=:now, lease_owner=NULL, lease_expires_at=NULL
         WHERE id=:id`,
      )
      .run({ id, r: result === undefined ? null : JSON.stringify(result), now });
  }

  /**
   * 失败。可重试则退避后回 `queued`，否则终态 `failed`。
   * 退避：`min(2^n × 2s, 5min)` + ±20% 抖动（D-01 §4.7）。
   */
  fail(id: number, code: string, detail: string, retryable: boolean, now = Date.now()): JobState {
    const job = this.byId(id);
    if (!job) return 'failed';
    const attempt = job.attempt + 1;
    const canRetry = retryable && attempt < job.max_attempts;

    if (canRetry) {
      const base = Math.min(2 ** attempt * 2000, 300_000);
      const jitter = base * (Math.random() * 0.4 - 0.2);
      this.db
        .prepare(
          `UPDATE jobs SET state='queued', attempt=:a, next_run_at=:next, error_code=:c,
                           error_detail=:d, updated_at=:now, lease_owner=NULL, lease_expires_at=NULL
           WHERE id=:id`,
        )
        .run({ id, a: attempt, next: Math.round(now + base + jitter), c: code, d: detail, now });
      return 'queued';
    }

    this.db
      .prepare(
        `UPDATE jobs SET state='failed', attempt=:a, error_code=:c, error_detail=:d,
                         finished_at=:now, updated_at=:now, lease_owner=NULL, lease_expires_at=NULL
         WHERE id=:id`,
      )
      .run({ id, a: attempt, c: code, d: detail, now });
    return 'failed';
  }

  /**
   * 转 `blocked`（D-01 §4.1）：缺前置条件（模型未装 / 磁盘不足 / 未配 API Key）。
   * 这是产品级重要状态 —— memo.ac 在缺后端时直接失败并报英文错误，
   * 我们让它变成一个**可点击修复**的等待态。
   */
  block(id: number, code: string, remediation?: unknown, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='blocked', blocked_code=:c, remediation_json=:r, updated_at=:now,
                         lease_owner=NULL, lease_expires_at=NULL
         WHERE id=:id`,
      )
      .run({
        id,
        c: code,
        r: remediation === undefined ? null : JSON.stringify(remediation),
        now,
      });
  }

  /** 列出所有 `blocked` 的 job（可按 blocked_code 过滤）。 */
  listBlocked(codes?: readonly string[]): JobRow[] {
    const rows = this.db.prepare<JobRow>(`SELECT * FROM jobs WHERE state='blocked'`).all();
    if (!codes || codes.length === 0) return rows;
    return rows.filter((r) => r.blocked_code !== null && codes.includes(r.blocked_code));
  }

  /**
   * 用户在任务中心点「重试」：把终态/阻塞态的 job 放回队列。
   *
   * `attempt` 归零是有意的：自动退避已经用完了它的预算，而这次是**用户看着屏幕主动点的**，
   * 不给新预算的话按钮会点了没反应（状态回到 queued，下一 tick 又立刻 failed）。
   * `blocked` 也走这里 —— 用户装完模型可能不想等热刷新那一轮。
   *
   * @returns 是否真的改了一行（false = 状态不允许，调用方据此回 409 而不是假装成功）
   */
  requeue(id: number, now = Date.now()): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET state='queued', attempt=0, next_run_at=0, blocked_code=NULL,
                         remediation_json=NULL, error_code=NULL, error_detail=NULL,
                         cancel_requested=0, pause_requested=0, updated_at=:now
         WHERE id=:id AND state IN ('blocked','failed','cancelled','paused')`,
      )
      .run({ id, now });
    return r.changes === 1;
  }

  /** 前置条件满足后解除阻塞。 */
  unblock(id: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='queued', blocked_code=NULL, remediation_json=NULL, updated_at=:now
         WHERE id=:id AND state='blocked'`,
      )
      .run({ id, now });
  }

  requestCancel(id: number, hard = false, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET cancel_requested=1, hard_cancel=:h, updated_at=:now
         WHERE id=:id AND state IN ('queued','blocked','leased','running','paused')`,
      )
      .run({ id, h: hard ? 1 : 0, now });
  }

  /**
   * 置终态 `cancelled`。
   *
   * `requestCancel()` 只是**置意图标记**（让 worker 在 chunk 边界自己停），
   * 它不改 state。worker 真的停下来之后必须再调这个把状态收口 ——
   * 否则任务会永远停在 `running`：UI 上转圈不停，`/api/jobs` 也一直报它在跑。
   * 实测踩到过（T-049）。
   */
  markCancelled(id: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='cancelled', finished_at=:now, updated_at=:now,
                         lease_owner=NULL, lease_expires_at=NULL, worker_pid=NULL
         WHERE id=:id AND state IN ('queued','blocked','leased','running','paused')`,
      )
      .run({ id, now });
  }

  /**
   * 置终态 `paused`（用户暂停）。
   *
   * ⚠️ 在此之前 **`state='paused'` 全仓没有任何写入方** —— `requestPause()` 只置意图标记，
   * 而 worker 停下来后走的是 `markCancelled()`。于是「暂停」实际是**不可逆的取消**：
   * `resume()` 的 `WHERE state='paused'` 永远匹配 0 行，接口却回 204 说成功。
   * 「接口说成功但什么都没发生」是最坏的一种失败。
   *
   * checkpoint（已落库的段落）**保留** —— resume 之后由 `resumableTranscript()` 接上。
   */
  markPaused(id: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='paused', pause_requested=0, updated_at=:now,
                         lease_owner=NULL, lease_expires_at=NULL, worker_pid=NULL
         WHERE id=:id AND state IN ('leased','running')`,
      )
      .run({ id, now });
  }

  /**
   * 置回 `queued`（**进程退出导致的中断**，不是用户意图）。
   *
   * daemon 正常关闭时，在跑的任务此前被当成"用户取消"标成 `cancelled`，
   * 而 `recoverOnStartup()` 只捞 `running`/`leased` —— 于是**正常退出的任务重启后永远不恢复**，
   * 反而 `kill -9` 的能恢复（因为来不及改状态）。正常关闭比强杀更糟，这显然反了。
   *
   * 置回 `queued` 后重启即被调度器自动接走，checkpoint 完好。
   */
  markInterrupted(id: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='queued', cancel_requested=0, pause_requested=0, updated_at=:now,
                         lease_owner=NULL, lease_expires_at=NULL, worker_pid=NULL
         WHERE id=:id AND state IN ('leased','running')`,
      )
      .run({ id, now });
  }

  /** 暂停一个**尚未开始**的任务（没有 worker 要停，直接置 paused）。 */
  pauseQueued(id: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='paused', pause_requested=0, updated_at=:now
         WHERE id=:id AND state IN ('queued','blocked')`,
      )
      .run({ id, now });
  }

  requestPause(id: number, now = Date.now()): void {
    this.db
      .prepare(`UPDATE jobs SET pause_requested=1, updated_at=:now WHERE id=:id`)
      .run({ id, now });
  }

  resume(id: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='queued', pause_requested=0, updated_at=:now
         WHERE id=:id AND state='paused'`,
      )
      .run({ id, now });
  }

  /**
   * **崩溃恢复**（D-01 §2.7 A）：启动时同步执行，在开始接受请求之前。
   *
   * 逻辑依据：我们刚启动，所以任何 `running`/`leased` 的 job 都**绝不可能真在跑**。
   *
   * ⚠️ 这里原来写的是「保留 `job_steps` 中已 succeeded 的步骤与 checkpoint —— 那是续跑的依据」。
   * **那是假话**：`job_steps` / `job_steps.checkpoint_json` 全仓**零写入**
   * （D-07/D-08 的 gap 台账里登记着），所以它既没东西可保留，也不可能是任何东西的依据。
   *
   * **真正的续跑依据是已经落库的转写段落**：`repos.resumableTranscript()`
   * （`db/repos.ts`）按 note+engine+model 找回上一份未完成的 `transcripts`，
   * runner（`jobs/runners/transcribe.ts`）再按 `transcript_segments.chunk_idx`
   * 跳过已完成的 chunk。也就是说 checkpoint 是**数据本身**，不是一张进度表 ——
   * 这条 UPDATE 只动 `jobs` 的租约字段，本来就不会碰到它，所以续跑确实是安全的，
   * 只是安全的理由和原注释说的完全不是一回事。
   *
   * @returns 被修复的 job 数量
   */
  recoverOnStartup(now = Date.now()): number {
    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          `UPDATE jobs SET state='queued', lease_owner=NULL, lease_expires_at=NULL,
                           worker_pid=NULL, worker_started_at=NULL, updated_at=:now
           WHERE state IN ('running','leased')`,
        )
        .run({ now });
      return r.changes;
    });
  }

  /** 统计各状态数量，用于健康检查与 UI。 */
  counts(): Record<string, number> {
    const rows = this.db
      .prepare<{ state: string; n: number }>(`SELECT state, COUNT(*) n FROM jobs GROUP BY state`)
      .all();
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  list(limit = 50): JobRow[] {
    return this.db
      .prepare<JobRow>(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT :limit`)
      .all({ limit });
  }

  /**
   * 一批笔记各自的**每种 job 类型最近一条任务**（#98）。
   *
   * ## 它存在的理由
   *
   * `notes.status` 里的 `'failed'` 这一档**全仓没有任何一处写过**，而列表页一直
   * 在渲染它。补写入方不是好办法（只救得了以后的数据，且会造出第二个真相），
   * 所以改成**读的时候问一次这里**：这条笔记最近一条转写任务是不是终态 `failed`。
   * 判据与序列化在同一次请求里完成，一个字节都不写库，
   * **修复之前就已经卡住的笔记同时被救回来**。
   *
   * ## 为什么是"每种 type 的最近一条"，而不是"有没有失败过"
   *
   * 「失败过」是个会**永久为真**的判据：用户重跑成功之后，那条旧的失败记录还在，
   * 笔记会永远标红。真正要问的是**最近一次**的结论 —— 重跑一次就该翻篇。
   * 按 type 分开是因为转写和导图是两件事：导图生成失败不该让一条转写好的笔记
   * 显示"处理失败"，而转写失败也不该被随后一次成功的导图任务盖过去。
   *
   * ## 一次查询，不做 N+1
   *
   * 列表一页最多 200 条，`note_id IN (...)` 一次取回，在 JS 里按
   * `(note_id, type)` 折叠。**别改成按笔记逐条查** —— `canRetranscribe` 那边
   * 之所以刻意不进列表，正是因为它每条要做真实的文件探测；这里只是一次索引扫描，
   * 两者不是一回事，但"列表里不许出现 N 次往返"这条规矩对两者都成立。
   *
   * @returns noteId → (job type → 该类型下**最近一条**任务)。没有任务的笔记不出现在 map 里。
   */
  noteJobDigests(noteIds: readonly number[]): Map<number, Map<string, NoteJobRecord>> {
    const out = new Map<number, Map<string, NoteJobRecord>>();
    if (noteIds.length === 0) return out;

    const unique = [...new Set(noteIds)];
    const placeholders = unique.map((_, i) => `:n${i}`).join(',');
    const params: Record<string, number> = {};
    unique.forEach((id, i) => (params[`n${i}`] = id));

    /*
     * `ORDER BY updated_at, id` 升序 + 后写覆盖 = 每个 (note, type) 留下最新的那条。
     * 用 `id` 兜同一毫秒内的并列：`updated_at` 是毫秒时间戳，同一条笔记上两个任务
     * 撞进同一毫秒是完全可能的（重跑就是紧接着入队的），只按时间排会得到不确定的赢家。
     */
    const rows = this.db
      .prepare<{
        note_id: number;
        uid: string;
        type: string;
        state: JobState;
        error_code: string | null;
        error_detail: string | null;
        updated_at: number;
      }>(
        `SELECT note_id, uid, type, state, error_code, error_detail, updated_at
         FROM jobs
         WHERE note_id IN (${placeholders})
         ORDER BY updated_at ASC, id ASC`,
      )
      .all(params);

    for (const r of rows) {
      let byType = out.get(r.note_id);
      if (!byType) {
        byType = new Map<string, NoteJobRecord>();
        out.set(r.note_id, byType);
      }
      byType.set(r.type, {
        uid: r.uid,
        type: r.type,
        state: r.state,
        errorCode: r.error_code,
        errorDetail: r.error_detail,
        updatedAt: r.updated_at,
      });
    }
    return out;
  }
}

/**
 * 一条笔记上某个类型的**最近一条**任务，只含判"这条笔记现在是什么状态"要用的列。
 *
 * 刻意**不是** `JobRow`：那是整行（含 payload / lease / 各种计时器字段），
 * 而这里的消费方是 HTTP 序列化路径 —— 给它一个大对象只会让下一个人顺手读到
 * 一个不该出现在响应里的字段。
 */
export interface NoteJobRecord {
  /** `jobs.uid`，对外唯一能说出口的任务标识。 */
  uid: string;
  /** `jobs.type`（`'transcribe'` / `'mindmap'` / …）。 */
  type: string;
  state: JobState;
  errorCode: string | null;
  errorDetail: string | null;
  /** `jobs.updated_at`（毫秒时间戳）。 */
  updatedAt: number;
}
