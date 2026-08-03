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
 *
 * ## ★ T-133：为什么 `@testing-library/react` 必须**动态** import
 *
 * `dom-env.ts` 的文件头写了「必须是整条 import 链上第一个被执行的模块」，
 * 在**源码**里这条是成立的（ESM 深度优先按 import 顺序求值）。
 * 但组件测试跑的不是源码，是 `vite build --ssr` 打出来的**单文件包**：
 * dom-env 是相对导入 → 被**内联进包体**；`@testing-library/react` 是外部依赖
 * → 保留成 `import` 语句并被 rollup **提升到文件最顶部**。
 * 于是产物里的真实顺序是：
 *
 * ```
 * import { JSDOM } from "jsdom";                 // ← 只是拿到构造函数，还没建 DOM
 * import { act, fireEvent, render } from "@testing-library/react";  // ← react-dom 在这里初始化
 * …
 * var jsdomWindow = new JSDOM(…);                // ← 包体，全局装配发生在**这之后**
 * ```
 *
 * react-dom 在模块初始化时算 `canUseDOM = typeof window !== 'undefined' && …`，
 * 此刻还没有 `window` → `canUseDOM === false` → `isInputEventSupported` 定死为 `false`
 * → `ChangeEventPlugin` 对**文本输入框**改走 IE 的 `onpropertychange` polyfill 分支，
 * 那条分支只认 `keyup`/`keydown`/`selectionchange`，**`input`/`change` 直接被丢掉**。
 * 症状就是「`fireEvent.change` / `fireEvent.input` / 原型链原生 setter 全都不管用，
 * 而且一声不吭」—— 因为问题根本不在事件怎么派发，**在 react-dom 早就初始化错了**。
 * `<select>` 不受影响（走的是 `shouldUseChangeEvent` 那条独立分支），
 * 所以现象是"下拉框好的、文本框是死的"。
 *
 * 顺带被 `canUseDOM === false` 拖下水的还有：composition/beforeInput（IME）、
 * animation/transitionend 的厂商前缀探测。都是同一个根因。
 *
 * → 修法是**推迟 react-dom 的模块初始化**，而不是换一种派发事件的写法。
 *   动态 import 的求值时机在包体里，`dom-env` 已经跑完了。
 * → 另外 `type()` 首次调用会做一次自检（见 `assertTypeReachesReact`），
 *   这类失效是静默的，必须有人在测试里替它喊出来。
 */

// ⚠️ 必须第一行：装 jsdom 全局 + 修 React 的事件特性检测（见 dom-env.ts）
import './dom-env';

import { createElement, useState, type ReactElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { RenderResult as RtlResult } from '@testing-library/react';

import { initI18n } from '../app/i18n';
import { forgetMissingEndpoints } from '../lib/api/client';
import { markSurface, SURFACES, type Surface } from '../lib/api/surfaces';

initI18n();

/**
 * RTL 的**延迟加载**。见文件头 T-133：静态 import 会被打包器提升到 `dom-env` 之前。
 *
 * 只加载一次（`node --test` 一个进程跑完整个套件），后续调用命中同一个 promise。
 * `@tanstack/react-query` 与 `react-router` 保持静态 import 是安全的 ——
 * 两者都不 import `react-dom/client`（已 grep 确认），也就不会触发那次特性探测。
 */
const importRtl = () => import('@testing-library/react');
type Rtl = Awaited<ReturnType<typeof importRtl>>;
let rtlPromise: Promise<Rtl> | undefined;
async function rtl(): Promise<Rtl> {
  rtlPromise ??= importRtl();
  return rtlPromise;
}

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

  const { act, render: rtlRender } = await rtl();

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
    const { act: act2 } = await rtl();
    await act2(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  await flush();

  return { container: result.container, unmount: () => result.unmount(), flush };
}

/* ── 交互（全部走 RTL 的 fireEvent，它内部已做 act 包装）─────────────────── */

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('click: 元素不存在');
  const { act, fireEvent } = await rtl();
  await act(async () => {
    fireEvent.click(el);
  });
}

