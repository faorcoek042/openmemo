/**
 * 软删除的**读取契约**：`*ByUid` 只看未删的，`*ById` 包含已删的。
 *
 * ## 起因（`[CI 实测 run 31247533926]`，三平台复现）
 *
 * 删掉一条笔记之后，`GET /api/notes/:uid` 仍然回 **200 + 完整正文** ——
 * 而列表（`listNotes` 的 `n.deleted_at IS NULL`）与搜索（`search.ts` 同名条件）
 * 都已经正确地当它不存在了。**同一份 API 对「这条笔记还存不存在」给出两个答案。**
 * 用户可见后果：删完之后旧链接 / 书签 / `?t=` 深链照样打得开。
 *
 * 而且不止 GET：`noteByUid` 有 10 个调用点，**全是 API 入口** ——
 * 改标题、改正文、锚点、重新转写、生成导图、导出、打星标、改标签、移动文件夹。
 * 一条"已删除"的笔记此前**还能被继续编辑和重新转写**。
 *
 * 审计同一个仓储层时查出**第二个同形漏**：`folderByUid` 也没过滤，
 * 于是笔记可以被移进一个已软删的文件夹 —— 请求成功，而那个文件夹在侧栏
 * （`listFolders`）和计数（`FOLDER_CLOSURE_CTE`）里都不存在。
 *
 * Manager 2026-08-08 裁决 **404，不是 410**（软删可逆，410 隐含永久移除）。
 *
 * ## 判据：**两侧都钉死**
 *
 * 只钉「uid 读不到」这一侧是不够的。哪天有人"顺手统一"成两边都过滤，
 * `main.ts` 里那些「笔记已被删、job 还在任务中心」的条目就会集体失去标题，
 * 而**没有任何测试会红**。所以这里把 `*ById` 仍然读得到也一并钉死 ——
 * 这个不对称是**刻意的**，不是漏改的。
 *
 * 每一组都先断言「删之前读得到」，再断言「删之后读不到」：
 * 少了前半句，后半句对一个拼错的 uid 也成立（本仓栽过的"夹具里恒为假"）。
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
  const dir = mkdtempSync(join(tmpdir(), 'om-softdel-'));
  made.push(dir);
  const handle = openAppDatabase({ filename: join(dir, 'openmemo.db') });
  closers.push(() => handle.close());
  const repos = new Repos(handle.db);
  repos.ensureDefaultFolder();
  return repos;
}

describe('软删除的读取契约：uid 看不见，id 仍看得见', () => {
  it('★ 笔记：删之前 noteByUid 读得到，删之后读不到（→ 调用方 404）', () => {
    const repos = freshRepos();
    const note = repos.createNote({ title: '要被删掉的笔记' });

    // 前提（非空虚）：不先证明"删之前读得到"，后半句对拼错的 uid 也成立。
    assert.equal(repos.noteByUid(note.uid)?.uid, note.uid);

    repos.softDeleteNote(note.id);

    assert.equal(repos.noteByUid(note.uid) === undefined, true);
  });

  it('★ 笔记：删之后 noteByIdIncludingDeleted 仍然读得到 —— 这个不对称是刻意的', () => {
    const repos = freshRepos();
    const note = repos.createNote({ title: 'job 中心还要拿它的标题' });
    repos.softDeleteNote(note.id);

    /*
     * `main.ts` 把 job 列表里的 `note_id` 翻成标题。笔记被删了，那条 job
     * 仍然存在于任务中心 —— 标题不该因此变成空白。
     * 这条要是红了，说明有人把这个显式变体也一起过滤了：请先想清楚 job 中心怎么办。
     *
     * ⚠️ 这条断言此前钉的是 `noteById`。把"连已删一起读"的意图挪进函数名之后，
     * 它跟着挪到了 `noteByIdIncludingDeleted` 上 —— **被保护的性质没有变**，
     * 变的只是它挂在哪个名字上。
     */
    assert.equal(repos.noteByIdIncludingDeleted(note.id)?.title, 'job 中心还要拿它的标题');
    assert.equal(typeof repos.noteByIdIncludingDeleted(note.id)?.deleted_at, 'number');
  });

  it('★ 笔记：删之后**过滤版** noteById 读不到 —— 默认必须是安全的那一侧', () => {
    const repos = freshRepos();
    const note = repos.createNote({ title: '默认就该看不见' });

    assert.equal(repos.noteById(note.id)?.uid, note.uid); // 前提：删之前读得到
    repos.softDeleteNote(note.id);

    /*
     * 这条与上一条**必须同时存在**：只有上一条时，把 `noteById` 也做成宽容的
     * 仍然全绿；只有这一条时，把两个都做成过滤的也全绿。
     * 两条一起才钉住"**一个宽容、一个安全，而且各自是哪一个**"。
     */
    assert.equal(repos.noteById(note.id) === undefined, true);
  });

  it('笔记：列表与计数同样当它不存在（"不存在"在本产品里的既定表达）', () => {
    const repos = freshRepos();
    const keep = repos.createNote({ title: '留着的' });
    const drop = repos.createNote({ title: '删掉的' });

    assert.equal(repos.countNotes(), 2);

    repos.softDeleteNote(drop.id);

    assert.equal(repos.countNotes(), 1);
    const uids = repos.listNotes(50, {}).map((n) => n.uid);
    assert.equal(uids.includes(keep.uid), true);
    assert.equal(uids.includes(drop.uid), false);
  });

  it('★ 文件夹：删之前 folderByUid 读得到，删之后读不到（本轮查出的第二个同形漏）', () => {
    const repos = freshRepos();
    const folder = repos.createFolder({ name: '要被删掉的文件夹' });

    assert.equal(repos.folderByUid(folder.uid)?.uid, folder.uid);

    repos.softDeleteFolderTree(folder.id);

    assert.equal(repos.folderByUid(folder.uid) === undefined, true);
    // 侧栏用的就是 listFolders —— 两边必须口径一致
    assert.equal(
      repos.listFolders().some((f) => f.uid === folder.uid),
      false,
    );
  });

  it('文件夹：删之后 folderByIdIncludingDeleted 仍然读得到 —— 环检测要看见它', () => {
    const repos = freshRepos();
    const folder = repos.createFolder({ name: '已删但仍要能被扫到' });
    repos.softDeleteFolderTree(folder.id);

    // 过滤版看不见（默认安全的那一侧）……
    assert.equal(repos.folderById(folder.id) === undefined, true);
    // ……显式变体看得见（环检测问的是"库里有没有环"，不是"用户看得见的树上有没有环"）
    assert.equal(repos.folderByIdIncludingDeleted(folder.id)?.name, '已删但仍要能被扫到');
    /*
     * `softDeleteFolderTree` 自己就是删除路径：它必须能重扫一棵已删的子树
     * （幂等），否则重复删除会静默少标记节点。
     */
    assert.equal(repos.folderSubtreeIds(folder.id).includes(folder.id), true);
  });

  it('删掉父文件夹会连子树一起删 —— 子文件夹的 uid 同样读不到了', () => {
    const repos = freshRepos();
    const parent = repos.createFolder({ name: '父' });
    const child = repos.createFolder({ name: '子', parentId: parent.id });

    assert.equal(repos.folderByUid(child.uid)?.uid, child.uid);

    repos.softDeleteFolderTree(parent.id);

    assert.equal(repos.folderByUid(child.uid) === undefined, true);
  });
});
