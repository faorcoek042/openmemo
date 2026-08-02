/**
 * 驱动工厂。
 *
 * 默认用 `better-sqlite3`（R-05 定案的主力），装不上时**自动回退**到 `node:sqlite`。
 * 回退不是理论上的：R-05 §6 记录了上游 open issue #1509
 * （`linux-arm64.node` 要求 GLIBC_2.38，老发行版会 dlopen 失败）。
 * 这正是 ADR-005 决策 6 要求"两个实现都要能跑"的现实理由。
 */
import { BetterSqlite3Database, isBetterSqlite3Available } from './better-sqlite3.js';
import { NodeSqliteDatabase } from './node-sqlite.js';
import type { DatabaseHandle, DriverName, OpenOptions } from './types.js';

export * from './types.js';
export { isBetterSqlite3Available };

/** 环境变量强制指定驱动，便于排障与测试：`OPENMEMO_DB_DRIVER=node:sqlite` */
const ENV_DRIVER = 'OPENMEMO_DB_DRIVER';

export function preferredDriver(): DriverName {
  const forced = process.env[ENV_DRIVER];
  if (forced === 'node:sqlite' || forced === 'better-sqlite3') return forced;
  return isBetterSqlite3Available() ? 'better-sqlite3' : 'node:sqlite';
}

export function openDatabase(opts: OpenOptions): DatabaseHandle {
  const driver = opts.driver ?? preferredDriver();
  if (driver === 'better-sqlite3') {
    if (!isBetterSqlite3Available()) {
      throw new Error(
        'better-sqlite3 不可用（可能是当前平台缺少 prebuild，见 upstream issue #1509）。' +
          `可设 ${ENV_DRIVER}=node:sqlite 回退到 Node 内置驱动。`,
      );
    }
    return new BetterSqlite3Database(opts);
  }
  return new NodeSqliteDatabase(opts);
}
