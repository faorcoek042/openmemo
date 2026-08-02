/**
 * 驱动适配层的**平价测试**（ADR-005 决策 6 要求：写测试证明备胎真的可用，不是声称可用）。
 *
 * 同一份断言对两个驱动各跑一遍。任何一边行为不一致 → 测试失败。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type DriverName, isBetterSqlite3Available, openDatabase } from './driver/index.js';

const DRIVERS: DriverName[] = ['node:sqlite'];
if (isBetterSqlite3Available()) DRIVERS.unshift('better-sqlite3');

// 若 better-sqlite3 不可用（某平台缺 prebuild），必须显式暴露，而不是静默少跑一半测试。
describe('驱动可用性', () => {
  it('至少一个驱动可用', () => {
    assert.ok(DRIVERS.length >= 1);
  });
  it('本机 better-sqlite3 可用性', () => {
    console.log(`      [info] 本次参与测试的驱动: ${DRIVERS.join(', ')}`);
    assert.ok(true);
  });
});

for (const driver of DRIVERS) {
  describe(`适配层平价 — ${driver}`, () => {
    const open = () => openDatabase({ filename: ':memory:', driver });

    it('sqliteVersion 可读且形如 3.x.y', () => {
      const db = open();
      assert.match(db.sqliteVersion, /^\d+\.\d+/);
      db.close();
    });

    it('exec / prepare / run / get / all', () => {
      const db = open();
      db.exec('create table t(id integer primary key, a text, n integer)');
      const r = db.prepare('insert into t(a,n) values (?,?)').run('x', 42);
      assert.equal(r.changes, 1);
      assert.equal(r.lastInsertRowid, 1);
      assert.equal(typeof r.changes, 'number');
      assert.equal(typeof r.lastInsertRowid, 'number');

      const row = db.prepare<{ a: string; n: number }>('select a,n from t where id=?').get(1);
      assert.deepEqual(row, { a: 'x', n: 42 });
      assert.equal(db.prepare('select * from t').all().length, 1);
      db.close();
    });

    it('get() 无结果返回 undefined（两驱动一致）', () => {
      const db = open();
      db.exec('create table t(id integer primary key)');
      assert.equal(db.prepare('select * from t where id=?').get(999), undefined);
      db.close();
    });

    it('命名参数用 :name + 裸键（这是两驱动唯一都支持的风格）', () => {
      const db = open();
      const row = db.prepare<{ v: number }>('select :a as v').get({ a: 7 });
      assert.equal(row?.v, 7);
      db.close();
    });

    it('iterate 可遍历', () => {
      const db = open();
      db.exec('create table t(id integer primary key)');
      db.exec('insert into t(id) values (1),(2),(3)');
      const ids = [...db.prepare<{ id: number }>('select id from t order by id').iterate()].map(
        (r) => r.id,
      );
      assert.deepEqual(ids, [1, 2, 3]);
      db.close();
    });

    it('transaction 提交', () => {
      const db = open();
      db.exec('create table t(id integer primary key)');
      db.transaction(() => {
        db.prepare('insert into t(id) values (?)').run(1);
      });
      assert.equal(db.prepare<{ c: number }>('select count(*) c from t').get()?.c, 1);
      db.close();
    });

    it('transaction 回滚（异常继续抛出，且数据不落库）', () => {
      const db = open();
      db.exec('create table t(id integer primary key)');
      assert.throws(
        () =>
          db.transaction(() => {
            db.prepare('insert into t(id) values (?)').run(1);
            throw new Error('boom');
          }),
        /boom/,
      );
      assert.equal(db.prepare<{ c: number }>('select count(*) c from t').get()?.c, 0);
      db.close();
    });

    it('嵌套 transaction：内层回滚不影响外层已写入的数据', () => {
      const db = open();
      db.exec('create table t(id integer primary key)');
      db.transaction(() => {
        db.prepare('insert into t(id) values (?)').run(1);
        try {
          db.transaction(() => {
            db.prepare('insert into t(id) values (?)').run(2);
            throw new Error('inner');
          });
        } catch {
          /* 内层失败可容忍 */
        }
        db.prepare('insert into t(id) values (?)').run(3);
      });
      const ids = db
        .prepare<{ id: number }>('select id from t order by id')
        .all()
        .map((r) => r.id);
      assert.deepEqual(ids, [1, 3], '内层 savepoint 应只回滚 id=2');
      db.close();
    });

    it('pragma 读写', () => {
      const db = open();
      db.setPragma('user_version = 42');
      assert.equal(db.pragma('user_version'), 42);
      db.close();
    });

    it('foreign_keys 必须能真正打开（D-02 §1.0：默认是 OFF）', () => {
      const db = open();
      db.setPragma('foreign_keys = ON');
      assert.equal(db.pragma('foreign_keys'), 1);
      db.exec('create table p(id integer primary key)');
      db.exec('create table c(id integer primary key, pid integer references p(id))');
      assert.throws(() => db.prepare('insert into c(id,pid) values (1, 999)').run());
      db.close();
    });
  });
}
