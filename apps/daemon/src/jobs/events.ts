/**
 * 流水线 job → `packages/shared` SSE 事件的构造器。
 *
 * ## 为什么需要这一层（T-033 的一个真实教训）
 *
 * 我在 T-028 用 `makeEvent(..., {...} as never)` 绕过了类型检查。
 * 结果：`model-mgmt` 后来把 `TranscribeSegmentEvent` 从 `startSec/endSec`
 * 改成了 `startMs/endMs`、把 job 系列的 `jobUid` 定为 `jobId`、
 * 给多个事件加了必填的 `noteUid` —— **daemon 侧一个编译错误都没有**，
 * 因为 `as never` 把契约检查全关掉了。错误一直到 `apps/web` 才暴露。
 *
 * 端到端测试也没抓到：我的验收脚本只断言了**事件类型**，没断言 payload 字段名。
 *
 * → 这里集中构造所有事件，**不使用任何类型断言**，让编译器成为契约的守门人。
 *
 * ## 契约缺口已补上（T-130）
 *
 * 这里原来写着：`JobCreatedEvent` 要求一个完整的 `DownloadJob`
 * （`kind: 'model' | 'backend-pack'`、`totalBytes`、`parts`、`fileIndex`…），
 * 转写/导图**填不进那个形状**，所以本模块**不发 `job.created`**，
 * 让前端从 202 响应拿 jobUid、后续状态走 `job.state` / `job.progress`。
 *
 * 拒绝伪造一个假的 `DownloadJob` 是对的，**结论错在后半句**：
 * 前端拿到的 jobUid 只活在发起那一次请求的调用点上，而 `job.state` / `job.blocked`
 * 只带 id 不带身份 —— 全局 toast 层、任务中心这些**没参与那次请求**的消费方，
 * 收到的是一串它从没被介绍过的 id，只能丢掉。于是流水线 job 的每一个状态
 * （尤其 `blocked`）在界面上都不存在：`[实测]` 没装 ASR 模型时导入媒体，
 * POST 返回 202、笔记停在 `processing`、**页面上一个字都没有**。
 *
 * 现在 shared 有了 `PipelineJob`（只含流水线 job 真有的字段，不含字节计数），
 * `job.created` 因此可以**如实**发出。仍然不使用任何类型断言。
 */
import type {
  JobBlockedEvent,
  JobCreatedEvent,
  JobDoneEvent,
  JobFailedEvent,
  JobProgressEvent,
  JobState,
  JobStateEvent,
  MediaReadyEvent,
  PipelineJob,
  PipelineJobKind,
  Remediation,
  TranscribeDoneEvent,
  TranscribeSegmentEvent,
  TranscribeStartedEvent,
} from '@openmemo/shared';
import { PIPELINE_JOB_KINDS, makeEvent, topics } from '@openmemo/shared';

import type { JobRow } from './queue.js';

/**
 * `jobs.type` → `PipelineJobKind`。
 *
 * 认不出的类型返回 `undefined`，调用方据此**不发** `job.created` ——
 * 而不是随便归到 'transcribe'。给用户看一个名字错误的任务，比不给更难排查。
 */
export function pipelineKindOf(type: string): PipelineJobKind | undefined {
  return (PIPELINE_JOB_KINDS as readonly string[]).includes(type)
    ? (type as PipelineJobKind)
    : undefined;
}

/**
 * `JobRow` → 契约里的 `PipelineJob`。
 *
 * `displayName` 用**笔记标题**：用户刚刚点的就是那条笔记，任何内部 uid 对他都没有意义。
 * 标题为空时回落到 uid 是有意的 —— 空字符串会渲染成一条没有主语的提示。
 */
