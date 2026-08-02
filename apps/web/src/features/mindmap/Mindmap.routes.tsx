import { lazy } from 'react';
import type { RouteObject } from 'react-router';

const MindmapPage = lazy(() => import('./MindmapPage'));

export const mindmapRoutes: RouteObject[] = [
  { path: 'notes/:noteUid/mindmap', element: <MindmapPage /> },
];
