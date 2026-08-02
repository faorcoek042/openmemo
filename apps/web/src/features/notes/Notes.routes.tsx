import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router';

import { isOnboardingDone } from '../onboarding';

const NotesListPage = lazy(() => import('./NotesListPage'));
const NoteDetailPage = lazy(() => import('./NoteDetailPage'));

export const notesRoutes: RouteObject[] = [
  // 未走过引导的新用户先去 /onboarding —— 否则打开就是一片空白，
  // 没人告诉他要先装模型（章程要求 2.1/2.2 的第一步）。
  { index: true, element: <Navigate to={isOnboardingDone() ? '/notes' : '/onboarding'} replace /> },
  { path: 'notes', element: <NotesListPage /> },
  { path: 'notes/:noteUid', element: <NoteDetailPage /> },
];
