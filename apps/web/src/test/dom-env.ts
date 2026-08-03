/**
 * jsdom 环境装配 —— **必须是整条 import 链上第一个被执行的模块**。
 *
 * ## 为什么要单独一个文件（这是个真踩过的坑）
 *
 * 我最初把这段代码写在 `host.tsx` 的顶层语句里，放在 `import react-dom` 之上，
 * 以为"写在前面就先执行"。**错了**：ESM 里一个模块的**所有 import 都先于它自己的语句执行**，
 * 打包器还会进一步 hoist。于是 react-dom 在 DOM 全局就绪之前就完成了模块初始化，
 * 它的事件特性检测（见下）在一个空 global 上跑，结论全错。
 *
 * 症状极具误导性：报错栈全在 react-dom 内部
 * （`activeElement$1.attachEvent is not a function`），看起来像 React 的 bug。
 *
 * → 只有把它拆成**独立模块**并作为第一个 import，ESM 的"深度优先、按 import 顺序执行"
 *   才能保证它先跑。
 *
 * ## ⚠️ T-133 更正：上面这条**在源码里成立，在打包产物里不成立**
 *
 * 组件测试跑的是 `vite build --ssr` 的产物。本文件是相对导入 → 被**内联进包体**；
 * `@testing-library/react` 是外部依赖 → 保留成 `import` 语句并被 rollup **提升到最顶部**。
 * 于是 react-dom 的模块初始化排在 `new JSDOM(...)` **前面** —— 正是本文件开头说
 * "打包器还会进一步 hoist" 的那个坑，只不过它对**外部依赖**依旧存在，拆文件挡不住。
 *
 * 后果不是报错，是**静默失效**：`canUseDOM=false` → 受控文本输入框收不到 `onChange`。
 * 真正的修法在 `host.tsx`（把 RTL 改成动态 import，见那边的 T-133 一节）。
 * 本文件保持不变即可 —— 它的职责是"把全局装好"，而不是"保证自己排第一"。
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:17650/',
  pretendToBeVisual: true,
});

export const jsdomWindow = dom.window as unknown as Window & typeof globalThis;

const define = (key: string, value: unknown): void => {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
};

define('window', jsdomWindow);
define('document', jsdomWindow.document);
define('navigator', jsdomWindow.navigator);
define('location', jsdomWindow.location);

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
  define(k, (jsdomWindow as unknown as Record<string, unknown>)[k]);
}

define('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
define('cancelAnimationFrame', (id: number) => clearTimeout(id));
define('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
define(
  'BroadcastChannel',
  class {
    postMessage(): void {}
    addEventListener(): void {}
    close(): void {}
  },
);
/** React 的 act 环境开关。交互全部包在 act 里，保证 setState 在返回前提交。 */
define('IS_REACT_ACT_ENVIRONMENT', true);

/**
 * ★ 让 React 走现代事件路径，而不是 IE 时代的 polyfill。
 *
 * React 在**模块初始化时**用 `'oninput' in document` 判断浏览器是否原生支持 input 事件。
 * jsdom 的 `document` 上没有 `oninput` 属性 → 判定为"不支持" →
 * React 退回 `handleEventsForInputEventPolyfill`，该路径调用 IE 的
 * `attachEvent` / `detachEvent`，jsdom 里根本不存在 → 一输入就抛异常。
 *
 * 因为这个检测发生在**模块初始化时**，属性必须在 react-dom 被 import 之前挂好 ——
 * 这也正是本文件必须独立且最先执行的第二个理由。
 *
 * ⚠️ T-133 实测（jsdom 30.0.1）：`'oninput' in document` **现在已经是 `true`**，
 * 下面这个循环因此一条都不会命中，是死代码。保留它有两个理由：
 * ① 它是无副作用的兜底，jsdom 降级或换环境时仍然有用；
 * ② 更重要的是**别把它当成修复**——当年那个 `attachEvent` 崩溃的真正病根是
 *    `canUseDOM === false`（连 `isEventSupported` 都没被调用过），
 *    把 `oninput` 挂上去在那种状态下**一点用都没有**。见本文件头 T-133 一节。
 */
for (const evt of ['oninput', 'onchange', 'onkeydown', 'onkeyup', 'onfocusin', 'onfocusout']) {
  if (!(evt in jsdomWindow.document)) {
    Object.defineProperty(jsdomWindow.document, evt, {
      value: null,
      writable: true,
      configurable: true,
    });
  }
}

/** 断言用中文文案；jsdom 的 navigator.language 是 en-US，不钉死会渲染英文。 */
try {
  jsdomWindow.localStorage.setItem('openmemo.locale', 'zh-CN');
} catch {
  /* ignore */
}
