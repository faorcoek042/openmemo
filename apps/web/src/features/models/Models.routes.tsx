import type { RouteObject } from 'react-router';

import ModelsPage from './ModelsPage';
import ModelDetailPage from './ModelDetailPage';
import StorageSettingsPage from './StorageSettingsPage';

/**
 * 模型域路由片段（T-022 独占）。
 *
 * 由 `src/routes.tsx` 聚合 —— 分片导出是 D-05 §3.4 的反冲突设计：
 * 三个并行任务各改自己的 `*.routes.tsx`，聚合文件只在新增 feature 时动一行。
 */
export const modelsRoutes: RouteObject[] = [
  { path: 'models', element: <ModelsPage /> },
  { path: 'models/:modelId', element: <ModelDetailPage /> },
  // `/settings/storage` 复用模型域的 storage API，归属见 features/models/README.md
  { path: 'settings/storage', element: <StorageSettingsPage /> },
];
