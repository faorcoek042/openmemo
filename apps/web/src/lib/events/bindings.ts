/**
 * SSE → TanStack Query 的绑定层。
 *
 * ★ 本文件**只做聚合**（D-05 §3.4 的反冲突设计）★
 *
 * 每个 feature 导出自己的 `*Sse` 绑定片段，这里只 import 并依次注册。
 * 于是 T-021 / T-022 / T-023 各改各 feature 目录里的文件，
 * 本文件只在**新增一个 feature 时**才动一行 —— 三方并行的写冲突被结构性消灭，
 * 而不是靠"记得别同时改"的君子协议。
 *
 * 同样的手法用在 routes.tsx。
 */

import type { QueryClient } from '@tanstack/react-query';

import { notesSse } from '../../features/notes/sse';
import { tasksSse } from '../../features/tasks/sse';
import { systemSse } from './system.sse';

// T-022 / T-023 认领各自 feature 后，在此追加一行 import + 一个数组项。
// import { modelsSse } from '../../features/models/sse';
// import { runtimeSse } from '../../features/runtime/sse';
// import { mindmapSse } from '../../features/mindmap/sse';

export type SseBinding = (qc: QueryClient) => (() => void)[];

const BINDINGS: SseBinding[] = [systemSse, notesSse, tasksSse];

/** 注册全部绑定，返回统一的注销函数。 */
export function registerAllSseBindings(qc: QueryClient): () => void {
  const disposers = BINDINGS.flatMap((b) => b(qc));
  return () => disposers.forEach((d) => d());
}
