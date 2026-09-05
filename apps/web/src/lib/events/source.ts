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
import { ALL_SSE_EVENT_TYPES, isSequenced } from './types';
import { useConnectionStore, type ConnectionState } from '../stores/connection.store';

const CHANNEL = 'openmemo-sse';
const LOCK_NAME = 'openmemo-sse-leader';
/**
 * 连续这么多次重连失败后转入 `degraded` —— 由 `degradedPolling.ts` 接手，
 * 改为每 `DEGRADED_POLL_INTERVAL_MS`（15s）全量重拉一次。
 *
 * ─── 这句话曾经是假的，两边都留着（#101）───────────────────────────────
 * 原文写的就是「降级为**轮询**（约 15s）」，而顺着 `degraded` 查下来
 * 只有一个枚举值、一条黄色横幅和一张 tone 表 —— **全仓没有任何一处在拉数据**。
 * 也就是说：SSE 断到降级之后，界面永久停在最后一帧上，而这句注释
 * 恰恰会让下一个人**不去查这里**（"哦，有兜底的"）。
 *
 * 现在兜底真的存在了（`lib/events/degradedPolling.ts`，由 `system.sse.ts` 装上），
 * 所以这句话第一次成立。⚠️ 那个模块删了，这里就要跟着改回"没有兜底"，
 * 不许留着这句话继续替不存在的东西背书。
 */
const MAX_RECONNECT_BEFORE_DEGRADE = 5;
/** 超过 keepalive 间隔这么多倍没收到任何帧，判定连接已死 */
const WATCHDOG_FACTOR = 2;

export interface SseSourceOptions {
  url: string;
  /**
   * 注入式，便于用 mock 源替换真实 EventSource。
   *
   * ⚠️ 这里原来写着"见 `mockSource.ts`"——**那个文件不存在**（全仓零命中）。
   * 指向不存在的文件和描述不存在的行为是同一类债，顺手改掉。
   */
  factory?: (url: string) => EventSourceLike;
  /**
   * 注入式的标签间广播通道。真实实现就是 `new BroadcastChannel(name)`。
   *
   * 加这个口子**不是为了好看**：多标签的主/从那条路此前**一行测试都没有**，
   * 而测试宿主里的 `BroadcastChannel` 是个 `postMessage(){}` 的空壳
   * （`test/dom-env.ts`），也就是说**任何跨标签行为在测试里都必然静默无事发生**。
   * 有了它，"主标签降级 → 跟随者真的去重拉"才钉得住（见 silentFailures.test.tsx）。
   */
  channelFactory?: (name: string) => ChannelLike | null;
}

/** 只依赖我们用到的那部分 BroadcastChannel 接口。 */
export interface ChannelLike {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  close(): void;
}

/**
 * 标签间报文。**带 `kind` 判别式**，因为现在通道上跑着两类东西：
 * 转播的 SSE 帧，和主标签的连接态。
 *
 * ⚠️ 收端对**没有 `kind`** 的报文按"旧版事件帧"处理：升级期间两个标签可能跑着
 * 不同的 bundle（浏览器缓存），老标签发的还是 `{type,payload}`。
 * 少这一档的后果不是报错，是那段时间里跨标签转播**静默失效**。
 */
type ChannelMessage =
  | { kind: 'event'; type: string; payload: unknown }
  | { kind: 'state'; state: ConnectionState }
  /** 新标签上线，向主标签要一次当前状态（否则要等到主标签下次状态变化才知道）。 */
  | { kind: 'hello' };

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
let channel: ChannelLike | null = null;
let isLeader = false;
let reconnectAttempts = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastFrameAt = Date.now();
let releaseLock: (() => void) | null = null;

/**
 * 写连接态。**主标签写的同时一律广播出去。**
 *
 * ★ 广播放在这里而不是各个调用点，是**结构性**的：连接态有五个写入点
 * （`openStream` 的 connecting、`onopen`、`onerror` 的两档、看门狗重建），
 * 靠"记得在每处补一句 postMessage"必然会漏掉一个 —— 而漏掉的那一个
 * 表现为"跟随者停在一个过期状态上"，**没有任何报错**。
 * 收在这一个函数里，漏不掉。
 */
function setState(s: ConnectionState) {
  useConnectionStore.getState().setState(s);
  if (isLeader) channel?.postMessage({ kind: 'state', state: s } satisfies ChannelMessage);
}

/**
 * 分发一条事件。data 类做 seq 缺口检测；缺口时发 `x.sync.required`，
 * 由 bindings 层触发整篇重拉（D-05 §11.0 总则 2）。
 */
