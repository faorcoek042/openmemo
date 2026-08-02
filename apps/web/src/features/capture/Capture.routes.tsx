import { lazy } from 'react';
import type { RouteObject } from 'react-router';

/**
 * 路由片段（D-05 §3.4）。
 *
 * ★ 每个 feature 导出自己的片段，`src/routes.tsx` 只做聚合 ★
 * 于是 T-021 / T-022 / T-023 各改各的文件，聚合文件只在新增 feature 时动一行。
 * 这是把写冲突**结构性消灭**，而不是靠"记得别同时改"的君子协议。
 */
const CapturePage = lazy(() => import('./CapturePage'));

export const captureRoutes: RouteObject[] = [{ path: 'capture', element: <CapturePage /> }];
