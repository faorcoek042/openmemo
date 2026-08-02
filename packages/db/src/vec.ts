/**
 * sqlite-vec (`vec0`) 写入收口层。
 *
 * **D-02 §4.3 的硬约定**：
 * > 凡是写入 `vec0` 虚拟表的整数列，一律绑 `BigInt`；
 * > 转换在 DB 适配层内部完成，业务代码继续传普通 `number`。
 *
 * 背景（T-014 实测，R-05 §4）：给 `vec0` 的整数列绑 JS `number` 会失败：
 *   `Only integers are allows for primary key values on <table>`
 * **两个驱动表现完全一致** —— 这是 sqlite-vec v0.1.9 的行为，不是驱动 bug。
 *
 * 让每个调用方各自记得 `BigInt(...)` 是必然会漏的（漏了要到运行时才炸），
 * 所以这里用类型 + 运行时双重收口：业务代码传 `number`，只有这一处做转换。
 */
import type { DatabaseHandle, SqlValue } from './driver/index.js';

/** 向量：业务侧用普通 number[]，序列化成 sqlite-vec 认的 JSON 文本。 */
export type Vector = readonly number[] | Float32Array;

export function serializeVector(v: Vector): string {
  const arr = v instanceof Float32Array ? Array.from(v) : v;
  return JSON.stringify(arr);
}

export interface VecInsertParams {
  /** vec0 的 rowid。业务侧传 number，内部转 BigInt。 */
  readonly rowid: number;
  readonly vectorColumn: string;
  readonly vector: Vector;
  /**
   * 元数据列（vec0 支持可过滤的元数据列）。
   * **整数值同样会被转成 BigInt** —— 这正是最容易漏的地方。
   */
  readonly meta?: Readonly<Record<string, number | string | null>>;
}

/**
 * 把 JS 值转成可安全绑给 `vec0` 的形式。
 * 整数 → BigInt；非整数 number（浮点元数据）保持不变；其余原样。
 */
function coerceForVec0(value: number | string | null): SqlValue {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  return value;
}

/**
 * 向 `vec0` 虚拟表插入一行。**这是写 vec0 的唯一合法入口。**
 *
 * @param table 虚拟表名。必须是我们自己 schema 里的标识符，不接受用户输入。
 */
export function vecInsert(db: DatabaseHandle, table: string, p: VecInsertParams): void {
  assertSafeIdentifier(table);
  assertSafeIdentifier(p.vectorColumn);

  const metaKeys = Object.keys(p.meta ?? {});
  for (const k of metaKeys) assertSafeIdentifier(k);

  const columns = ['rowid', p.vectorColumn, ...metaKeys];
  const placeholders = columns.map(() => '?').join(', ');
  const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`;

  const values: SqlValue[] = [
    BigInt(p.rowid), // ← 约定的核心：rowid 永远是 BigInt
    serializeVector(p.vector),
    ...metaKeys.map((k) => coerceForVec0(p.meta?.[k] ?? null)),
  ];

  db.prepare(sql).run(...values);
}

/** 按 rowid 删除（同样需要 BigInt）。 */
export function vecDelete(db: DatabaseHandle, table: string, rowid: number): void {
  assertSafeIdentifier(table);
  db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).run(BigInt(rowid));
}

export interface VecSearchHit {
  readonly rowid: number;
  readonly distance: number;
}

/** kNN 查询。读路径不受 BigInt 约定影响，但 rowid 统一转回 number 交给业务层。 */
export function vecSearch(
  db: DatabaseHandle,
  table: string,
  vectorColumn: string,
  query: Vector,
  k: number,
): VecSearchHit[] {
  assertSafeIdentifier(table);
  assertSafeIdentifier(vectorColumn);
  const rows = db
    .prepare<{ rowid: number | bigint; distance: number }>(
      `SELECT rowid, distance FROM "${table}" WHERE "${vectorColumn}" MATCH ? AND k = ? ORDER BY distance`,
    )
    .all(serializeVector(query), BigInt(k));
  return rows.map((r) => ({ rowid: Number(r.rowid), distance: r.distance }));
}

/**
 * 标识符白名单校验。
 * 表名/列名无法参数化，只能靠白名单。这些值只来自我们自己的 schema 常量，
 * 但加这道断言可以保证"将来有人把它接到用户输入上"时会立刻炸掉而不是被注入。
 */
function assertSafeIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`非法 SQL 标识符：${JSON.stringify(name)}`);
  }
}
