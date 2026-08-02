/**
 * 轻量事件总线（D-05 §2.3）。
 *
 * 刻意不用第三方 emitter：我们只需要 on/off/emit 三个方法，
 * 而且要保证**一个订阅者抛错不会拖垮其余订阅者**（SSE 是全局单流，
 * 一个 handler 炸掉会让整条流的后续分发全部停摆）。
 */

import type { EventMap } from './types';

type Handler<T> = (payload: T) => void;

const handlers = new Map<string, Set<Handler<never>>>();
const anyHandlers = new Set<(type: string, payload: unknown) => void>();

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

  emit(type: string, payload: unknown): void {
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
  },

  /** 仅供测试与热更新使用。 */
  _reset(): void {
    handlers.clear();
    anyHandlers.clear();
  },
};
