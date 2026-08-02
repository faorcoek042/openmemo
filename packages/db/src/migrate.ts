/**
 * 迁移执行器（D-02 §5 + D-01 §2.6）。
 *
 * **两条独立的版本线**（D-02 §4.5 的关键原则）：
 *
 * | 版本线 | 存放位置 | 失败后果 |
 * |---|---|---|
 * | 业务 schema | `PRAGMA user_version` | **阻塞启动**（数据正确性问题） |
 * | 搜索索引 | `app_meta.search_index_version` | **不阻塞启动**，后台重建 |
 *
 * 之所以分开：sqlite-vec 还是 0.1.x，磁盘格式可能变；libsimple 可能加载失败。
 * 索引是**可重建的缓存**，不是数据 —— 真相在 `notes` / `transcript_segments` 等基表里。
 * 把它们绑在同一条版本线上，会让一个可恢复的索引问题升级成"打不开库"。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DatabaseHandle } from './driver/index.js';
import { applyTokenizer, type ExtensionStatus } from './extensions.js';

/** 迁移文件目录：包根下的 migrations/（`dist/` 的上一级）。 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly path: string;
  /** 搜索索引层（依赖扩展、可重建）还是业务 schema 层。 */
  readonly kind: 'schema' | 'search';
}

/**
 * 扫描迁移目录。
 * 命名约定：`NNNN_<slug>.sql`；slug 含 `search` 的归入索引版本线。
 */
export function discoverMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f): MigrationFile => {
      const m = /^(\d+)_(.+)\.sql$/.exec(f);
      if (!m) throw new Error(`迁移文件名不合约定（应为 NNNN_slug.sql）：${f}`);
      const slug = m[2] ?? '';
      return {
        version: Number(m[1]),
        name: f,
        path: join(dir, f),
        kind: slug.includes('search') ? 'search' : 'schema',
      };
    })
    .sort((a, b) => a.version - b.version);
}

export class SchemaTooNewError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly appVersion: number,
  ) {
    super(
      `数据库由更新版本的 OpenMemo 创建（schema v${dbVersion} > 本应用支持的 v${appVersion}）。` +
        `请升级应用，或从 backups/ 目录恢复旧版本备份。`,
    );
    this.name = 'SchemaTooNewError';
  }
}

export interface MigrateResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
  readonly backupPath?: string | undefined;
}

export interface MigrateOptions {
  readonly dir?: string;
  /** 备份目录；不传则不备份（内存库、测试）。 */
  readonly backupDir?: string | undefined;
}

/**
 * 业务 schema 迁移。**幂等**：已是最新版则什么都不做，返回 applied=[]。
 *
 * @throws SchemaTooNewError 当库版本高于本应用支持的版本时（D-01 §2.6：绝不"尽力而为"地打开）
 */
export function migrateSchema(db: DatabaseHandle, opts: MigrateOptions = {}): MigrateResult {
  const files = discoverMigrations(opts.dir).filter((f) => f.kind === 'schema');
  const target = files.length ? Math.max(...files.map((f) => f.version)) : 0;
  const current = Number(db.pragma('user_version') ?? 0);

  if (current > target) throw new SchemaTooNewError(current, target);
  if (current === target) return { from: current, to: target, applied: [] };

  // 备份：只在"库里已经有东西"时才需要（current > 0），且 VACUUM INTO 不能在事务里跑。
  let backupPath: string | undefined;
  if (opts.backupDir && current > 0) {
    mkdirSync(opts.backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = join(opts.backupDir, `openmemo-v${current}-${ts}.db`);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  }

  const applied: string[] = [];
  for (const f of files) {
    if (f.version <= current) continue;
    const sql = readFileSync(f.path, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      // PRAGMA 不支持参数绑定；version 来自文件名正则，已是纯数字，无注入面。
      db.setPragma(`user_version = ${f.version}`);
    });
    applied.push(f.name);
  }

  // app_meta.schema_version 是给 SQL 侧查询用的冗余副本（D-02 §1.2）
  syncSchemaVersionMeta(db, target);
  return { from: current, to: target, applied, backupPath };
}

