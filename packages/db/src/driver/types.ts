/**
 * 驱动无关的 SQLite 接口（ADR-005 决策 6：薄适配层，两个驱动都必须能跑）。
 *
 * 设计原则：**只暴露两个驱动都原生支持、且语义已实测一致的能力**。
 * 任何一边独有的东西（better-sqlite3 的 `transaction()` / `pragma()`）由适配层自己补齐，
 * 而不是把差异漏给调用方。
 *
 * 已实测的驱动差异（T-016 实机对比，见 R-05 与 db.test.ts）：
 *
 * | 行为 | better-sqlite3 13.0.2 | node:sqlite (Node 24.18) | 适配层做法 |
 * |---|---|---|---|
 * | `run()` 返回 | `{changes:number, lastInsertRowid:number}` | 同 | 直接透传 |
 * | `get()` 无结果 | `undefined` | `undefined` | 直接透传 |
 * | 命名参数 `:a` + `{a:1}` | ✅ | ✅ | **只允许这一种命名风格** |
 * | 命名参数 `$a` + `{$a:1}` | ❌ 抛 Missing named parameter | ✅ | 禁用，见上 |
 * | 读回 > 2^53 的整数 | ⚠️ **静默丢精度**（9007199254740993 → …992） | ✅ **抛 ERR_OUT_OF_RANGE** | 见 `readBigInts` |
 * | `transaction()` / `pragma()` | 有 | 无 | 适配层统一实现 |
 * | 扩展加载 | `loadExtension(path)` 直接可用 | 需构造时 `{allowExtension:true}` + `enableLoadExtension(true)` | 工厂内部处理 |
 */

/** SQLite 能存储的标量类型。 */
export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * 绑定参数。
 * - 位置参数：`?` + 数组
 * - 命名参数：`:name` + 裸键对象（**不要用 `$name`**，better-sqlite3 不接受）
 */
export type BindParams = SqlValue[] | [Record<string, SqlValue>];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface PreparedStatement<Row = Record<string, SqlValue>> {
  get(...params: BindParams): Row | undefined;
  all(...params: BindParams): Row[];
  run(...params: BindParams): RunResult;
  iterate(...params: BindParams): IterableIterator<Row>;
}

/** 驱动标识。用于日志、诊断包、以及测试里断言"两个实现都跑过了"。 */
export type DriverName = 'better-sqlite3' | 'node:sqlite';

export interface DatabaseHandle {
  readonly driver: DriverName;
  /** 底层 SQLite 库版本（例如 3.53.4）。 */
  readonly sqliteVersion: string;

  prepare<Row = Record<string, SqlValue>>(sql: string): PreparedStatement<Row>;
  exec(sql: string): void;

  /**
   * 事务。**支持嵌套**：最外层用 BEGIN/COMMIT，内层自动降级为 SAVEPOINT。
   * 回调抛异常则整体回滚并把异常继续抛出。
   */
  transaction<T>(fn: () => T): T;

  /** 读单个 PRAGMA 的值（`pragma('user_version')` → number）。 */
  pragma(name: string): SqlValue | undefined;
  /** 设置 PRAGMA。分开成两个方法，避免 better-sqlite3 那种 `simple` 开关的歧义。 */
  setPragma(statement: string): void;

  loadExtension(path: string, entryPoint?: string): void;

  close(): void;
}

export interface OpenOptions {
  /** 数据库文件路径；`:memory:` 表示内存库。 */
  readonly filename: string;
  /**
   * 指定驱动。不传则按 `preferredDriver()` 自动选择。
   * 显式指定主要用于测试（要证明两个实现都能跑）与故障排除时的手动切换。
   */
  readonly driver?: DriverName;
  /** 是否允许加载原生扩展。node:sqlite 必须在构造时就决定，故放在这里。 */
  readonly allowExtension?: boolean;
  readonly readonly?: boolean;
}
