/**
 * @openmemo/db —— DB 层（T-016, oss-scout）
 *
 * - 驱动适配层：`better-sqlite3`（主力）⇄ `node:sqlite`（备胎），ADR-005 决策 6
 * - 迁移执行器：业务 schema 与搜索索引**两条独立版本线**（D-02 §4.5 / §5）
 * - 扩展加载：sqlite-vec + libsimple，**失败只降级不阻塞启动**
 * - `vec0` 写入收口：统一 BigInt 转换（D-02 §4.3 硬约定）
 */
export * from './driver/index.js';
export * from './extensions.js';
export * from './migrate.js';
export * from './open.js';
export * from './pragmas.js';
export * from './vec.js';
