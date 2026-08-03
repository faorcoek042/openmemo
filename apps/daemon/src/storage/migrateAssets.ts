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
 * ## 规则（与安装记录迁移同一套，刻意保持一致）
 * 1. 已是相对路径 → 不动
 * 2. 绝对路径且在 dataDir 内 → 转成相对（相对 media 根，落不进就相对 dataDir）
 * 3. 绝对路径已失效 → **在新 dataDir 里按文件名找回来**并重挂
 * 4. 找不到 → **不删记录、不假装正常**，计入 unresolved 由调用方 warn
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import type { DatabaseHandle } from '@openmemo/db';

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
  const stale = rows.filter((r) => isAbsolute(r.rel_path));
  if (stale.length === 0) return { scanned: rows.length, migrated: 0, unresolved: [], notes: [] };

  const all = await indexFiles(dataDir, mediaRoot);
  /*
   * 已被占用的 rel_path —— 迁移**绝不能把两行指到同一个文件**。
   * `media_assets.rel_path` 上有 UNIQUE 约束，撞了整批回滚（这是对的），
   * 但更重要的是语义：那意味着把一条笔记的音频挂到另一条笔记上。
   */
  const taken = new Set(rows.filter((r) => !isAbsolute(r.rel_path)).map((r) => r.rel_path));
  const notes: string[] = [];
  const unresolved: string[] = [];
  const updates: Array<{ id: number; rel: string }> = [];

  for (const r of stale) {
    const abs = r.rel_path;
    // ② 绝对路径仍在 dataDir 内 → 直接转相对
    if (abs.startsWith(mediaRoot)) {
      taken.add(relative(mediaRoot, abs));
      updates.push({ id: r.id, rel: relative(mediaRoot, abs) });
      notes.push(`#${r.id} ${r.role}: 转为相对路径 ${relative(mediaRoot, abs)}`);
      continue;
    }
    if (abs.startsWith(dataDir)) {
      taken.add(relative(dataDir, abs));
      updates.push({ id: r.id, rel: relative(dataDir, abs) });
      notes.push(`#${r.id} ${r.role}: 转为相对路径 ${relative(dataDir, abs)}`);
      continue;
    }
    // ③ 路径已失效 → 按**最长后缀**在新 dataDir 里找回来
    const hit = matchBySuffix(abs, all);
    if (hit && !taken.has(hit)) {
      taken.add(hit);
      updates.push({ id: r.id, rel: hit });
      notes.push(`#${r.id} ${r.role}: 原路径已失效（${abs}），重新挂到 ${hit}`);
      continue;
    }
    if (hit) {
      // 后缀命中但那个文件已经被别的资产占了 → **宁可不迁，也不把两条挂到同一个文件**
      unresolved.push(`#${r.id} ${r.role}: 唯一候选 ${hit} 已被其它资产占用，不做猜测`);
      continue;
    }
    // ④ 找不到 —— 不动它，如实报告
    unresolved.push(`#${r.id} ${r.role}: 记录指向 ${abs}，新数据目录里找不到同名文件`);
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
    const destRel = join('media', 'legacy', basename(dirname(from)) + '-' + basename(from));
    const to = join(dataDir, destRel);
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
