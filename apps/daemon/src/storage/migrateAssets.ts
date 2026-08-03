/**
 * `media_assets` 的路径迁移。
 *
 * ## 为什么这条是"数据丢失边缘"而不是"数据不一致"
 * `storage/move.ts` 把**文件**搬得很严谨（校验通过才删源、13 条失败路径都测过），
 * 但**搬完没有更新数据库里的引用** —— 文件到了新家，`media_assets.rel_path`
 * 还指着老家的绝对路径。实测用户库里 4 条有 3 条如此：
 * ```
 * /tmp/omdemo/jfk.wav                      ← 已不在那儿
 * /tmp/omdemo/tmp/job-…/audio16k.wav       ← 同上
 * /tmp/dd55/tmp/job-…/audio16k.wav         ← 那个测试目录早被清了
 * ```
 * 真实文件其实在新 dataDir 里。**但只要有人清一次 `/tmp`，而新目录里恰好没有副本，
 * 那条笔记的音频就真的没了** —— 而且不会有任何报错，用户点播放才发现。
 *
 * 所以迁移必须是「文件 + 记录」一起完成，不能只搬文件。
 *
 * ## ★ T-136：「相对但指错」曾经是这里的盲区
 * 旧规则第 1 条是「已是相对路径 → 不动」，并且整个函数在**没有绝对路径时直接 return**。
 * 于是一条相对路径**指错了地方**（记录写 `foo.wav`、文件其实在 `media/legacy/foo.wav`）
 * 会被当成"没问题"一路放行 —— **相对但指错比绝对路径更隐蔽**：
 * 前者一眼看上去就是"已经迁移过了"的样子。
 *
 * 所以判据改成**钉后果**：一条记录要不要迁移，取决于**按播放端那份规则能不能真的读到内容**
 * （`probeAssetFile`），而不是它长得像相对还是绝对。
 *
 * ## 规则（与安装记录迁移同一套，刻意保持一致）
 * 1. 读得到内容、且形式已经规范 → 不动
 * 2. 绝对路径 → 转成相对（相对 media 根，落不进就相对 dataDir）
 * 3. 读不到内容（绝对失效 **或 相对指错**）→ 在 dataDir 里按路径后缀找回来并重挂
 * 4. 找不到 / 候选不唯一 → **不删记录、不假装正常、不猜**，计入 unresolved 由调用方 warn
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import type { DatabaseHandle } from '@openmemo/db';
import { probeAssetFile } from '@openmemo/runtime';

export interface AssetMigrationResult {
  readonly scanned: number;
  readonly migrated: number;
  readonly unresolved: readonly string[];
  readonly notes: readonly string[];
}

interface AssetRowLite {
  id: number;
  role: string;
  rel_path: string;
}

/**
 * 递归收集 dataDir 下所有文件的**相对 dataDir 路径**集合。
 *
 * 用**路径后缀**匹配而不是文件名匹配 —— 这条很关键：
 * 两条不同笔记的归一化音频**都叫 `audio16k.wav`**，只有它们所在的
 * `tmp/job-<jobId>/` 目录能区分。按文件名匹配会把两行指到同一个文件，
 * 结果是**一条笔记的音频被挂到另一条笔记上**，而且撞 UNIQUE 约束才暴露 ——
 * 这比不迁移更糟。实测就是这样炸出来的。
 */
async function indexFiles(dataDir: string, mediaRoot: string): Promise<Set<string>> {
  const all = new Set<string>();
  const skip = new Set(['models', 'logs', 'runtime', 'backups']); // 这些下面不会有媒体资产
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (dir === dataDir && skip.has(e.name)) continue;
        await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        all.add(relative(dataDir, join(dir, e.name)));
      }
    }
  };
  void mediaRoot;
  await walk(dataDir, 0);
  return all;
}

/**
 * 用**最长后缀**把一个失效的绝对路径映射回新 dataDir 里的真实文件。
 *
 * `/tmp/dd55/tmp/job-XXX/audio16k.wav` → 后缀 `tmp/job-XXX/audio16k.wav`
 * 在新目录里存在 → 命中。逐段缩短、长的优先，因此永远取**最具体**的那个匹配。
 */
