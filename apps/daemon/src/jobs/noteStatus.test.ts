/**
 * #98 —— **一条转写失败的笔记，不许在列表里永远写着「处理中」。**
 *
 * ## 被钉住的那个缺陷
 *
 * `notes.status` 的 CHECK 约束里从第一天就有 `'failed'`，`NotesListPage.tsx` 也一直
 * 在渲染它（红色的「失败」chip）。但**全仓没有任何一处写过这个值** ——
 * 接收端早就建好了，发送端从来没接上。于是转写失败之后：
 * 右下角一条刷新即无的 toast、详情页一个字不说、列表说它还在跑。
 *
 * 修法是**读时自愈**（不写库）：序列化笔记时问一次 `jobs` 表。
 * 这个文件钉的就是那条判据，外加它下面那句 SQL 真的按 `(note, type)` 取到了最新一条。
 *
 * ## 判据为什么钉在这一层
 *
 * 纯函数 + 一次真 SQLite，**不起 daemon**：
 * 这条规则的每一档（可重试的中间失败 / 终态失败 / 重跑之后翻篇 / 已经 ready 的笔记）
 * 都是状态组合，用真 HTTP 去摆这些组合既慢又不可靠。
 * `queue.fail()` 是真的在跑（它决定"可重试"要不要落 `failed`），
 * 所以这里验的不是我对它行为的想象。
 *
 * 复现判据：把 `rest/notes.ts` 里 `effectiveNoteStatus(...)` 换回 `noteStatusOf(n.status)`，
 * 本文件的第二条与第三条必须变红。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { openAppDatabase } from '@openmemo/db';

import { Repos } from '../db/repos.js';
import { JobQueue } from './queue.js';
import { effectiveNoteStatus, noteFailureOf } from './noteStatus.js';

const made: string[] = [];
const closers: (() => void)[] = [];
after(() => {
  for (const c of closers) c();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function fresh(): { repos: Repos; queue: JobQueue } {
  const dir = mkdtempSync(join(tmpdir(), 'om-notestatus-'));
  made.push(dir);
  const handle = openAppDatabase({ filename: join(dir, 'openmemo.db') });
  closers.push(() => handle.close());
  const repos = new Repos(handle.db);
  repos.ensureDefaultFolder();
  return { repos, queue: new JobQueue(handle.db, 'test') };
}

/** 一条刚导入、还在 `processing` 的笔记 + 一条属于它的转写任务。 */
function noteWithJob(): {
  repos: Repos;
  queue: JobQueue;
  noteId: number;
  jobId: number;
  jobUid: string;
} {
  const { repos, queue } = fresh();
  const note = repos.createNote({ title: '一节课的录音' });
  // 前提（非空虚）：`createNote` 就是落 'processing' 的，后面的断言才有对象
  assert.equal(note.status, 'processing', '前提：新建的笔记就是 processing');
  const job = queue.enqueue({ type: 'transcribe', lane: 'gpu.asr', noteId: note.id });
  return { repos, queue, noteId: note.id, jobId: job.id, jobUid: job.uid };
}

const digestOf = (queue: JobQueue, noteId: number) => queue.noteJobDigests([noteId]).get(noteId);

