/**
 * Toast 层的**纯决策逻辑**（T-130 从 `JobToaster.tsx` 抽出来）。
 *
 * ## 为什么要抽出来
 *
 * 被修的缺陷是一句"这条事件到不了屏幕上"：
 * daemon 不发 `job.created` → 前端收到一串没被介绍过的 jobId → 一律丢弃 →
 * 没装 ASR 模型时导入媒体，**页面一个字都没有**。
 *
 * 也就是说，这里最该被测的东西不是渲染，而是**"哪些事件能变成一条 toast、哪些不能"**。
 * 那条规则原先埋在一个 React 组件的 `useEffect` 里，只能靠起浏览器点一遍来验证 ——
 * 而这个项目已经栽过好几次"单测测的是另一条路，绿灯照亮"的跟头。
 *
 * 抽成纯函数之后，可以把 **daemon 真实发出的事件载荷原样喂进去**（测试里就是这么做的），
 * 断言"这条 blocked 到底能不能被用户看见"。渲染、计时器、`/api/health` 复查仍留在组件里。
 *
 * 本文件**不 import React / react-router / i18next 运行时**，因此能进 `tsconfig.test.json`
 * 那条 CommonJS 单测通道（react-router 是纯 ESM，进不去）。
 */
import type {
  DownloadJob,
  JobBlockedEvent,
  JobCreatedEvent,
  JobFailedEvent,
  JobState,
  JobStateEvent,
  PipelineJobKind,
} from '@openmemo/shared';
import { PIPELINE_JOB_KINDS, isPipelineJob } from '@openmemo/shared';

export type Phase = 'active' | 'blocked' | 'failed' | 'done';

/** 下载类两种 + 流水线两种。判别靠 `kind` 本身（shared 保证两组字面量不相交）。 */
export type ToastKind = DownloadJob['kind'] | PipelineJobKind;

export function isPipelineKind(kind: ToastKind): kind is PipelineJobKind {
  return (PIPELINE_JOB_KINDS as readonly string[]).includes(kind);
}

export interface Toast {
  jobId: string;
  kind: ToastKind;
  name: string;
  totalBytes: number;
  phase: Phase;
  state: JobState;
  /**
   * blocked / failed 的原因，**中英各存一份**。
   * 服务端两份都给了；以前无条件取 `messageZh`，英文界面上会渲染出一句中文（实测见过）。
   */
  reason?: string;
  reasonEn?: string;
  /** 流水线任务归属的笔记 —— 完成后"现在能干嘛"要有出口 */
  noteUid?: string | null;
  remediation?: JobBlockedEvent['remediation'];
  attempt?: number;
  maxAttempts?: number;
  willRetry?: boolean;
  /** 完成后是否需要重启才生效（由 /api/health 的 restartRequired 判定） */
  needsRestart?: boolean;
}

export type ToastPatch = Partial<Toast> & Pick<Toast, 'jobId'>;

/**
 * 一条事件对 toast 层的影响。
 *
 * `seed` = "这条事件本身足以撑起一条 toast"，**只在补建时生效**，不覆盖已有条目 ——
 * 否则 `job.created` 带来的真实笔记标题会被随后 `job.blocked` 的兜底名字盖掉。
 */
export type ToastAction =
  | { kind: 'ignore' }
  | { kind: 'dismiss'; jobId: string }
  | { kind: 'upsert'; jobId: string; patch: ToastPatch; seed?: Partial<Toast>; settled?: boolean };

/** 兜底名字由调用方提供（i18n 属于渲染层，不进这个纯模块）。 */
export interface FallbackNames {
  blocked(blockedCode: string): string;
  failed(): string;
}

/**
 * `job.*` 事件 → toast 层动作。
 *
 * ## 「收到一个没见过的 jobId 的状态更新，该怎么办？」
 *
 * 原来的答案是**一律丢弃**（"没见过 job.created 就不补建"），理由正当：
 * SSE 重连会重放历史事件，刷新页面时不该凭空冒出一堆早就结束的任务的 toast。
 *
 * 但"一律"错了。分两种：
 *   - **纯生命周期噪音**（`job.state` 到 running / queued / paused）：丢弃仍然是对的。
 *     它既没有名字也不需要用户做什么，补建出来只会是一条没有主语的提示。
 *   - **需要用户动手的状态**（`blocked`、终态 `failed`）：丢弃 = 一次零报错的卡住。
 *     这类事件自身带齐了"为什么停 + 怎么办"，缺的只是一个名字 —— 那就给一个笼统的。
 */