function syncSchemaVersionMeta(db: DatabaseHandle, version: number): void {
  if (!tableExists(db, 'app_meta')) return;
  db.prepare(
    `INSERT INTO app_meta(key, value) VALUES ('schema_version', :v)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ v: String(version) });
}

export function tableExists(db: DatabaseHandle, name: string): boolean {
  const row = db
    .prepare<{ n: number }>(
      `select count(*) as n from sqlite_master where type in ('table','view') and name = :name`,
    )
    .get({ name });
  return (row?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// 搜索索引版本线
// ---------------------------------------------------------------------------

export interface SearchIndexResult {
  readonly ok: boolean;
  readonly version: number;
  readonly tokenizer: string;
  readonly rebuilt: boolean;
  readonly error?: string | undefined;
  /** 每张 FTS 表的回填结果（`ok(N)` 或 `failed: …`）。可观测性：静默失效必须看得见。 */
  readonly backfill?: Record<string, string> | undefined;
}

function readMeta(db: DatabaseHandle, key: string): string | undefined {
  if (!tableExists(db, 'app_meta')) return undefined;
  return db.prepare<{ value: string }>('select value from app_meta where key = :k').get({ k: key })
    ?.value;
}

function writeMeta(db: DatabaseHandle, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta(key, value) VALUES (:k, :v)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ k: key, v: value });
}

/**
 * 索引"指纹"：分词器变了、索引 DDL 版本变了，都必须重建。
 * 用指纹而不是纯版本号，是因为 libsimple 可用性会在两次启动之间变化
 * （用户装了/删了扩展），而 DDL 版本号不会因此改变。
 */
function indexFingerprint(version: number, tokenizer: string): string {
  return `${version}:${tokenizer}`;
}

/** 找出所有 FTS5 影子表与其触发器，用于重建前的清理。 */
function dropSearchObjects(db: DatabaseHandle): void {
  const triggers = db
    .prepare<{ name: string }>(
      `select name from sqlite_master where type='trigger' and name like '%_fts_%'`,
    )
    .all();
  for (const t of triggers) db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);

  const tables = db
    .prepare<{ name: string }>(
      `select name from sqlite_master where type='table' and name like '%_fts'`,
    )
    .all();
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
}

/**
 * 从内容表回填全部 FTS5 影子表。
 *
 * 对每个 `*_fts` 表执行官方回填指令 `INSERT INTO t(t) VALUES('rebuild')`。
 * 单表失败不影响其它表（比如某张表的 content 表还没建），失败会被记录但不抛。
 *
 * @returns 每张表的回填结果，便于诊断
 */
export function rebuildSearchIndexes(db: DatabaseHandle): Record<string, string> {
  const out: Record<string, string> = {};
  const tables = db
    .prepare<{ name: string }>(
      `select name from sqlite_master where type='table' and name like '%_fts'`,
    )
    .all();
  for (const t of tables) {
    try {
      db.exec(`INSERT INTO "${t.name}"("${t.name}") VALUES('rebuild')`);
      const n = db.prepare<{ c: number }>(`select count(*) c from "${t.name}"`).get()?.c ?? 0;
      out[t.name] = `ok(${n})`;
    } catch (err) {
      out[t.name] = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return out;
}

/**
 * 搜索索引迁移。**永不抛出** —— 失败只是"检索降级"，不是"库打不开"。
 *
 * @param status 扩展加载结果，决定用 simple 还是 trigram 分词器
 */
export function migrateSearchIndex(
  db: DatabaseHandle,
  status: ExtensionStatus,
  opts: MigrateOptions = {},
): SearchIndexResult {
  const files = discoverMigrations(opts.dir).filter((f) => f.kind === 'search');
  const target = files.length ? Math.max(...files.map((f) => f.version)) : 0;
  const want = indexFingerprint(target, status.tokenizer);
  const have = readMeta(db, 'search_index_version');

  if (have === want) {
    return { ok: true, version: target, tokenizer: status.tokenizer, rebuilt: false };
  }

  let backfill: Record<string, string> = {};
  try {
    db.transaction(() => {
      dropSearchObjects(db);
      for (const f of files) {
        const sql = applyTokenizer(readFileSync(f.path, 'utf8'), status.tokenizer);
        db.exec(sql);
      }
      /*
       * ★ 必须回填 ★
       *
       * DROP + CREATE 只建出**空**的 FTS5 影子表；触发器只对**此后**的写入生效。
       * 已经存在的行不会自动进索引 —— 于是搜索会**静默返回 0 条**，不报错、不崩溃。
       *
       * 而触发重建的最常见原因恰恰是"扩展加载失败/恢复导致分词器变了"，
       * 也就是说：**扩展一出问题，搜索就悄悄变成永远搜不到**。
       * 静默错误比崩溃更糟，因为没人会报告它。
       *
       * FTS5 外部内容表的官方回填指令就是 `INSERT INTO <fts>(<fts>) VALUES('rebuild')`，
       * 它会从 content 表重新读取全部行。
       */
      backfill = rebuildSearchIndexes(db);
      writeMeta(db, 'search_index_version', want);
    });
    return { ok: true, version: target, tokenizer: status.tokenizer, rebuilt: true, backfill };
  } catch (err) {
    // 关键：吞掉异常。检索不可用 ≠ 产品不可用。
    return {
      ok: false,
      version: target,
      tokenizer: status.tokenizer,
      rebuilt: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
