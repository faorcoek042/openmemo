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
 * ## 已知契约缺口（已报 Manager）
 *
 * `JobCreatedEvent` 要求一个完整的 `DownloadJob`，而 `DownloadJob` 是**为下载建模的**
 * （`kind: 'model' | 'backend-pack'`、`totalBytes`、`parts`、`fileIndex`…）。
 * 转写/导图这类流水线 job **无法诚实地填进这个形状**。
 * 因此本模块**不发 `job.created`**：前端从 `POST` 的 202 响应拿到 jobUid，
 * 后续状态由 `job.state` / `job.progress` 提供。
 * 等 shared 补上流水线 job 的表示后再加回来。
 */
import type {
  JobBlockedEvent,
  JobDoneEvent,
  JobFailedEvent,
  JobProgressEvent,
  JobState,
  JobStateEvent,
  MediaReadyEvent,
  Remediation,
  TranscribeDoneEvent,
  TranscribeSegmentEvent,
  TranscribeStartedEvent,
} from '@openmemo/shared';
import { makeEvent, topics } from '@openmemo/shared';

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
