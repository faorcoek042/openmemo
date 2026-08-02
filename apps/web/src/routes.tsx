import type { RouteObject } from 'react-router';

import App from './App';
import { captureRoutes } from './features/capture/Capture.routes';
import { notesRoutes } from './features/notes/Notes.routes';
import { recorderRoutes } from './features/recorder/Recorder.routes';
import { settingsRoutes } from './features/settings/Settings.routes';
import { tasksRoutes } from './features/tasks/Tasks.routes';

/**
 * ★ 本文件**只做聚合**（D-05 §3.4 的反冲突设计）★
 *
 * 每个 feature 导出自己的路由片段，这里只 import 并展开。
 * 三个并行任务各改各 feature 目录里的 `*.routes.tsx`，
 * 本文件只在**新增一个 feature 时**才动一行 —— 写冲突被结构性消灭。
 *
 * T-022 / T-023 认领后在此追加：
 *   import { modelsRoutes }  from './features/models/Models.routes';
 *   import { runtimeRoutes } from './features/runtime/Runtime.routes';
 *   import { mindmapRoutes } from './features/mindmap/Mindmap.routes';
 * 并加进下面的数组。
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      ...notesRoutes,
      ...captureRoutes,
      ...recorderRoutes,
      ...tasksRoutes,
      ...settingsRoutes,
      // ...modelsRoutes,   // T-022
      // ...runtimeRoutes,  // T-022
      // ...mindmapRoutes,  // T-023
    ],
  },
];
