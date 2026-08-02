import { lazy } from 'react';
import type { RouteObject } from 'react-router';

const RecorderPage = lazy(() => import('./RecorderPage'));

export const recorderRoutes: RouteObject[] = [{ path: 'record', element: <RecorderPage /> }];
