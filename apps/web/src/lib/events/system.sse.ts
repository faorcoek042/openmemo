/**
 * 系统域 SSE 绑定（D-05 §11.5）。不属于任何 feature，故放在 lib 里。
 */

import type { QueryClient } from '@tanstack/react-query';
import { bus } from './bus';
import { useConnectionStore } from '../stores/connection.store';
import type { SseBinding } from './bindings';

export const systemSse: SseBinding = (qc: QueryClient) => [
  /**
   * 重放缓冲滚过（256 条，`SSE_REPLAY_BUFFER_SIZE`）→ 我们不知道漏了什么。
   * 唯一安全的做法是全量失效。宁可多拉一次，也不要前后端状态不一致。
   */
  bus.on('sync.required', () => {
    void qc.invalidateQueries();
  }),

  bus.on('daemon.shutdown', () => {
    useConnectionStore.getState().setState('degraded');
  }),

  bus.on('index.progress', () => {
    // 后台重建索引：只在设置页显示，不打扰主界面
  }),
];
