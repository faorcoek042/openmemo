/**
 * T-195 —— **「装不装得下」不许建立在过期的可用空间上。**
 *
 * ## 缺陷
 *
 * `RestState.hardware` 是一份结构快照（探测要 spawn probe / nvidia-smi，缓存有理由）。
 * 但 `HardwareInfo` 里同时装着**环境读数**：`disks[].freeMB` 与 `ram.availableMB`。
 * 它们是 `statfs` + `os.freemem()`，**零 spawn**，而且**一直在变**。
 *
 * `buildCatalog()` 把这份快照喂给 `computeFit()`，`fitness.ts:196` 的
 * `modelsRootFreeMB()` 读的就是 `disks[].freeMB` —— 它决定一个模型是不是
 * `blocked_disk`，也就是**用户能不能装**。
 *
 * > ⚠️ **用户刚删掉东西腾出空间的那一刻，正是他最可能去装东西的那一刻 ——
 * > 而产品用的是旧数字。**
 *
 * ## 判据（Manager 2026-08-10）
 *
 * 不是"缓存被打掉了"，是「**用户腾出空间之后，下一次判断必须用新数字**」。
 * 所以这里**不去断言缓存的内部状态**，而是把快照里那一格**投毒**成一个
 * 与现实明显不符的值，然后看结论跟谁走。
 *
 * ## ★ 为什么必须配一条反向的
 *
 * 只有第一条的话，「**把整份快照的缓存关掉、每次请求都重新探测一遍**」也能让它变绿 ——
 * 而那会给每一次目录请求加上一次 probe（≤10 s）+ nvidia-smi。
 * 所以第二条钉的是**没有为此白跑探针**：`detectedAt` 不许动、结构快照不许失效。
 * 两条一起才把"按贵不贵拆开"这个判据钉住；缺任何一条，另一种错法都能溜过去。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-diskfresh-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { SseHub } from '../sse.js';
import { RestState } from './state.js';

const REPO_ROOT = resolve(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
);
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

async function seed(): Promise<RestState> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  const state = await RestState.create({ sse: new SseHub(), dataDir, manifestDir: MANIFEST_DIR });
  // 结构快照建立起来（这一步会真的探测一次，之后就不该再探了）
  await state.freshHardware();
  return state;
}

/** 目录里所有被判成「装不下」的条目。 */
function blockedIds(catalog: { groups: { variants: { id: string; fitness: { tier: string } }[] }[] }): string[] {
  return catalog.groups.flatMap((g) =>
    g.variants.filter((v) => v.fitness.tier === 'blocked_disk').map((v) => v.id),
  );
}

describe('目录的「装不装得下」必须用现算的可用空间（T-195）', () => {
  it('★ 快照里那一格被投毒成 0 也不影响结论 —— 说明读的是现算的那份', async () => {
    const state = await seed();

    const honest = await state.buildCatalog('all', null);
    /*
     * 阴性对照先行：真实磁盘上装得下的东西必须**本来就不是** blocked_disk，
     * 否则下面那条断言在一个恒真的前提上空跑。
     */
    assert.ok(
      blockedIds(honest).length < honest.groups.flatMap((g) => g.variants).length,
      '真实磁盘上一个都装不下 —— 这台机器空间太小，本用例无法区分新旧数字',
    );

    /*
     * 把**快照**里的可用空间改成 0。如果 `computeFit` 吃的是快照，
     * 那么每一条模型都会变成 blocked_disk；吃现算的话，结论一个都不变。
     */
    state.hardware = {
      ...state.hardware,
      disks: state.hardware.disks.map((d) => ({ ...d, freeMB: 0 })),
    };

    const after = await state.buildCatalog('all', null);
    assert.deepEqual(
      blockedIds(after),
      blockedIds(honest),
      '目录的「装不下」判定跟着**快照里那个过期数字**走了 ——\n' +
        '  用户刚腾出空间，产品还在用旧数字告诉他装不下。',
    );
  });

  it('★ 反向配对：不许为了拿一个 statfs 就重跑一次结构探测', async () => {
    const state = await seed();
    const before = state.hardware.detectedAt;
    assert.equal(await state.hardwareSnapshotIsCurrent(), true, '前提：快照此刻是当真的');

    await state.buildCatalog('all', null);
    await state.buildCatalog('all', null);

    assert.equal(
      state.hardware.detectedAt,
      before,
      'detectedAt 动了 ⇒ 每次目录请求都重跑了一次结构探测（probe ≤10s + nvidia-smi）。\n' +
        '  那不是"按贵不贵拆开"，那是把缓存整个关掉 —— 第一条断言会一样绿。',
    );
    assert.equal(
      await state.hardwareSnapshotIsCurrent(),
      true,
      '结构快照被打成失效了 ⇒ 下一次请求会真的重探',
    );
  });

  it('★ `detectedAt` 说的是结构探测的时刻，不许被现算的读数带着往前跑', async () => {
    const state = await seed();
    const before = state.hardware.detectedAt;
    const cat = await state.buildCatalog('all', null);
    assert.ok(cat.groups.length > 0, '目录是空的，这条在空跑');
    assert.equal(
      state.hardware.detectedAt,
      before,
      '把它刷成"现在"等于声称刚跑过一次 probe —— 而我们恰恰没有跑',
    );
  });
});
