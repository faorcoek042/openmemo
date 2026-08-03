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

import { componentsSse } from '../../features/components/sse';
import { modelsSse } from '../../features/models/sse';
import { runtimeSse } from '../../features/runtime/sse';
/*
 * ⚠️ 这里原来留着一行 `// import { mindmapSse } from '../../features/mindmap/sse';`
 * 和一句"T-023 认领后在此追加"。**那个文件不需要存在**，注释已按实测更正（T-139）。
 *
 * 盘点把"`mindmap.done` 没有订阅者"记成了"导图生成完页面不刷新"的原因。
 * 实测（真 daemon + 真浏览器）：daemon 在导图落库后**同时**发
 * `mindmap.done` 与 `note.updated{changed:['mindmap']}`，
 * 而 `notesSse` 一直订阅着后者并 invalidate `qk.mindmap(noteUid)` ——
 * 浏览器网络日志里能看到那次 `GET /notes/:uid/mindmap` 真的发生了。
 * 所以缓存这一层**没有断**；断的是渲染器（见 `features/mindmap/MindmapView.tsx`）。
 *
 * 那为什么不顺手补一个 `mindmapSse`？因为它会是**第二个**"导图变了"的触发源，
 * 而 `note.updated` 还覆盖 `PATCH`（手工编辑保存）这条 `mindmap.done` 不发的路径 ——
 * 留一个不完整的第二来源，正是本项目反复吃亏的形状（"两处对同一问题给出不同答案"）。
 * `mindmap.done` / `mindmap.delta` 目前在前端**确实没有消费者**，这是如实的现状，
 * 不是等着被补的洞。
 */

export type SseBinding = (qc: QueryClient) => (() => void)[];

const BINDINGS: SseBinding[] = [systemSse, notesSse, tasksSse, modelsSse, runtimeSse, componentsSse];

/** 注册全部绑定，返回统一的注销函数。 */
export function registerAllSseBindings(qc: QueryClient): () => void {
  const disposers = BINDINGS.flatMap((b) => b(qc));
  return () => disposers.forEach((d) => d());
}
