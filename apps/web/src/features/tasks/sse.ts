/**
 * 任务域 SSE 绑定片段（T-021 独占）。
 */

import type { QueryClient } from '@tanstack/react-query';
import type { JobFailedEvent, JobProgressEvent, JobStateEvent } from '@openmemo/shared';
import { TERMINAL_JOB_STATES } from '@openmemo/shared';

import { bus } from '../../lib/events/bus';
import { qk } from '../../app/query';
import { pushProgress, useProgressStore } from '../../lib/stores/progress.store';
import type { SseBinding } from '../../lib/events/bindings';

export const tasksSse: SseBinding = (qc: QueryClient) => [
  /**
   * ★ `job.progress` **绝不碰 Query 缓存**（D-05 §2.3）。
   *
   * 服务端已按 4Hz 节流，但 N 个任务同时跑就是 4N 次/秒。写进 Query 缓存会让
   * 所有订阅任务列表的组件跟着重渲染 —— 一个下载 + 一个转写就足以让
   * 3000 行的转写稿列表掉帧。所以它进 transient store，再节流一次到 200ms。
   */
  bus.on('job.progress', (e: JobProgressEvent) => {
    pushProgress({
      jobId: e.jobId,
      // shared 的 JobProgressEvent 目前不带 jobType / noteUid（已上报）：
      // 从 topic（形如 "job:01J8…"）只能拿到 jobId，类型只好留空由列表页 join 补。
      jobType: 'job',
      state: e.state,
      progress: e.pct ?? 0,
      step: e.step,
      completedBytes: e.completedBytes,
      totalBytes: e.totalBytes,
      speedBps: e.speedBps,
      etaSeconds: e.etaSeconds,
    });

    // 只有终态才动 Query 缓存（低频）
    if ((TERMINAL_JOB_STATES as readonly string[]).includes(e.state)) {
      useProgressStore.getState().clear(e.jobId);
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
      void qc.invalidateQueries({ queryKey: qk.notes.all });
    }
  }),

  bus.on('job.created', () => {
    void qc.invalidateQueries({ queryKey: qk.jobs.all });
  }),

  bus.on('job.state', (_e: JobStateEvent) => {
    void qc.invalidateQueries({ queryKey: qk.jobs.all });
  }),

  bus.on('job.done', () => {
    void qc.invalidateQueries({ queryKey: qk.jobs.all });
    void qc.invalidateQueries({ queryKey: qk.notes.all });
  }),

  /**
   * `blocked` 是产品级重要状态：缺前置条件（模型没装 / 磁盘不足 / 没配 Key）。
   * 它**必须**在 UI 上带一个可点击的修复按钮，否则"用户不碰命令行"就没做到。
   */
  bus.on('job.blocked', () => {
    void qc.invalidateQueries({ queryKey: qk.jobs.all });
  }),

  bus.on('job.failed', (e: JobFailedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.jobs.all });
    // 自动重试中的失败不该打扰用户（D-05 §2.3 映射表）
    if (!e.willRetry) bus.emit('ui.toast.jobFailed', e);
  }),
];
