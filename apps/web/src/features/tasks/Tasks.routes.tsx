import { lazy } from 'react';
import type { RouteObject } from 'react-router';

const TasksPage = lazy(() => import('./TasksPage'));

export const tasksRoutes: RouteObject[] = [{ path: 'tasks', element: <TasksPage /> }];