function matchBySuffix(abs: string, all: ReadonlySet<string>): string | undefined {
  const parts = abs.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const cand = parts.slice(i).join('/');
    if (all.has(cand)) return cand;
  }
  return undefined;
}

/**
 * 反过来的那一半（T-136）：记录**少了前缀**时，去索引里找以它结尾的那个文件。
 *
 * `matchBySuffix` 只会把记录**削短**（`/old/x/a.wav` → `a.wav`），
 * 所以它救不了 `foo.wav` 而文件在 `media/legacy/foo.wav` 这种"相对但指错"。
 *
 * **命中必须唯一**：`audio16k.wav` 在库里会有很多份，猜错的后果是
 * 把一条笔记的音频挂到另一条笔记上 —— 比不迁移糟得多（那次事故见文件头）。
 */
function matchByTail(rel: string, all: ReadonlySet<string>): string | undefined {
  const needle = rel.split(sep).join('/');
  const hits = [...all].filter((e) => {
    const u = e.split(sep).join('/');
    return u === needle || u.endsWith('/' + needle);
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * 迁移全部 `media_assets`。**幂等**：第二遍不会再改任何行。
 *
 * 整批一个事务：要么全部更新，要么一行都不动。
 * 半更新会留下"一部分指新、一部分指旧"，比全指旧更难排查。
 */
export async function migrateMediaAssets(
  db: DatabaseHandle,
  dataDir: string,
  mediaRoot: string,
): Promise<AssetMigrationResult> {
  let rows: AssetRowLite[];
  try {
    rows = db.prepare<AssetRowLite>(`SELECT id, role, rel_path FROM media_assets`).all();
  } catch {
    return { scanned: 0, migrated: 0, unresolved: [], notes: [] };
  }
  /*
   * ★ T-136：先按**播放端那份规则**把每条探一遍，判据是「真的读到了内容吗」。
   * 只看 `isAbsolute` 的旧写法会漏掉「相对但指错」，而那种记录长得就像已经迁好了。
   */
  const roots = [mediaRoot, join(dataDir, 'tmp'), dataDir];
  const resolved = new Map<number, string | null>();
  for (const r of rows) resolved.set(r.id, (await probeAssetFile(roots, r.rel_path)).abs);

  const stale = rows.filter((r) => isAbsolute(r.rel_path) || resolved.get(r.id) == null);
  if (stale.length === 0) return { scanned: rows.length, migrated: 0, unresolved: [], notes: [] };

  const all = await indexFiles(dataDir, mediaRoot);

  /**
   * 规范形态：**能相对 media 根就相对 media 根**，否则相对 dataDir。
   *
   * 这一条是 T-136 的直接教训：旧迁移把归档结果写成 `media/legacy/…`（相对 dataDir），
   * 而写入侧（`transcribe.ts`）写的是相对 media 根 —— 同一列两种约定，
   * 读取方只要挑错基准就会把好文件报成"已删除"。**统一由这里产出唯一一种形态。**
   */
  const canonicalRel = (abs: string): string =>
    abs.startsWith(mediaRoot + sep) ? relative(mediaRoot, abs) : relative(dataDir, abs);

  /*
   * 已被占用的 rel_path —— 迁移**绝不能把两行指到同一个文件**。
   * `media_assets.rel_path` 上有 UNIQUE 约束，撞了整批回滚（这是对的），
   * 但更重要的是语义：那意味着把一条笔记的音频挂到另一条笔记上。
   * 不动的那些行按**规范形态**也登记一份，否则 `media/legacy/x` 与 `legacy/x`
   * 会被当成两个不同的名字，而它们其实是同一个文件。
   */
  const taken = new Set<string>();
  for (const r of rows) {
    if (stale.includes(r)) continue;
    taken.add(r.rel_path);
    const abs = resolved.get(r.id);
    if (abs != null) taken.add(canonicalRel(abs));
  }
  const notes: string[] = [];
  const unresolved: string[] = [];
  const updates: Array<{ id: number; rel: string }> = [];

  const claim = (id: number, role: string, rel: string, why: string): boolean => {
    if (taken.has(rel)) {
      // **宁可不迁，也不把两条挂到同一个文件** —— 那是把一条笔记的音频挂到另一条上
      unresolved.push(`#${id} ${role}: 目标 ${rel} 已被其它资产占用，不做猜测`);
      return false;
    }
    taken.add(rel);
    updates.push({ id, rel });
    notes.push(`#${id} ${role}: ${why} → ${rel}`);
    return true;
  };

  for (const r of stale) {
    const abs = r.rel_path;
    const hitAbs = resolved.get(r.id);

    // ② 读得到内容（走到这儿说明它是绝对路径）→ 只需把形态转规范
    if (hitAbs != null) {
      const rel = canonicalRel(hitAbs);
      if (rel !== r.rel_path) claim(r.id, r.role, rel, `绝对路径转为相对路径`);
      continue;
    }

    /*
     * ③ 读不到内容 → 在 dataDir 里找回来。两个方向都要试：
     *   - `matchBySuffix`：记录**多了前缀**（失效的绝对路径就是这种）
     *   - `matchByTail`  ：记录**少了前缀**（T-136 的"相对但指错"：记录 `foo.wav`，
     *                      文件其实在 `media/legacy/foo.wav`）——**命中必须唯一**
     */
    const hit = matchBySuffix(abs, all) ?? (isAbsolute(abs) ? undefined : matchByTail(abs, all));
    if (hit !== undefined) {
      const rel = canonicalRel(join(dataDir, hit));
      if (rel === r.rel_path) {
        // 已经是规范形态却读不到（索引与探测打架）—— 不假装迁移过
        unresolved.push(`#${r.id} ${r.role}: 记录 ${abs} 已是规范形态但读不到内容`);
      } else {
        claim(r.id, r.role, rel, `原路径读不到（${abs}）`);
      }
      continue;
    }

    // ④ 找不到文件。绝对路径至少把**形态**规范掉（搬家后仍有机会再匹配上），
    //    但必须如实说"文件仍然读不到"，不许因为改了个形状就算迁移成功。
    if (abs.startsWith(mediaRoot + sep) || abs.startsWith(dataDir + sep)) {
      claim(r.id, r.role, canonicalRel(abs), `绝对路径转为相对路径（文件仍读不到）`);
      unresolved.push(`#${r.id} ${r.role}: ${abs} 指向的文件不存在，只规范了路径形态`);
      continue;
    }
    unresolved.push(`#${r.id} ${r.role}: 记录指向 ${abs}，新数据目录里找不到能对上的文件`);
  }

  /*
   * ★ 把落在 `tmp/` 里的已入库资产**搬进 `media/`**。
   *
   * 设置页把 `tmp` 描述成「可随时删」，而这些是**已入库的资产** ——
   * 不搬走，那句话就是假的，用户照着删一次就丢音频。
   * （协调者今天真的清过一次 /tmp，只是恰好新目录里有副本才没出事。）
   * T-095 已让新产物直接归档到 media/，这里补的是**历史遗留的那几条**。
   */
  for (const u of updates) {
    if (!u.rel.startsWith(`tmp${sep}`) && !u.rel.startsWith('tmp/')) continue;
    const from = join(dataDir, u.rel);
    // 归档结果同样写成**规范形态**（相对 media 根）：写成 `media/legacy/…` 正是 T-136 的病根
    const destRel = join('legacy', basename(dirname(from)) + '-' + basename(from));
    const to = join(mediaRoot, destRel);
    try {
      await fs.mkdir(dirname(to), { recursive: true });
      await fs.rename(from, to);
      notes.push(`#${u.id}: 已从 tmp/ 归档到 ${destRel}（tmp 被标为"可随时删"）`);
      u.rel = destRel;
    } catch (err) {
      // 搬不动就保持指向 tmp —— 记录仍然是对的，只是那份文件仍有被清理的风险
      notes.push(`#${u.id}: 从 tmp/ 归档失败（${String(err)}），记录仍指向 tmp`);
    }
  }

  if (updates.length > 0) {
    db.transaction(() => {
      const stmt = db.prepare(`UPDATE media_assets SET rel_path = :rel WHERE id = :id`);
      for (const u of updates) stmt.run({ rel: u.rel, id: u.id });
    });
  }

  return { scanned: rows.length, migrated: updates.length, unresolved, notes };
}
