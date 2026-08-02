/**
 * `node:sqlite` 驱动实现（Node 内置，零原生依赖）。
 *
 * ⚠️ 稳定性：Node 24 上无 ExperimentalWarning；**Node 22 上仍是 experimental**（会打警告）。
 *    见 R-05 §2。这也是它当前是"备胎"而非主力的原因。
 */
import { DatabaseSync } from 'node:sqlite';

import type {
  BindParams,
  DatabaseHandle,
  OpenOptions,
  PreparedStatement,
  RunResult,
  SqlValue,
} from './types.js';

/**
 * node:sqlite 的 StatementSync 在类型上不接受 `bigint`/对象混合绑定，
 * 但运行时是支持的。这里收口成一次断言，避免在业务代码里到处 `as any`。
 */
type LooseStatement = {
  get: (...p: unknown[]) => unknown;
  all: (...p: unknown[]) => unknown[];
  run: (...p: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate: (...p: unknown[]) => IterableIterator<unknown>;
};

function toRunResult(r: { changes: number | bigint; lastInsertRowid: number | bigint }): RunResult {
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/**
 * ⚠️ 已实测的驱动差异（T-016）：`node:sqlite` 返回的行是 **null 原型对象**
 * （`[Object: null prototype] { a: 'x' }`），而 better-sqlite3 返回普通对象。
 *
 * 这会造成很隐蔽的不一致：`assert.deepStrictEqual` 会判不等、`structuredClone` 行为不同、
 * 任何依赖 `Object.prototype` 上方法（`hasOwnProperty` / `toString`）的代码会直接炸。
 *
 * 适配层的职责就是抹平这类差异 —— 统一成**普通对象**（符合 JS 直觉，也与主力驱动一致）。
 * 代价是每行一次浅拷贝；由于 node:sqlite 是备胎路径，这点开销可以接受。
 */
function toPlainRow<Row>(row: unknown): Row {
  if (row === null || row === undefined || typeof row !== 'object') return row as Row;
  return Object.assign({}, row) as Row;
}

class NodeSqliteStatement<Row> implements PreparedStatement<Row> {
  constructor(private readonly st: LooseStatement) {}

  get(...params: BindParams): Row | undefined {
    const row = this.st.get(...params);
    return row === undefined || row === null ? undefined : toPlainRow<Row>(row);
  }
  all(...params: BindParams): Row[] {
    return this.st.all(...params).map((r) => toPlainRow<Row>(r));
  }
  run(...params: BindParams): RunResult {
    return toRunResult(this.st.run(...params));
  }
  *iterate(...params: BindParams): IterableIterator<Row> {
    for (const row of this.st.iterate(...params)) yield toPlainRow<Row>(row);
  }
}

export class NodeSqliteDatabase implements DatabaseHandle {
  readonly driver = 'node:sqlite' as const;
  readonly sqliteVersion: string;
  readonly #db: DatabaseSync;
  /** 嵌套事务深度。0 = 不在事务中。 */
  #txDepth = 0;

  constructor(opts: OpenOptions) {
    // allowExtension 必须在构造时决定 —— node:sqlite 不支持事后开启。
    this.#db = new DatabaseSync(opts.filename, {
      allowExtension: opts.allowExtension ?? false,
      readOnly: opts.readonly ?? false,
    });
    this.sqliteVersion = String(
      (this.#db.prepare('select sqlite_version() as v').get() as { v: string }).v,
    );
  }

  prepare<Row>(sql: string): PreparedStatement<Row> {
    return new NodeSqliteStatement<Row>(this.#db.prepare(sql) as unknown as LooseStatement);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

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
      // 回滚失败不能掩盖原始异常 —— 原始异常才是根因。
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
    this.#db.enableLoadExtension(true);
    // node:sqlite 的 loadExtension 目前只接受 path 一个参数
    if (entryPoint !== undefined) {
      throw new Error(
        `node:sqlite 驱动不支持自定义扩展入口点（entryPoint=${entryPoint}）。` +
          `请使用默认入口点约定 sqlite3_<libname>_init，或改用 better-sqlite3 驱动。`,
      );
    }
    this.#db.loadExtension(path);
  }

  close(): void {
    this.#db.close();
  }
}
