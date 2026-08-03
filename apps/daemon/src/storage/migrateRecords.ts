/**
 * 安装记录的**格式迁移**（不是读时兼容）。
 *
 * ## 为什么必须迁移，而不是继续"读时兼容"
 * T-053 把 `InstalledFile` 改成 `root`+`relPath`，T-097 把 `installPath` 拆成
 * `linkInto`/`unpackInto` —— 两次都是 forward-only：**新写的是新格式，已经在库里的旧记录没人动。**
 * 我当初在 `modelStore` 里留的是**读时兼容分支**，它让旧数据永远是旧的：
 * 下次再改格式就要同时兼容两代，再下次三代，而且**每一代的兼容分支都没有测试覆盖真实旧数据**。
 *
 * 实测这台机器上的后果：4 条记录全是绝对路径，其中 2 条指向 `/tmp/cold4/...` ——
 * **那个目录早就不存在了**，而文件其实好好地在当前 models 根下。
 * 也就是说记录说"装在这儿"，那儿什么都没有；能用只是因为兜底扫描恰好找得到。
 *
 * ## 迁移做三件事（都幂等）
 * 1. 绝对路径 → `root:'models'` + `relPath`（相对当前 models 根）
 * 2. 路径已失效但**同名文件在当前库里** → 重新指向它（数据目录搬过家就是这种）
 * 3. 删掉残留的 `installPath`（T-097 已拆成 linkInto/unpackInto）
 *
 * 找不到对应文件时**不删记录、也不假装正常**：保留原样并计入 `unresolved`，
 * 由调用方打印出来。悄悄删掉用户的安装记录，比留着一条坏记录更糟。
 */
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

export interface RecordFile {
  role?: string;
  name?: string;
  root?: string;
  relPath?: string;
  path?: string;
  [k: string]: unknown;
}
export interface InstallRecordShape {
  id?: string;
  role?: string;
  installPath?: unknown;
  files?: RecordFile[];
  [k: string]: unknown;
}

export interface MigrationOutcome {
  readonly changed: boolean;
  readonly record: InstallRecordShape;
  /** 无法解析到真实文件的条目（记录保持原样）。 */
  readonly unresolved: readonly string[];
  readonly notes: readonly string[];
}

/** 路径是否落在 root 之内（用 relative，避免 `/a` 与 `/a-backup` 的前缀误判）。 */
function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 迁移**一条**记录。纯逻辑 + 一次目录查找，便于测试。
 *
 * @param existing 当前 models 根下已有文件的**相对路径集合**，用于把失效的绝对路径重新归位。
 */
export function migrateRecord(
  rec: InstallRecordShape,
  modelsDir: string,
  existing: ReadonlySet<string>,
): MigrationOutcome {
  const notes: string[] = [];
  const unresolved: string[] = [];
  let changed = false;

  const next: InstallRecordShape = { ...rec };

  if ('installPath' in next) {
    // T-097 已拆成 linkInto / unpackInto，这个字段留着只会让人以为它还起作用
    delete next.installPath;
    changed = true;
    notes.push('移除残留 installPath');
  }

  const files = (rec.files ?? []).map((f): RecordFile => {
    if (f.relPath) return f; // 已是新格式
    const abs = f.path;
    if (!abs) {
      unresolved.push(f.name ?? '(无名)');
      return f;
    }
    // ① 绝对路径就在当前 models 根内 → 直接转相对
    if (inside(modelsDir, abs)) {
      changed = true;
      const rel = relative(modelsDir, abs);
      notes.push(`${basename(abs)} → 相对路径 ${rel}`);
      const { path: _drop, ...rest } = f;
      return { ...rest, root: 'models', relPath: rel };
    }
    // ② 路径失效（例如数据目录搬过家）→ 按文件名在当前库里找回来
    const hit = [...existing].find((r) => basename(r) === basename(abs));
    if (hit) {
      changed = true;
      notes.push(`${basename(abs)} 原路径已失效（${abs}），重新指向 ${hit}`);
      const { path: _drop, ...rest } = f;
      return { ...rest, root: 'models', relPath: hit };
    }
    // ③ 找不到 → 保留原样并如实报告，不删记录也不假装正常
    unresolved.push(`${f.name ?? basename(abs)}（记录指向 ${abs}，当前库中找不到同名文件）`);
    return f;
  });

  next.files = files;
  return { changed, record: next, unresolved, notes };
}

/** 列出 `by-name/**` 下所有文件的相对路径（相对 models 根）。 */
export async function listExistingRelPaths(modelsDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.add(relative(modelsDir, p));
    }
  };
  await walk(join(modelsDir, 'by-name'));
  return out;
}

export interface MigrateAllResult {
  readonly scanned: number;
  readonly migrated: number;
  readonly unresolved: readonly string[];
  readonly notes: readonly string[];
}

/**
 * 迁移 `manifests/**` 下全部记录。**幂等**：跑第二遍不会再改任何东西。
 *
 * 写入用 temp+rename：中途崩溃不会留下半个 JSON
 * （一个截断的 manifest 会让那个模型彻底读不出来）。
 */
export async function migrateInstallRecords(modelsDir: string): Promise<MigrateAllResult> {
  const existing = await listExistingRelPaths(modelsDir);
  const manifestRoot = join(modelsDir, 'manifests');
  const notes: string[] = [];
  const unresolved: string[] = [];
  let scanned = 0;
  let migrated = 0;

  let buckets: string[];
  try {
    buckets = (await fs.readdir(manifestRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { scanned: 0, migrated: 0, unresolved: [], notes: [] };
  }

  for (const b of buckets) {
    const dir = join(manifestRoot, b);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const file = join(dir, n);
      let rec: InstallRecordShape;
      try {
        rec = JSON.parse(await fs.readFile(file, 'utf8')) as InstallRecordShape;
      } catch {
        unresolved.push(`${b}${sep}${n}（不是合法 JSON，未改动）`);
        continue;
      }
      scanned += 1;
      const r = migrateRecord(rec, modelsDir, existing);
      unresolved.push(...r.unresolved.map((u) => `${b}/${n}: ${u}`));
      if (!r.changed) continue;
      const tmp = `${file}.tmp-${Date.now().toString(36)}`;
      await fs.writeFile(tmp, JSON.stringify(r.record, null, 2));
      await fs.rename(tmp, file);
      migrated += 1;
      notes.push(...r.notes.map((x) => `${b}/${n}: ${x}`));
    }
  }
  return { scanned, migrated, unresolved, notes };
}
