/**
 * `better-sqlite3` 驱动实现（主力，R-05 定案）。
 *
 * v13.0.2 起走 prebuildify：8 个平台的预编译 `.node` 直接打在 npm tarball 里，
 * **用户机器不需要编译工具链**（R-05 §0 实测）。因此它是可以随产品分发的。
 */
import { createRequire } from 'node:module';

import type {
  BindParams,
  DatabaseHandle,
  OpenOptions,
  PreparedStatement,
  RunResult,
  SqlValue,
} from './types.js';

/**
 * 用 createRequire 而不是静态 import：better-sqlite3 是**可选** peer dependency。
 * 若它装不上（某平台没有 prebuild），我们要能优雅回退到 node:sqlite，
 * 而不是在模块加载阶段就把整个 daemon 炸掉。
 */
const require = createRequire(import.meta.url);

type BetterStatement = {
  get: (...p: unknown[]) => unknown;
  all: (...p: unknown[]) => unknown[];
  run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  iterate: (...p: unknown[]) => IterableIterator<unknown>;
};

type BetterDb = {
  prepare: (sql: string) => BetterStatement;
  exec: (sql: string) => void;
  loadExtension: (path: string, entryPoint?: string) => void;
  close: () => void;
};

type BetterCtor = new (
  filename: string,
  options?: { readonly?: boolean },
) => BetterDb;

/** better-sqlite3 是否真的可用（装上了且能 dlopen 到对应平台的 prebuild）。 */
export function isBetterSqlite3Available(): boolean {
  try {
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

class BetterStatementWrapper<Row> implements PreparedStatement<Row> {
  constructor(private readonly st: BetterStatement) {}

  get(...params: BindParams): Row | undefined {
    return this.st.get(...params) as Row | undefined;
  }
  all(...params: BindParams): Row[] {
    return this.st.all(...params) as Row[];
  }
  run(...params: BindParams): RunResult {
    const r = this.st.run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  iterate(...params: BindParams): IterableIterator<Row> {
    return this.st.iterate(...params) as IterableIterator<Row>;
  }
}

export class BetterSqlite3Database implements DatabaseHandle {
  readonly driver = 'better-sqlite3' as const;
  readonly sqliteVersion: string;
  readonly #db: BetterDb;
  #txDepth = 0;

  constructor(opts: OpenOptions) {
    const Ctor = require('better-sqlite3') as BetterCtor;
    this.#db = new Ctor(opts.filename, { readonly: opts.readonly ?? false });
    this.sqliteVersion = String(
      (this.#db.prepare('select sqlite_version() as v').get() as { v: string }).v,
    );
  }

  prepare<Row>(sql: string): PreparedStatement<Row> {
    return new BetterStatementWrapper<Row>(this.#db.prepare(sql));
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /**
   * 刻意**不使用** better-sqlite3 自带的 `db.transaction()`：
   * 它的语义（返回一个包装函数、自动 savepoint）与 node:sqlite 侧无法对齐。
   * 两个驱动共用同一份手写实现，才能保证适配层语义真的一致。
   */
  transaction<T>(fn: () => T): T {
    const depth = this.#txDepth;
    const savepoint = `om_sp_${depth}`;
    this.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    this.#txDepth = depth + 1;
    try {
      const out = fn();
      this.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return out;
    } catch (err) {
      try {
        this.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
        if (depth > 0) this.exec(`RELEASE ${savepoint}`);
      } catch {
        /* 忽略：原始异常优先 */
      }
      throw err;
    } finally {
      this.#txDepth = depth;
    }
  }

  pragma(name: string): SqlValue | undefined {
    const row = this.#db.prepare(`PRAGMA ${name}`).get() as Record<string, SqlValue> | undefined;
    if (!row) return undefined;
    return Object.values(row)[0];
  }

  setPragma(statement: string): void {
    this.#db.exec(`PRAGMA ${statement}`);
  }

  loadExtension(path: string, entryPoint?: string): void {
    if (entryPoint === undefined) this.#db.loadExtension(path);
    else this.#db.loadExtension(path, entryPoint);
  }

  close(): void {
    this.#db.close();
  }
}