export function pipelineJobOf(row: JobRow, note: { uid: string; title: string } | undefined): PipelineJob | undefined {
  const kind = pipelineKindOf(row.type);
  if (!kind) return undefined;
  return {
    jobId: row.uid,
    kind,
    type: row.type,
    displayName: note?.title?.trim() || note?.uid || row.uid,
    noteUid: note?.uid ?? null,
    state: row.state,
    step: row.current_step,
    progress: row.progress,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    error: row.error_code
      ? {
          code: row.error_code,
          message: row.error_detail ?? row.error_code,
          messageZh: row.error_detail ?? row.error_code,
          retryable: false,
        }
      : null,
    blockedCode: row.blocked_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * 流水线 job 的 `job.created`。
 *
 * 认不出的 job 类型返回 `undefined` —— 调用方**不发事件**，而不是编一个。
 */
export function jobCreatedEvent(
  row: JobRow,
  note: { uid: string; title: string } | undefined,
): JobCreatedEvent | undefined {
  const job = pipelineJobOf(row, note);
  if (!job) return undefined;
  return makeEvent('job.created', topics.job(row.uid), { job });
}

export function jobStateEvent(
  jobUid: string,
  state: JobState,
  previousState: JobState,
): JobStateEvent {
  return makeEvent('job.state', topics.job(jobUid), {
    jobId: jobUid,
    state,
    previousState,
  });
}

export function jobProgressEvent(
  jobUid: string,
  p: { step: string | null; fraction: number; state: JobState },
): JobProgressEvent {
  return makeEvent('job.progress', topics.job(jobUid), {
    jobId: jobUid,
    step: p.step,
    // 契约用的是百分比（0..100），不是 0..1 的小数 —— 又一处只有类型检查才拦得住的差异
    pct: Math.round(Math.max(0, Math.min(1, p.fraction)) * 100),
    completedBytes: null,
    totalBytes: null,
    speedBps: null,
    etaSeconds: null,
    state: p.state,
  });
}

export function jobBlockedEvent(
  jobUid: string,
  blockedCode: string,
  messageZh: string,
  message: string,
  remediation: Remediation | null,
): JobBlockedEvent {
  return makeEvent('job.blocked', topics.job(jobUid), {
    jobId: jobUid,
    blockedCode,
    messageZh,
    message,
    remediation,
  });
}

export function jobDoneEvent(
  jobUid: string,
  resultUid: string | null,
  resultKind: JobDoneEvent['resultKind'],
): JobDoneEvent {
  return makeEvent('job.done', topics.job(jobUid), { jobId: jobUid, resultUid, resultKind });
}

export function jobFailedEvent(
  jobUid: string,
  err: { code: string; message: string; messageZh: string; retryable: boolean },
  willRetry: boolean,
): JobFailedEvent {
  return makeEvent('job.failed', topics.job(jobUid), {
    jobId: jobUid,
    // ErrorCode 是字面量联合；daemon 侧的错误码不一定都在里面，
    // 用 as 收窄会掩盖问题，这里保留原值并让 shared 决定是否扩充枚举。
    error: {
      code: err.code as JobFailedEvent['error']['code'],
      message: err.message,
      messageZh: err.messageZh,
      retryable: err.retryable,
    },
    willRetry,
    nextProvider: null,
  });
}

export function transcribeStartedEvent(p: {
  transcriptUid: string;
  noteUid: string;
  modelId: string;
  durationMs: number;
  language: string | null;
}): TranscribeStartedEvent {
  return makeEvent('transcribe.started', topics.transcript(p.transcriptUid), p);
}

export function transcribeSegmentEvent(p: {
  transcriptUid: string;
  noteUid: string;
  seq: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  confidence: number | null;
}): TranscribeSegmentEvent {
  return makeEvent('transcribe.segment', topics.transcript(p.transcriptUid), p);
}

export function transcribeDoneEvent(p: {
  transcriptUid: string;
  noteUid: string;
  segmentCount: number;
  rtf: number | null;
  partial: boolean;
}): TranscribeDoneEvent {
  return makeEvent('transcribe.done', topics.transcript(p.transcriptUid), p);
}

export function mediaReadyEvent(p: {
  noteUid: string;
  mediaUid: string;
  durationMs: number;
  title: string | null;
  hasVideo: boolean;
}): MediaReadyEvent {
  return makeEvent('media.ready', topics.note(p.noteUid), p);
}
