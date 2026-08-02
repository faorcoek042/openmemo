/**
 * 渲染冒烟入口（**验证用，不进产品包**）。
 *
 * 本机没有可用的无头浏览器（chromium 下载超时），而 `curl` 只能拿到 SPA 外壳，
 * 证明不了 React 真的渲染出了东西。所以这里做一次**真实的 DOM 渲染**：
 * 用 jsdom 提供 DOM 环境 + `createRoot` 客户端渲染 + `MemoryRouter`，
 * 把渲染结果的文本导出，由 `scripts` 侧断言关键内容存在。
 *
 * 它证明的是"组件树能挂载并产出预期文本"，**不是**"端到端接通了 daemon"。
 * daemon 的业务事件仍未实现，数据来自 MOCK —— 这一点不会因为本文件而改变。
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { act } from 'react';

import { Providers } from '../app/providers';
import { initI18n } from '../app/i18n';
import { routes } from '../routes';

export async function renderRoute(path: string): Promise<string> {
  initI18n();

  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);

  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(Providers, null, createElement(RouterProvider, { router })));
  });
  // 等 lazy 路由与首批 query 落地
  await act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });

  const text = container.textContent ?? '';
  root.unmount();
  container.remove();
  return text;
}
