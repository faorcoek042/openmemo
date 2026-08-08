/**
 * **同一个断点续传边车的并发写，不许把 daemon 打死。**
 *
 * ## 这组用例来自一次用户可见的"点按钮完全没反应"
 *
 * `[CI 实测 2026-08-08 run 31261593715, win32-x64]` 用户点一次「下载模型」，
 * daemon **整个退出，exitCode=1**：
 *
 * ```
 * Error: ENOENT: no such file or directory, rename '…\sha256-3942….partial.json…'
 *   来源 packages/downloader/src/sidecar.ts  writeSidecar()
 * ```
 *
 * > **daemon 一死，页面上每个请求同时失败 —— 那就是"点按钮完全没反应"。**
 *
 * ## 真因（`[本机实测]`，不是从代码推断的）
 *
 * `writeSidecar` 原本用**写死的** `${target}.tmp`，而同一个 `partialPath`
 * **有并发写者**：`download.ts` 里 `setInterval(() => void persist(), 2000)`，
 * 而 `clearInterval` **不取消已经开始执行的那一次**。于是：
 *
 * ```
 * 定时器: writeFile(tmp) ─────────────────► rename(tmp→target)  ✘ ENOENT
 * 收尾:        writeFile(tmp) ► rename(tmp→target) ✓（tmp 已被搬走）
 * ```
 *
 * `[本机实测 2026-08-08]` 修复前：同一路径并发 600 次调用 → **400 次 ENOENT**。
 * **所以它根本不是 Windows 特有的** —— Windows 只是文件操作更慢、窗口更宽，
 * 于是先在那儿被撞见。这一点很重要：按"平台特有时序"去找，会找错方向。
 *
 * ## 为什么这条用例值得存在
 *
 * 它是**并发**用例，而并发 bug 的特点是"跑一次多半是绿的"——
 * 那正是本轮 Manager 点名的那句：**"间歇性"比"总是红"更糟，它训练人"先重跑一次再说"**。
 * 所以这里跑的是**批量**（200 轮 × 3 并发），把概率压成必然：
 * 恢复成固定 tmp 名的话，这条用例**不是偶尔红，是必然红**。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { newSidecar, readSidecar, writeSidecar } from './sidecar.js';

const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true }).catch(() => undefined);
});

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'om-sidecar-'));
  roots.push(d);
  return d;
}

describe('并发写同一个边车', () => {
  it('★ 200 轮 × 3 并发全部成功 —— 一个 ENOENT 都不许有（修复前实测 400/600 红）', async () => {
    const dir = await scratch();
    const partial = join(dir, 'sha256-deadbeef.partial');
    const s = newSidecar('a'.repeat(64), 4096, 'test');

    let failures = 0;
    for (let round = 0; round < 200; round++) {
      const results = await Promise.allSettled([
        writeSidecar(partial, s),
        writeSidecar(partial, s),
        writeSidecar(partial, s),
      ]);
      for (const r of results) if (r.status === 'rejected') failures += 1;
    }
    assert.equal(failures, 0);
  });

  it('并发之后边车仍然是可读的完整 JSON（rename 的原子性 —— 这个函数真正要防的东西）', async () => {
    const dir = await scratch();
    const partial = join(dir, 'sha256-cafe.partial');
    const s = newSidecar('b'.repeat(64), 4096, 'test');
    await Promise.all(Array.from({ length: 8 }, () => writeSidecar(partial, s)));
    const back = await readSidecar(partial);
    assert.equal(back === null, false);
    assert.equal(back?.digest, 'b'.repeat(64));
  });

  it('★ 不留临时文件 —— 否则 blobs 目录会被 .tmp 慢慢污染', async () => {
    const dir = await scratch();
    const partial = join(dir, 'sha256-feed.partial');
    const s = newSidecar('c'.repeat(64), 4096, 'test');
    await Promise.all(Array.from({ length: 8 }, () => writeSidecar(partial, s)));
    const left = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(left, []);
  });
});
