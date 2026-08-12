/**
 * 任务域 SSE 绑定片段（T-021 独占）。
 */

import type { QueryClient } from '@tanstack/react-query';
import type { JobProgressEvent, JobStateEvent } from '@openmemo/shared';
import { TERMINAL_JOB_STATES, fractionOf } from '@openmemo/shared';

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
      /*
       * ★ #90：这一行以前是 `progress: e.pct ?? 0`，**同时错了两件事**。
       *
       * ① 量纲：`e.pct` 从流水线那侧来的是 0–100（`daemon/src/jobs/events.ts` 曾写
       *    `fraction * 100`），而 store / `ProgressMeter` / `formatPercent` 全按 0–1 用。
       *    ⇒ 任何 ≥1 的帧一到，界面就永久钉在 100%。审计用 playwright 掐断
       *    `/api/events` 做过反证：同一条任务立刻显示 71%（服务端的 0–1 值），
       *    实时通道一恢复就跳回 100%。
       * ② `?? 0`：契约里"报不出进度"的表达被兜底成了 **0%** ——
       *    正是 `features/models/sse.ts` 用一整段注释在防的那件事
       *    （"正在安装"显示成停在 0% 的进度条，一个看起来精确的假话）。
       *    **同一条规则，隔壁文件守着，这里破着。**
       *
       * `fractionOf()` 是唯一读取点：它要么给 0–1，要么给 `null`＝「这一步没有刻度」。
       * store 的 `progress` 本来就是 `number | null`，`null` 由渲染层用不确定表达画。
       */
      progress: fractionOf(e.progress),
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

  /**
   * ★ T-198：**终态也要清 `progressStore`。**
   *
   * 此前只有上面那条 `job.progress` 在终态时清 store —— 而**取消发的是
   * `job.state`，不是 `job.progress`**。于是取消之后，那条陈旧的
   * `running` / `resolving` 快照留在 store 里，`mergeOne()` 又让它压过服务端行，
   * 用户看到一条"已取消"的任务仍然显示「进行中 · 正在选择下载源」。
   *
   * 两处都清是刻意的（不是把上面那条挪下来）：`job.progress` 的终态帧和
   * `job.state` 谁先到没有保证，少任何一条都会留下同一个残影。
   */
  bus.on('job.state', (e: JobStateEvent) => {
    if ((TERMINAL_JOB_STATES as readonly string[]).includes(e.state)) {
      useProgressStore.getState().clear(e.jobId);
      /*
       * ★ 终态也要让**笔记**失效（#98）。
       *
       * `notes.status` 现在是 daemon 在读的时候从 job 状态算出来的
       * （`jobs/noteStatus.ts`），`NoteDetail.lastFailure` 同理 ——
       * 也就是说**一条任务到达终态，就是这条笔记的状态变了**。
       * 只失效 `jobs` 的话，列表里那条「处理中」要等下一次手动刷新才会变成「失败」，
       * 而这正是这一轮在修的那个病（用户得刷新才能看见真相）的翻版。
       */
      void qc.invalidateQueries({ queryKey: qk.notes.all });
    }
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

  /**
   * ★ `bus.emit('ui.toast.jobFailed', e)` **删掉了**（#98 ⑤）。
   *
   * 它长得像接线，其实是死代码：全仓 `ui.toast.*` 有 **2 个 emit、0 个 `bus.on`**，
   * 而且这个事件名根本不在 `EventMap` 里 —— 当时 `bus.emit(type: string, …)` 的签名
   * 是**宽**的，所以它编译得过、跑得过、什么都不做。
   *
   * ⚠️ 后半句已经不成立了，**而这是好事**：`bus.emit` 现在按事件名索引
   * （`emit<K extends keyof EventMap>`，见 `lib/events/bus.ts`），
   * 线上来的那一档单独叫 `emitFromWire`。也就是说**这一行今天再写回来会直接编译不过** ——
   * 当初让它活下来的那个洞已经堵上，不必再靠这段注释看着它。
   *
   * 危害不是"多了两行"，是**它会骗人**：任何人读到这一行都会以为失败 toast 是它发的，
   * 于是去改它、去它的订阅端找 bug。真正的 toast 走的是另一条路 ——
   * `JobToaster.tsx` 自己 `bus.on('job.failed', …)`，直接吃 SSE 的原始事件。
   * （本轮修 #98 时正是先照着这一行找了一圈订阅者，才发现根本没有。）
   *
   * 保留的那半句判断（`willRetry` 时不打扰用户）**已经在真正的消费方里**：
   * `jobToastModel.ts` 的 `job.failed` 分支 —— `willRetry` 为真时 phase 保持
   * `active` 并降级成「正在自动重试」，也只有为假时才补建一条 toast。
   * 也就是说这里删掉之后，那条规则一条都没少，只是不再有第二份写在没人走的路上。
   */
  bus.on('job.failed', () => {
    void qc.invalidateQueries({ queryKey: qk.jobs.all });
    /*
     * 失败也要让笔记失效 —— 理由同上面 `job.state` 那条：`notes.status` 的
     * 「失败」和 `NoteDetail.lastFailure` 都是从这条事实推出来的。
     * ⚠️ **不按 `willRetry` 区分**：还会自动重试的那次失败会把 job 置回 `queued`，
     * 笔记状态因此仍是「处理中」—— 重新拉一次得到的还是同一句话，不会闪。
     */
    void qc.invalidateQueries({ queryKey: qk.notes.all });
  }),
];
