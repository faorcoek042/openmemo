/**
 * 「写操作失败了，界面必须说话」—— 这一族的**回归腿**。
 *
 * ## 为什么单独开一个 bundle，而不是并进 components.test.tsx
 *
 * 判据不同。`components.test.tsx` 覆盖的是"这个组件渲染/交互对不对"；
 * 这里覆盖的是**一条横切规则**：
 *
 *   > **任何一个用户点出来的写操作，失败时界面上必须出现可读的东西。**
 *
 * 这条规则被违反过至少 16 次（14 处 `void mutateAsync` + 本轮又查出的几处），
 * 每次的形状都一样：成功路径接了，失败路径没人渲染，**用户看到的与"按钮是死的"完全一样**。
 * 把它们收在一个文件里，加新按钮的人一眼能看到该照着写什么。
 *
 * ## ⚠️ 断言钉的是**结构**，不是**用词**
 *
 * 这一点是 B11 那次教训的直接产物。`e2e-browser-audit.mjs` 的 B11 原来用关键词表
 * （`/失败|错误|重试|无法|不可用|出错|error|failed|retry/i`）判断"说话了没有"，
 * 而产品对 `FOLDER_NOT_FOUND` 渲染的是「文件夹不存在 / 它可能刚被删掉了。侧栏刷新后
 * 重新选一个。」—— **一个关键词都不含**。于是产品明明说了话，断言报「界面一个字都没说」。
 *
 * **文案写得越好，关键词判据越判不出来** —— 它在惩罚好文案。
 * 所以这里一律断言 `[data-testid="error-block"]`（`ErrorBlock` 的结构标记，
 * 同时带 `role="alert"`）**出现在该出现的容器里**，且**文字非空**。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { render, click, type, stubApi } from './host';
import { NoteActionsMenu } from '../features/notes/NoteActionsMenu';

const UID = '01B11AAAAAAAAAAAAAAAAAAAAA';
const NOTE = { uid: UID, title: '一条笔记' };

/** 造一个真实形状的错误响应（照抄 daemon 的错误信封）。 */
const fail = (status: number, code: string, messageZh: string) =>
  new Response(JSON.stringify({ error: { code, message: code, messageZh } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 某个容器里有没有一个**说得出话**的错误块。 */
function spoke(root: Element | null): { block: boolean; text: string } {
  if (!root) return { block: false, text: '' };
  const el = root.querySelector('[data-testid="error-block"]');
  return { block: el !== null, text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim() };
}

async function openMenu(r: Awaited<ReturnType<typeof render>>) {
  await click(r.container.querySelector('[data-testid="note-actions"]'));
  await r.flush();
}

describe('写操作失败时界面必须说话（NoteActionsMenu）', () => {
  /*
   * ★ 这一条是 B11 的等价复现。
   * B11 在真浏览器里报「端点回了 404 FOLDER_NOT_FOUND，而界面一个字都没说」——
   * 这里证明那是**假指控**：产品一直是说话的，B11 的判据看不见它。
   */
  test('★ 移动失败：面板留在原地，且面板里出现错误块（B11 的等价复现）', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`PUT /notes/${UID}/folder`]: fail(404, 'FOLDER_NOT_FOUND', '文件夹不存在'),
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-move"]'));
    await r.flush();

    await click(r.container.querySelector('[data-testid="note-move-root"]'));
    await r.flush();

    const panel = r.container.querySelector('[data-testid="note-move-panel"]');
    assert.equal(
      panel === null,
      false,
      '移动失败后面板被收起来了 —— 用户分不清"移好了"还是"被吞了"',
    );
    const got = spoke(panel);
    assert.equal(got.block, true, `面板里没有错误块。面板文字：${panel?.textContent ?? ''}`);
    assert.equal(got.text.length > 0, true, '错误块渲染出来了，但一个字都没有');
  });

  /*
   * ★ 删除：修之前 `onError: () => close()` 把整个下拉卸载，而 `del.isError` 零渲染点。
   *   更坏的是它旁边那句注释写着"错误由 mutation 自己的状态呈现"—— 那个渲染点不存在。
   */
  test('★ 删除失败：菜单不许收起，且要出现错误块', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`DELETE /notes/${UID}`]: fail(409, 'NOTE_IN_USE', '这条笔记正在被使用'),
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-delete"]'));
    await r.flush();
    await click(r.container.querySelector('[data-testid="note-delete-confirm"]'));
    await r.flush();

    // 判据先证明自己不是空的：确认区还在，说明菜单没被卸载
    assert.equal(
      r.container.querySelector('[data-testid="note-delete-confirm"]') === null,
      false,
      '删除失败后菜单整个收起来了 —— 笔记还在、一个字都没有，用户只会以为自己没点中',
    );
    const got = spoke(r.container);
    assert.equal(got.block, true, `删除失败后没有任何错误块：${r.container.textContent ?? ''}`);
    assert.equal(got.text.length > 0, true, '错误块渲染出来了，但一个字都没有');
  });

  /* ★ 改名：修之前是 `onSettled: close` —— 成功失败都收起，失败等于静默。 */
  test('★ 改名失败：输入框不许收起，且要出现错误块', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`PATCH /notes/${UID}`]: fail(400, 'BAD_REQUEST', '标题不合法'),
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-rename"]'));
    await r.flush();
    await type(r.container.querySelector('[data-testid="note-rename-input"]'), '新标题');
    await click(r.container.querySelector('[data-testid="note-rename-save"]'));
    await r.flush();

    assert.equal(
      r.container.querySelector('[data-testid="note-rename-input"]') === null,
      false,
      '改名失败后输入框被收起 —— 用户看到"面板关了、标题没变"，分不清是没刷新还是被吞了',
    );
    const got = spoke(r.container);
    assert.equal(got.block, true, `改名失败后没有任何错误块：${r.container.textContent ?? ''}`);
    assert.equal(got.text.length > 0, true, '错误块渲染出来了，但一个字都没有');
  });

  /*
   * ★ 反向的守卫：**什么都还没失败的时候**不许出现错误块。
   *   没有它，把 `{isError ? … }` 写成恒真也能让上面三条全绿。
   *
   * ⚠️ 这条**第一版写错了**，如实记下：原来是"移动成功之后不许有错误块"。
   *   `[实测]` 把渲染条件改成恒真，它**照样绿** —— 因为移动成功会 `setMode('menu')`，
   *   整个面板连同里面的错误块一起卸载，"没有错误块"是**卸载**保证的，
   *   跟那个条件写成什么完全无关。一条因为正确的结果、错误的理由通过的断言。
   *   改成"面板刚打开、还没点任何东西"才具备鉴别力：恒真的话它当场就会显出来。
   */
  test('★ 还没有任何失败时不许出现错误块（否则上面三条写成恒真也会绿）', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`PUT /notes/${UID}/folder`]: { uid: UID, folderUid: null },
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-move"]'));
    await r.flush();

    const panel = r.container.querySelector('[data-testid="note-move-panel"]');
    assert.equal(panel === null, false, '面板没打开 —— 这条断言就什么都没验');
    assert.equal(spoke(panel).block, false, '什么都还没失败，界面上就摆着一个错误块');
  });
});

describe('ErrorBlock 的结构标记本身', () => {
  /*
   * `role="alert"` 与 `data-testid="error-block"` 是**契约**：
   * `e2e-browser-audit.mjs` 的 B11 直接按这个 testid 找错误块。
   * 谁把它改掉，这条会当场红，而不是让那条浏览器腿在 CI 上莫名其妙变绿/变红。
   */
  test('★ 错误块必须带 role="alert"（读屏要当场播报），且 testid 是浏览器腿约定的那个', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`PUT /notes/${UID}/folder`]: fail(404, 'FOLDER_NOT_FOUND', '文件夹不存在'),
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-move"]'));
    await r.flush();
    await click(r.container.querySelector('[data-testid="note-move-root"]'));
    await r.flush();

    const el = r.container.querySelector('[data-testid="error-block"]');
    assert.equal(el === null, false, '没有 data-testid="error-block" —— B11 那条浏览器腿会瞎掉');
    assert.equal(el?.getAttribute('role'), 'alert');
  });
});
