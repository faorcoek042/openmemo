/**
 * 扩展加载与**降级路径**测试。
 *
 * Manager 在 T-016 的验收要求：
 *   「扩展加载失败时 daemon 仍能启动（把 .so 改名模拟，跑给我看）」
 *
 * 这里覆盖库层；daemon 层的端到端演示见 apps/daemon/scripts/demo-degraded-start.mjs。
 *
 * 需要真实扩展的用例通过环境变量 `OPENMEMO_TEST_EXT_DIR` 开启；
 * 未设置时这些用例会**显式 skip**（而不是静默通过 —— 那会掩盖回归）。
 */
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { isBetterSqlite3Available, openDatabase } from './driver/index.js';
import { applyTokenizer, defaultExtensionPaths, loadExtensions } from './extensions.js';
import { openAppDatabase } from './open.js';
import { applyConnectionPragmas } from './pragmas.js';
import { vecInsert, vecSearch } from './vec.js';

const EXT_DIR = process.env['OPENMEMO_TEST_EXT_DIR'];
const HAS_EXT = !!EXT_DIR && existsSync(join(EXT_DIR, `libsimple${suffix()}`));
const TMP = mkdtempSync(join(tmpdir(), 'omdb-ext-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

function suffix(): string {
  if (process.platform === 'win32') return '.dll';
  if (process.platform === 'darwin') return '.dylib';
  return '.so';
}

describe('降级路径（无需真实扩展）', () => {
  it('扩展文件不存在 → 不抛异常，返回失败原因', () => {
    const db = openDatabase({ filename: ':memory:', allowExtension: true });
    const st = loadExtensions(db, {
      libsimple: '/definitely/not/here.so',
      sqliteVec: '/definitely/not/here2.so',
    });
    assert.equal(st.libsimple, false);
    assert.equal(st.sqliteVec, false);
    assert.equal(st.tokenizer, 'trigram');
    assert.match(st.failures['libsimple'] ?? '', /不存在/);
    assert.match(st.failures['sqlite-vec'] ?? '', /不存在/);
    db.close();
  });

  it('未配置路径 → 同样降级，不抛', () => {
    const db = openDatabase({ filename: ':memory:', allowExtension: true });
    const st = loadExtensions(db, {});
    assert.equal(st.tokenizer, 'trigram');
    db.close();
  });

  it('损坏的 .so（内容是垃圾）→ 捕获 dlopen 错误并降级', () => {
    const bogus = join(TMP, `bogus${suffix()}`);
    // 写一个存在但不是合法动态库的文件 —— 这是"改名/损坏"的最坏情况
    copyFileSync(process.execPath, bogus); // 是可执行文件但不是共享库
    const db = openDatabase({ filename: ':memory:', allowExtension: true });
    const st = loadExtensions(db, { sqliteVec: bogus });
    assert.equal(st.sqliteVec, false, '损坏的 .so 不应被当作加载成功');
    assert.ok(st.failures['sqlite-vec'], '必须记录失败原因');
    db.close();
  });

  it('applyTokenizer 把 simple 替换成 trigram', () => {
    const sql = `CREATE VIRTUAL TABLE x USING fts5(a, tokenize = 'simple');`;
    assert.match(applyTokenizer(sql, 'trigram'), /tokenize = 'trigram'/);
    assert.equal(applyTokenizer(sql, 'simple'), sql);
  });

  it('openAppDatabase：扩展全挂时仍能打开库并完成迁移', () => {
    const app = openAppDatabase({
      filename: join(TMP, 'degraded.db'),
      extensions: { libsimple: '/nope.so', sqliteVec: '/nope2.so' },
    });
    assert.ok(app.schema.to >= 1, 'schema 迁移必须成功');
    assert.equal(app.extensions.libsimple, false);
    assert.equal(app.extensions.sqliteVec, false);
    assert.equal(app.search.ok, true, '搜索层应降级成功而非失败');
    assert.equal(app.search.tokenizer, 'trigram');
    app.close();
  });

  it('安全模式（D-01 §2.7 D）：完全不加载扩展也能打开', () => {
    const app = openAppDatabase({
      filename: join(TMP, 'safemode.db'),
      extensions: defaultExtensionPaths('/whatever'),
      safeMode: true,
    });
    assert.equal(app.extensions.libsimple, false);
    assert.ok(app.extensions.failures['safeMode']);
    assert.ok(app.schema.to >= 1);
    app.close();
  });
});

describe('真实扩展（需要 OPENMEMO_TEST_EXT_DIR）', { skip: !HAS_EXT }, () => {
  const drivers = isBetterSqlite3Available()
    ? (['better-sqlite3', 'node:sqlite'] as const)
    : (['node:sqlite'] as const);

  for (const driver of drivers) {
    it(`${driver}: libsimple + sqlite-vec 都能加载`, () => {
      const db = openDatabase({ filename: ':memory:', driver, allowExtension: true });
      const st = loadExtensions(db, defaultExtensionPaths(EXT_DIR as string));
      assert.equal(st.libsimple, true, `libsimple 加载失败：${st.failures['libsimple'] ?? ''}`);
      assert.equal(st.sqliteVec, true, `sqlite-vec 加载失败：${st.failures['sqlite-vec'] ?? ''}`);
      assert.equal(st.tokenizer, 'simple');
      assert.match(st.vecVersion ?? '', /^v?\d/);
      db.close();
    });

    it(`${driver}: 中文分词真的生效`, () => {
      const db = openDatabase({ filename: ':memory:', driver, allowExtension: true });
      loadExtensions(db, defaultExtensionPaths(EXT_DIR as string));
      db.exec(`create virtual table t using fts5(body, tokenize='simple')`);
      db.prepare('insert into t(body) values (?)').run('思维导图与转写稿的时间轴联动');
      const hit = db
        .prepare<{ body: string }>(`select body from t where t match simple_query(?)`)
        .all('思维');
      assert.equal(hit.length, 1, '中文分词后应能搜到');
      db.close();
    });

    it(`${driver}: vecInsert 用 BigInt 收口（D-02 §4.3 硬约定）`, () => {
      const db = openDatabase({ filename: ':memory:', driver, allowExtension: true });
      loadExtensions(db, defaultExtensionPaths(EXT_DIR as string));
      db.exec('create virtual table vec_chunks using vec0(note_id integer, embedding float[4])');

      // 业务代码传的是普通 number —— 适配层负责转 BigInt
      vecInsert(db, 'vec_chunks', {
        rowid: 1,
        vectorColumn: 'embedding',
        vector: [1, 2, 3, 4],
        meta: { note_id: 10 },
      });
      vecInsert(db, 'vec_chunks', {
        rowid: 2,
        vectorColumn: 'embedding',
        vector: [9, 9, 9, 9],
        meta: { note_id: 10 },
      });

      const hits = vecSearch(db, 'vec_chunks', 'embedding', [1, 2, 3, 4], 2);
      assert.equal(hits.length, 2);
      assert.equal(hits[0]?.rowid, 1);
      assert.equal(hits[0]?.distance, 0);
      assert.equal(typeof hits[0]?.rowid, 'number', 'rowid 应转回 number 交给业务层');
      db.close();
    });

    it(`${driver}: 直接绑 number 会失败 —— 证明 BigInt 收口不是多余的`, () => {
      const db = openDatabase({ filename: ':memory:', driver, allowExtension: true });
      loadExtensions(db, defaultExtensionPaths(EXT_DIR as string));
      db.exec('create virtual table v using vec0(embedding float[4])');
      assert.throws(
        () => db.prepare('insert into v(rowid, embedding) values (?,?)').run(1, '[1,2,3,4]'),
        /[Oo]nly integers/,
      );
      db.close();
    });
  }

  it('扩展"改名"后重开：自动降级为 trigram，库仍可用', () => {
    // 复制一份扩展目录，然后把 libsimple 改名，模拟用户删了/换了文件
    const dir = join(TMP, 'extcopy');
    cpSync(EXT_DIR as string, dir, { recursive: true });
    const lib = join(dir, `libsimple${suffix()}`);
    renameSync(lib, `${lib}.disabled`);

    const app = openAppDatabase({
      filename: join(TMP, 'renamed.db'),
      extensions: defaultExtensionPaths(dir),
    });
    assert.equal(app.extensions.libsimple, false, 'libsimple 已改名，应加载失败');
    assert.equal(app.extensions.tokenizer, 'trigram', '应降级为 trigram');
    assert.equal(app.search.ok, true, '搜索层仍应可用（降级）');
    assert.ok(app.schema.to >= 1, '业务 schema 不受影响');
    app.close();
  });

  it('扩展恢复后重开：指纹变化触发索引重建，自动升回 simple', () => {
    const dir = join(TMP, 'extcopy2');
    cpSync(EXT_DIR as string, dir, { recursive: true });
    const lib = join(dir, `libsimple${suffix()}`);
    const file = join(TMP, 'recover.db');

    renameSync(lib, `${lib}.off`);
    const a = openAppDatabase({ filename: file, extensions: defaultExtensionPaths(dir) });
    assert.equal(a.extensions.tokenizer, 'trigram');
    a.close();

    renameSync(`${lib}.off`, lib);
    const b = openAppDatabase({ filename: file, extensions: defaultExtensionPaths(dir) });
    assert.equal(b.extensions.tokenizer, 'simple');
    assert.equal(b.search.rebuilt, true, '分词器变了必须重建索引');
    b.close();
  });
});

describe('连接级 PRAGMA', () => {
  it('WAL 与 foreign_keys 生效', () => {
    const db = openDatabase({ filename: join(TMP, 'pragma.db') });
    const mode = applyConnectionPragmas(db);
    assert.equal(mode, 'wal');
    assert.equal(db.pragma('foreign_keys'), 1);
    db.close();
  });
});
