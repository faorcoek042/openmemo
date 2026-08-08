import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { reduceToasts, toastActionFor, type Toast } from './jobToastModel.js';

/**
 * T-130 —— 「一条 `job.blocked` 到底能不能被用户看见」。
 *
 * ## 这组测试的载荷是**抄来的，不是编的**
 *
 * 下面每一条事件都是从真 daemon 的 `GET /api/events` 上原样抓下来的
 * （空数据目录 → 没有 ASR 模型 → 拖一个 wav 进去）。这一点很重要：
 * 上一版 `job.created` 的载荷是 `{jobUid, kind, label}`，与契约完全不同，
 * 而当时的端到端脚本**只断言了事件类型**，于是它一路发到浏览器，
 * 消费方读 `ev.job.jobId` 每次上传都抛一次 TypeError，没有任何测试变红。
 *
 * 配套的服务端断言在 `apps/daemon/src/jobs/pipelineJobEvents.test.ts`
 * （起真 daemon、真上传、真 SSE，断言发出去的字段名）。两边合起来才覆盖整条链路。
 */

/** 真 daemon 发出的 job.created（转写，排队中）。 */
const CREATED = {
  type: 'job.created',
  ts: '2026-08-03T12:40:47.517Z',
  topic: 'job:01KZ3T85MXGADJX7D5KZ3ZA28Q',
  job: {
    jobId: '01KZ3T85MXGADJX7D5KZ3ZA28Q',
    kind: 'transcribe',
    type: 'transcribe',
    displayName: 'sample-tone.wav',
    noteUid: '01KZ3T85MWND9C292D63X3H2AH',
    state: 'queued',
    step: null,
    progress: 0,
    attempt: 0,
    maxAttempts: 5,
    error: null,
    blockedCode: null,
    createdAt: '2026-08-03T12:40:47.517Z',
    updatedAt: '2026-08-03T12:40:47.517Z',
  },
};

/** 真 daemon 发出的 job.blocked（没装 ASR 模型）。 */
const BLOCKED = {
  type: 'job.blocked',
  ts: '2026-08-03T12:40:47.557Z',
  topic: 'job:01KZ3T85MXGADJX7D5KZ3ZA28Q',
  jobId: '01KZ3T85MXGADJX7D5KZ3ZA28Q',
  blockedCode: 'MISSING_ASR_MODEL',
  messageZh: '尚未安装语音识别模型',
  message: 'ASR model not installed',
  remediation: {
    action: 'installModel',
    params: { role: 'asr' },
    labelZh: '去安装语音识别模型',
    label: 'Install an ASR model',
  },
};

/** 旧 daemon（T-130 之前）用 `as never` 发出去的**坏**载荷，形状与契约完全不同。 */
const MALFORMED_CREATED = {
  type: 'job.created',
  ts: '2026-08-03T12:16:30.651Z',
  topic: 'job:01KZ3RVPXT6QF7KKT6Q456MPWZ',
  jobUid: '01KZ3RVPXT6QF7KKT6Q456MPWZ',
  kind: 'transcribe',
  label: 'sample-tone.wav',
};

const NAMES = {
  blocked: (code: string) => (code === 'MISSING_ASR_MODEL' ? '转写任务已暂停' : '后台任务已暂停'),
  failed: () => '后台任务',
};

const feed = (events: [Parameters<typeof toastActionFor>[0], unknown][]): Toast[] =>
  events.reduce<Toast[]>(
    (acc, [type, ev]) => reduceToasts(acc, toastActionFor(type, ev, NAMES)),
    [],
  );