function dispatch(type: string, payload: unknown): void {
  lastFrameAt = Date.now();

  if (type === 'keepalive') return; // 只用于喂看门狗，不派发

  if (isSequenced(type) && payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    const seq = typeof p.seq === 'number' ? p.seq : null;
    if (seq !== null) {
      const key = streamKeyOf(type, p);
      const prev = seqCursors.get(key);
      if (prev !== undefined && seq !== prev + 1) {
        console.warn(`[sse] ${type} seq 缺口: 期望 ${prev + 1}, 收到 ${seq} → 触发重拉`);
        // 客户端**自己发现**的缺口，不是服务端那条 `sync.required`（见 types.ts 的说明）
        bus.emit('x.sync.required', { type: 'x.sync.required', reason: 'replay_gap' });
      }
      seqCursors.set(key, seq);
    }
  }

  // ★ 唯一合法的动态分发点之一：type 是遍历出来的字符串，payload 是 JSON.parse 的产物
  bus.emitFromWire(type, payload);
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
      if (isLeader && channel) {
        channel.postMessage({ kind: 'event', type, payload } satisfies ChannelMessage);
      }
    });
  }

  source.onopen = () => {
    reconnectAttempts = 0;
    const wasDown = useConnectionStore.getState().state !== 'open';
    setState('open');
    // 重放缓冲只有 256 条（SSE_REPLAY_BUFFER_SIZE），一次批量下载就能滚过
    // → 重连后一律全量失效，宁可多拉一次（D-05 §2.3）
    //
    // ⚠️ reason 从 `'replay_gap'` 改成 `'reconnected'`：这里**不是**缺口，是重连。
    // 原来两处报同一个理由，而两者的排查方向完全不同。
    if (wasDown) bus.emit('x.sync.required', { type: 'x.sync.required', reason: 'reconnected' });
  };

  source.onerror = () => {
    reconnectAttempts += 1;
    // EventSource 会自动重连；超过阈值才降级为轮询
    setState(reconnectAttempts >= MAX_RECONNECT_BEFORE_DEGRADE ? 'degraded' : 'reconnecting');
  };
}

function openStream(opts: SseSourceOptions): void {
  const factory =
    opts.factory ??
    ((url: string) => new EventSource(url, { withCredentials: true }) as EventSourceLike);
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

/**
 * ★★ 跟随者：**连接态一律以主标签为准，自己绝不编。**
 *
 * ## 它原来在说谎
 *
 * 原文是 `setState('open')`，注释写着「跟随者的"连接"就是 BroadcastChannel，视作已连」。
 * 听上去成立，实际后果是：
 *
 * > **主标签降级了，跟随者仍然显示"实时正常"，而数据早就停了。**
 *
 * 而且它比"少一条横幅"更糟一层 —— `degraded` 的轮询兜底是由连接态驱动的，
 * 跟随者**永远看不到 `degraded`**，所以那条兜底在它上面**根本不会启动**。
 * 用户在第二个标签页里既没有实时更新、也没有轮询、还看着一切正常。
 *
 * ## 为什么起手是 `connecting` 而不是 `open`
 *
 * 因为这一刻我们**真的不知道**主标签连上没有。`connecting` 是唯一诚实的初值，
 * 而且它就是 store 的初值 —— 所以这里不需要写任何东西，**删掉那行谎话就够了**。
 *
 * ## 为什么要发 `hello`
 *
 * 主标签只在**状态变化**时广播。一个刚打开的标签如果只是被动等待，
 * 就会一直停在 `connecting`（主标签可能已经稳定 `open` 好几个小时了）——
 * 那是把一句旧谎话换成一句新谎话。`hello` 让它主动问一次。
 * 没有主标签时没人回答，状态留在 `connecting`，这仍然是实话。
 */
function becomeFollower(): void {
  isLeader = false;
  channel?.addEventListener('message', (e: MessageEvent) => onChannelMessage(e.data));
  channel?.postMessage({ kind: 'hello' } satisfies ChannelMessage);
}

/**
 * 通道收报。主/从**共用**这一个入口 —— 一个标签在拿到锁之前是从、之后是主，
 * 两套收报逻辑会在那个切换点上打架。
 */
function onChannelMessage(data: unknown): void {
  const msg = data as Partial<ChannelMessage> & { type?: string; payload?: unknown };

  // 没有 kind = 旧版 bundle 发来的事件帧（升级期间会出现），按事件处理
  if (msg.kind === undefined && typeof msg.type === 'string') {
    if (!isLeader) dispatch(msg.type, msg.payload);
    return;
  }

  switch (msg.kind) {
    case 'event':
      // 主标签自己不消费转播（它的帧已经从 EventSource 走过 dispatch 了）
      if (!isLeader) dispatch(msg.type as string, msg.payload);
      return;

    case 'state':
      // 只有跟随者听主标签的。主标签的状态由它自己的 EventSource 决定。
      if (!isLeader && msg.state) applyLeaderState(msg.state);
      return;

    case 'hello':
      // 新标签来问，只有主标签答得上
      if (isLeader) {
        const cur = useConnectionStore.getState().state;
        channel?.postMessage({ kind: 'state', state: cur } satisfies ChannelMessage);
      }
      return;

    default:
      return;
  }
}

/**
 * 跟随者应用主标签的状态。
 *
 * ⚠️ 从"不是 open"变成"open"时要**自己**触发一次全量重拉：
 * 主标签断线期间漏掉的帧，主标签会靠自己的 `onopen` 补回来，
 * 但**跟随者有它自己那份 Query 缓存**，没人替它刷。
 * 少这一句，跟随者会一直显示断线那一刻的旧数据 —— 连接态倒是对了，数据还是错的。
 */
function applyLeaderState(state: ConnectionState): void {
  const was = useConnectionStore.getState().state;
  useConnectionStore.getState().setState(state);
  if (state === 'open' && was !== 'open') {
    bus.emit('x.sync.required', { type: 'x.sync.required', reason: 'leader_reconnected' });
  }
}

/**
 * 启动 SSE。幂等 + 引用计数，StrictMode 双挂载安全。
 * 返回 stop 函数。
 */
export function startSse(opts: SseSourceOptions): () => void {
  refCount += 1;
  if (started) return makeStop();
  started = true;

  const makeChannel =
    opts.channelFactory ??
    ((name: string) =>
      typeof BroadcastChannel !== 'undefined'
        ? (new BroadcastChannel(name) as unknown as ChannelLike)
        : null);
  channel = makeChannel(CHANNEL);

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
