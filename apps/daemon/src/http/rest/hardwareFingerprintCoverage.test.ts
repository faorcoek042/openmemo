/**
 * 硬件指纹的**完整性**必须是可检验的，不能是注释里的一句承诺。
 *
 * ## 这个文件为什么存在（一句假的免检承诺，害了一次用户可见的死胡同）
 *
 * `machineFingerprint()` 上一版是"手挑三样"：模型根 + 选中的后端 + 装了哪些包的 **id**。
 * 它的注释写着：
 *
 * > 「新增一个改变机器状态的动作时，只要它影响的是这三样东西之一，
 * >   **不写任何代码它就已经被覆盖了**」
 *
 * **那句话把一个需要验证的断言写成了免检承诺，而它是假的。**
 * 漏掉的动作是「把同一个 id 重装成不同的字节」：
 *
 * `[用户真机实测 2026-08-09，:10000]` 08-02 装的是上游 `whisper-bin-ubuntu-x64.tar.gz`
 * （**不含 `openmemo-probe`**）；T-167 把同一个 id 换成我们自建的那份（**含探针**）。
 * 走产品自己的安装路重装之后 —— **磁盘上探针出现了，`/api/runtime/hardware`
 * 照旧说 `probe executable not found`**，六个后端全部不可用。
 * 因为装前装后 **id 集合一模一样**，指纹没变，快照就不重算。
 * （`?refresh=1` 一发就对 ⇒ 解析链没瞎，是失效条件漏了一格。）
 *
 * ## 判据（Manager 2026-08-09）：**别再写一句新的免检承诺**
 *
 * 所以实现改成「**全文减去一张显式排除表**」，而这个文件是那条性质的可执行版本：
 *
 *   **已安装记录里的每一个字段，改了它，指纹要么必须变（默认），
 *     要么必须在 `FINGERPRINT_IGNORED_FIELDS` 里被显式豁免。**
 *
 * 于是 `InstalledBackendPack` 新增字段时有且只有两条路：什么都不做（自动进指纹），
 * 或者把它写进排除表（一处看得见的 diff）。**没有第三条"忘了"的路。**
 *
 * ⚠️ 本文件**不构造 `RestState`**（那会 mkdir 模型根、读写 `active.json`）。
 * 它只对导出的纯函数 `canonicalPackFingerprint()` 做逐字段变异 ——
 * 不碰磁盘、不碰机器级状态（PROTOCOL §9-bis 的判据：把它 kill 在最坏的那一行，
 * 机器上什么都不会剩下）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FINGERPRINT_IGNORED_FIELDS, canonicalPackFingerprint } from './state.js';

/**
 * 一条**真实形状**的已安装记录。
 *
 * 字段取自 `[实测 2026-08-09]` `:10000` 的 `GET /api/backends/installed`
 * 里 `whispercpp-cpu-linux-x64` 那一条 —— 刻意用真机原文而不是我编的形状，
 * 因为这条守卫要防的正是"我以为它长这样"。
 */
const RECORD = {
  schemaVersion: 1,
  id: 'whispercpp-cpu-linux-x64',
  engine: 'whisper.cpp',
  engineVersion: 'v1.9.1',
  backend: 'cpu',
  installedAt: '2026-08-02T09:48:49.715Z',
  verifiedAt: '2026-08-02T09:48:49.715Z',
  integrity: 'ok',
  files: [
    {
      name: 'whisper-bin-ubuntu-x64.tar.gz',
      sha256: 'f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5',
      sizeBytes: 9379235,
      root: 'models',
      relPath: 'by-name/backend/whisper-bin-ubuntu-x64.tar.gz',
    },
  ],
  selfTest: null,
} as const;

/** 给任意字段造一个"确实不同"的新值，不依赖类型。 */
function mutate(value: unknown): unknown {
  if (typeof value === 'string') return `${value}-MUTATED`;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (value === null) return { mutated: true };
  if (Array.isArray(value)) return [...value, { mutated: true }];
  if (typeof value === 'object') return { ...(value as object), mutated: true };
  return 'MUTATED';
}