describe('T-130 流水线 job 的状态能不能到达 toast 层', () => {
  test('★ 真实链路：job.created → job.blocked，用户必须看到一条带原因和补救的提示', () => {
    const toasts = feed([
      ['job.created', CREATED],
      [
        'job.state',
        { type: 'job.state', jobId: CREATED.job.jobId, state: 'running', previousState: 'leased' },
      ],
      ['job.blocked', BLOCKED],
    ]);

    assert.equal(toasts.length, 1, '必须有且只有一条 toast');
    const toast = toasts[0] as Toast;
    assert.equal(toast.phase, 'blocked', 'blocked 是"等前置条件"，不是失败');
    assert.equal(
      toast.name,
      'sample-tone.wav',
      '标题必须是真实笔记标题 —— 用的是 job.created 带来的身份，而不是兜底名字。' +
        '若这里退回"转写任务已暂停"，说明根因（服务端不发 job.created）又回来了',
    );
    assert.equal(toast.reason, '尚未安装语音识别模型');
    assert.equal(toast.reasonEn, 'ASR model not installed', '英文界面不能渲染中文原因');
    assert.equal(toast.remediation?.action, 'installModel', 'blocked 必须带可点的补救动作');
    assert.equal(toast.noteUid, CREATED.job.noteUid);
    assert.equal(toast.totalBytes, 0, '转写没有字节计数，不能画成一个卡住的下载条');
  });

  test('★ 反向验证的靶子：服务端不发 job.created 时，blocked 仍然必须可见（兜底层）', () => {
    // 这正是 T-130 被发现时的现场：只有 job.state 和 job.blocked，没有 job.created
    const toasts = feed([
      [
        'job.state',
        { type: 'job.state', jobId: BLOCKED.jobId, state: 'running', previousState: 'leased' },
      ],
      ['job.blocked', BLOCKED],
    ]);

    assert.equal(
      toasts.length,
      1,
      '即使没被介绍过这个 jobId，"需要用户动手"的状态也必须补建 —— ' +
        '丢掉它就是一次零报错的卡住：用户点了导入，页面一个字都没有',
    );
    assert.equal((toasts[0] as Toast).name, '转写任务已暂停', '没有真实标题时才用笼统兜底名');
    assert.equal((toasts[0] as Toast).reason, '尚未安装语音识别模型');
  });

  test('★ 兜底名字不能盖掉真实标题（两层叠加时的顺序）', () => {
    const toasts = feed([
      ['job.created', CREATED],
      ['job.blocked', BLOCKED],
    ]);
    assert.equal(
      (toasts[0] as Toast).name,
      'sample-tone.wav',
      'seed 只在补建时生效；覆盖已有条目会让修复后的提示反而比修复前更差',
    );
  });

  test('★ 终态失败同样不许静默（与 blocked 同成因，只是没人撞见过）', () => {
    const toasts = feed([
      [
        'job.failed',
        {
          type: 'job.failed',
          jobId: 'j-unseen',
          error: {
            code: 'RUNNER_ERROR',
            message: 'ffmpeg exited 1',
            messageZh: '任务失败：ffmpeg exited 1',
            retryable: false,
          },
          willRetry: false,
          nextProvider: null,
        },
      ],
    ]);
    assert.equal(toasts.length, 1, '没见过的 job 终态失败也必须出现 —— 失败是用户必须知道的事');
    assert.equal((toasts[0] as Toast).phase, 'failed');
  });

  test('还在自动重试的失败不补建（重试成功了用户根本不用知道）', () => {
    const toasts = feed([
      [
        'job.failed',
        {
          type: 'job.failed',
          jobId: 'j-unseen',
          error: {
            code: 'NETWORK_TIMEOUT',
            message: 'timeout',
            messageZh: '网络超时',
            retryable: true,
          },
          willRetry: true,
          nextProvider: null,
        },
      ],
    ]);
    assert.equal(toasts.length, 0, '重试中的失败不该打扰用户（D-05 §2.3）');
  });

  test('纯生命周期噪音仍然丢弃：刷新页面时重放的历史 job.state 不该凭空造出 toast', () => {
    const toasts = feed([
      [
        'job.state',
        { type: 'job.state', jobId: 'old-job', state: 'running', previousState: 'leased' },
      ],
      [
        'job.state',
        { type: 'job.state', jobId: 'old-job', state: 'queued', previousState: 'running' },
      ],
    ]);
    assert.equal(
      toasts.length,
      0,
      '没有名字、也不需要用户做什么的事件，补建出来只是一条没有主语的提示',
    );
  });

  test('★ 坏载荷不许让处理器抛异常（旧 daemon 的 as never 事件）', () => {
    let toasts: Toast[] = [];
    assert.doesNotThrow(() => {
      toasts = feed([['job.created', MALFORMED_CREATED]]);
    }, '消费方不该假设发送方永远正确 —— 这条事件曾让每次上传都在控制台抛一次 TypeError');
    assert.equal(toasts.length, 0, '认不出的载荷宁可忽略，也不要建一条没有名字的 toast');
  });

  test('★ 转写完成要能走到 done —— job.state(succeeded) 是唯一的入口', () => {
    const toasts = feed([
      ['job.created', CREATED],
      [
        'job.state',
        {
          type: 'job.state',
          jobId: CREATED.job.jobId,
          state: 'succeeded',
          previousState: 'running',
        },
      ],
    ]);
    assert.equal(
      (toasts[0] as Toast).phase,
      'done',
      '调度器原来只发 job.done 不发 job.state(succeeded)，于是转写跑完了提示还停在"转写中"',
    );
  });

  test('下载 job 一个字段都不能受影响（同一条通道上的另一半）', () => {
    const toasts = feed([
      [
        'job.created',
        {
          type: 'job.created',
          job: {
            jobId: 'dl-1',
            kind: 'model',
            type: 'download.model',
            targetId: 'asr/whisper-large-v3-turbo-q8_0',
            displayName: 'Whisper large v3 turbo',
            state: 'queued',
            step: null,
            provider: null,
            totalBytes: 874_000_000,
            completedBytes: 0,
            speedBps: 0,
            etaSeconds: null,
            parts: [],
            currentFile: null,
            fileIndex: 0,
            fileCount: 1,
            attempt: 0,
            maxAttempts: 5,
            error: null,
            startedAt: '2026-08-03T12:00:00.000Z',
            updatedAt: '2026-08-03T12:00:00.000Z',
          },
        },
      ],
    ]);
    const toast = toasts[0] as Toast;
    assert.equal(toast.kind, 'model');
    assert.equal(toast.name, 'Whisper large v3 turbo');
    assert.equal(toast.totalBytes, 874_000_000, '下载 job 的字节计数必须保留，进度条靠它');
  });
});
