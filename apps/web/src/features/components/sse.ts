/**
 * 组件域 SSE 绑定片段（T-068，model-mgmt 独占）。
 *
 * ⚠️ 具名 `event:` 帧不会触发 `EventSource.onmessage` —— 这一层由
 * `lib/events/source.ts` 遍历 `ALL_SSE_EVENT_TYPES` 逐类型 `addEventListener` 统一处理，
 * 本文件只从 `bus` 订阅，不要在这里自己 new EventSource。
 */

import type { QueryClient } from '@tanstack/react-query';
import type { BackendInstalledEvent, BackendRemovedEvent } from '@openmemo/shared';

import { bus } from '../../lib/events/bus';
import { qk } from '../../app/query';
import type { SseBinding } from '../../lib/events/bindings';

export const componentsSse: SseBinding = (qc: QueryClient) => [
  // 装/删后已安装版本变了，清单要重取（但**不重查上游**，避免每次安装都打一轮 API）
  bus.on('backend.installed', (_e: BackendInstalledEvent) => {
    void qc.invalidateQueries({ queryKey: qk.components.all });
  }),
  bus.on('backend.removed', (_e: BackendRemovedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.components.all });
  }),
  bus.on('model.installed', () => {
    void qc.invalidateQueries({ queryKey: qk.components.all });
  }),
];
