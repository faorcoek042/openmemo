/**
 * 系统域 SSE 绑定（D-05 §11.5）。不属于任何 feature，故放在 lib 里。
 */

import type { QueryClient } from '@tanstack/react-query';
import { bus } from './bus';
import { useConnectionStore } from '../stores/connection.store';
import { startDegradedPolling } from './degradedPolling';
import type { SseBinding } from './bindings';

export const systemSse: SseBinding = (qc: QueryClient) => [
  /**
   * 重放缓冲滚过（256 条，`SSE_REPLAY_BUFFER_SIZE`）→ 我们不知道漏了什么。
   * 唯一安全的做法是全量失效。宁可多拉一次，也不要前后端状态不一致。
   */
  bus.on('sync.required', () => {
    void qc.invalidateQueries();
  }),

  /**
   * ★ `degraded` 的轮询兜底（#101）。
   *
   * 挂在这里而不是 `source.ts` 里，是因为它要的是 `QueryClient` 而不是 EventSource：
   * 轮询发生在**放弃 SSE 之后**，与那条流已经没有关系了。
   * 而这份绑定表本来就是"拿着 qc、按连接态做事"的地方。
   *
   * 在此之前 `degraded` 只有一条黄色横幅 —— 横幅说着"正在轮询"，
   * 而全仓没有任何一处在拉数据。见 `degradedPolling.ts` 文件头。
   */
  startDegradedPolling(qc),

  bus.on('x.daemon.shutdown', () => {
    useConnectionStore.getState().setState('degraded');
  }),

  bus.on('x.index.progress', () => {
    // 后台重建索引：只在设置页显示，不打扰主界面
  }),
];
