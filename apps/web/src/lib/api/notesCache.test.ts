import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { applyStarToPage, applyStarToPages, type NotesPage, type NotesPages } from './notesCache';
import type { NoteSummary } from './types';

/**
 * ⚠️ T-150：这个夹具原来还写着 `folderUid` / `coverAssetUid` / `source` 三个字段。
 * 它们**从来不在 `GET /api/notes` 的响应里** —— `NoteSummary` 换成共享契约
 * `NoteListItem` 之后编译当场报错，于是这里也一并去掉。
 * 一个比真实响应宽的测试夹具，测的就是一个不存在的形状。
 */
function note(uid: string, starred: boolean): NoteSummary {
  return {
    uid,
    title: uid,
    kind: 'media',
    status: 'ready',
    language: null,
    durationMs: 1000,
    starred,
    tags: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

const PAGE: NotesPage = {
  notes: [note('a', true), note('b', false)],
  total: 2,
  limit: 50,
  offset: 0,
  hasMore: false,
};

describe('T-138 ③ 星标切换的乐观更新规则', () => {
  test('★ 「全部笔记」那一页：只翻标记，一条都不许少', () => {
    const out = applyStarToPage(PAGE, {}, 'a', false);
    assert.deepEqual(
      out?.notes.map((n) => [n.uid, n.starred]),
      [
        ['a', false],
        ['b', false],
      ],
      '「全部笔记」不按星标筛，取消星标不该让那条笔记从列表里消失',
    );
  });

  test('★ 「星标」那一页：取消星标要把它移出去（否则用户点了没反应）', () => {
    const out = applyStarToPage(PAGE, { starred: true }, 'a', false);
    assert.deepEqual(
      out?.notes.map((n) => n.uid),
      [],
      '星标页是服务端按 starred=1 筛过的一页，取消星标之后它就不属于这一页了 —— ' +
        '留在原地等 invalidate 回来才消失，用户看到的是"点了没反应"',
    );
  });

  test('★ 「星标」那一页：加星是加星，别把别人的状态也改了', () => {
    const out = applyStarToPage(PAGE, { starred: true }, 'b', true);
    assert.deepEqual(
      out?.notes.map((n) => [n.uid, n.starred]),
      [
        ['a', true],
        ['b', true],
      ],
      '只有被点的那条该变',
    );
  });

  test('★ 缓存还没建立时返回 undefined，而不是凭空造一页空列表', () => {
    assert.equal(
      applyStarToPage(undefined, { starred: true }, 'a', false),
      undefined,
      '把 undefined 变成 {notes:[]} 会让"还没加载"和"加载完是空的"变成同一件事 —— ' +
        '页面会先闪一次空态',
    );
  });

  test('★ 不认识的 filter 一律按"不筛"处理（宁可多显示一条，也不凭空藏东西）', () => {
    const out = applyStarToPage(PAGE, { folder: 'x' }, 'a', false);
    assert.equal(out?.notes.length, 2);
  });

  /*
   * ★ T-157 ③：翻页之后，同一条规则要多守两件事。
   */
  test('★ 星标页移出一条时 total 也要减 —— 否则界面会说"还有 1 条"然后翻出空的', () => {
    // 夹具要**像服务端真会返回的那一页**：星标页上每条都带星。
    // 拿上面那份混着未加星的 PAGE 来测，取消一条会连带把 b 也筛掉，
    // 得到的 0 既不是缺陷也不是修复 —— 只是夹具不成立。
    const starredPage: NotesPage = {
      notes: [note('a', true), note('b', true)],
      total: 2,
      limit: 50,
      offset: 0,
      hasMore: false,
    };
    const out = applyStarToPage(starredPage, { starred: true }, 'a', false);
    assert.deepEqual(
      out?.notes.map((n) => n.uid),
      ['b'],
    );
    assert.equal(
      out?.total,
      1,
      'total 不跟着动的话，页脚会一边显示"已显示 1 / 2 条"一边给出一个拉回空数组的「加载更多」',
    );
  });

  test('★ 乐观更新要打到**每一页**，不是只打第一页', () => {
    // 翻到第二页之后在第二页上点星星 —— 只改 pages[0] 的话它会一动不动，
    // 而"点了没反应"正是用户会连点第二次的那种反馈（T-138 那次的同形疏漏）。
    const p2: NotesPage = { ...PAGE, notes: [note('c', false)], offset: 2, total: 3 };
    const data: NotesPages = { pages: [PAGE, p2], pageParams: [0, 2] };
    const out = applyStarToPages(data, {}, 'c', true);
    assert.deepEqual(
      out?.pages.map((p) => p.notes.map((n) => [n.uid, n.starred])),
      [
        [
          ['a', true],
          ['b', false],
        ],
        [['c', true]],
      ],
    );
  });
});
