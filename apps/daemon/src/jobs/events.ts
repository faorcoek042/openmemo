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
import { PIPELINE_JOB_KINDS, makeEvent, progressFraction, topics } from '@openmemo/shared';

import { jobErrorTextOf } from './errorText.js';
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
export function pipelineJobOf(
  row: JobRow,
  note: { uid: string; title: string } | undefined,
): PipelineJob | undefined {
  const kind = pipelineKindOf(row.type);
  if (!kind) return undefined;
  /*
   * ★ 两份文案由 `jobErrorTextOf()` 产（#98 ④）。
   *
   * 这里原来是：
   *     message:   row.error_detail ?? row.error_code,
   *     messageZh: row.error_detail ?? row.error_code,   // ← 同一个英文串
   * 也就是把英文原文**当作中文交出去**。消费方（任务中心 `JobList.tsx`、
   * 右下角 `JobToaster.tsx`）都是按界面语言二选一 —— 中文界面读 `messageZh`，
   * 于是老老实实渲染出 `no media source can handle this input`。
   * 契约里 `messageZh` 存在的全部理由就是"这句已经翻好了"，而这里等于
   * 宣称翻好了然后交出原文。类型对、字段在，**没有任何东西会因此报错**。
   */
  const text = jobErrorTextOf(row.error_code, row.error_detail);
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
          message: text.message,
          messageZh: text.messageZh,
          /*
           * ★ 这里原来是写死的 `false`，而带 `error_code` 的行**不一定是终态**：
           * `queue.fail()` 在可重试时把 state 置回 `queued` 并留着错误码
           * （那正是"失败了、但还会自己再试一次"的形态）。恒 false 会让
           * `JobError.retryable` 这个字段对流水线 job 永远说同一句话，
           * 而契约给它的定义是"UI 据此决定给什么出口"。
           * 判据取**这一行此刻的真实状态**：回到队列里 = 真的还会再跑。
           */
          retryable: row.state === 'queued',
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
    /*
     * ★★ #90 —— **这一行是「每一条正在跑的任务都显示 100%」的成因。**
     *
     * 它原本写的是：
     *
     *     // 契约用的是百分比（0..100），不是 0..1 的小数 —— 又一处只有类型检查才拦得住的差异
     *     pct: Math.round(Math.max(0, Math.min(1, p.fraction)) * 100),
     *
     * 那句注释**两处都说反了**：契约（`packages/shared/src/events.ts` 与
     * `openapi.yaml` 两处原文）写的是 `0..1`，而同一个字段的另一个生产者
     * （`http/rest/state.ts` 的下载桥接）发的也是 `completed/total`。
     * 于是转写/导图发 `90`、下载发 `0.9`，**同一个字段名，两种刻度**。
     * web 那侧全按 0–1 用，`formatPercent` 把 90 夹成 1 ⇒ 恒 `100%`。
     *
     * 最刺人的是注释的后半句：它准确地说出了"只有类型检查才拦得住"，
     * 然后自己成了那个没被拦住的例子 —— `number | null` 对 `0.9` 和 `90` 一视同仁。
     *
     * 所以修法不是在这里补一个 `/ 100`：`progressFraction()` 是全仓唯一的构造点，
     * 它产出的 `ProgressReading` **只有 fraction 一种量纲可表达**，
     * 乘 100 这件事从此写不进这个字段（写了也编译不过）。
     */
    progress: progressFraction(p.fraction, 'jobProgressEvent'),
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
