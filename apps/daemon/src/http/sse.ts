/**
 * SSE 全局单流广播器（D-01 §3.3，ADR-004 决策 5）。
 *
 * **硬约束来源**：HTTP/1.1 对同一 origin 只有 6 个并发连接。预算：
 *   1 × SSE（常驻） + 1~2 × media（`<audio>` 的 Range 连接） + 剩余 3~4 × REST
 * 每多开一条常驻流就少一个 REST 槽位 → 页面会随机卡死。
 * 因此**全应用只有一条 EventSource**，所有主题复用。
 *
 * 另一条重要原则（D-01 §3.3 末尾）：
 * > **绝不把 SSE 当作可靠数据源** —— 任何事件都只是"该去拉数据了"的提示，
 * > 真相永远在 REST/DB。这条原则消灭一整类"前后端状态不一致"的 bug。
 */
import type { ServerResponse } from 'node:http';

import {
  KEEPALIVE_INTERVAL_MS,
  PROGRESS_THROTTLE_MS,
  SSE_REPLAY_BUFFER_SIZE,
  formatSseFrame,
  formatSseKeepalive,
  formatSseRetry,
  type SseEvent,
} from '@openmemo/shared';

interface Buffered {
  readonly id: number;
  readonly event: SseEvent;
}

interface Client {
  readonly res: ServerResponse;
  readonly sid: string;
}

export class SseHub {
  #nextId = 1;
  readonly #ring: Buffered[] = [];
  /** sid → client。**同一 session 只允许一条流**（见 attach 的注释）。 */
  readonly #clients = new Map<string, Client>();
  /** topic → 待发送的最新进度事件（节流用）。 */
  readonly #pending = new Map<string, SseEvent>();
  #throttleTimer: NodeJS.Timeout | undefined;
  #keepaliveTimer: NodeJS.Timeout | undefined;
  #closed = false;

  get clientCount(): number {
    return this.#clients.size;
  }

  get lastEventId(): number {
    return this.#nextId - 1;
  }

  /**
   * 接入一条 SSE 连接。
   *
   * **同一 session 的第二条连接会挤掉第一条**（而不是拒绝新的）——
   * 这样浏览器刷新/标签页复活的场景才不会卡住（D-01 §3.3 单流强制）。
   */
  attach(sid: string, res: ServerResponse, lastEventId?: number): void {
    const existing = this.#clients.get(sid);
    if (existing) {
      try {
        existing.res.end();
      } catch {
        /* 旧连接可能已断 */
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉反向代理缓冲（本地场景一般没有，但零成本）
      'X-Accel-Buffering': 'no',
    });
    res.write(formatSseRetry(3000));

    this.#clients.set(sid, { res, sid });

    // 断线重放：命中环形缓冲则补发，未命中说明缓冲已滚过 → 让前端全量重拉
    if (lastEventId !== undefined && this.#ring.length > 0) {
      const oldest = this.#ring[0]?.id ?? 0;
      if (lastEventId >= oldest - 1) {
        for (const b of this.#ring) {
          if (b.id > lastEventId) res.write(formatSseFrame(b.id, b.event));
        }
      } else {
        this.#writeRaw(res, this.#nextId++, {
          type: 'sync.required',
          ts: new Date().toISOString(),
          reason: 'replay-buffer-overrun',
        } as unknown as SseEvent);
      }
    }

    res.on('close', () => {
      if (this.#clients.get(sid)?.res === res) this.#clients.delete(sid);
    });

    this.#ensureKeepalive();
  }

  detach(sid: string): void {
    const c = this.#clients.get(sid);
    if (!c) return;
    try {
      c.res.end();
    } catch {
      /* ignore */
    }
    this.#clients.delete(sid);
  }

  /**
   * 广播一个事件。
   *
   * @param throttleTopic 传入则按 topic 做 250ms 合并（只保留最新值）。
   *   进度类事件必须节流；**`transcribe.segment` 这类增量结果不能丢，不要传 topic**。
   */
  publish(event: SseEvent, throttleTopic?: string): void {
    if (this.#closed) return;
    if (throttleTopic === undefined) {
      this.#flushOne(event);
      return;
    }
    this.#pending.set(throttleTopic, event);
    this.#throttleTimer ??= setTimeout(() => {
      this.#throttleTimer = undefined;
      const pending = [...this.#pending.values()];
      this.#pending.clear();
      for (const e of pending) this.#flushOne(e);
    }, PROGRESS_THROTTLE_MS);
    this.#throttleTimer.unref?.();
  }

  #flushOne(event: SseEvent): void {
    const id = this.#nextId++;
    this.#ring.push({ id, event });
    while (this.#ring.length > SSE_REPLAY_BUFFER_SIZE) this.#ring.shift();
    const frame = formatSseFrame(id, event);
    for (const c of this.#clients.values()) {
      try {
        c.res.write(frame);
      } catch {
        this.#clients.delete(c.sid);
      }
    }
  }

  #writeRaw(res: ServerResponse, id: number, event: SseEvent): void {
    try {
      res.write(formatSseFrame(id, event));
    } catch {
      /* 连接已断 */
    }
  }

  #ensureKeepalive(): void {
    if (this.#keepaliveTimer) return;
    this.#keepaliveTimer = setInterval(() => {
      const ka = formatSseKeepalive();
      for (const c of this.#clients.values()) {
        try {
          c.res.write(ka);
        } catch {
          this.#clients.delete(c.sid);
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
    this.#keepaliveTimer.unref?.();
  }

  close(): void {
    this.#closed = true;
    if (this.#throttleTimer) clearTimeout(this.#throttleTimer);
    if (this.#keepaliveTimer) clearInterval(this.#keepaliveTimer);
    for (const c of this.#clients.values()) {
      try {
        c.res.end();
      } catch {
        /* ignore */
      }
    }
    this.#clients.clear();
  }
}
