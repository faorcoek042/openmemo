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
  bus.on('backend.installed', (e: BackendInstalledEvent) => {
    void qc.invalidateQueries({ queryKey: qk.backends.installed });
    void qc.invalidateQueries({ queryKey: qk.backends.catalog });
    // 装了新后端 → 可用算力变了 → 所有模型的 fit 判定失效
    void qc.invalidateQueries({ queryKey: qk.models.catalog });
    // 自检失败必须显性告知（ADR-003 决策 3），不能静默
    if (e.selfTestPassed === false) bus.emit('ui.toast.backendSelfTestFailed', e);
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
