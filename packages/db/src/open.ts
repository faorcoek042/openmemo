/**
 * 打开应用数据库的完整装配流程（D-01 §2 启动序列的第 3 步）。
 *
 * 顺序是有讲究的，别改：
 *   1. 开连接（allowExtension 必须在构造时决定）
 *   2. 连接级 PRAGMA（foreign_keys 必须在任何写入之前）
 *   3. 加载扩展（失败只降级，不抛）
 *   4. 业务 schema 迁移（失败 = 启动失败）
 *   5. 搜索索引迁移（失败 = 降级，不阻塞）
 */
import type { DatabaseHandle, DriverName } from './driver/index.js';
import { openDatabase } from './driver/index.js';
import { type ExtensionPaths, type ExtensionStatus, loadExtensions } from './extensions.js';
import {
  type MigrateResult,
  type SearchIndexResult,
  migrateSchema,
  migrateSearchIndex,
} from './migrate.js';
import { applyConnectionPragmas } from './pragmas.js';

export interface OpenAppDatabaseOptions {
  readonly filename: string;
  readonly driver?: DriverName | undefined;
  readonly extensions?: ExtensionPaths | undefined;
  readonly backupDir?: string | undefined;
  readonly migrationsDir?: string | undefined;
  /** 安全模式（D-01 §2.7 D）：不加载任何原生扩展。 */
  readonly safeMode?: boolean;
}

export interface AppDatabase {
  readonly db: DatabaseHandle;
  readonly driver: DriverName;
  readonly sqliteVersion: string;
  readonly journalMode: string;
  readonly extensions: ExtensionStatus;
  readonly schema: MigrateResult;
  readonly search: SearchIndexResult;
  close(): void;
}

export function openAppDatabase(opts: OpenAppDatabaseOptions): AppDatabase {
  const wantExtensions = !opts.safeMode && !!opts.extensions;

  const db = openDatabase({
    filename: opts.filename,
    ...(opts.driver ? { driver: opts.driver } : {}),
    allowExtension: wantExtensions,
  });

  try {
    const journalMode = applyConnectionPragmas(db);

    const extensions: ExtensionStatus = wantExtensions
      ? loadExtensions(db, opts.extensions ?? {})
      : {
          libsimple: false,
          sqliteVec: false,
          tokenizer: 'trigram',
          failures: opts.safeMode ? { safeMode: '安全模式：已禁用所有原生扩展' } : {},
        };

    // 业务 schema：失败必须冒泡（数据正确性问题，不能"尽力而为"）
    const schema = migrateSchema(db, {
      ...(opts.migrationsDir ? { dir: opts.migrationsDir } : {}),
      backupDir: opts.backupDir,
    });

    // 搜索索引：失败只降级
    const search = migrateSearchIndex(db, extensions, {
      ...(opts.migrationsDir ? { dir: opts.migrationsDir } : {}),
    });

    return {
      db,
      driver: db.driver,
      sqliteVersion: db.sqliteVersion,
      journalMode,
      extensions,
      schema,
      search,
      close: () => db.close(),
    };
  } catch (err) {
    // 打开过程中失败要关掉连接，否则会留下 WAL 文件与文件锁
    try {
      db.close();
    } catch {
      /* 原始异常优先 */
    }
    throw err;
  }
}