describe('#98 笔记状态的读时自愈', () => {
  it('★ 任务还在排队 → 仍然是「处理中」（没失败就别说失败）', () => {
    const { queue, noteId } = noteWithJob();
    assert.equal(effectiveNoteStatus('processing', digestOf(queue, noteId)), 'processing');
    assert.equal(noteFailureOf(digestOf(queue, noteId)), null);
  });

  it('★★ 终态失败 → 报 failed，并说得出为什么（这条就是那个 bug）', () => {
    const { queue, noteId, jobId, jobUid } = noteWithJob();

    // retryable=false ⇒ `queue.fail()` 直接落终态 failed
    assert.equal(
      queue.fail(
        jobId,
        'NO_MEDIA_SOURCE',
        'no media source can handle this input. 换个直链试试',
        false,
      ),
      'failed',
      '前提：这一步必须真的落到 failed，否则后面测的是另一件事',
    );

    assert.equal(
      effectiveNoteStatus('processing', digestOf(queue, noteId)),
      'failed',
      '库里存着 processing、任务已经死了 —— 列表上那句「处理中」正是本轮要消灭的谎话',
    );

    const failure = noteFailureOf(digestOf(queue, noteId));
    assert.equal(failure?.jobUid, jobUid, '得说得出是**哪条**任务，否则「重试」按钮无从下手');
    assert.equal(failure?.kind, 'transcribe');
    assert.equal(failure?.code, 'NO_MEDIA_SOURCE');
    /*
     * ★ 中文那份**必须是中文**。它曾经就是英文原文的拷贝
     * （`pipelineJobOf()` 把 error_detail 同时填进 message 和 messageZh），
     * 于是中文界面上渲染出一句英文，而没有任何东西会因此报错。
     */
    assert.notEqual(
      failure?.messageZh,
      failure?.message,
      'messageZh 与 message 逐字相同 = 又一次把英文当中文交出去',
    );
    assert.ok(
      /没有可用的媒体来源/.test(failure?.messageZh ?? ''),
      `messageZh 应该是一句真的中文，实际是：${failure?.messageZh ?? '(空)'}`,
    );
  });

  it('★★ 可重试的中间失败**不**算失败 —— 一次网络抖动不许把笔记永久标红', () => {
    const { queue, noteId, jobId } = noteWithJob();

    // retryable=true 且 attempt 还没用完 ⇒ 退避后回 queued（留着 error_code）
    assert.equal(
      queue.fail(jobId, 'RUNNER_ERROR', 'socket hang up', true),
      'queued',
      '前提：可重试的失败应当回到 queued，否则这条用例测不到它想测的东西',
    );

    assert.equal(
      effectiveNoteStatus('processing', digestOf(queue, noteId)),
      'processing',
      '还会自己再试一次的任务被报成「失败」= 用户以为白等了',
    );
    assert.equal(noteFailureOf(digestOf(queue, noteId)), null);
  });

  it('★ 重跑一次就翻篇 —— 旧的失败不许一直挂在页面上', () => {
    const { queue, noteId, jobId } = noteWithJob();
    queue.fail(jobId, 'RUNNER_ERROR', 'boom', false);
    assert.equal(effectiveNoteStatus('processing', digestOf(queue, noteId)), 'failed');

    // 用户点了「重新转写」：同一条笔记上再排一条
    queue.enqueue({ type: 'transcribe', lane: 'gpu.asr', noteId });

    assert.equal(
      effectiveNoteStatus('processing', digestOf(queue, noteId)),
      'processing',
      '判据要是「失败过」，那它会永久为真，笔记会永远标红',
    );
    assert.equal(noteFailureOf(digestOf(queue, noteId)), null);
  });

  it('★ 已经转写好的笔记，重跑失败仍然是 ready（稿子确实还在）', () => {
    const { queue, noteId, jobId } = noteWithJob();
    queue.fail(jobId, 'RUNNER_ERROR', 'boom', false);

    assert.equal(
      effectiveNoteStatus('ready', digestOf(queue, noteId)),
      'ready',
      '把一条读得了的笔记标成「失败」是另一句假话，而且更贵：用户会以为数据没了',
    );
    // 但那次失败仍然要说出来 —— 由 lastFailure 单独说，两件事分开表达
    assert.notEqual(noteFailureOf(digestOf(queue, noteId)), null);
  });

  it('★ 导图任务失败不改笔记状态，但会出现在 lastFailure 里', () => {
    const { repos, queue } = fresh();
    const note = repos.createNote({ title: '有稿子的笔记' });
    const mind = queue.enqueue({ type: 'mindmap', lane: 'gpu.llm', noteId: note.id });
    queue.fail(mind.id, 'LLM_NOT_CONFIGURED', 'no llm configured', false);

    const digest = queue.noteJobDigests([note.id]).get(note.id);
    assert.equal(
      effectiveNoteStatus('processing', digest),
      'processing',
      '导图失败让笔记显示「转写失败」= 说了一件它并不知道的事',
    );
    assert.equal(noteFailureOf(digest)?.kind, 'mindmap');
  });

  it('★ 没有任何 job 的笔记：判据不许凭空冒出结论', () => {
    const { repos, queue } = fresh();
    const note = repos.createNote({ title: '刚建的' });
    assert.equal(queue.noteJobDigests([note.id]).size, 0);
    assert.equal(effectiveNoteStatus('processing', undefined), 'processing');
    assert.equal(noteFailureOf(undefined), null);
  });

  it('★ 批量取：一次查询要能同时答对多条笔记（列表页不许 N+1）', () => {
    const { repos, queue } = fresh();
    const bad = repos.createNote({ title: '死了的' });
    const good = repos.createNote({ title: '在跑的' });
    const j1 = queue.enqueue({ type: 'transcribe', lane: 'gpu.asr', noteId: bad.id });
    queue.enqueue({ type: 'transcribe', lane: 'gpu.asr', noteId: good.id });
    queue.fail(j1.id, 'RUNNER_ERROR', 'boom', false);

    const map = queue.noteJobDigests([bad.id, good.id]);
    assert.equal(effectiveNoteStatus('processing', map.get(bad.id)), 'failed');
    assert.equal(effectiveNoteStatus('processing', map.get(good.id)), 'processing');
  });
});
