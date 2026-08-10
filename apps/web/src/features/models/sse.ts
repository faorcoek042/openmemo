/**
 * 模型域 SSE 绑定片段（T-022 独占）。
 *
 * ⚠️ 我是发这些事件的人（`packages/shared/src/events.ts`），所以要特别提醒消费侧的坑：
 * `formatSseFrame()` 发的是具名 `event: <type>` 帧，因此 **`EventSource.onmessage` 永远不触发**，
 * 必须逐类型 `addEventListener` —— 这件事已经由 `lib/events/source.ts` 遍历
 * `ALL_SSE_EVENT_TYPES` 统一处理，本文件只需从 `bus` 订阅。
 *
 * 分发原则（D-01 §3.3）：**事件只是"该去拉数据了"的提示，真相在 REST。**
 * 唯一例外是 `job.progress` —— 它进 transient store，用完即弃，绝不碰 Query 缓存。
 */

import type { QueryClient } from '@tanstack/react-query';
import type {
  CatalogUpdatedEvent,
  JobProgressEvent,
  ModelActivatedEvent,
  ModelInstalledEvent,
  ModelRemovedEvent,
  SourcesProbedEvent,
  StorageChangedEvent,
} from '@openmemo/shared';
import { TERMINAL_JOB_STATES } from '@openmemo/shared';

import { bus } from '../../lib/events/bus';
import { qk } from '../../app/query';
import { pushProgress, useProgressStore } from '../../lib/stores/progress.store';
import type { SseBinding } from '../../lib/events/bindings';

export const modelsSse: SseBinding = (qc: QueryClient) => [
  /**
   * 下载进度 → transient store（已在 store 内节流到 200ms）。
   *
   * 与 `features/tasks/sse.ts` 的订阅**并存不冲突**：bus 是多订阅者广播，
   * 两个 feature 各自 push 到同一个 store 是幂等的（同 jobId 覆盖）。
   * 这里额外补上模型域独有的信息：下载类任务的 `step` 是 resolving/downloading/verifying/installing。
   */
  /*
   * ★★ T-198 / S-2：**这里也必须在终态清 store。**
   *
   * `[实测]` `lib/events/bindings.ts` 里 `tasksSse` 注册在 `modelsSse` **之前**，
   * `lib/events/bus.ts` 按 Set 插入序**同步**遍历。于是一次终态 `job.progress`
   * 的真实次序是：`tasks push → tasks clear → models push`
   * —— **tasks 那侧刚清掉的快照，被这里当场写了回去。**
   *
   * 也就是说：只在 `features/tasks/sse.ts` 里清是不够的，那个修会被同一个事件的
   * 下一个订阅者原地撤销，人还会以为自己没修好。两侧都清才成立。
   *
   * ⚠️ 这不是"重复代码"，两个 feature 各自订阅同一事件本来就是设计
   *（上面那段注释写着"并存不冲突"）—— 那么**收尾也各自负责**。
   */
  bus.on('job.progress', (e: JobProgressEvent) => {
    if ((TERMINAL_JOB_STATES as readonly string[]).includes(e.state)) {
      useProgressStore.getState().clear(e.jobId);
      return;
    }
    pushProgress({
      jobId: e.jobId,
      jobType: 'download',
      state: e.state,
      /*
       * ★ `pct: null` 的意思是「这一步报不出进度」（契约原话：
       *   "Null when the step genuinely cannot report a fraction."），
       *   **不是 0%**。以前这里兜底成 0，于是"正在安装"显示成停在 0% 的进度条 ——
       *   一条看起来精确的假话。现在原样传 null，由渲染层用**不确定表达**去画。
       */
      progress:
        e.pct ??
        (e.totalBytes && e.completedBytes != null ? e.completedBytes / e.totalBytes : null),
      step: e.step,
      completedBytes: e.completedBytes,
      totalBytes: e.totalBytes,
      speedBps: e.speedBps,
      etaSeconds: e.etaSeconds,
    });
  }),

  /**
   * 装好了 → 目录、已安装列表、磁盘占用三处都变了。
   * 目录也要失效：`installed` 标记和 fit 判定都在 catalog 响应里。
   */
  bus.on('model.installed', (_e: ModelInstalledEvent) => {
    void qc.invalidateQueries({ queryKey: qk.models.installed });
    void qc.invalidateQueries({ queryKey: qk.models.catalog });
    void qc.invalidateQueries({ queryKey: qk.models.storage });
  }),

  bus.on('model.removed', (_e: ModelRemovedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.models.installed });
    void qc.invalidateQueries({ queryKey: qk.models.catalog });
    void qc.invalidateQueries({ queryKey: qk.models.storage });
  }),

  bus.on('model.activated', (_e: ModelActivatedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.models.installed });
  }),

  bus.on('storage.changed', (_e: StorageChangedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.models.storage });
  }),

  bus.on('catalog.updated', (_e: CatalogUpdatedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.models.catalog });
  }),

  bus.on('sources.probed', (_e: SourcesProbedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.models.sources });
  }),
];
