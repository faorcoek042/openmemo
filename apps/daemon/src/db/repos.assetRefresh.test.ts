/**
 * `createAsset` 的**幂等语义**：行的身份不许变，描述那个文件的数字必须跟着文件走（#96②）。
 *
 * ## 它对着的那件事
 *
 * 网络导入的笔记点「重新转写」会**重新下载一次源**，落在与上次完全相同的路径上，
 * `rename(2)` 静默覆盖。`createAsset` 按 `rel_path` 幂等 —— 这一条是对的，
 * 没有它重跑会 100% 撞 `UNIQUE constraint failed`。但旧写法是无条件 `return existing`，
 * 于是这一次真的量到的数（`stat()` 出来的 `bytes`、ffprobe 出来的 `duration_ms`）
 * **全被丢掉**，行里留着上一份文件的大小与时长。
 *
 * 这个错数为什么能一直没人发现：`/media/asset/:uid` 用 `stat()` 现取真实大小，
 * **播放、Range、ETag 全都不受影响** —— 它只在 `GET /api/notes/:uid` 的
 * `assets[].bytes` / `.durationMs` 上说假话。而同一次重转里
 * `notes.duration_ms` 与 `transcripts.duration_ms` 是刷新的，所以错的那份
 * 还会和自己家的另外两份对不上。
 *
 * ## 判据是**两侧都钉死**
 *
 * 只钉「覆盖后要刷新」是不够的：把它修成"每次都刷"同样会红这一半 ——
 * 而那会顺手改掉一条**没被动过的文件**的数（录音记的是墙上时钟，
 * 重转量的是 ffprobe，两个数对同一份文件都成立）。所以另一半钉的是
 * **没覆盖就一个字节都不许动**。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { openAppDatabase } from '@openmemo/db';

import { Repos } from './repos.js';

const made: string[] = [];
const closers: (() => void)[] = [];
after(() => {
  for (const c of closers) c();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function freshRepos(): Repos {
  const dir = mkdtempSync(join(tmpdir(), 'om-assetrefresh-'));
  made.push(dir);
  const handle = openAppDatabase({ filename: join(dir, 'openmemo.db') });
  closers.push(() => handle.close());
  const repos = new Repos(handle.db);
  repos.ensureDefaultFolder();
  return repos;
}

describe('createAsset：同一个 rel_path 上的文件被换掉之后', () => {
  it('★ 覆盖了盘上那份（传了 replacedAt）⇒ bytes / duration_ms 刷新，uid 与 rel_path 不变', () => {
    const repos = freshRepos();
    const note = repos.createNote({ title: '网络导入的一条' });

    const first = repos.createAsset({
      noteId: note.id,
      role: 'original',
      relPath: join(note.uid, 'source.mp3'),
      bytes: 1_000_000,
      durationMs: 60_000,
    });
    assert.equal(first.replaced_at, null, '首次导入不该被记成"换过"');

    // 第二次重转：远端内容变了，同名落点被覆盖
    const second = repos.createAsset({
      noteId: note.id,
      role: 'original',
      relPath: join(note.uid, 'source.mp3'),
      bytes: 2_500_000,
      durationMs: 143_000,
      replacedAt: 1_700_000_000_000,
    });

    assert.equal(
      second.uid,
      first.uid,
      '资产 uid 变了 —— /media/asset/<uid> 与前端的引用会一起失效',
    );
    assert.equal(second.id, first.id, '长出了第二条 original —— 那是另一个已经修过的 bug');
    assert.equal(second.rel_path, first.rel_path);
    assert.equal(
      second.bytes,
      2_500_000,
      'bytes 还是上一份文件的大小 —— GET /api/notes/:uid 会一直报这个错数（播放不受影响，所以没人发现）',
    );
    assert.equal(
      second.duration_ms,
      143_000,
      'duration_ms 还是上一份的时长 —— 而同一次重转刷新了 notes/transcripts 的时长，三者对不上',
    );
    assert.equal(
      second.replaced_at,
      1_700_000_000_000,
      '原件被换掉了却没留下时刻 —— 用户无从知道"我上次听到的那一版还在不在"',
    );

    // 只有一条 original：幂等本身没被这次改动破坏
    assert.equal(repos.assetsOfNote(note.id).length, 1);
  });

  it('★ 反向：没覆盖任何文件（不传 replacedAt）⇒ 旧行一个字节都不许动', () => {
    const repos = freshRepos();
    const note = repos.createNote({ title: '一条录音' });

    const first = repos.createAsset({
      noteId: note.id,
      role: 'original',
      relPath: join('recordings', 'REC01.wav'),
      // 录音记的是墙上时钟
      bytes: 3_528_044,
      durationMs: 110_250,
    });

    /*
     * 重转一条录音：文件本来就在 media/ 里，`archiveIntoMedia` 提前返回、
     * 根本没动它，于是不传 `replacedAt`。这时 ffprobe 量出来的时长哪怕和
     * 墙上时钟差几十毫秒，也**不该**悄悄换掉库里那个 —— 同一份文件的两种量法，
     * 换掉一个不是修复，是另一种漂移。
     */
    const again = repos.createAsset({
      noteId: note.id,
      role: 'original',
      relPath: join('recordings', 'REC01.wav'),
      bytes: 3_528_044,
      durationMs: 110_312,
    });

    assert.equal(again.id, first.id);
    assert.equal(again.duration_ms, 110_250, '文件没被动过，行里的数却被改了');
    assert.equal(again.bytes, 3_528_044);
    assert.equal(again.replaced_at, null, '没换过任何文件，却记上了一笔替换');
  });

  it('这次没量到的列不许被"没量到"覆盖掉（undefined ≠ null）', () => {
    const repos = freshRepos();
    const note = repos.createNote({ title: '一条网络导入' });

    const first = repos.createAsset({
      noteId: note.id,
      role: 'original',
      relPath: join(note.uid, 'source.m4a'),
      bytes: 900_000,
      durationMs: 30_000,
      sampleRate: 44_100,
      channels: 2,
    });
    assert.equal(first.sample_rate, 44_100);

    // 覆盖发生了，但这一跑没去量采样率/声道
    const second = repos.createAsset({
      noteId: note.id,
      role: 'original',
      relPath: join(note.uid, 'source.m4a'),
      bytes: 950_000,
      durationMs: 31_000,
      replacedAt: 1_700_000_000_001,
    });

    assert.equal(second.bytes, 950_000);
    assert.equal(second.sample_rate, 44_100, '"这次没量"被写成了"量到 NULL"');
    assert.equal(second.channels, 2);
  });
});
