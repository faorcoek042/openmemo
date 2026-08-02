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
  constructor(
    private readonly db: DatabaseHandle,
    private readonly instanceId: string,
  ) {}

  /** 入队。带 idempotencyKey 时，24h 内重复提交返回原 job（D-01 §3.2）。 */
  enqueue(p: EnqueueParams): JobRow {
    const now = Date.now();
    return this.db.transaction(() => {
      if (p.idempotencyKey) {
        const existing = this.db
          .prepare<JobRow>(
            `SELECT * FROM jobs WHERE idempotency_key = :k AND created_at > :since
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get({ k: p.idempotencyKey, since: now - IDEMPOTENCY_WINDOW_MS });
        if (existing) return existing;
      }

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
   * 保留 `job_steps` 中已 succeeded 的步骤与 checkpoint —— 那是续跑的依据。
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
}
