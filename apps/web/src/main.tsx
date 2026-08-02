import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { Providers } from './app/providers';
import { initI18n } from './app/i18n';
import { routes } from './routes';
import './index.css';

/**
 * ⚠️ react-router **v8 起已移除 `react-router-dom` 包**：
 * `RouterProvider` 从 `react-router/dom` 导入，其余从 `react-router`。
 * 按 v7 的旧写法 import 会直接解析失败。
 *
 * 采用 **Data 模式**（`createBrowserRouter` + `RouterProvider`）：
 * 它不需要任何 Vite 插件，是纯库调用 —— 与 D-05 §3.4 的"每个 feature 导出路由对象数组、
 * 聚合文件只做拼接"完美契合。不选 Framework 模式，是因为它需要 `@react-router/dev`
 * 插件 + 约定式 `routes.ts`，会把路由结构绑到它的构建约定上，削弱这个反冲突设计；
 * 而我们是纯 SPA，也用不到它的 SSR 与自动分包。
 */
initI18n();

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root not found in index.html');
}

const router = createBrowserRouter(routes);

createRoot(container).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
