/**
 * 下载任务 REST（`/api/jobs**`）。
 *
 * 任务本身归 `DownloadQueue`（packages/downloader）；这里只做 HTTP 映射。
 * 进度**不在响应里返回**，一律走全局单条 SSE（D-01 §3.2 规则 2）。
 */
import type { ServerResponse } from 'node:http';

import type { DownloadJob, GetJobsResponse, PullResponse } from '@openmemo/shared';

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
    const body: GetJobsResponse = {
      jobs: state.queue.list(),
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
    const job = state.queue.get(decodePathSegment(single[1]));
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
    } else {
      sendError(res, 409, 'CONFLICT', 'job is absent or already terminal', '任务不存在或已结束');
    }
    return true;
  }

  if (action === 'retry') {
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
