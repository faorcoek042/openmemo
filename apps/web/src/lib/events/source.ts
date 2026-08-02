/**
 * SSE 单例（D-05 §2.3）—— 全应用**唯一**一条 EventSource。
 *
 * 三个必须做对的地方，每一个都是踩过/预判到的坑：
 *
 * 1. ★ **`onmessage` 永远不会触发。**
 *    `packages/shared` 的 `formatSseFrame()` 发的是 `event: <type>`（具名事件）。
 *    按 SSE 规范，带具名 `event:` 的帧只会派发到 `addEventListener('<type>')`，
 *    `onmessage` 只接 `event: message` 或无 `event:` 的帧。
 *    → 必须遍历类型逐一 addEventListener。写成 onmessage 会得到
 *      "连上了但什么都收不到"的**静默失败**。
 *
 * 2. ★ **多标签页会吃掉 HTTP/1.1 的 6 连接预算。**
 *    3 个标签各开一条 SSE = 预算去掉一半，媒体 Range 与 REST 会随机排队卡住。
 *    → Web Locks 选主：全浏览器只有一个标签持有 EventSource，其余靠 BroadcastChannel 收转播。
 *    ADR-007 决策 5 的硬要求：**必须特性检测**，`navigator.locks` 不可用时降级回
 *    "每个标签各开一条"（即 D-01 的原行为），不让这个 UNKNOWN 变成阻塞。
 *
 * 3. ★ **StrictMode 会双挂载。**
 *    绝不在组件里 `new EventSource`。这里用模块级单例 + 引用计数。
 */

import { KEEPALIVE_INTERVAL_MS } from '@openmemo/shared';
import { bus } from './bus';
import { ALL_SSE_EVENT_TYPES, classOf } from './types';
import { useConnectionStore } from '../stores/connection.store';

const CHANNEL = 'openmemo-sse';
const LOCK_NAME = 'openmemo-sse-leader';
/** 连续这么多次重连失败后降级为轮询（约 15s） */
const MAX_RECONNECT_BEFORE_DEGRADE = 5;
/** 超过 keepalive 间隔这么多倍没收到任何帧，判定连接已死 */
const WATCHDOG_FACTOR = 2;

export interface SseSourceOptions {
  url: string;
  /** 注入式，便于用 mock 源替换真实 EventSource（见 mockSource.ts） */
  factory?: (url: string) => EventSourceLike;
}

/** 只依赖我们用到的那部分 EventSource 接口，好让 mock 能实现它。 */
export interface EventSourceLike {
  addEventListener(type: string, fn: (e: MessageEvent) => void): void;
  close(): void;
  onerror: ((e: unknown) => void) | null;
  onopen: ((e: unknown) => void) | null;
}

/** `data` 类事件的 seq 缺口检测状态：streamKey → 上一个 seq */
const seqCursors = new Map<string, number>();

/** 判断一条 data 事件属于哪条"流"（缺口检测按流独立进行）。 */
function streamKeyOf(type: string, payload: Record<string, unknown>): string {
  if (type === 'transcribe.segment') return `t:${String(payload.transcriptUid)}`;
  if (type === 'mindmap.delta') return `m:${String(payload.mindmapUid)}`;
  if (type === 'summary.delta') return `s:${String(payload.noteUid)}`;
  return type;
}

let started = false;
let refCount = 0;
let es: EventSourceLike | null = null;
let channel: BroadcastChannel | null = null;
let isLeader = false;
let reconnectAttempts = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastFrameAt = Date.now();
let releaseLock: (() => void) | null = null;

function setState(s: ReturnType<typeof useConnectionStore.getState>['state']) {
  useConnectionStore.getState().setState(s);
}

/**
 * 分发一条事件。data 类做 seq 缺口检测；缺口时发 `sync.required`，
 * 由 bindings 层触发整篇重拉（D-05 §11.0 总则 2）。
 */
function dispatch(type: string, payload: unknown): void {
  lastFrameAt = Date.now();

  if (type === 'keepalive') return; // 只用于喂看门狗，不派发

  if (classOf(type) === 'data' && payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    const seq = typeof p.seq === 'number' ? p.seq : null;
    if (seq !== null) {
      const key = streamKeyOf(type, p);
      const prev = seqCursors.get(key);
      if (prev !== undefined && seq !== prev + 1) {
        console.warn(`[sse] ${type} seq 缺口: 期望 ${prev + 1}, 收到 ${seq} → 触发重拉`);
        bus.emit('sync.required', { type: 'sync.required', reason: 'replay_gap' });
      }
      seqCursors.set(key, seq);
    }
  }

  bus.emit(type, payload);
}

