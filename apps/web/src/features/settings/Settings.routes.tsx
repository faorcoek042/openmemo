import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router';

const SettingsPage = lazy(() => import('./SettingsPage'));

export const settingsRoutes: RouteObject[] = [
  { path: 'settings', element: <Navigate to="/settings/general" replace /> },
  { path: 'settings/:section', element: <SettingsPage /> },
];
