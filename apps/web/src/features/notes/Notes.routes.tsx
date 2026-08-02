import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router';

const NotesListPage = lazy(() => import('./NotesListPage'));
const NoteDetailPage = lazy(() => import('./NoteDetailPage'));

export const notesRoutes: RouteObject[] = [
  { index: true, element: <Navigate to="/notes" replace /> },
  { path: 'notes', element: <NotesListPage /> },
  { path: 'notes/:noteUid', element: <NoteDetailPage /> },
];
