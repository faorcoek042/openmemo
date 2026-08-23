/**
 * `listComponents()` 的**兜底方向**：清单漏填 `sha256Verification` 时退到哪一档。
 *
 * ## 这条腿为什么值得单独存在
 *
 * `Sha256Verification` 的 `upstream-provided` 那一格在**清单里今天一条都没有**
 * （27 个组件全是 `local-recomputed`）。审计者因此在浏览器里根本验不到那条警告分支，
 * 并且合理地问了一句：**它是不是一条永远不渲染的死分支，在冒充"我们处理了这种情况"？**
 *
 * 答案是不是 —— **它有一个活的生产者**，就是下面这行兜底。但"有生产者"不能靠
 * 一句注释断言，所以这里把它变成一条会红的腿。
 *
 * ## ★★ 方向是判据的全部
 *
 * 诱惑是写 `?? 'local-recomputed'`（毕竟清单里今天全是它）。**那是反的**：
 * `local-recomputed` 是一句关于我们做过什么的保证（"每个字节都下下来重算过"），
 * 一条**忘了填**这一格的新组件不该**自动获得**它。退到弱档最坏只是多一个警告色 ——
 * **错的方向必须是「少信我们一点」。**
 *
 * 所以这条腿断的不是"有没有兜底"，是**兜到哪一边**。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listComponents } from './components.js';

/** 最小可解析的清单：两条，一条填了这一格、一条**故意漏填**。 */
const REGISTRY = {
  schemaVersion: 1,
  catalogVersion: '2026.08.24',
  components: [
    {
      id: 'declared',
      displayName: 'Declared',
      displayNameZh: 'Declared',
      category: 'tool',
      pinnedVersion: '1.0.0',
      provenance: { license: 'MIT' },
      upstream: null,
      sizeBytes: 1,
      sha256Verification: 'local-recomputed',
      sha256: 'a'.repeat(64),
    },
    {
      id: 'omitted',
      displayName: 'Omitted',
      displayNameZh: 'Omitted',
      category: 'tool',
      pinnedVersion: '1.0.0',
      provenance: { license: 'MIT' },
      upstream: null,
      sizeBytes: 1,
      // ← sha256Verification 故意缺席，这正是被测的那件事
      sha256: 'b'.repeat(64),
    },
  ],
};

/**
 * `listComponents` 只经 `readInstalledVersions()` 用到 `store.listManifests()`；
 * 这里给一个说"什么都没装"的最小替身。
 */
const EMPTY_STORE = {
  listManifests: async () => [],
} as unknown as Parameters<typeof listComponents>[0]['store'];

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'openmemo-components-'));
  const registryPath = join(dir, 'components.json');
  await writeFile(registryPath, JSON.stringify(REGISTRY), 'utf8');
  const res = await listComponents({ registryPath, store: EMPTY_STORE, checkUpstream: false });
  return new Map(res.components.map((c) => [c.id, c]));
}

describe('listComponents：sha256Verification 的兜底方向', () => {
  it('★★ 清单漏填这一格时，退到 upstream-provided（弱档），不是 local-recomputed', async () => {
    const byId = await run();
    const omitted = byId.get('omitted');
    assert.ok(omitted, '夹具没被读进来 —— 这条腿在空转');
    assert.equal(
      omitted.sha256Verification,
      'upstream-provided',
      '漏填这一格的组件拿到了"本机复算"——那是一句我们没做过的保证，' +
        '而且不会有任何东西报错。错的方向必须是"少信我们一点"。',
    );
  });

  it('★ 填了的照原样透传（否则上面那条可能只是"永远返回弱档"）', async () => {
    const byId = await run();
    assert.equal(byId.get('declared')?.sha256Verification, 'local-recomputed');
  });

  it('★ caveats 缺省是空数组，不是某个默认提醒', async () => {
    const byId = await run();
    // 界面只因为它**非空**而多说一句；空的时候永远不会宣称"已验证"。
    assert.deepEqual(byId.get('declared')?.caveats, []);
    assert.deepEqual(byId.get('omitted')?.caveats, []);
  });
});
