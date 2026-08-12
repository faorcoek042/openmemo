/**
 * 轻量事件总线（D-05 §2.3）。
 *
 * 刻意不用第三方 emitter：我们只需要 on/off/emit 三个方法，
 * 而且要保证**一个订阅者抛错不会拖垮其余订阅者**（SSE 是全局单流，
 * 一个 handler 炸掉会让整条流的后续分发全部停摆）。
 *
 * ## ★ 为什么 `emit` 现在是**按事件名索引**的（#101 顺带）
 *
 * 它原来是 `emit(type: string, payload: unknown)` —— 订阅端 (`on`) 是**typed** 的
 * （`K extends keyof EventMap`，handler 拿到 `EventMap[K]`），发布端却是**全开的**。
 * 这个不对称有一个具体后果，实测抓到：
 *
 * > `source.ts` 两处发的是 `{ type: 'sync.required', reason: 'replay_gap' }`，
 * > 而 `packages/shared` 声明 `SyncRequiredEvent.reason` 只有
 * > `'replay_buffer_overflow' | 'server_restarted'`，另外还必须带 `ts`/`topic`/
 * > `oldestAvailableId`。**三处对不上，`tsc` 一个字都不报。**
 *
 * 之所以今天没炸，只是因为唯一那个订阅者（`system.sse.ts`）**整个 payload 都不看**。
 * 下一个想读 `reason` 或 `oldestAvailableId` 的人会拿到一个 `undefined`，
 * 而契约文件会告诉他那不可能发生。
 *
 * ## 为什么保留 `emitFromWire` 这个口子，而不是"全部收紧"
 *
 * 因为**线上来的那一条本来就无法静态保证**：`source.ts` 的 `dispatch()` 拿到的
 * `type` 是从 `ALL_SSE_EVENT_TYPES` 遍历出来的运行时字符串，`payload` 是
 * `JSON.parse()` 的产物 —— 对它做类型断言只会得到一个**假的**保证。
 *
 * 所以分成两个名字，让那条动态边界**看得见、grep 得到**：
 * - `emit`  —— 手写的、类型受检的。**人能写错的地方，全在这一档。**
 * - `emitFromWire` —— 只给"从网络/mock 收到一帧、按运行时字符串分发"的那两处。
 *
 * ⚠️ 新代码一律用 `emit`。见到 `emitFromWire` 出现在第三个地方，那多半是有人
 * 拿它绕过类型检查 —— 那正是这次要堵的那个洞又被挖开了。
 */

import type { EventMap } from './types';

type Handler<T> = (payload: T) => void;

const handlers = new Map<string, Set<Handler<never>>>();
const anyHandlers = new Set<(type: string, payload: unknown) => void>();

/** `emit` 与 `emitFromWire` 的共同实现 —— 两者只在**类型**上不同，运行时完全一致。 */
function deliver(type: string, payload: unknown): void {
  const set = handlers.get(type);
  if (set) {
    for (const fn of set) {
      try {
        (fn as Handler<unknown>)(payload);
      } catch (err) {
        // 一个订阅者出错不能影响其它订阅者，也不能中断整条 SSE 分发
        console.error(`[sse] handler for "${type}" threw`, err);
      }
    }
  }
  for (const fn of anyHandlers) {
    try {
      fn(type, payload);
    } catch (err) {
      console.error('[sse] wildcard handler threw', err);
    }
  }
}

export const bus = {
  on<K extends keyof EventMap & string>(type: K, fn: Handler<EventMap[K]>): () => void {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => {
      set!.delete(fn as Handler<never>);
    };
  },

  /** 订阅全部事件（调试面板 / 连接看门狗用）。 */
  onAny(fn: (type: string, payload: unknown) => void): () => void {
    anyHandlers.add(fn);
    return () => {
      anyHandlers.delete(fn);
    };
  },

  /**
   * 发一条**手写**的事件。payload 由事件名索引，写错当场红。
   *
   * 这是默认入口 —— 除了下面那两处真正的动态边界，一律用它。
   */
  emit<K extends keyof EventMap & string>(type: K, payload: EventMap[K]): void {
    deliver(type, payload);
  },

  /**
   * 分发一条**运行时才知道类型**的帧。**只有两个合法调用点**：
   * `lib/events/source.ts` 的 `dispatch()`（真 SSE）与 `lib/api/mock.ts` 的 `emit()`（mock 源）。
   *
   * 它们的 `type` 是遍历出来的字符串、`payload` 是 `JSON.parse()` 的结果，
   * 静态类型在这里**不可能**成立 —— 与其写一个骗人的断言，不如让这条边界有名字。
   */
  emitFromWire(type: string, payload: unknown): void {
    deliver(type, payload);
  },

  /** 仅供测试与热更新使用。 */
  _reset(): void {
    handlers.clear();
    anyHandlers.clear();
  },
};
