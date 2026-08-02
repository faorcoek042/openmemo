import type { RouteObject } from 'react-router';

import RuntimePage from './RuntimePage';

/** 运行时域路由片段（T-022 独占）。由 `src/routes.tsx` 聚合。 */
export const runtimeRoutes: RouteObject[] = [{ path: 'runtime', element: <RuntimePage /> }];
