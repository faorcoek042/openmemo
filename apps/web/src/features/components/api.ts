/**
 * 组件域的 Query / Mutation hooks（T-068，model-mgmt 独占）。
 *
 * 端点契约见 `packages/shared/src/components.ts`；数据层实现见
 * `packages/downloader/src/components.ts`（`listComponents` / `stashForRollback` / `rollback`）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CheckUpdatesRequest,
  GetComponentsResponse,
  UpdateComponentRequest,
} from '@openmemo/shared';

import { api } from '../../lib/api/client';
import { qk, STALE_TIME_OVERRIDES } from '../../app/query';

/**
 * 组件清单。
 *
 * `check=false` 时**完全不查上游** —— 纯本地数据，断网也能看清单、看来源、装组件。
 * 版本检测是锦上添花，绝不能成为前置条件。
 */
export function useComponentsQuery(check = false) {
  return useQuery({
    queryKey: [...qk.components.all, check],
    queryFn: () => api<GetComponentsResponse>(`/components${check ? '?check=true' : ''}`),
    staleTime: check ? 60_000 : STALE_TIME_OVERRIDES.catalog,
  });
}

/** 主动查一次上游。查不到只是"未知"，不当错误抛给用户。 */
export function useCheckUpdatesMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CheckUpdatesRequest = {}) =>
      api<GetComponentsResponse>('/components/check', { method: 'POST', body: req }),
    onSuccess: (data) => {
      // 直接写回缓存：响应已是完整清单，再拉一次纯属浪费
      qc.setQueryData([...qk.components.all, true], data);
      qc.setQueryData([...qk.components.all, false], data);
    },
  });
}

/**
 * 更新单个组件。
 *
 * 走**同一个下载器**（校验/续传/去重/重试/回滚全复用），不是另写一条更新路径 ——
 * 另写一条就意味着那条路径会漏掉这些保证。
 */
export function useUpdateComponentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateComponentRequest) =>
      api<{ jobId: string }>('/components/update', {
        method: 'POST',
        body: req,
        idempotencyKey: `component-update:${req.id}:${req.toVersion ?? 'latest'}`,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
      void qc.invalidateQueries({ queryKey: qk.components.all });
    },
  });
}

/** 回滚到上一版本（更新前保留的那份）。 */
export function useRollbackComponentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true; version: string }>('/components/rollback', {
        method: 'POST',
        body: { id },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.components.all });
    },
  });
}