export function toastActionFor(
  type: 'job.created' | 'job.state' | 'job.blocked' | 'job.failed',
  event: unknown,
  names: FallbackNames,
): ToastAction {
  switch (type) {
    case 'job.created': {
      const ev = event as JobCreatedEvent;
      const j = ev?.job;
      /*
       * 载荷防御：`job` 缺失时忽略，不让一条坏事件抛异常。
       * 不是假想的 —— `[实测]` daemon 的上传端点曾用 `as never` 发过
       * `{jobUid, kind, label}`，消费方读 `j.jobId` 每次上传都抛一次 TypeError。
       * 发送方已修，但**契约的消费方不该假设发送方永远正确**。
       */
      if (!j || typeof j.jobId !== 'string') return { kind: 'ignore' };

      if (isPipelineJob(j)) {
        return {
          kind: 'upsert',
          jobId: j.jobId,
          patch: {
            jobId: j.jobId,
            kind: j.kind,
            name: j.displayName,
            // 流水线 job 没有字节计数 —— 给 0，渲染层因此不画 "0 B / 0 B"
            totalBytes: 0,
            state: j.state,
            // 排队时就已经 blocked 的（例如缺件被立刻拦下）不要先闪一下"进行中"
            phase: j.state === 'blocked' ? 'blocked' : 'active',
            noteUid: j.noteUid,
            attempt: j.attempt,
            maxAttempts: j.maxAttempts,
          },
        };
      }
      return {
        kind: 'upsert',
        jobId: j.jobId,
        patch: {
          jobId: j.jobId,
          kind: j.kind,
          name: j.displayName || j.targetId,
          totalBytes: j.totalBytes,
          state: j.state,
          phase: 'active',
          attempt: j.attempt,
          maxAttempts: j.maxAttempts,
        },
      };
    }

    case 'job.state': {
      const ev = event as JobStateEvent;
      if (ev.state === 'succeeded') {
        return {
          kind: 'upsert',
          jobId: ev.jobId,
          patch: { jobId: ev.jobId, phase: 'done', state: ev.state },
          settled: true,
        };
      }
      if (ev.state === 'cancelled') return { kind: 'dismiss', jobId: ev.jobId };
      // blocked / failed 有各自的专门事件，这里不重复处理
      if (ev.state === 'blocked' || ev.state === 'failed') return { kind: 'ignore' };
      return {
        kind: 'upsert',
        jobId: ev.jobId,
        patch: { jobId: ev.jobId, phase: 'active', state: ev.state },
      };
    }

    case 'job.blocked': {
      const ev = event as JobBlockedEvent;
      return {
        kind: 'upsert',
        jobId: ev.jobId,
        patch: {
          jobId: ev.jobId,
          phase: 'blocked',
          state: 'blocked',
          reason: ev.messageZh || ev.message,
          reasonEn: ev.message || ev.messageZh,
          remediation: ev.remediation,
        },
        /*
         * ★ 兜底，不是主路径（T-130 之后）：根因已在契约层修掉，流水线 job 现在会发
         * `job.created`，所以正常情况下这条 toast 已经存在、且标题是**真实的笔记标题**。
         * ⚠️ 但不能删：SSE 重放缓冲只有 256 条，`job.created` 滚出去而 `job.blocked`
         * 还在的窗口真实存在。宁可显示一个笼统的名字，也不能把"需要用户动手"的状态整条丢掉。
         */
        seed: { name: names.blocked(ev.blockedCode), kind: 'model', totalBytes: 0 },
      };
    }

    case 'job.failed': {
      const ev = event as JobFailedEvent;
      return {
        kind: 'upsert',
        jobId: ev.jobId,
        patch: {
          jobId: ev.jobId,
          // ★ 还在自动重试的失败**不升级为红色错误**（D-05 §2.3：重试中的失败不该打扰用户）。
          //   但也不能一声不吭 —— 保持 active 并在副文案里说"正在自动重试"。
          phase: ev.willRetry ? 'active' : 'failed',
          state: 'failed',
          willRetry: ev.willRetry,
          reason: ev.error?.messageZh ?? ev.error?.message,
          reasonEn: ev.error?.message ?? ev.error?.messageZh,
        },
        /*
         * ★ 与 blocked 同理的兜底 —— 而这一条此前**没有**：`job.failed` 不带 name，
         * 于是流水线任务**失败**时页面同样一个字都没有。同成因、同后果，只是没人撞见过。
         * 只给终态失败补建：还在自动重试的不该打扰用户（重试成功了他根本不用知道）。
         */
        ...(ev.willRetry
          ? {}
          : { seed: { name: names.failed(), kind: 'model' as ToastKind, totalBytes: 0 } }),
      };
    }
  }
}

/** 把一个动作合并进 toast 列表。纯函数：同样的输入永远得到同样的输出。 */
export function reduceToasts(prev: Toast[], action: ToastAction): Toast[] {
  if (action.kind === 'ignore') return prev;
  if (action.kind === 'dismiss') return prev.filter((x) => x.jobId !== action.jobId);

  const i = prev.findIndex((x) => x.jobId === action.jobId);
  if (i === -1) {
    // 没见过这个 job：只有事件自带名字（job.created）或调用方给了 seed 才补建
    if (action.patch.name == null && action.seed?.name == null) return prev;
    return [
      ...prev,
      {
        phase: 'active',
        state: 'queued',
        totalBytes: 0,
        kind: 'model',
        ...action.seed,
        ...action.patch,
      } as Toast,
    ];
  }
  const next = [...prev];
  next[i] = { ...(next[i] as Toast), ...action.patch };
  return next;
}
