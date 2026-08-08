/**
 * T-157 ③ —— `listNotes` / `countNotes` 的翻页性质（直接打库，不经 HTTP）。
 *
 * ## 为什么端到端那几条还不够
 *
 * `notesRest.test.ts` 里的翻页用例是靠连续上传建笔记的，**每条的 `created_at` 都不一样**。
 * 于是「排序里那个唯一次级键」这条性质在那儿测不出来：
 * `[实测]` 把 `ORDER BY created_at DESC, id DESC` 改回 `ORDER BY created_at DESC`，
 * 那一组用例**一条都不红**。
 *
 * 而真实用户恰恰会撞到相同的 `created_at`：批量导入一个播放列表时，
 * 几条笔记在同一毫秒内建出来是常事。此时只按 `created_at` 排序的话，
 * 相同键的相对顺序由 SQLite 自己定、两次查询可以不同 ——
 * `LIMIT/OFFSET` 翻页于是会**重复一条、漏掉另一条**，而两页各自看起来都完全正常。
 *
 * 所以这一组把 `created_at` **钉成同一个值**，让那条性质变成可判定的。
 * 判据仍然是后果：**翻完所有页拿到的 uid 集合 == 全部笔记，且一条不重复。**
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
  const dir = mkdtempSync(join(tmpdir(), 'om-paging-'));
  made.push(dir);
  const handle = openAppDatabase({ filename: join(dir, 'openmemo.db') });
  closers.push(() => handle.close());
  const repos = new Repos(handle.db);
  repos.ensureDefaultFolder();
  return repos;
}

/** 一页页翻到底，返回按顺序收集到的全部 uid。 */
function pageThrough(
  repos: Repos,
  pageSize: number,
  opts: { starredOnly?: boolean } = {},
): string[] {
  const total = repos.countNotes(opts);
  const seen: string[] = [];
  for (let offset = 0; offset < total; offset += pageSize) {
    seen.push(...repos.listNotes(pageSize, { ...opts, offset }).map((n) => n.uid));
  }
  return seen;
}

describe('T-157 ③ 笔记翻页：created_at 撞车时也不许重复或漏条', () => {
  it('★ 8 条笔记全部建在同一毫秒 —— 每页 3 条翻完必须**不重不漏**', () => {
    const repos = freshRepos();
    const SAME_MS = 1_760_000_000_000;
    const uids: string[] = [];
    for (let i = 0; i < 8; i++) {
      uids.push(repos.createNote({ title: `n${i}`, now: SAME_MS }).uid);
    }

    // 先证明夹具真的做到了"同一毫秒"，否则这条用例钉的是别的东西
    const stamps = new Set(repos.listNotes(100).map((n) => n.created_at));
    assert.equal(stamps.size, 1, `夹具没造出 created_at 撞车（实际 ${stamps.size} 个不同值）`);

    const seen = pageThrough(repos, 3);
    assert.equal(
      new Set(seen).size,
      seen.length,
      `翻页翻出了重复条目（${seen.length} 条里只有 ${new Set(seen).size} 个不同的 uid）——` +
        '重复的另一面必然是漏掉，而两页各自看起来都正常',
    );
    assert.deepEqual([...seen].sort(), [...uids].sort(), '翻完所有页拿到的不是全部笔记');
  });

  it('★ 同一批筛选条件下 countNotes 与 listNotes 必须同口径', () => {
    // 两处各写一份 WHERE 的表现是"说还有 3 条、翻过去是空的"：
    // 两个数字各自都算对了，只有用户觉得这软件有点怪。
    const repos = freshRepos();
    const SAME_MS = 1_760_000_000_000;
    const uids = Array.from(
      { length: 5 },
      (_, i) => repos.createNote({ title: `n${i}`, now: SAME_MS }).uid,
    );
    repos.setNoteStarred(repos.noteByUid(uids[0] as string)!.id, true);
    repos.setNoteStarred(repos.noteByUid(uids[1] as string)!.id, true);

    assert.equal(repos.countNotes(), 5);
    assert.equal(repos.countNotes({ starredOnly: true }), 2);
    assert.deepEqual(
      pageThrough(repos, 1, { starredOnly: true }).sort(),
      [uids[0], uids[1]].sort(),
      '按星标翻页拿到的不是那两条 —— count 与 list 口径分叉了',
    );
  });

  it('offset 超过总数时返回空数组，不报错也不回绕到第一页', () => {
    const repos = freshRepos();
    repos.createNote({ title: 'only', now: 1_760_000_000_000 });
    assert.equal(repos.listNotes(50, { offset: 999 }).length, 0);
  });
});
