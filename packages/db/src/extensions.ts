/**
 * SQLite 扩展加载与降级（D-02 §4.5「索引 = 可重建缓存」）。
 *
 * **核心契约：扩展加载失败绝不阻塞启动。**
 * - libsimple 挂了 → FTS5 退回内置 `trigram` 分词（中文仍可用，只是效果差些）
 * - sqlite-vec 挂了 → 语义/混合检索关闭，关键词检索照常
 *
 * 这条降级路径是被测试覆盖的（见 extensions.test.ts / migrate.test.ts）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { DatabaseHandle } from './driver/index.js';

export type TokenizerKind = 'simple' | 'trigram';

export interface ExtensionPaths {
  /** libsimple 动态库路径（FTS5 中文分词 tokenizer）。 */
  readonly libsimple?: string | undefined;
  /** libsimple 的词典目录（jieba_dict 需要）。 */
  readonly libsimpleDict?: string | undefined;
  /** sqlite-vec 动态库路径（vec0 向量表）。 */
  readonly sqliteVec?: string | undefined;
}

export interface ExtensionStatus {
  readonly libsimple: boolean;
  readonly sqliteVec: boolean;
  /** 实际可用的 FTS5 分词器。libsimple 不可用时自动降级为 trigram。 */
  readonly tokenizer: TokenizerKind;
  /** 每个扩展的失败原因（成功则不出现）。用于 UI 解释"为什么语义检索是灰的"。 */
  readonly failures: Readonly<Record<string, string>>;
  readonly vecVersion?: string | undefined;
}

/** 各平台的动态库后缀。 */
function libSuffix(): string {
  if (process.platform === 'win32') return '.dll';
  if (process.platform === 'darwin') return '.dylib';
  return '.so';
}

/**
 * 从一个"扩展根目录"推导默认路径。
 * 目录布局由 T-012 的构建脚本产出，约定：
 *   <root>/libsimple.<ext> · <root>/dict/ · <root>/vec0.<ext>
 */
export function defaultExtensionPaths(root: string): ExtensionPaths {
  const s = libSuffix();
  return {
    libsimple: join(root, `libsimple${s}`),
    libsimpleDict: join(root, 'dict'),
    sqliteVec: join(root, `vec0${s}`),
  };
}

/**
 * 尽力加载扩展，**任何失败都只记录、不抛出**。
 *
 * @returns 实际可用能力，调用方据此决定建 FTS5 时用哪个 tokenizer、要不要建 vec 表。
 */
export function loadExtensions(db: DatabaseHandle, paths: ExtensionPaths): ExtensionStatus {
  const failures: Record<string, string> = {};
  let libsimple = false;
  let sqliteVec = false;
  let vecVersion: string | undefined;

  // ---- libsimple（中文分词）----
  if (!paths.libsimple) {
    failures['libsimple'] = '未配置路径';
  } else if (!existsSync(paths.libsimple)) {
    failures['libsimple'] = `文件不存在：${paths.libsimple}`;
  } else {
    try {
      db.loadExtension(paths.libsimple);
      // 词典是可选的：不加载 jieba_dict 时 libsimple 仍能工作（退化为字符切分），
      // 但中文分词质量会明显下降，所以词典失败也要记录。
      if (paths.libsimpleDict && existsSync(paths.libsimpleDict)) {
        const dict = paths.libsimpleDict.replace(/'/g, "''");
        db.exec(`select jieba_dict('${dict}')`);
      } else if (paths.libsimpleDict) {
        failures['libsimple.dict'] = `词典目录不存在：${paths.libsimpleDict}`;
      }
      libsimple = true;
    } catch (err) {
      failures['libsimple'] = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- sqlite-vec（向量检索）----
  if (!paths.sqliteVec) {
    failures['sqlite-vec'] = '未配置路径';
  } else if (!existsSync(paths.sqliteVec)) {
    failures['sqlite-vec'] = `文件不存在：${paths.sqliteVec}`;
  } else {
    try {
      db.loadExtension(paths.sqliteVec);
      const row = db.prepare<{ v: string }>('select vec_version() as v').get();
      vecVersion = row?.v;
      sqliteVec = true;
    } catch (err) {
      failures['sqlite-vec'] = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    libsimple,
    sqliteVec,
    tokenizer: libsimple ? 'simple' : 'trigram',
    failures,
    vecVersion,
  };
}

/**
 * 把搜索层 DDL 里的 `tokenize = 'simple'` 换成实际可用的分词器。
 *
 * 之所以做字符串替换而不是维护两份 SQL：两份 SQL 会不可避免地漂移，
 * 而分词器是这两份之间**唯一**的差异。
 */
export function applyTokenizer(sql: string, tokenizer: TokenizerKind): string {
  if (tokenizer === 'simple') return sql;
  return sql.replace(/tokenize\s*=\s*'simple'/g, `tokenize = '${tokenizer}'`);
}

/**
 * `simple_query()` 只在 libsimple 可用时存在。降级时必须回退到朴素查询串，
 * 否则每次搜索都会 "no such function: simple_query"。
 */
export function buildMatchExpression(status: ExtensionStatus): (userTerm: string) => string {
  if (status.libsimple) return () => 'simple_query(?)';
  // trigram 模式下直接用参数占位，由调用方保证已做 FTS5 语法转义
  return () => '?';
}
