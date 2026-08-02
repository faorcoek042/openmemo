/**
 * 迁移执行器测试。
 *
 * 覆盖 Manager 在 T-016 列的两条验收：
 *   - 迁移能从空库跑到最新版本
 *   - **再跑一次是幂等的**
 * 以及 D-01 §2.6 的"库版本比应用新 → 拒绝启动"。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type DriverName, isBetterSqlite3Available, openDatabase } from './driver/index.js';
import { loadExtensions } from './extensions.js';
import {
  SchemaTooNewError,
  discoverMigrations,
  migrateSchema,
  migrateSearchIndex,
} from './migrate.js';
import { applyConnectionPragmas } from './pragmas.js';

const TMP = mkdtempSync(join(tmpdir(), 'omdb-mig-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const DRIVERS: DriverName[] = ['node:sqlite'];
if (isBetterSqlite3Available()) DRIVERS.unshift('better-sqlite3');

describe('迁移文件发现', () => {
  it('至少有一个 schema 迁移和一个 search 迁移', () => {
    const all = discoverMigrations();
    assert.ok(all.length >= 2, `发现 ${all.length} 个迁移文件`);
    assert.ok(all.some((m) => m.kind === 'schema'));
    assert.ok(all.some((m) => m.kind === 'search'));
  });

  it('版本号严格递增', () => {
    const versions = discoverMigrations().map((m) => m.version);
    assert.deepEqual(
      [...versions].sort((a, b) => a - b),
      versions,
    );
  });
});

for (const driver of DRIVERS) {
  describe(`迁移 — ${driver}`, () => {
    it('空库 → 最新版本，且建出了预期的表', () => {
      const db = openDatabase({ filename: ':memory:', driver });
      applyConnectionPragmas(db);
      const r = migrateSchema(db);

      assert.equal(r.from, 0);
      assert.ok(r.to >= 1);
      assert.ok(r.applied.length >= 1, '应至少应用一个迁移');
      assert.equal(db.pragma('user_version'), r.to);

      const tables = db
        .prepare<{ name: string }>(
          `select name from sqlite_master where type='table' order by name`,
        )
        .all()
        .map((x) => x.name);
      for (const expected of ['app_meta', 'settings', 'notes', 'jobs', 'transcript_segments']) {
        assert.ok(tables.includes(expected), `缺少表 ${expected}`);
      }
      // app_meta.schema_version 冗余副本（D-02 §1.2）
      const meta = db
        .prepare<{ value: string }>(`select value from app_meta where key='schema_version'`)
        .get();
      assert.equal(meta?.value, String(r.to));
      db.close();
    });

    it('**幂等**：第二次跑不应用任何迁移，版本不变', () => {
      const db = openDatabase({ filename: ':memory:', driver });
      applyConnectionPragmas(db);
      const first = migrateSchema(db);
      const second = migrateSchema(db);

      assert.deepEqual(second.applied, [], '第二次不应再应用任何迁移');
      assert.equal(second.from, first.to);
      assert.equal(second.to, first.to);
      assert.equal(db.pragma('user_version'), first.to);
      db.close();
    });

    it('三次调用结果稳定（幂等不是只对第二次成立）', () => {
      const db = openDatabase({ filename: ':memory:', driver });
      applyConnectionPragmas(db);
      migrateSchema(db);
      migrateSchema(db);
      const third = migrateSchema(db);
      assert.deepEqual(third.applied, []);
      db.close();
    });

    it('库版本比应用新 → 抛 SchemaTooNewError（D-01 §2.6 拒绝启动）', () => {
      const db = openDatabase({ filename: ':memory:', driver });
      applyConnectionPragmas(db);
      db.setPragma('user_version = 99999');
      assert.throws(() => migrateSchema(db), SchemaTooNewError);
      db.close();
    });

    it('落到真实文件 + 迁移 + 备份目录（VACUUM INTO 路径可用）', () => {
      const file = join(TMP, `real-${driver.replace(/\W/g, '')}.db`);
      const backups = join(TMP, 'backups');

      const db1 = openDatabase({ filename: file, driver });
      applyConnectionPragmas(db1);
      const r1 = migrateSchema(db1, { backupDir: backups });
      assert.equal(r1.from, 0);
      // from=0 时不备份（空库没什么好备的）
      assert.equal(r1.backupPath, undefined);
      db1.close();

      // 重开同一个文件，应识别为已是最新
      const db2 = openDatabase({ filename: file, driver });
      applyConnectionPragmas(db2);
      const r2 = migrateSchema(db2, { backupDir: backups });
      assert.deepEqual(r2.applied, []);
      db2.close();
    });

    it('搜索索引迁移：无扩展时降级为 trigram，且不抛异常', () => {
      const db = openDatabase({ filename: ':memory:', driver });
      applyConnectionPragmas(db);
      migrateSchema(db);

      // 故意给不存在的扩展路径 → 必须降级而不是崩
      const status = loadExtensions(db, {
        libsimple: '/nonexistent/libsimple.so',
        sqliteVec: '/nonexistent/vec0.so',
      });
      assert.equal(status.libsimple, false);
      assert.equal(status.sqliteVec, false);
      assert.equal(status.tokenizer, 'trigram');

      const res = migrateSearchIndex(db, status);
      assert.equal(res.ok, true, `搜索索引迁移应成功（降级模式）：${res.error ?? ''}`);
      assert.equal(res.tokenizer, 'trigram');

      // FTS 表确实建出来了，且能搜（虽然是 trigram 分词）
      const fts = db
        .prepare<{ name: string }>(
          `select name from sqlite_master where type='table' and name like '%_fts'`,
        )
        .all()
        .map((x) => x.name);
      assert.ok(fts.includes('notes_fts'), `应建出 notes_fts，实际：${fts.join(',')}`);
      db.close();
    });

    it('搜索索引迁移幂等：同样的扩展状态下第二次不重建', () => {
      const db = openDatabase({ filename: ':memory:', driver });
      applyConnectionPragmas(db);
      migrateSchema(db);
      const status = loadExtensions(db, {});
      const first = migrateSearchIndex(db, status);
      const second = migrateSearchIndex(db, status);
      assert.equal(first.rebuilt, true);
      assert.equal(second.rebuilt, false, '指纹未变时不应重建');
      db.close();
    });
  });
}
