import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DownloadJob, JobState } from '@openmemo/shared';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';
import { useProgressStore, type JobProgressSnapshot } from '../../lib/stores/progress.store';

/**
 * M-5 任务中心持久化。
 *
 * ## 问题不是"少了个接口"，是**数据源选错了**
 *
 * 之前任务中心的唯一数据源是 `progressStore` —— 一个 transient store，
 * 专门用来接 4Hz 的 `job.progress` 事件、刻意不进 React 缓存（D-05 §2.4）。
 * 用它当列表数据源的后果是：**刷新即空**。
 *
 * 而我们在 UI 上白纸黑字写着"可以关闭此页面，任务会继续"——
 * 用户照做之后回来发现列表空了。**承诺与实现打架，比缺功能更伤信任。**
 *
 * ## 修法：两个数据源各司其职
 *
 * | 来源 | 负责 | 频率 |
 * |---|---|---|
 * | `GET /api/jobs`（服务端） | **有哪些任务、状态、元信息** —— 真相 | 低频，SSE 终态事件触发失效 |
 * | `progressStore`（内存） | **进度百分比 / 速度 / ETA** —— 易失 | 4Hz，不进缓存 |
 *
 * 渲染时把两者合并：列表来自服务端（刷新后仍在），进度覆盖来自内存（不刷新也在动）。
 * 这也正好是 D-01 §3.3 那条原则的实例：**SSE 事件是提示，真相永远在 REST/DB。**
 */

export interface JobsResponse {
  jobs: DownloadJob[];
  concurrencyLimit: number;
}

export function useJobsQuery() {
  return useQuery({
    queryKey: qk.jobs.all,
    queryFn: () => api<JobsResponse>('jobs', '/jobs'),
  });
}

/** 服务端 job + 内存进度的合并视图。 */
export interface MergedJob {
  jobId: string;
  displayName: string;
  type: string;
  state: JobState;
  step: string | null;
  /** 0..1。优先用内存里的实时值，没有则回退服务端的字节比。 */
  progress: number;
  completedBytes: number | null;
  totalBytes: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
  attempt: number;
  maxAttempts: number;
  error: DownloadJob['error'];
  /** true = 这条只在内存里有，服务端还没收录（刚创建的瞬间） */
  transientOnly: boolean;
}

function mergeOne(job: DownloadJob, live: JobProgressSnapshot | undefined): MergedJob {
  const serverProgress =
    job.totalBytes > 0 ? Math.min(1, job.completedBytes / job.totalBytes) : 0;
  return {
    jobId: job.jobId,
    displayName: job.displayName,
    type: job.type,
    state: live?.state ? (live.state as JobState) : job.state,
    step: live?.step ?? job.step,
    progress: live?.progress ?? serverProgress,
    completedBytes: live?.completedBytes ?? job.completedBytes,
    totalBytes: live?.totalBytes ?? job.totalBytes,
    speedBps: live?.speedBps ?? job.speedBps,
    etaSeconds: live?.etaSeconds ?? job.etaSeconds,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    error: job.error,
    transientOnly: false,
  };
}

/**
 * 合并后的任务列表。
 *
 * 服务端列表是主干；内存里有、服务端还没有的（刚 POST 完那一瞬间）作为
 * `transientOnly` 补进去，避免"点了开始但列表里什么都没有"的空窗期。
 */
export function useMergedJobs(): { jobs: MergedJob[]; isLoading: boolean; isError: boolean; error: unknown } {
  const q = useJobsQuery();
  const byJob = useProgressStore((s) => s.byJob);

  const serverJobs = q.data?.jobs ?? [];
  const seen = new Set(serverJobs.map((j) => j.jobId));
  const merged = serverJobs.map((j) => mergeOne(j, byJob[j.jobId]));

  for (const [jobId, live] of Object.entries(byJob)) {
    if (seen.has(jobId)) continue;
    merged.push({
      jobId,
      displayName: live.jobType,
      type: live.jobType,
      state: live.state as JobState,
      step: live.step,
      progress: live.progress,
      completedBytes: live.completedBytes,
      totalBytes: live.totalBytes,
      speedBps: live.speedBps,
      etaSeconds: live.etaSeconds,
      attempt: 0,
      maxAttempts: 0,
      error: null,
      transientOnly: true,
    });
  }

  return { jobs: merged, isLoading: q.isLoading, isError: q.isError, error: q.error };
}

/** 分组：**"需要处理"排在"已完成"之前** —— blocked/failed 是唯一需要用户动作的一类。 */
export function groupJobs(jobs: MergedJob[]) {
  return {
    running: jobs.filter((j) => j.state === 'running' || j.state === 'leased'),
    waiting: jobs.filter((j) => j.state === 'queued' || j.state === 'paused'),
    attention: jobs.filter((j) => j.state === 'blocked' || j.state === 'failed'),
    done: jobs.filter((j) => j.state === 'succeeded' || j.state === 'cancelled'),
  };
}

function jobAction(action: 'cancel' | 'pause' | 'resume' | 'retry') {
  return (jobId: string) =>
    api<{ ok: true }>('jobs', `/jobs/${jobId}/${action}`, { method: 'POST' });
}

export function useJobActions() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: qk.jobs.all });

  return {
    cancel: useMutation({ mutationFn: jobAction('cancel'), onSuccess: invalidate }),
    pause: useMutation({ mutationFn: jobAction('pause'), onSuccess: invalidate }),
    resume: useMutation({ mutationFn: jobAction('resume'), onSuccess: invalidate }),
    retry: useMutation({ mutationFn: jobAction('retry'), onSuccess: invalidate }),
  };
}
