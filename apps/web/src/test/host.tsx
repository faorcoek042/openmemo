/**
 * 组件测试宿主。
 *
 * ## 为什么要有这一层
 *
 * 我之前只有两种验证：纯逻辑单测（挡不住渲染/交互问题）和 jsdom **一次性渲染**
 * （只能证明"渲染出来了"，证明不了"点得动"）。中间那层一直是空的 ——
 * 于是"点击/输入/状态切换"这类问题全被推给真实浏览器 E2E，积压到 18 项。
 *
 * 其中相当一部分根本不需要真浏览器：**它们只需要一个 DOM 和一次事件派发。**
 *
 * ## 两个必须做对的地方
 *
 * 1. **`./dom-env` 必须是第一个 import**（且必须是独立模块）——
 *    ESM 里一个模块的所有 import 都先于它自己的语句执行，
 *    把 DOM 装配写在本文件顶层语句里是**不起作用的**。详见 dom-env.ts 的注释。
 * 2. **给 input 赋值要用原生 setter** —— React 劫持了 `value` 的 setter 做受控组件，
 *    直接 `el.value = x` 不会触发 onChange。
 */

// ⚠️ 必须第一行：装 jsdom 全局 + 修 React 的事件特性检测（见 dom-env.ts）
import './dom-env';

import { createElement, act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

import { initI18n } from '../app/i18n';
import { registerMockFetcher, type ApiOptions, type Fetcher } from '../lib/api/client';
import { markSurface, SURFACES, type Surface } from '../lib/api/surfaces';

initI18n();

/* ── 3. 渲染 ───────────────────────────────────────────────────────────── */

export interface RenderResult {
  container: HTMLElement;
  unmount: () => void;
  /** 冲刷 microtask + timer，让 query/mutation 的异步结果落地 */
  flush: () => Promise<void>;
}

export async function render(
  ui: ReactElement,
  opts: { route?: string; queryClient?: QueryClient } = {},
): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const qc =
    opts.queryClient ??
    new QueryClient({
      defaultOptions: {
        // 测试里重试只会让失败用例变慢，且掩盖真实错误
        queries: { retry: false, gcTime: 0, staleTime: 0 },
        mutations: { retry: false },
      },
    });

  let root: Root;
    root = createRoot(container);
  root.render(
    createElement(
    QueryClientProvider,
    { client: qc },
    createElement(
      MemoryRouter,
      { initialEntries: [opts.route ?? '/'] },
      ui as unknown as ReactNode,
    ),
    ),
  );
  });

  const flush = async (): Promise<void> => {
  // 两轮：第一轮让 setState 的更新提交，第二轮让因它产生的副作用
  // （query/mutation 的 promise、useEffect）落地。一轮 setTimeout(0) 不够 ——
  // 实测症状是"onChange 已触发但下一个事件处理器仍拿到旧 state"。
  for (let i = 0; i < 2; i += 1) {
    await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    });
  }
  };
  await flush();

  return {
  container,
  flush,
  unmount: () => {
    act(() => root.unmount());
    container.remove();
  },
  };
}

/* ── 4. 交互 ───────────────────────────────────────────────────────────── */

/**
 * 让 React 的调度器把待处理的更新跑完。
 *
 * 连续让出两个宏任务：第一个让事件产生的 setState 提交，
 * 第二个让由它触发的 effect / query / mutation 的 promise 落地。
 * 一个不够 —— 实测症状是"onChange 已触发，但下一个事件的处理器仍拿到旧 state"。
 */
/** 把 React 待处理的更新与随之产生的副作用排空。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('click: 元素不存在');
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

/**
 * 给受控 input/textarea 赋值。
 *
 * 两个必须做对的地方：
 * 1. **用原型上的原生 setter**：React 在实例上装了自己的 `value` setter 来做受控输入，
 *    直接 `el.value = x` 会被它拦下、`_valueTracker` 认为值没变 → onChange 不触发。
 *    走原型 setter 才能让 tracker 看到差异。
 * 2. **只派 `input`，不要补 `change`**：React 对文本输入只认 input，
 *    多派一个 change 会让 tracker 在同一轮被二次读取并复位。
 */
export async function type(el: Element | null, value: string): Promise<void> {
  if (!el) throw new Error('type: 元素不存在');
  const proto =
    el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('type: 拿不到原生 value setter');

  // jsdom 里 React 的 input 事件路径依赖 document.activeElement，不 focus 会拿到 null
  (el as HTMLElement).focus();
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle();
}

export async function pressKey(el: Element | null, key: string): Promise<void> {
  if (!el) throw new Error('pressKey: 元素不存在');
  await act(async () => {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await settle();
}

/* ── 5. 查询 ───────────────────────────────────────────────────────────── */

export const text = (c: HTMLElement): string => (c.textContent ?? '').replace(/\s+/g, ' ').trim();

export function byText(c: HTMLElement, needle: string): Element | null {
  return (
    Array.from(c.querySelectorAll('button, a, li, span, div, label')).find((el) =>
      (el.textContent ?? '').includes(needle),
    ) ?? null
  );
}

export function buttonByText(c: HTMLElement, needle: string): Element | null {
  return (
    Array.from(c.querySelectorAll('button')).find((el) =>
      (el.textContent ?? '').includes(needle),
    ) ?? null
  );
}

/* ── 6. API 打桩 ───────────────────────────────────────────────────────── */

export interface StubCall {
  path: string;
  method: string;
  body: unknown;
}

/**
 * 用一张 `路径 → 响应` 表打桩，并记录所有调用。
 * 所有 surface 标成 `live`，避免走真实 fetch。
 */
export function stubApi(routes: Record<string, unknown | ((c: StubCall) => unknown)>): {
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetcher: Fetcher = async <T,>(path: string, opts: ApiOptions = {}): Promise<T> => {
    const method = (opts.method ?? 'GET').toUpperCase();
    const call: StubCall = { path, method, body: opts.body };
    calls.push(call);
    const key = `${method} ${path}`;
    const handler = routes[key] ?? routes[path];
    if (handler === undefined) throw new Error(`stubApi: 未打桩的调用 ${key}`);
    return (typeof handler === 'function' ? (handler as (c: StubCall) => unknown)(call) : handler) as T;
  };
  registerMockFetcher(fetcher);
  for (const s of SURFACES) markSurface(s as Surface, 'mock');
  return { calls };
}
