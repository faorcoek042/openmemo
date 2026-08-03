import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { AnyJob, DownloadJob, JobState, PipelineJob } from '@openmemo/shared';

import { activeNoteJobs, isActiveJobState, pickActiveNoteJob } from './noteJobs';

const NOTE = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = '01BBBBBBBBBBBBBBBBBBBBBBBB';

function pipeline(p: {
  jobId: string;
  kind?: PipelineJob['kind'];
  noteUid?: string | null;
  state?: JobState;
  createdAt?: string;
  blockedCode?: string | null;
}): PipelineJob {
  return {
    jobId: p.jobId,
    kind: p.kind ?? 'transcribe',
    type: p.kind ?? 'transcribe',
    displayName: p.jobId,
    noteUid: p.noteUid === undefined ? NOTE : p.noteUid,
    state: p.state ?? 'running',
    step: null,
    progress: 0.5,
    attempt: 0,
    maxAttempts: 5,
    error: null,
    blockedCode: p.blockedCode ?? null,
    createdAt: p.createdAt ?? '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

/** 一条下载 job —— 它没有 `noteUid`，混进来时**绝不能**被当成这条笔记的任务。 */
const DOWNLOAD: DownloadJob = {
  jobId: 'dl1',
  kind: 'model',
  type: 'download.model',
  targetId: 'asr/whisper',
  displayName: 'Whisper',
  state: 'running',
  step: 'downloading',
  provider: null,
  totalBytes: 100,
  completedBytes: 10,
  speedBps: 1,
  etaSeconds: null,
  parts: [],
  currentFile: null,
  fileIndex: 0,
  fileCount: 1,
  attempt: 0,
  maxAttempts: 5,
  error: null,
  startedAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('T-138 ② 这条笔记上现在有没有任务在跑', () => {
  test('★ blocked 算"还没结束" —— 它正是最需要在笔记页上说话的状态', () => {
    assert.equal(isActiveJobState('blocked'), true, 'blocked 被当成终态 = 一次零报错的卡住又回来了');
    assert.equal(isActiveJobState('queued'), true);
    assert.equal(isActiveJobState('paused'), true);
    assert.equal(isActiveJobState('succeeded'), false);
    assert.equal(isActiveJobState('failed'), false);
    assert.equal(isActiveJobState('cancelled'), false);
  });

  test('★ 终态任务不许再显示成"进行中"', () => {
    const jobs: AnyJob[] = [pipeline({ jobId: 'j1', state: 'succeeded' })];
    assert.equal(pickActiveNoteJob(jobs, NOTE), undefined);
  });

  test('★ 别的笔记的任务不算这条笔记的', () => {
    const jobs: AnyJob[] = [pipeline({ jobId: 'j1', noteUid: OTHER })];
    assert.equal(pickActiveNoteJob(jobs, NOTE), undefined, '按 noteUid 归属，不是"随便找一条在跑的"');
  });

  test('★ 下载任务不许被认领成笔记任务（它根本没有 noteUid）', () => {
    const jobs: AnyJob[] = [DOWNLOAD];
    assert.equal(
      pickActiveNoteJob(jobs, NOTE),
      undefined,
      '下载模型的进度出现在笔记页上，用户会以为是这条笔记在转写',
    );
  });

  test('★ 按 kind 收窄：导图按钮只该看导图任务，转写在跑不是它的事', () => {
    const jobs: AnyJob[] = [
      pipeline({ jobId: 'tr', kind: 'transcribe' }),
      pipeline({ jobId: 'mm', kind: 'mindmap' }),
    ];
    assert.equal(pickActiveNoteJob(jobs, NOTE, 'mindmap')?.jobId, 'mm');
    assert.equal(pickActiveNoteJob(jobs, NOTE, 'transcribe')?.jobId, 'tr');
    assert.equal(
      pickActiveNoteJob(jobs, NOTE)?.jobId !== undefined,
      true,
      '不传 kind 时任意流水线任务都算',
    );
  });

  test('★ 多条未完成时取最新创建的那条 —— 用户刚点的那个就是他在等的那个', () => {
    /*
     * 顺序**故意给反**：`GET /api/jobs` 目前恰好是新的在前，但那是实现细节不是契约。
     * 这条断言钉的是"选择本身按 createdAt 排"，而不是"调用方给的第一条"。
     */
    const jobs: AnyJob[] = [
      pipeline({ jobId: 'old', state: 'blocked', createdAt: '2026-08-01T00:00:00.000Z' }),
      pipeline({ jobId: 'new', state: 'queued', createdAt: '2026-08-02T00:00:00.000Z' }),
    ];
    assert.equal(
      pickActiveNoteJob(jobs, NOTE)?.jobId,
      'new',
      '刚点完还在排队的那条输给了一个早就卡住的旧任务 —— 表现就是"我点了但什么都没变"',
    );
    assert.deepEqual(
      activeNoteJobs(jobs, NOTE).map((j) => j.jobId),
      ['new', 'old'],
    );
  });

  test('★ 没有 noteUid（还没打开笔记）时返回空，而不是随便挑一条', () => {
    const jobs: AnyJob[] = [pipeline({ jobId: 'j1' })];
    assert.deepEqual(activeNoteJobs(jobs, undefined), []);
    assert.equal(pickActiveNoteJob(jobs, undefined), undefined);
  });
});
