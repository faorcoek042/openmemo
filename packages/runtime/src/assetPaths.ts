/**
 * `media_assets.rel_path` → 绝对路径：**全项目唯一的一份解析规则**（T-136）。
 *
 * ─── 为什么这份规则必须只有一份 ────────────────────────────────────────────────────
 * `rel_path` 这一列**同时存在三种历史形态**，这不是设想，是用户库里实测到的：
 *
 * | 写入方 | 形态 | 例 |
 * |---|---|---|
 * | `jobs/runners/transcribe.ts`（T-095 起） | 相对 `<dataDir>/media` | `<noteUid>/audio16k.wav` |
 * | `storage/migrateAssets.ts` | 相对 `<dataDir>` | `media/legacy/job-…-audio16k.wav` |
 * | `ws/recorder.ts` | **绝对路径** | `<dataDir>/media/recordings/…wav` |
 *
 * 只要读取方各写各的基准，同一条记录就会得出不同结论 —— T-136 就是这么炸的：
 * 播放端把 `media/legacy/x.wav` 拼成 `<dataDir>/media/media/legacy/x.wav`（两个 media）
 * 于是 404，而自检拿同样的错基准算了一遍，报出 **"3 条文件已不存在"**——
 * 那 3 个文件当时好好地躺在盘上。**判错的不是文件在不在，是路径该从哪儿算起。**
 *
 * ─── 判据：**真的把它打开**，不是 `access()` ────────────────────────────────────────
 * 与 T-128 的 `.so` 检查同一条标准（见 `selfcheck.ts` 的 `checkBackendSymlinks`）：
 * `lstat` 不跟随符号链接、对悬空链接照样成功；`access` 跟随但只回答"能不能"，
 * **不产生可核对的证据**。这里 `open()` + 读**首 4 字节**：悬空 → ENOENT；
 * 0 字节 → `bytesRead === 0`（这种资产播不了，必须与"读到了"区分开）；
 * 读到了 → 把那 4 字节的十六进制原样返回，**报告里可以拿去核对**。
 */
import { open } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * 允许的根，**数组顺序即优先级**：媒体库 → 临时产物 → 数据目录本身。
 *
 * 三个都必须在内，因为上面那张表里的三种形态分别需要其中一个：
 * 少了 `<dataDir>` 这一档，`migrateAssets` 自己写出来的记录就没人认得。
 */
export function mediaAssetRoots(dataDir: string): string[] {
  const d = resolve(dataDir);
  return [join(d, 'media'), join(d, 'tmp'), d];
}

/**
 * 纯函数：把一条 `rel_path` 展开成**全部落在允许根内**的候选绝对路径。
 *
 * 返回空数组 = 这条记录指到了所有根之外（绝对路径指向别处，或用 `..` 穿越出去）。
 * 调用方据此报"越界"，**不要**把它和"文件不存在"混为一谈 —— 那是两种毛病。
 */
export function assetCandidates(roots: readonly string[], relOrAbs: string): string[] {
  if (relOrAbs.length === 0) return [];
  const rs = roots.map((r) => resolve(r));
  const raw = isAbsolute(relOrAbs) ? [resolve(relOrAbs)] : rs.map((r) => resolve(join(r, relOrAbs)));
  const inside = (p: string): boolean => rs.some((r) => p === r || p.startsWith(r + sep));
  const out: string[] = [];
  for (const p of raw) if (inside(p) && !out.includes(p)) out.push(p);
  return out;
}

export interface AssetProbe {
  /** 第一个**真的打开成功**的候选；一个都打不开时为 null。 */
  readonly abs: string | null;
  /** 依次试过的候选（都在允许根内）。空数组 = 记录指到了根外。 */
  readonly tried: readonly string[];
  /** 从 `abs` 读到的字节数（0…4）。`abs !== null && bytesRead === 0` = 空文件。 */
  readonly bytesRead: number;
  /** 读到时是首 4 字节的十六进制（可核对的证据）；读不到时是最后一次失败的 errno。 */
  readonly note: string;
}

/**
 * 按 `roots` 顺序找出**第一个真能打开**的候选。
 *
 * 注意是"第一个能打开的"，不是"第一个落在根内的" —— T-136 的播放 404 正是后者：
 * 候选①永远落在 `mediaRoot` 内，于是它总是赢，后面两个根**从来没有被试过一次**，
 * `extraRoots` 这个参数存在了很久却等同于死代码。
 */
export async function probeAssetFile(
  roots: readonly string[],
  relOrAbs: string,
): Promise<AssetProbe> {
  const tried = assetCandidates(roots, relOrAbs);
  let note = tried.length === 0 ? '路径不在任何允许的根内' : 'ENOENT';
  for (const abs of tried) {
    let fh;
    try {
      // open() 跟随符号链接 —— 悬空链接在这里就会抛，`lstat` 不会
      fh = await open(abs, 'r');
      const buf = Buffer.alloc(4);
      const { bytesRead } = await fh.read(buf, 0, 4, 0);
      return {
        abs,
        tried,
        bytesRead,
        note: bytesRead > 0 ? buf.subarray(0, bytesRead).toString('hex') : '0 字节',
      };
    } catch (err) {
      // EISDIR（候选恰好是个目录）也走这里 —— 目录不是资产，继续试下一个根
      note = (err as NodeJS.ErrnoException).code ?? String(err);
    } finally {
      await fh?.close().catch(() => {});
    }
  }
  return { abs: null, tried, bytesRead: 0, note };
}
