import { QueryClient } from '@tanstack/react-query';

/**
 * queryKey 工厂 —— **唯一来源**（D-05 §2.2）。
 *
 * 手写 `['notes','list']` 字面量是缓存失效失灵的头号原因，而且三个并行任务
 * 各写各的必然拼错。所有 key 从这里取。
 */
export const qk = {
  notes: {
    all: ['notes'] as const,
    list: (filter: Record<string, unknown> = {}) => ['notes', 'list', filter] as const,
    detail: (uid: string) => ['notes', 'detail', uid] as const,
  },
  transcript: (noteUid: string) => ['transcript', noteUid] as const,
  mindmap: (noteUid: string) => ['mindmap', noteUid] as const,
  summary: (noteUid: string) => ['summary', noteUid] as const,
  assets: (noteUid: string) => ['assets', noteUid] as const,
  jobs: {
    all: ['jobs'] as const,
    detail: (id: string) => ['jobs', id] as const,
  },
  folders: ['folders'] as const,
  tags: ['tags'] as const,
  search: (q: string, mode: string) => ['search', mode, q] as const,
  models: {
    catalog: ['models', 'catalog'] as const,
    installed: ['models', 'installed'] as const,
    storage: ['models', 'storage'] as const,
    sources: ['models', 'sources'] as const,
  },
  backends: {
    catalog: ['backends', 'catalog'] as const,
    installed: ['backends', 'installed'] as const,
  },
  runtime: {
    hardware: ['runtime', 'hardware'] as const,
  },
  /**
   * `GET /api/daemon/status` —— ASR 引擎**可用性的唯一真实来源**。
   *
   * 不是 `/api/components`：那里的 `ComponentStatus` 没有 `engine` 字段，
   * 只能靠 id 前缀猜（`whispercpp-*`），而且"组件包装了"≠"引擎构造得起来"——
   * Paraformer 还需要 `OPENMEMO_PARAFORMER_DIR` 指向模型目录，没设就压根不进候选。
   * `daemon/status` 的 `pipeline.engines[]` 是 daemon 自己构造引擎后的实测结果，
   * 带 `available` 和 `reason`，这才是"能不能用"。
   */
  daemon: {
    status: ['daemon', 'status'] as const,
  },
  components: {
    all: ['components'] as const,
  },
  settings: ['settings'] as const,
} as const;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 本地 daemon，请求几乎零成本 —— 宁可多拉一次也不显示旧数据。
        staleTime: 0,
        gcTime: 5 * 60_000,
        // 我们有 SSE，不需要靠窗口聚焦兜底；开着会在多标签间制造请求风暴。
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // 服务端已经给了 retryable 判断，不在前端另造一套（D-05 §2.2）
          const retryable = (error as { retryable?: boolean } | null)?.retryable;
          if (retryable === false) return false;
          return failureCount < 1;
        },
      },
      mutations: { retry: 0 },
    },
  });
}

/** 例外：探测慢且贵的查询，单独放宽 staleTime（D-05 §2.2）。 */
export const STALE_TIME_OVERRIDES = {
  /** R-02 §A.1 实测 `system_profiler` 可达数秒 */
  hardware: 5 * 60_000,
  /** 目录带 ETag 缓存 */
  catalog: 60_000,
} as const;
