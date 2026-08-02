/**
 * 连接级 PRAGMA（D-02 §1.0）。
 *
 * ⚠️ 这些是**连接级**设置，不是库级 —— 每开一个连接都必须重设。
 *    尤其 `foreign_keys`：SQLite 默认 OFF，忘了设 = 外键形同虚设（D-02 §1.0 注）。
 */
import type { DatabaseHandle } from './driver/index.js';

export interface PragmaOptions {
  /**
   * Windows 上 mmap 与部分杀软/网络盘冲突（D-02 §1.0 标注 [待核实]）→ 提供开关。
   * 默认在 win32 上关闭，属保守选择。
   */
  readonly enableMmap?: boolean;
  /** 只读连接不需要 WAL 切换（切换本身要写文件）。 */
  readonly readonly?: boolean;
}

/**
 * 按 D-02 §1.0 应用全部连接级 PRAGMA。
 * 返回实际生效的 journal_mode，调用方可据此判断 WAL 是否真的开上了
 * （网络盘 / 某些 FUSE 上 WAL 会静默退回 delete 模式）。
 */
export function applyConnectionPragmas(db: DatabaseHandle, opts: PragmaOptions = {}): string {
  const enableMmap = opts.enableMmap ?? process.platform !== 'win32';

  if (!opts.readonly) {
    db.setPragma('journal_mode = WAL');
  }
  db.setPragma('synchronous = NORMAL');
  db.setPragma('foreign_keys = ON');
  db.setPragma('busy_timeout = 5000');
  db.setPragma('temp_store = MEMORY');
  db.setPragma('cache_size = -65536'); // 负数 = KB → 64 MB
  db.setPragma('wal_autocheckpoint = 1000');
  db.setPragma('trusted_schema = OFF'); // 安全：禁止 schema 中的函数在未信任上下文执行

  if (enableMmap) {
    db.setPragma('mmap_size = 268435456'); // 256 MB
  }

  return String(db.pragma('journal_mode') ?? 'unknown');
}

/** 自检：确认关键 PRAGMA 真的生效了。用于启动日志与诊断包。 */
export function readPragmaState(db: DatabaseHandle): Record<string, unknown> {
  return {
    journal_mode: db.pragma('journal_mode'),
    synchronous: db.pragma('synchronous'),
    foreign_keys: db.pragma('foreign_keys'),
    busy_timeout: db.pragma('busy_timeout'),
    user_version: db.pragma('user_version'),
  };
}
