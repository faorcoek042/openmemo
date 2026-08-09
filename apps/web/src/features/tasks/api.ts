import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnyJob, DownloadJob, JobState, PipelineJobKind } from '@openmemo/shared';
import { isPipelineJob } from '@openmemo/shared';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';
import { useProgressStore, type JobProgressSnapshot } from '../../lib/stores/progress.store';
import { isActiveJobState, pickActiveNoteJob } from '../../lib/jobs/noteJobs';

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
  /**
   * 下载类 + 流水线类（转写/导图）。
   *
   * 这个接口原来只返回下载队列，于是一条**卡在 blocked 等模型**的转写任务
   * 在任务中心里根本不存在 —— 而"需要处理"那一组正是为它准备的（T-130）。
   */
  jobs: AnyJob[];
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

function mergeOne(job: AnyJob, live: JobProgressSnapshot | undefined): MergedJob {
  /*
   * 流水线 job 没有字节计数（`PipelineJob` 里根本没有这些字段，而不是填 0）——
   * 所以进度取 `progress`（0..1），字节一律 null。
   * 填 0 会让任务中心画出一条 "0 B / 0 B" 的下载条，像个卡住的下载。
   */
  if (isPipelineJob(job)) {
    return {
      jobId: job.jobId,
      displayName: job.displayName,
      type: job.type,
      state: live?.state ? (live.state as JobState) : job.state,
      step: live?.step ?? job.step,
      progress: live?.progress ?? job.progress,
      completedBytes: null,
      totalBytes: null,
      speedBps: null,
      etaSeconds: live?.etaSeconds ?? null,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      error: job.error,
      transientOnly: false,
    };
  }

  const serverProgress = job.totalBytes > 0 ? Math.min(1, job.completedBytes / job.totalBytes) : 0;
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
export function useMergedJobs(): {
  jobs: MergedJob[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
} {
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
      // 契约里 PipelineJob.progress 是 number；不确定时按 0 记账，
      // **但渲染层要看 step 而不是这个数**（见 JobToaster：installing 走不确定表达）。
      progress: live.progress ?? 0,
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

/**
 * 一条笔记上**还没结束**的流水线任务（转写 / 导图）。
 *
 * 服务端列表（刷新后仍在）+ 内存进度（4Hz 实时）两层合并，规则与上面的任务中心一致 ——
 * **这是"这条笔记在忙什么"的唯一出处**：笔记页的进度行、导图的「生成中」都读它。
 * 不再有第二个 `note.activeJobId` 字段（为什么，见 `lib/jobs/noteJobs.ts` 的文件头）。
 */
export interface ActiveNoteJob {
  jobId: string;
  kind: PipelineJobKind;
  displayName: string;
  state: JobState;
  step: string | null;
  progress: number;
  stepIndex: number | undefined;
  stepCount: number | undefined;
  etaSeconds: number | null;
  blockedCode: string | null;
}

export function useActiveNoteJob(
  noteUid: string | undefined,
  kind?: PipelineJobKind,
): ActiveNoteJob | undefined {
  const q = useJobsQuery();
  const job = pickActiveNoteJob(q.data?.jobs ?? [], noteUid, kind);
  /*
   * ★ selector 只订阅**这一条** job 的快照（D-05 §2.4）。
   * 订阅整张 `byJob` 表的话，笔记列表里每一行都会随任意任务的 4Hz 进度重渲染。
   */
  const live = useProgressStore((s) => (job ? s.byJob[job.jobId] : undefined));
  if (!job) return undefined;

  const state = (live?.state as JobState | undefined) ?? job.state;
  /*
   * 内存里已经是终态（刚跑完）而 REST 列表还没刷新时，**以内存为准**：
   * 否则完成之后进度行还会挂几百毫秒，看起来像卡住。
   */
  if (!isActiveJobState(state)) return undefined;

  return {
    jobId: job.jobId,
    kind: job.kind,
    displayName: job.displayName,
    state,
    step: live?.step ?? job.step,
    progress: live?.progress ?? job.progress,
    stepIndex: live?.stepIndex,
    stepCount: live?.stepCount,
    etaSeconds: live?.etaSeconds ?? null,
    blockedCode: job.blockedCode,
  };
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
