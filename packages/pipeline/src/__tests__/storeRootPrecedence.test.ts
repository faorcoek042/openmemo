/**
 * `resolveStoreRoot()` 的优先级 —— **钉住现状，不改语义**（Manager 裁定）。
 *
 * ## 为什么专门给一个"没坏"的东西写测试
 *
 * T-142 那轮机器级状态审计里唯一没定性的一条：
 * **`OPENMEMO_MODELS` 排在显式 `dataDir` 之前。**
 *
 * 后果链是这样的：daemon 的每个测试都传显式的临时 `dataDir`，本以为
 * `paths.modelsDir` 因此必然落在临时目录里 —— 但只要有人把 `OPENMEMO_MODELS`
 * 导出到真实模型库，**每个 daemon 测试的 `modelsDir` 就都是那个真实库**，
 * 而 `main.ts:466` 会拿它去跑 `materializeSqliteExtensions(paths.modelsDir, …)`。
 *
 * 我读过那条路径，它对 storeRoot **只读**（只往临时 extDir 写符号链接），
 * 所以**今天没有后果**。但"今天恰好只读"和"保证只读"是两回事，
 * 而这正是"一个环境变量静默重定向整个根"的同一形状 ——
 * 和数据目录指针那次一模一样，只是那次是文件、这次是目录树。
 *
 * ## 所以这里做的是**先把现状钉住**
 *
 * 改不改优先级是另一个决定（改了会影响产品行为，得单独裁）。
 * 在那之前，至少让"优先级是什么"这件事有一个执行者：
 * 谁动了这个顺序 —— 无论是有意还是顺手 —— 都会在这里当场红，
 * 而不是等到某台机器上的模型包被写坏了才发现。
 *
 * ## 纪律
 *
 * 本文件只读环境变量、只比字符串，**不碰磁盘、不建目录、不写任何机器级状态**
 * （PROTOCOL §9-bis）。env 的改动全部在 `try/finally` 里还原 ——
 * 但即使 finally 没跑到也无所谓：node:test 一个测试文件一个子进程，
 * env 随进程消失，**这正是"根本不写机器级状态"和"写完记得擦"的区别**。
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveStoreRoot } from '../tools.js';

/** 临时改一组环境变量，跑完还原（只影响本进程）。 */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(patch)) saved.set(k, process.env[k]);
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAR = {
  OPENMEMO_MODELS: undefined,
  OPENMEMO_DATA_DIR: undefined,
} as const;

describe('resolveStoreRoot 的优先级（钉现状，不改语义）', () => {
  it('★ `OPENMEMO_MODELS` **压过**显式传入的 dataDir —— 这就是那条要盯住的性质', () => {
    /*
     * 这条断言看起来像是在给一个可疑设计背书 —— 它不是。
     * 它的作用是：这条性质**今天确实成立**，谁改了它就必须**在这里明确地改一次**，
     * 从而变成一个有人看见的决定，而不是一次没人注意的顺手。
     */
    const out = withEnv({ ...CLEAR, OPENMEMO_MODELS: '/tmp/om-explicit-models' }, () =>
      resolveStoreRoot('/tmp/om-datadir'),
    );
    assert.equal(
      out,
      '/tmp/om-explicit-models',
      '优先级变了 —— 这不一定是错的，但它是个需要裁决的改动，不该顺手发生',
    );
  });

  it('没有 `OPENMEMO_MODELS` 时，显式 dataDir 说了算（daemon 测试全靠这一条隔离）', () => {
    const out = withEnv(CLEAR, () => resolveStoreRoot('/tmp/om-datadir'));
    assert.equal(out, join('/tmp/om-datadir', 'models'));
  });

  it('显式 dataDir 压过 `OPENMEMO_DATA_DIR`', () => {
    const out = withEnv({ ...CLEAR, OPENMEMO_DATA_DIR: '/tmp/om-env-datadir' }, () =>
      resolveStoreRoot('/tmp/om-explicit'),
    );
    assert.equal(out, join('/tmp/om-explicit', 'models'));
  });

  it('两者都没有时才回落到 `OPENMEMO_DATA_DIR`', () => {
    const out = withEnv({ ...CLEAR, OPENMEMO_DATA_DIR: '/tmp/om-env-datadir' }, () =>
      resolveStoreRoot(),
    );
    assert.equal(out, join('/tmp/om-env-datadir', 'models'));
  });

  it('空串不算"设过"（否则 `OPENMEMO_MODELS=` 会把 store 指到裸的相对路径）', () => {
    const out = withEnv({ ...CLEAR, OPENMEMO_MODELS: '' }, () =>
      resolveStoreRoot('/tmp/om-datadir'),
    );
    assert.equal(out, join('/tmp/om-datadir', 'models'));
  });

  it('前提自检：`withEnv` 真的还原了（不还原的话后面的用例会互相污染）', () => {
    const before = process.env['OPENMEMO_MODELS'];
    withEnv({ OPENMEMO_MODELS: '/tmp/om-probe' }, () => {
      assert.equal(process.env['OPENMEMO_MODELS'], '/tmp/om-probe', '设 env 这个动作本身没生效');
    });
    assert.equal(process.env['OPENMEMO_MODELS'], before, 'withEnv 没有还原 —— 用例间会互相污染');
  });
});
