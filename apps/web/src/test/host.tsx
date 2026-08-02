/**
 * 组件测试宿主。
 *
 * ## 为什么要有这一层
 *
 * 此前只有两种验证：纯逻辑单测（挡不住渲染/交互）和 jsdom **一次性渲染**
 * （只证明"渲染出来了"，证明不了"点得动"）。中间空着，于是点击/输入/状态切换
 * 全被推给真实浏览器 E2E，积压到 18 项 —— 而其中大部分只需要一个 DOM 和一次事件派发。
 *
 * ## 为什么最终用了 @testing-library/react 而不是自己写
 *
 * 我先手写了一版（原型链上的原生 setter 赋值 + dispatchEvent + act 包裹），
 * 卡在一个具体现象上：**事件产生的 setState 要等到下一次事件派发才提交**，
 * 于是"onChange 明明触发了，紧接着的 keydown 处理器仍拿到旧 state"。
 * 试过 act 包裹、act 内让出微任务、关掉 act 环境改用真实定时器、多轮宏任务等待 —— 都没解决。
 *
 * 这是个已经被解决过的问题，RTL 的 `fireEvent` + 内建 act 包装正是为它而生。
 * **继续手写的成本已经超过引入一个依赖的成本**，换掉是正确的取舍。
 *
 * 保留下来的自有部分（RTL 不管这两件事）：
 * - `./dom-env`：jsdom 全局 + React 事件特性检测的修补（详见该文件）
 * - `stubApi`：按 surface 打桩，配合我们自己的 `registerMockFetcher`
 */

// ⚠️ 必须第一行：装 jsdom 全局 + 修 React 的事件特性检测（见 dom-env.ts）
import './dom-env';

import { createElement, type ReactElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import {
  act,
  fireEvent,
  render as rtlRender,
  type RenderResult as RtlResult,
} from '@testing-library/react';

import { initI18n } from '../app/i18n';
import { forgetMissingEndpoints } from '../lib/api/client';
import { markSurface, SURFACES, type Surface } from '../lib/api/surfaces';

initI18n();

export interface RenderResult {
  container: HTMLElement;
  unmount: () => void;
  /** 让 query/mutation 的 promise 与随之而来的重渲染落地 */
  flush: () => Promise<void>;
}

export async function render(
  ui: ReactElement,
  opts: { route?: string; queryClient?: QueryClient } = {},
): Promise<RenderResult> {
  const qc =
    opts.queryClient ??
    new QueryClient({
      defaultOptions: {
        // 测试里重试只会拖慢失败用例并掩盖真实错误
        queries: { retry: false, gcTime: 0, staleTime: 0 },
        mutations: { retry: false },
      },
    });

  let result!: RtlResult;
  await act(async () => {
    result = rtlRender(
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

  return { container: result.container, unmount: () => result.unmount(), flush };
}

/* ── 交互（全部走 RTL 的 fireEvent，它内部已做 act 包装）─────────────────── */

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('click: 元素不存在');
  await act(async () => {
    fireEvent.click(el);
  });
}

export async function type(el: Element | null, value: string): Promise<void> {
  if (!el) throw new Error('type: 元素不存在');
  await act(async () => {
    fireEvent.change(el, { target: { value } });
  });
}

export async function pressKey(el: Element | null, key: string): Promise<void> {
  if (!el) throw new Error('pressKey: 元素不存在');
  await act(async () => {
    fireEvent.keyDown(el, { key });
  });
}

export async function blur(el: Element | null): Promise<void> {
  if (!el) throw new Error('blur: 元素不存在');
  await act(async () => {
    fireEvent.blur(el);
  });
}

/* ── 查询 ──────────────────────────────────────────────────────────────── */

export const text = (c: HTMLElement): string => (c.textContent ?? '').replace(/\s+/g, ' ').trim();

export function buttonByText(c: HTMLElement, needle: string): Element | null {
  return (
    Array.from(c.querySelectorAll('button')).find((el) =>
      (el.textContent ?? '').includes(needle),
    ) ?? null
  );
}

/* ── API 打桩 ──────────────────────────────────────────────────────────── */

export interface StubCall {
  path: string;
  method: string;
  body: unknown;
}

/**
 * 用一张 `路径 → 响应` 表打桩，并记录全部调用。
 * 所有 surface 标成 `mock`，避免走真实 fetch。
 */
export function stubApi(routes: Record<string, unknown | ((c: StubCall) => unknown)>): {
  calls: StubCall[];
} {
  const calls: StubCall[] = [];

  /**
   * ★ 打桩打在 **`fetch`** 上，而不是 `registerMockFetcher`。
   *
   * 一开始我桩的是 mock 回落层，结果测的是"回落路径"而不是真实路径。
   * 等 `client.ts` 改成「**写操作永不静默回落 mock**」之后，
   * 写请求不再经过 mock 层，这些用例就集体拿不到调用记录了 ——
   * **测试桩接错了层，这件事本身就被这次改动暴露出来了。**
   *
   * 桩在 fetch 上更忠实：请求真的走完 `realFetch`（含 CSRF 头、credentials、
   * 错误信封解析、端点级记账），只是不出网。
   */
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.replace(/^\/api/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });

    const handler = routes[`${method} ${path}`] ?? routes[path];
    if (handler === undefined) {
      // 未打桩 → 当作"该路由不存在"，正好覆盖端点级记账那条分支
      return new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: `no stub for ${method} ${path}` } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    const payload =
      typeof handler === 'function' ? (handler as (c: StubCall) => unknown)(calls.at(-1)!) : handler;

    /**
     * 桩函数可以直接返回一个 `Response`，用来表达**非 200**。
     *
     * 加这个之前，桩只会把返回值当 body 包成 200 —— 于是"服务端拒绝"这一整类
     * 行为（409 冲突、403、422…）在组件测试里**根本没法构造**，
     * 只能靠不打桩得到的那个 404 凑合。而错误分支恰恰是最该测的：
     * 正常路径用户自己会走通，出错时说什么话才是产品差别所在。
     */
    if (payload instanceof Response) return payload;

    return new Response(JSON.stringify(payload ?? null), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  Object.defineProperty(globalThis, 'fetch', {
    value: fetchStub,
    configurable: true,
    writable: true,
  });
  forgetMissingEndpoints();
  for (const s of SURFACES) markSurface(s as Surface, 'live');
  return { calls };
}
