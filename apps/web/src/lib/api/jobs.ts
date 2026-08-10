/**
 * 任务查询与取消/重试 —— **唯一的一份**。
 *
 * ## ★★ T-195：为什么它在 `lib/` 而不在某个 feature 里
 *
 * `useJobsQuery` 此前有**两份**：`features/models/api.ts` 与 `features/tasks/api.ts`，
 * 查的是同一个 `qk.jobs.all` / 同一个 `GET /api/jobs`，只是 `api()` 的重载用法不同。
 * 「运行时」页也要它（后端包的下载与模型下载走同一个 `DownloadQueue`、同一份
 * `DownloadJob`），而 ESLint 的 `no-restricted-imports` 明写着：
 *
 * > features/A 不得 import features/B（D-05 §3.5）。需要复用请把组件**提升**到
 * > `components/common/`，并在 inbox 写 SHARED-CHANGE 申报。
 *
 * 照做 —— 但**不是抄第三份**：这里是那一份，两个 feature 改成从这里再导出，
 * 它们的调用点一个字都不用改。同一件事在三处各写一遍，正是本仓反复清的那族。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GetJobsResponse } from '@openmemo/shared';

import { qk } from '../../app/query';
import { api } from './client';

export function useJobsQuery() {
  return useQuery({
    queryKey: qk.jobs.all,
    queryFn: () => api<GetJobsResponse>('jobs', '/jobs'),
  });
}

export function useJobCancelMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api<void>('jobs', `/jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.jobs.all }),
  });
}

export function useJobRetryMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api<void>('jobs', `/jobs/${jobId}/retry`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.jobs.all }),
  });
}
