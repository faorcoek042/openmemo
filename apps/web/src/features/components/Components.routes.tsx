import type { RouteObject } from 'react-router';

import ComponentsPage from './ComponentsPage';

/** 组件域路由片段（T-068 独占）。由 `src/routes.tsx` 聚合。 */
export const componentsRoutes: RouteObject[] = [
  { path: 'components', element: <ComponentsPage /> },
];
