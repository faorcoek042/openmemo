/**
 * 任务 REST（`/api/jobs**`）。
 *
 * ⚠️ 这里有**两套队列**，别混：
 *   - `state.queue`  = `DownloadQueue`（packages/downloader）—— 模型/后端包下载
 *   - `pipelineJobs` = daemon 自己的 `JobQueue` + `Scheduler` —— 转写 / 导图
 *
 * 原先只接了前者，于是**转写任务根本取消不掉**（`Scheduler.cancel()` 零调用方，
 * UI 上的取消按钮是假的）。复合起来最难看：取消不了 → 用户杀 daemon →
 * 子进程还活着吃 CPU → 重启从第 0 块重来 → 之前转好的还看不见了。
 * 这正是 chunk 分层设计要避免的失败模式。
 *
 * 进度**不在响应里返回**，一律走全局单条 SSE（D-01 §3.2 规则 2）。
 */
import type { ServerResponse } from 'node:http';

import type { DownloadJob, GetJobsResponse, PipelineJob, PullResponse } from '@openmemo/shared';

import { sendError, sendJson } from '../respond.js';
import { decodePathSegment } from './request.js';
import type { RestState } from './state.js';

const EVENTS_URL = '/api/events';

export function toPullResponse(job: DownloadJob, deduplicated: boolean): PullResponse {
  return {
    jobId: job.jobId,
    state: job.state,
    targetId: job.targetId,
    totalBytes: job.totalBytes,
    eventsUrl: EVENTS_URL,
    deduplicated,
  };
}

/** 流水线任务（转写/导图）的取消与查询钩子。由 main.ts 注入。 */
export interface PipelineJobHooks {
  /** 返回 true 表示这个 uid 确实是流水线任务且已受理取消。 */
  cancel(jobUid: string, hard: boolean): boolean;
  pause(jobUid: string): boolean;
  resume(jobUid: string): boolean;
  /**
   * 列出流水线任务，最近的在前。
   *
   * ★ 没有它，`GET /api/jobs` 只返回下载队列 —— 于是一条卡在 `blocked` 的转写任务
   * **在任务中心里根本不存在**（`[实测]` 5 条 blocked job 在库里，接口返回 `jobs: []`）。
   * 而 blocked 那条 toast 给的第二个按钮正是「任务中心」。把用户送到一个空列表，
   * 比不给按钮更糟：他会以为任务已经没了。
   */
  list(limit: number): PipelineJob[];
  get(jobUid: string): PipelineJob | undefined;
  /** 前置条件已满足时把 blocked 任务放回队列（任务中心的「重试」）。 */
  retry(jobUid: string): boolean;
}

let pipelineJobs: PipelineJobHooks | undefined;

/** main.ts 在调度器建好之后调用一次。 */
export function setPipelineJobHooks(hooks: PipelineJobHooks): void {
  pipelineJobs = hooks;
}

export function handleJobRoutes(
  state: RestState,
  res: ServerResponse,
  pathname: string,
  method: string,
): boolean {
  if (pathname === '/api/jobs') {
    if (method !== 'GET') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', '方法不允许');
      return true;
    }
    /*
     * 两套队列合并成一个列表（T-130）。
     * 顺序：下载在前、流水线在后 —— 前端自己会按状态分组，这里不越俎代庖排序。
     */
    const body: GetJobsResponse = {
      jobs: [...state.queue.list(), ...(pipelineJobs?.list(50) ?? [])],
      concurrencyLimit: state.queue.concurrency,
    };
    sendJson(res, 200, body);
    return true;
  }

  const action = /^\/api\/jobs\/([^/]+)\/(cancel|retry|pause|resume)$/.exec(pathname);
  if (action) {
    if (method !== 'POST') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST', '方法不允许');
      return true;
    }
    return handleJobAction(state, res, decodePathSegment(action[1]), action[2]);
  }

  const single = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  if (single) {
    if (method !== 'GET') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', '方法不允许');
      return true;
    }
    const uid = decodePathSegment(single[1]);
    // 列表里能看见的，详情就必须能拿到 —— 否则任务中心点进去 404
    const job = state.queue.get(uid) ?? pipelineJobs?.get(uid);
    if (!job) {
      sendError(res, 404, 'NOT_FOUND', 'no such job', '任务不存在（可能已被清理）');
      return true;
    }
    sendJson(res, 200, job);
    return true;
  }

  return false;
}

function handleJobAction(
  state: RestState,
  res: ServerResponse,
  jobId: string,
  action: string,
): boolean {
  if (action === 'cancel') {
    // 取消**保留 .partial**，所以之后 retry 是断点续传而不是重下。
    if (state.queue.cancel(jobId)) {
      res.writeHead(204);
      res.end();
      return true;
    }
    // 下载队列不认识它 → 可能是流水线任务（转写/导图）
    if (pipelineJobs?.cancel(jobId, false)) {
      res.writeHead(204);
      res.end();
      return true;
    }
    sendError(res, 409, 'CONFLICT', 'job is absent or already terminal', '任务不存在或已结束');
    return true;
  }

  if (action === 'pause' && pipelineJobs?.pause(jobId)) {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (action === 'resume' && pipelineJobs?.resume(jobId)) {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (action === 'retry') {
    // 流水线任务的「重试」= 解除阻塞 / 重新排队（下载队列不认识它）
    if (pipelineJobs?.retry(jobId)) {
      res.writeHead(204);
      res.end();
      return true;
    }
    const job = state.queue.retry(jobId);
    if (!job) {
      sendError(
        res,
        409,
        'CONFLICT',
        'only failed or cancelled jobs can be retried',
        '只有失败或已取消的任务可以重试',
      );
      return true;
    }
    sendJson(res, 202, toPullResponse(job, false));
    return true;
  }

  // pause / resume：`DownloadQueue` 没有 paused 状态，而 packages/downloader 本任务不可改。
  // 用 cancel+retry 冒充会让 GET /api/jobs 里的 state 报成 cancelled，与前端看到的"已暂停"
  // 自相矛盾 —— 宁可明确 501，也不给一个会说谎的状态机。
  sendError(
    res,
    501,
    'NOT_IMPLEMENTED',
    'pause/resume needs a paused state in DownloadQueue (packages/downloader), which this change may not modify',
    '暂停/继续尚未实现：下载队列（packages/downloader）还没有 paused 状态。可以先「取消」，之后「重试」会从断点续传。',
    {
      remediation: {
        action: 'cancel_job',
        params: { jobId },
        labelZh: '改为取消（保留断点）',
        label: 'Cancel instead (resume later)',
      },
    },
  );
  return true;
}
