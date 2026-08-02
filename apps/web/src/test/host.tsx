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
 * ## 三个必须做对的地方
 *
 * 1. **jsdom 全局必须在 react-dom 之前装好** —— 所以本模块在顶层就装，
 *    测试文件把它放在第一个 import。CJS 的 `require` 按序执行，能保证这个顺序。
 * 2. **`IS_REACT_ACT_ENVIRONMENT = true`**，否则 React 19 会对每次状态更新告警刷屏。
 * 3. **给 input 赋值要用原生 setter** —— React 劫持了 `value` 的 setter 来做受控组件，
 *    直接 `input.value = x` 不会触发 React 的 onChange。这是手写测试宿主最容易踩的坑。
 */

import { JSDOM } from 'jsdom';

/* ── 1. DOM 全局（必须在任何 React 代码之前）────────────────────────────── */

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:17650/',
  pretendToBeVisual: true,
});

const w = dom.window as unknown as Window & typeof globalThis;

const define = (key: string, value: unknown): void => {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
};

define('window', w);
define('document', w.document);
define('navigator', w.navigator);
define('location', w.location);
for (const k of [
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'getComputedStyle',
  'localStorage',
  'sessionStorage',
] as const) {
  define(k, (w as unknown as Record<string, unknown>)[k]);
}
define('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
define('cancelAnimationFrame', (id: number) => clearTimeout(id));
define('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}));
define('BroadcastChannel', class {
  postMessage(): void {}
  addEventListener(): void {}
  close(): void {}
});
define('IS_REACT_ACT_ENVIRONMENT', true);

/* ── 2. React / 应用依赖（此时 DOM 已就绪）──────────────────────────────── */

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
  await act(async () => {
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
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

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('click: 元素不存在');
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/**
 * 给受控 input/textarea 赋值。
 *
 * ⚠️ 必须走**原生 setter**：React 为了实现受控组件劫持了 `value` 的 setter 并记录
 * "上一次的值"，直接 `el.value = x` 会让 React 认为值没变、不触发 onChange。
 */
export async function type(el: Element | null, value: string): Promise<void> {
  if (!el) throw new Error('type: 元素不存在');
  const proto =
    el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('type: 拿不到原生 value setter');
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

export async function pressKey(el: Element | null, key: string): Promise<void> {
  if (!el) throw new Error('pressKey: 元素不存在');
  await act(async () => {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  });
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
