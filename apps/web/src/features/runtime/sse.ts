/**
 * 运行时域 SSE 绑定片段（T-022 独占）。
 *
 * 后端包下载与模型下载**共用同一个下载器与同一条 SSE 流**（ADR-003 决策 6），
 * 所以 `job.progress` 的订阅在 models/tasks 侧已经处理；这里只关心后端域的终态事件。
 */

import type { QueryClient } from '@tanstack/react-query';
import type {
  BackendInstalledEvent,
  BackendRemovedEvent,
  HardwareChangedEvent,
} from '@openmemo/shared';

import { bus } from '../../lib/events/bus';
import { qk } from '../../app/query';
import type { SseBinding } from '../../lib/events/bindings';

export const runtimeSse: SseBinding = (qc: QueryClient) => [
  /*
   * ★ 这里原来有一句
   *     if (e.selfTestPassed === false) bus.emit('ui.toast.backendSelfTestFailed', e);
   *   顶着注释「自检失败必须显性告知（ADR-003 决策 3），不能静默」。
   *   **删掉了**（#98 ⑤）—— 它是一句从来没有执行过任何效果的话。
   *
   * `ui.toast.*` 全仓 **2 个 emit、0 个 `bus.on`**，事件名也不在 `EventMap` 里；
   * `bus.emit(type: string, …)` 的签名是宽的，所以它编译得过、跑得过、什么都不做。
   * 也就是说：那条注释描述的承诺**从未兑现**，而它的存在会让每个读到的人
   * 以为已经兑现了 —— 本仓最贵的那一类「描述了不存在事实的代码」。
   *
   * ⚠️ 删之前核过这个事实今天在哪儿说：**`/runtime` 的后端包卡片**
   * （`components/BackendPackCard.tsx` 用 `selfTestVerdict()` 分四档，
   *  `failed` 那一档是红的），数据来自 `qk.backends.installed` —— 而它正被
   * 上面这两行重新拉取。所以删掉这一行，用户能看见的东西一个字都没少。
   * 少的是一句假装还有第二条通道的代码。
   *
   * ⚠️ 仍然**没有**全局提示：自检失败只在 `/runtime` 页上说。
   * 那与 ADR-003 「不能静默」是否够，不在本轮范围内，已在回执里单独提出。
   */
  bus.on('backend.installed', (_e: BackendInstalledEvent) => {
    void qc.invalidateQueries({ queryKey: qk.backends.installed });
    void qc.invalidateQueries({ queryKey: qk.backends.catalog });
    // 装了新后端 → 可用算力变了 → 所有模型的 fit 判定失效
    void qc.invalidateQueries({ queryKey: qk.models.catalog });
  }),

  bus.on('backend.removed', (_e: BackendRemovedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.backends.installed });
    void qc.invalidateQueries({ queryKey: qk.backends.catalog });
    void qc.invalidateQueries({ queryKey: qk.models.catalog });
    void qc.invalidateQueries({ queryKey: qk.models.storage });
  }),

  /**
   * 硬件或后端选择变了 → **所有 fit 判定失效**。
   * 必须连模型目录一起失效，只刷新硬件面板会让模型卡片继续显示旧的"能不能跑"结论。
   */
  bus.on('hardware.changed', (_e: HardwareChangedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.runtime.hardware });
    void qc.invalidateQueries({ queryKey: qk.models.catalog });
  }),
];
