import { lazy } from 'react';
import type { RouteObject } from 'react-router';

const DiagnosticsPage = lazy(() => import('./DiagnosticsPage'));

export const diagnosticsRoutes: RouteObject[] = [
  { path: 'diagnostics', element: <DiagnosticsPage /> },
];