describe('硬件指纹的完整性由构造保证，并且逐字段可检验（T-191）', () => {
  it('★ 每个字段都必须表态：不在排除表里 ⇒ 改了它指纹必须变', () => {
    const base = canonicalPackFingerprint(RECORD);
    const missed: string[] = [];
    let checked = 0;

    for (const key of Object.keys(RECORD)) {
      const mutated = {
        ...(RECORD as Record<string, unknown>),
        [key]: mutate(RECORD[key as keyof typeof RECORD]),
      };
      const changed = canonicalPackFingerprint(mutated) !== base;
      const ignored = FINGERPRINT_IGNORED_FIELDS.includes(key);
      checked += 1;
      if (!ignored && !changed) missed.push(key);
      if (ignored && changed) missed.push(`${key}（在排除表里却影响了指纹）`);
    }

    // 一个字段都没检查到就报绿，正是本仓 ci-prep C5 那一族。
    assert.ok(checked >= 8, `只检查了 ${checked} 个字段 —— 夹具塌了，这条守卫在空跑`);
    assert.deepEqual(
      missed,
      [],
      `以下字段既不进指纹、也不在 FINGERPRINT_IGNORED_FIELDS 里：${missed.join(', ')}\n` +
        `  「机器上有什么」的一部分改了而指纹不变 ⇒ 硬件快照不会重算 ⇒\n` +
        `  界面会停在旧结论上（T-191：探针装上了，接口照旧说 probe executable not found）。\n` +
        `  两条路选一条：让它进指纹（默认，什么都不用做），\n` +
        `  或者把它写进 FINGERPRINT_IGNORED_FIELDS 并在那里写下代价。`,
    );
  });

  it('★ 那个真实事故：同一个 id、不同的 sha256，指纹必须变', () => {
    const old = canonicalPackFingerprint(RECORD);
    // T-167 之后目录里那一版：同一个 id，另一个归档、另一个 sha256（且**含探针**）
    const fresh = canonicalPackFingerprint({
      ...RECORD,
      files: [
        {
          name: 'whispercpp-cpu-linux-x64.tar.gz',
          sha256: '7075ef1ce24087798d2a7f4ddaaf7506559560d5b35ec8af49a5a6854dca6ba8',
          sizeBytes: 6752275,
          root: 'models',
          relPath: 'by-name/backend/whispercpp-cpu-linux-x64.tar.gz',
        },
      ],
    });
    assert.notEqual(
      fresh,
      old,
      '同一个 id 换了字节而指纹不变 —— 这就是用户机器上"探针装上了、界面说没有"的成因',
    );
  });

  it('★ 排除表里那几个必须真的不影响指纹（否则每次校验完整性都会白探测一遍）', () => {
    const base = canonicalPackFingerprint(RECORD);
    assert.ok(FINGERPRINT_IGNORED_FIELDS.length > 0, '排除表空了 —— 那这条断言在空跑');
    for (const key of FINGERPRINT_IGNORED_FIELDS) {
      if (!(key in RECORD)) continue;
      const mutated = {
        ...(RECORD as Record<string, unknown>),
        [key]: mutate(RECORD[key as keyof typeof RECORD]),
      };
      assert.equal(
        canonicalPackFingerprint(mutated),
        base,
        `${key} 影响了指纹 —— 它会在内容没变时触发真探测（spawn probe / nvidia-smi）`,
      );
    }
  });

  it('★ 字段顺序不算变化（JSON 里键的次序不该被读成"机器变了"）', () => {
    const reordered = {
      selfTest: RECORD.selfTest,
      files: RECORD.files,
      integrity: RECORD.integrity,
      backend: RECORD.backend,
      engineVersion: RECORD.engineVersion,
      engine: RECORD.engine,
      id: RECORD.id,
      schemaVersion: RECORD.schemaVersion,
      verifiedAt: RECORD.verifiedAt,
      installedAt: RECORD.installedAt,
    };
    assert.equal(canonicalPackFingerprint(reordered), canonicalPackFingerprint(RECORD));
  });

  it('★ 嵌套字段也算：`files[].sha256` 深一层，同样不许漏', () => {
    const base = canonicalPackFingerprint(RECORD);
    const deep = canonicalPackFingerprint({
      ...RECORD,
      files: [{ ...RECORD.files[0], sha256: 'deadbeef' }],
    });
    assert.notEqual(deep, base, '只做浅比较的话，换内容这件事恰好落在深一层');
  });
});
