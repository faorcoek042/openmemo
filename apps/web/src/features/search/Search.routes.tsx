import { lazy } from 'react';
import type { RouteObject } from 'react-router';

const SearchPage = lazy(() => import('./SearchPage'));

export const searchRoutes: RouteObject[] = [{ path: 'search', element: <SearchPage /> }];