/**
 * ★ 宿主自检：证明「文本输入真的能驱动 React 的 state」，**不是**只把 DOM 属性改了。
 *
 * 为什么要有它（T-133）：这条链路一旦断掉（见文件头），表现是
 * **一声不吭地什么都不做** —— `el.value` 照样是新值（那是原生 setter 写进去的），
 * 组件的 `onChange` 一次都没进，state 恒为初值。
 * 于是任何"输入 → 提交 → 断言请求发出去了"的用例都会变成
 * **在断言"什么都没发生"**，而它是绿的。本项目已经真实吃过一次这个亏
 * （`storage-fix` T-128b §5：一条"没有失效链接时不显示警告块"的用例，
 * 实际上 mutation 根本没发出去）。
 *
 * 判据必须是**渲染出来的 state**，不能是 `input.value`：
 * 受控组件里这两者在缺陷状态下恰好会分叉，而分叉正是这个 bug 的本体。
 * （同 HANDOFF「断言要钉后果，不要钉形式」。）
 *
 * 一个进程只跑一次，成本是一次 1 个节点的渲染。
 */
let typeSelfCheck: Promise<void> | undefined;

async function assertTypeReachesReact(): Promise<void> {
  const { act, fireEvent, render: rtlRender } = await rtl();

  function Probe(): ReactElement {
    const [v, setV] = useState('');
    return createElement(
      'div',
      null,
      createElement('input', {
        type: 'text',
        value: v,
        onChange: (e: { target: { value: string } }) => setV(e.target.value),
      }),
      // state 的**唯一**出口：它变了才说明 setState 真的提交了
      createElement('b', { 'data-probe': 'state' }, v),
    );
  }

  let r!: RtlResult;
  await act(async () => {
    r = rtlRender(createElement(Probe));
  });
  const input = r.container.querySelector('input')!;
  await act(async () => {
    fireEvent.change(input, { target: { value: 'ok' } });
  });
  const rendered = r.container.querySelector('b')?.textContent ?? '';
  const domValue = input.value;
  r.unmount();

  if (rendered !== 'ok') {
    throw new Error(
      `宿主自检失败：type() 驱动不了受控输入框。\n` +
        `  DOM 的 input.value = ${JSON.stringify(domValue)}（原生 setter 写进去的，不代表 React 收到了）\n` +
        `  React 渲染出的 state = ${JSON.stringify(rendered)}（应为 "ok"）\n` +
        `  → 几乎可以肯定是 react-dom 的模块初始化又跑到了 dom-env 前面（canUseDOM=false）。\n` +
        `    见 host.tsx 文件头 T-133 一节。**不要**改 type() 的事件派发写法，那不是病根。\n` +
        `  ⚠️ 在这条自检存在之前，这种状态下测试是**全绿**的 —— 因为什么都没发生。`,
    );
  }
}

export async function type(el: Element | null, value: string): Promise<void> {
  if (!el) throw new Error('type: 元素不存在');
  typeSelfCheck ??= assertTypeReachesReact();
  await typeSelfCheck;

  const { act, fireEvent } = await rtl();
  await act(async () => {
    fireEvent.change(el, { target: { value } });
  });
}

export async function pressKey(el: Element | null, key: string): Promise<void> {
  if (!el) throw new Error('pressKey: 元素不存在');
  const { act, fireEvent } = await rtl();
  await act(async () => {
    fireEvent.keyDown(el, { key });
  });
}

/**
 * 触发失焦。
 *
 * 背景：React 17 起把 `onBlur` 挂在**根容器**上，监听的是会冒泡的 `focusout`，
 * 而不是不冒泡的 `blur`。只发原生 `blur` 的话事件到不了根容器，
 * `onBlur` **永远不会触发** —— 表现是"测试跑绿、回调一次没进"。
 *
 * ⚠️ **T-133 更正**：为此手工补一句 `fireEvent.focusOut(el)` 是**多余且有害**的。
 * `@testing-library/react` 的 `fireEvent.blur` **自己就先派发 `focusOut` 再派发 `blur`**
 * （见 RTL `dist/fire-event.js`，那段注释直接引了 React PR #19186）。
 * 两边都发 = `focusout` 派发两次 = **`onBlur` 跑两遍**。
 * 后果是"失焦保存"这类组件在测试里会发出**两条**请求，
 * 于是断言要么写成 `calls.length === 2`（把缺陷写成期望），要么用 `find()`
 * 把重复悄悄吞掉 —— 两条路都会让真实的重复提交缺陷再也测不出来。
 * 这条是本套件的 `★ 输入 + 失焦提交` 用例抓出来的（`['x','x'] !== ['x']`）。
 */
export async function blur(el: Element | null): Promise<void> {
  if (!el) throw new Error('blur: 元素不存在');
  const { act, fireEvent } = await rtl();
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