function attach(source: EventSourceLike): void {
  // ★ 坑 1：逐类型 addEventListener，绝不用 onmessage
  for (const type of ALL_SSE_EVENT_TYPES) {
    source.addEventListener(type, (e: MessageEvent) => {
      lastFrameAt = Date.now();
      let payload: unknown;
      try {
        payload = JSON.parse(e.data as string);
      } catch {
        console.error(`[sse] 无法解析 ${type} 的 data`, e.data);
        return;
      }
      dispatch(type, payload);
      // 主标签把事件转播给其它标签
      if (isLeader && channel) channel.postMessage({ type, payload });
    });
  }

  source.onopen = () => {
    reconnectAttempts = 0;
    const wasDown = useConnectionStore.getState().state !== 'open';
    setState('open');
    // 重放缓冲只有 256 条（SSE_REPLAY_BUFFER_SIZE），一次批量下载就能滚过
    // → 重连后一律全量失效，宁可多拉一次（D-05 §2.3）
    if (wasDown) bus.emit('sync.required', { type: 'sync.required', reason: 'replay_gap' });
  };

  source.onerror = () => {
    reconnectAttempts += 1;
    // EventSource 会自动重连；超过阈值才降级为轮询
    setState(reconnectAttempts >= MAX_RECONNECT_BEFORE_DEGRADE ? 'degraded' : 'reconnecting');
  };
}

function openStream(opts: SseSourceOptions): void {
  const factory =
    opts.factory ?? ((url: string) => new EventSource(url, { withCredentials: true }) as EventSourceLike);
  setState('connecting');
  es = factory(opts.url);
  attach(es);

  watchdog = setInterval(() => {
    if (Date.now() - lastFrameAt > KEEPALIVE_INTERVAL_MS * WATCHDOG_FACTOR) {
      // 连 keepalive 都没有 → 连接实际已死但浏览器没报错，主动重建
      console.warn('[sse] 看门狗超时，重建连接');
      es?.close();
      es = null;
      lastFrameAt = Date.now();
      openStream(opts);
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function becomeFollower(): void {
  isLeader = false;
  setState('open'); // 跟随者的"连接"就是 BroadcastChannel，视作已连
  channel?.addEventListener('message', (e: MessageEvent) => {
    const { type, payload } = e.data as { type: string; payload: unknown };
    dispatch(type, payload);
  });
}

/**
 * 启动 SSE。幂等 + 引用计数，StrictMode 双挂载安全。
 * 返回 stop 函数。
 */
export function startSse(opts: SseSourceOptions): () => void {
  refCount += 1;
  if (started) return makeStop();
  started = true;

  channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;

  // ★ 坑 2 + ADR-007 决策 5：特性检测，不可用就降级，不让 UNKNOWN 变成阻塞
  const hasWebLocks = typeof navigator !== 'undefined' && 'locks' in navigator && !!navigator.locks;

  if (hasWebLocks && channel) {
    // 持有锁的那个标签当主；它永不释放，标签关闭时浏览器自动释放 → 另一个标签秒级接管
    void navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, () => {
      isLeader = true;
      openStream(opts);
      return new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });
    // 在拿到锁之前先当跟随者收转播；拿到锁后 isLeader 变 true，两者不冲突
    becomeFollower();
  } else {
    // 降级：回到 D-01 的原行为 —— 每个标签各开一条。
    console.info('[sse] navigator.locks 不可用，降级为每标签一条流');
    useConnectionStore.getState().setMultiTabDegraded(true);
    isLeader = true;
    openStream(opts);
  }

  return makeStop();
}

function makeStop(): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    refCount -= 1;
    if (refCount > 0) return;
    started = false;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    es?.close();
    es = null;
    releaseLock?.();
    releaseLock = null;
    channel?.close();
    channel = null;
    isLeader = false;
    seqCursors.clear();
  };
}

/** 供调试面板显示。 */
export function sseDebugInfo() {
  return { started, isLeader, refCount, reconnectAttempts, lastFrameAt };
}
