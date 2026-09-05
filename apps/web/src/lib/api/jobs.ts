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
import { TERMINAL_JOB_STATES, type GetJobsResponse } from '@openmemo/shared';

import { qk } from '../../app/query';
import { api } from './client';

/**
 * 任务列表。
 *
 * ## ★ T-198：一条**有界**的兜底轮询
 *
 * 这个查询原本既没有 `refetchInterval`，`app/query.ts` 里 `refetchOnWindowFocus`
 * 又是 `false` —— 也就是说**列表只靠 SSE 推动**。掉一帧（网络抖动、标签页被挂起、
 * 事件在重连窗口里丢了）就永远停在错的状态上，除非用户硬刷新。
 * `[用户真机 Windows v0.7.0]` 那条「进行中 (1)」僵尸就一直挂在那儿。
 *
 * ⚠️ **有界**是关键，不是无条件常驻轮询：只在**还有非终态任务**时每 5 秒兜一次，
 * 全部结束就自动停。空闲的任务中心（以及后台标签页）不会有任何多余请求 ——
 * 常驻轮询会让"任务中心开着"变成一个持续的电量/流量成本。
 */
const JOBS_POLL_MS = 5000;

export function useJobsQuery() {
  return useQuery({
    queryKey: qk.jobs.all,
    queryFn: () => api<GetJobsResponse>('jobs', '/jobs'),
    refetchInterval: (q) => (hasUnfinishedJob(q.state.data) ? JOBS_POLL_MS : false),
  });
}

/** 还有没有没跑完的任务 —— 决定要不要继续兜底轮询。 */
function hasUnfinishedJob(data: GetJobsResponse | undefined): boolean {
  return (data?.jobs ?? []).some(
    (j) => !(TERMINAL_JOB_STATES as readonly string[]).includes(j.state),
  );
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
