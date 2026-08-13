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
 * 2. 路径已失效但**当前库里有同一条库内路径** → 重新指向它（数据目录搬过家就是这种）
 *    ⚠️ 判据是"整条库内路径是后缀"，**不是 basename 相等** —— 见 `remapsOnto()`，
 *    那里记着一次真实的"守卫被自家迁移绕过"。
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
 * 一条失效的绝对路径 `stale`，可以被重新指向当前库里的 `candidate`（相对 models 根）吗？
 *
 * ## ★★ T-107 ③：判据从 **basename 相等** 收紧成 **整条库内路径是后缀**
 *
 * ── 上一版为什么是个洞 ───────────────────────────────────────────────────────────
 *
 * 上一版是 `basename(candidate) === basename(stale)`。**basename 匹配极其松** ——
 * 它可以把**任意**一条记录重新指到一个只是重名的文件上。下一个人需要知道这件事，
 * 所以写在这里：库里只要有一个同名文件，这条判据就成立，**不管那个文件是谁的、
 * 也不管原路径本来指向哪儿**。
 *
 * `[隔离实例实测]` 真出过事：随应用出厂的记录（`source: 'bundled'`，
 * `path = <安装目录>/runtime/probe/ffmpeg`）在用户**同时也下载装了** media-tools 时，
 * 被这条迁移**悄悄改成**指向 `by-name/backend/media-tools-linux-x64/ffmpeg`：
 *
 * ```
 * note: media-tools-linux-x64.json: ffmpeg 原路径已失效（…/app/runtime/probe/ffmpeg），
 *       重新指向 by-name/backend/media-tools-linux-x64/ffmpeg
 * source=bundled  files[0]={"root":"models","relPath":"by-name/backend/media-tools-…/ffmpeg"}
 * ```
 *
 * 后果不是"多迁了一条"，是 **一道守卫被自家另一段代码绕过去了**：任何把"不许删随包
 * 出厂那份"的判据从 `source` 改写成"路径在不在库内"的修法，都会被这条迁移**在启动时
 * 悄悄满足掉**。一道能被绕开的守卫比没有守卫更坏——它看起来像还有人在守。
 *
 * ── 收紧成什么 ─────────────────────────────────────────────────────────────────
 *
 * 只有当 `stale` **以 `candidate` 整条相对路径结尾**（按路径段比，不是按字符串比）
 * 时才重指。语义是：「这条记录原先指向的就是**一个和我们同构的库**，只是根不同」——
 * 那正是"数据目录搬过家"的定义，也**只**覆盖那一种。
 *
 *   · `/tmp/cold4/models/by-name/asr/x.bin`  vs  `by-name/asr/x.bin`  → ✅ 搬家，重指
 *   · `<安装目录>/runtime/probe/ffmpeg`      vs  `by-name/backend/…/ffmpeg` → ❌ 不是同一个库
 *
 * 不匹配时**不删记录、不假装正常**，落进 `unresolved` 由调用方打印 —— 与第 ③ 档一致。
 */
function remapsOnto(stale: string, candidate: string): boolean {
  const seg = (p: string): string[] => p.split(/[\\/]/).filter((s) => s.length > 0);
  const want = seg(candidate);
  const have = seg(stale);
  if (want.length === 0 || have.length < want.length) return false;
  const tail = have.slice(have.length - want.length);
  return tail.every((s, i) => s === want[i]);
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
    // ② 路径失效（例如数据目录搬过家）→ 在当前库里找回来
    const hit = [...existing].find((r) => remapsOnto(abs, r));
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
