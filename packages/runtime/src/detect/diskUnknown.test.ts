/**
 * A-5 的**触发路径复现** —— 把 UNKNOWN 变成已知。
 *
 * 裁决书里这条的"用户可见后果"标的是 UNKNOWN：`modelsRoot` 的 `statfs` 失败而
 * `runtimesRoot` 成功，这个组合**没有实测记录**，只是代码里那条回退分支是活的。
 *
 * 这一档证明它**不需要任何特殊硬件**就能构造出来：一个还没建出来的目录就够了 ——
 * 而那正是 `detectDisks()` 自己注释里写的合法情况（"Directory may not exist yet on
 * first run"）。也就是说这条路径**首次运行就会走到**，不是理论风险。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { detectDisks } from './system.js';

describe('A-5 触发路径：modelsRoot 还没建出来时，它会被整条省略', () => {
  it('★ modelsRoot 不存在 / runtimesRoot 存在 → disks 里只剩 runtimes_root', async () => {
    const real = await mkdtemp(path.join(tmpdir(), 'a5-runtimes-'));
    const missing = path.join(real, 'not-created-yet', 'models');

    const disks = await detectDisks({ modelsRoot: missing, runtimesRoot: real });

    const roles = disks.map((d) => d.pathFor).sort();
    assert.deepEqual(
      roles,
      ['runtimes_root'],
      `models_root 应当被省略（statfs 失败），实际拿到：${JSON.stringify(disks)}`,
    );
    /*
     * ★ 这一行是这条复现的要害：**剩下的那一项带着一个真实、合理、但属于另一个卷的数字。**
     * 旧的 `modelsRootFreeMB()`（`?? hw.disks[0]`）会把它当成模型卷的余量交给 fit 判定。
     */
    assert.equal(
      typeof disks[0]?.freeMB,
      'number',
      '剩下那一项本身是有真读数的 —— 所以借用它不会报错，只会悄悄说错',
    );
    assert.equal(disks[0]?.freeMB !== undefined && disks[0].freeMB >= 0, true);
  });

  it('★ 阴性对照：两个都存在时两项都在（省略确实是 statfs 失败造成的，不是别的原因）', async () => {
    const real = await mkdtemp(path.join(tmpdir(), 'a5-both-'));
    const disks = await detectDisks({ modelsRoot: real, runtimesRoot: real });
    assert.deepEqual(disks.map((d) => d.pathFor).sort(), ['models_root', 'runtimes_root']);
  });
});
