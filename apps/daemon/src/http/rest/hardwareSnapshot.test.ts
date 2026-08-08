/**
 * 硬件快照的**失效**：装 / 卸 / 切之后，`state.hardware` 不许还停在启动那一刻。
 *
 * ## 这个文件在守什么（一次真实的、用户可见的死胡同）
 *
 * `[CI 实测 2026-08-08 run 31250730491，三平台全中]` 要求 2.1 的主路径断在这里：
 *
 *   在网页上装一个加速后端 → 装成功（`/api/backends/installed` 里有它）
 *   → 点"启用" → **409「backend package not installed」**
 *
 * 那句话是假的：包就是上一步刚装的。成因是 `RestState.hardware` 是
 * `RestState.create()` 那一刻的快照，装包不会刷新它，于是 `backends[].installed`
 * 恒为 false，`select` 的闸门据此拒绝。同一份陈旧快照还让目录在装完 CPU 基础包
 * 之后继续说「请先安装 CPU 基础包」—— 让用户去做一件他刚做完的事。
 *
 * ## 判据不是"记得在 install 后面补一次刷新"
 *
 * Manager 2026-08-08 的裁定：**一个会过期的快照，不该被当成事实来源；
 * 如果它必须是快照（探测很贵），那么"谁在什么时候让它失效"必须是显式的、且穷尽的。**
 *
 * "穷尽"是难点，而**逐个补刷新已经被证明走不通**：只在 install 后面补，
 * 卸载与切后端那两条路照样漂。所以实现把失效做成**从输入派生**的
 * （`machineFingerprint()` = 装了哪些包 + 选了哪个后端 + 模型根目录），
 * 而这个文件就是那条判据的可执行版本：
 *
 *   **做完任何一个改变"机器上有什么"的动作之后，
 *     `hardwareSnapshotIsCurrent()` 必须为 false。**
 *
 * 新增一个这类动作却忘了让快照失效时，只要在这里加一行就会当场红 ——
 * 而不是等到用户在网页上撞见一句假话。
 *
 * ## 隔离（PROTOCOL §9-bis）
 *
 * `RestState.create()` 会 mkdir 模型根、读写 `active.json` / `prefs.json`。
 * 不重定向就会去动这台机器上真实的数据目录（用户的 demo 就在那儿）。
 * 这里在**模块顶层**设环境变量，窗口为零；node:test 一个文件一个子进程，
 * 进程一退就没了，**不需要清理代码** —— 而"清理代码"正是 §9-bis 判定为靠不住的东西。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-hwsnap-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { SseHub } from '../sse.js';
import { currentPlatform } from './backends.js';
import { RestState } from './state.js';

const HERE = currentPlatform();
const BYTES = Buffer.from('#!/bin/sh\necho hwsnap\n');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const MIRROR = [
  { provider: 'github', url: 'https://github.com/x/y/releases/download/v1/f', official: true },
];
const LICENSE = { id: 'MIT', gated: false, url: 'https://github.com/x/y/blob/main/LICENSE' };

function pack(id: string, backend: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    engine: 'whisper.cpp',
    engineVersion: 'v1.9.1',
    ggmlAbi: '0.15.1',
    backend,
    tier: 'downloadable',
    os: HERE.os,
    arch: HERE.arch,
    displayName: id,
    displayNameZh: id,
    files: [
      {
        role: 'binary',
        name: `${id}-bin`,
        sizeBytes: BYTES.length,
        sha256: sha(BYTES),
        mirrors: MIRROR,
      },
    ],
    totalSizeBytes: BYTES.length,
    requiresDriver: null,
    license: LICENSE,
    providesFiles: [`${id}-bin`],
    priority: 10,
    availability: 'published',
    benchmark: null,
    catalogVersion: '2026.08.07',
  };
}

const CATALOG = {
  schemaVersion: 1,
  catalogVersion: '2026.08.07',
  generatedAt: '2026-08-07T00:00:00.000Z',
  packs: [pack('hwsnap-cpu', 'cpu'), pack('hwsnap-accel', 'vulkan')],
};

async function seed(): Promise<RestState> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  const manifestDir = mkdtempSync(join(TEST_ROOT, 'manifests-'));
  await writeFile(join(manifestDir, 'backends.json'), JSON.stringify(CATALOG), 'utf8');
  return await RestState.create({ sse: new SseHub(), dataDir, manifestDir });
}

/** 直接写一份安装记录 —— 等价于"装了一个包"，但不需要真的下载。 */
async function writeInstalledPack(state: RestState, id: string, backend: string): Promise<void> {
  const dir = join(state.modelsRoot, 'manifests', 'backend');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${encodeURIComponent(id)}.json`),
    JSON.stringify({
      schemaVersion: 1,
      id,
      engine: 'whisper.cpp',
      engineVersion: 'v1.9.1',
      backend,
      installedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      integrity: 'ok',
      priority: 10,
      files: [],
      selfTest: null,
    }),
    'utf8',
  );
}

describe('硬件快照必须跟着"机器上有什么"一起变（要求 2.1 的死胡同）', () => {
  it('★ 刚探测完时，快照是当真的', async () => {
    const state = await seed();
    await state.freshHardware();
    assert.equal(await state.hardwareSnapshotIsCurrent(), true);
  });

  it('★ 装一个包之后，快照必须失效 —— 这正是 409「backend package not installed」的成因', async () => {
    const state = await seed();
    await state.freshHardware();
    assert.equal(await state.hardwareSnapshotIsCurrent(), true);

    await writeInstalledPack(state, 'hwsnap-accel', 'vulkan');

    /*
     * **注意这里没有调用任何 `invalidate`。**
     * 判据就是"忘了调也会被抓住" —— 失效是从输入派生的，不是靠人记得。
     */
    assert.equal(
      await state.hardwareSnapshotIsCurrent(),
      false,
      '装了包而快照仍自称当真 ⇒ select/catalog 会读到 installed=false，用户会看到那句假话',
    );
  });

  it('★ 卸一个包之后，快照必须失效（"只在 install 后面补刷新"漏掉的那条路）', async () => {
    const state = await seed();
    await writeInstalledPack(state, 'hwsnap-accel', 'vulkan');
    await state.freshHardware();
    assert.equal(await state.hardwareSnapshotIsCurrent(), true);

    await state.store.removeManifest('backend', 'hwsnap-accel');
    assert.equal(await state.hardwareSnapshotIsCurrent(), false, '卸载同病，不能只修 install');
  });

  it('★ 切后端之后，快照必须失效 —— backendDir 是单值的，切了就该重探', async () => {
    const state = await seed();
    await state.freshHardware();
    assert.equal(await state.hardwareSnapshotIsCurrent(), true);

    // 与 `POST /api/backends/select` 写的是同一个字段
    state.prefs.selectedBackend = 'vulkan';
    assert.equal(
      await state.hardwareSnapshotIsCurrent(),
      false,
      '切了后端仍用旧快照 ⇒ 新选中的那个包永远不会被探到，probed 恒 false',
    );
  });

  it('★ 重探之后，用户显式选过的后端不许被默认值盖掉', async () => {
    const state = await seed();
    state.prefs.selectedBackend = 'vulkan';
    const hw = await state.freshHardware();
    assert.equal(
      hw.selectedBackend,
      'vulkan',
      '重探会按偏好顺序算一个默认 selectedBackend，那是"没人选过时"的值，不能覆盖用户的选择',
    );
  });

  it('★ 指纹没变时不重复探测（探测要 spawn，不能每个请求都跑）', async () => {
    const state = await seed();
    const first = await state.freshHardware();
    const second = await state.freshHardware();
    assert.equal(second, first, '同一份对象 ⇒ 命中缓存，没有重新探测');
  });

  it('★ invalidateHardware() 能强制失效（给指纹看不见的变化用，例如断路器复位）', async () => {
    const state = await seed();
    await state.freshHardware();
    assert.equal(await state.hardwareSnapshotIsCurrent(), true);
    state.invalidateHardware();
    assert.equal(await state.hardwareSnapshotIsCurrent(), false);
  });
});
