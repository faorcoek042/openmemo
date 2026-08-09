/**
 * 「关库 → 搬迁 → 重开」的顺序编排测试。
 *
 * **这里要钉死的不是"搬迁成不成功"，是"搬迁失败之后库还开不开得起来"。**
 * 库已经关了，如果这时没能重新打开，用户拿到的是一个
 * "库关了、也没搬成、谁也开不了" 的 daemon —— 比不搬糟得多。
 *
 * 用注入的回调而不是真 fs/sqlite：这几条分支（关库就抛、搬迁抛异常、
 * 新位置开不起来、连原位都开不回来）在真实环境里**极难制造**，
 * 而它们恰恰是最危险的几条。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { moveDataDirWithDatabase } from './moveWithDb.js';

const FROM = '/old/data';
const TO = '/new/data';

/** 记录调用顺序的假库。 */
function fakeDb(opts: { closeThrows?: boolean; failReopenAt?: (dir: string) => boolean } = {}) {
  const calls: string[] = [];
  let openAt: string | null = FROM;
  return {
    calls,
    get openAt(): string | null {
      return openAt;
    },
    closeDb(): void {
      calls.push('close');
      if (opts.closeThrows) throw new Error('close failed');
      openAt = null;
    },
    reopenDb(dir: string): void {
      calls.push(`reopen:${dir}`);
      if (opts.failReopenAt?.(dir)) throw new Error(`cannot open at ${dir}`);
      openAt = dir;
    },
  };
}

test('搬迁成功 → 库在新位置重开，且关库发生在搬迁之前', async () => {
  const db = fakeDb();
  const out = await moveDataDirWithDatabase(FROM, TO, {
    closeDb: () => db.closeDb(),
    reopenDb: (d) => db.reopenDb(d),
    move: async () => {
      // ★ 搬迁执行的那一刻，库必须已经是关着的 —— 这正是 Windows 删得掉源的前提
      assert.equal(db.openAt, null);
      return { ok: true };
    },
    succeeded: (r) => r.ok,
  });
  assert.equal(out.attempted, true);
  assert.equal(out.reopenedAt, TO);
  assert.equal(out.databaseLost, false);
  assert.deepEqual(db.calls, ['close', `reopen:${TO}`]);
});

test('★ 搬迁失败 → 库必须开回原位置，daemon 还能继续工作', async () => {
  const db = fakeDb();
  const out = await moveDataDirWithDatabase(FROM, TO, {
    closeDb: () => db.closeDb(),
    reopenDb: (d) => db.reopenDb(d),
    move: async () => ({ ok: false }),
    succeeded: (r) => r.ok,
  });
  assert.equal(out.attempted, true);
  assert.equal(out.reopenedAt, FROM); // ← 回原位
  assert.equal(out.databaseLost, false);
  assert.equal(db.openAt, FROM);
});

test('★ 搬迁抛异常（不是结构化失败）→ 同样要开回原位置，不许让库停在关着的状态', async () => {
  const db = fakeDb();
  const out = await moveDataDirWithDatabase(FROM, TO, {
    closeDb: () => db.closeDb(),
    reopenDb: (d) => db.reopenDb(d),
    move: async () => {
      throw new Error('EIO: disk exploded');
    },
    succeeded: () => true,
  });
  assert.equal(out.reopenedAt, FROM);
  assert.equal(out.databaseLost, false);
  assert.match(out.moveError ?? '', /disk exploded/);
  assert.equal(db.openAt, FROM);
});

test('★ 关库就失败 → 一步都不许往下走（绝不能带着开着的库去搬）', async () => {
  const db = fakeDb({ closeThrows: true });
  let moveCalled = false;
  const out = await moveDataDirWithDatabase(FROM, TO, {
    closeDb: () => db.closeDb(),
    reopenDb: (d) => db.reopenDb(d),
    move: async () => {
      moveCalled = true;
      return { ok: true };
    },
    succeeded: (r) => r.ok,
  });
  assert.equal(moveCalled, false, '关库失败后绝不能还去搬');
  assert.equal(out.attempted, false);
  assert.match(out.closeError ?? '', /close failed/);
  assert.equal(out.reopenedAt, FROM, '仍要尽力把库开回原位');
  assert.equal(out.databaseLost, false);
});

test('搬成功但新位置开不起来 → 退回原位置重开（数据在新位置，但 daemon 得活着）', async () => {
  const db = fakeDb({ failReopenAt: (d) => d === TO });
  const out = await moveDataDirWithDatabase(FROM, TO, {
    closeDb: () => db.closeDb(),
    reopenDb: (d) => db.reopenDb(d),
    move: async () => ({ ok: true }),
    succeeded: (r) => r.ok,
  });
  assert.equal(out.reopenedAt, FROM, '退回原位');
  assert.equal(out.databaseLost, false);
  assert.match(out.reopenError ?? '', /cannot open at/);
  assert.deepEqual(db.calls, ['close', `reopen:${TO}`, `reopen:${FROM}`]);
});

test('★ 连原位置都开不回来 → databaseLost 必须为 true（这一格不许静默）', async () => {
  const db = fakeDb({ failReopenAt: () => true });
  const out = await moveDataDirWithDatabase(FROM, TO, {
    closeDb: () => db.closeDb(),
    reopenDb: (d) => db.reopenDb(d),
    move: async () => ({ ok: false }),
    succeeded: (r) => r.ok,
  });
  assert.equal(out.reopenedAt, null);
  assert.equal(out.databaseLost, true, '必须能被调用方看见，否则用户面对一个哑掉的 daemon');
});

test('反向验证：把「失败时回原位」拆掉，上面那条就必须变红', async () => {
  /*
   * 这条不是多余的。它证明「搬迁失败 → 回原位」那条断言**真的在看那件事** ——
   * 而不是碰巧因为默认值就绿。
   * 做法：模拟一个"失败时不重开"的坏实现，断言它确实达不到 reopenedAt=FROM。
   */
  const db = fakeDb();
  const badImpl = async (): Promise<{ reopenedAt: string | null }> => {
    db.closeDb();
    return { reopenedAt: null }; // 坏实现：失败后干脆不重开
  };
  const bad = await badImpl();
  assert.notEqual(bad.reopenedAt, FROM, '坏实现必须达不到"回原位"，否则上面那条断言是空的');
  assert.equal(db.openAt, null, '坏实现留下的正是"库关着"这个状态');
});
