/**
 * 任务域 SSE 绑定片段（T-021 独占）。
 */

import type { QueryClient } from '@tanstack/react-query';
import { bus } from '../../lib/events/bus';
import { qk } from '../../app/query';
import { pushProgress, useProgressStore } from '../../lib/stores/progress.store';
import type { SseBinding } from '../../lib/events/bindings';
import type { PipelineJobProgress } from '../../lib/events/types';

export const tasksSse: SseBinding = (qc: QueryClient) => [
  /**
   * ★ `job.progress` **绝不碰 Query 缓存**（D-05 §2.3）。
   *
   * 服务端已按 4Hz 节流，但 N 个任务同时跑就是 4N 次/秒。写进 Query 缓存会让
   * 所有订阅任务列表的组件跟着重渲染 —— 一个下载 + 一个转写就足以让
   * 3000 行的转写稿列表掉帧。所以它去 transient store，再节流一次到 200ms。
   */
  bus.on('job.progress', (e: PipelineJobProgress) => {
    pushProgress({
      jobId: e.jobId,
      jobType: e.jobType ?? 'unknown',
      noteUid: e.noteUid,
      state: e.state,
      progress: typeof e.progress === 'number' ? e.progress : 0,
      step: e.step ?? null,
      stepIndex: e.stepIndex,
      stepCount: e.stepCount,
      completedBytes: e.completedBytes ?? null,
      totalBytes: e.totalBytes ?? null,
      speedBps: e.speedBps ?? null,
      etaSeconds: e.etaSeconds ?? null,
    });

    // 终态才动 Query 缓存（低频）
    if (['succeeded', 'failed', 'cancelled'].includes(e.state)) {
      useProgressStore.getState().clear(e.jobId);
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
      if (e.noteUid) void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
    }
  }),

  // 以下三个来自 packages/shared 既有的 14 个事件
  bus.on('job.created', () => {
    void qc.invalidateQueries({ queryKey: qk.jobs.all });
  }),

  bus.on('job.state', () => {
    void qc.invalidateQueries({ queryKey: qk.jobs.all });
  }),

  bus.on('job.failed', (e: { willRetry: boolean }) => {
    void qc.invalidateQueries({ queryKey: qk.jobs.all });
    // 自动重试中的失败不该打扰用户（D-05 §2.3 映射表）
    if (!e.willRetry) bus.emit('ui.toast.jobFailed', e);
  }),
];
