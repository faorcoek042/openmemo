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
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve, sep, win32 } from 'node:path';

/**
 * 「这个**已经解析过的绝对路径**落在允许的根内吗」——唯一那份判据。
 *
 * 词法剔除（`assetCandidates`）和**解析后**复核（`probeAssetFile`）必须用同一个谓词：
 * 两处各写一遍，就等于给自己留了一条"两边规则不一样"的缝。
 */
function insideAnyRoot(resolvedRoots: readonly string[], p: string): boolean {
  return resolvedRoots.some((r) => p === r || p.startsWith(r + sep));
}

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
  const out: string[] = [];
  for (const p of raw) if (insideAnyRoot(rs, p) && !out.includes(p)) out.push(p);
  return out;
}

/**
 * **写入侧**唯一那份「`rel_path` 该写成什么」——与上面的读取规则严格配对（T-151 ①）。
 *
 * ─── 为什么读取侧统一了还不够 ──────────────────────────────────────────────────
 * T-136 把**读**的规则收敛成了这一个文件（播放端 / 自检 / 迁移三方共用），
 * 但**写**的一侧当时原封没动：`transcribe.ts` 写相对 media 根、`migrateAssets.ts`
 * 写相对 `dataDir`、`ws/recorder.ts` 写**绝对路径**。
 * 读取侧的候选式解析很宽容，于是三种形态**碰巧**都读得回来 ——
 * 这正是它能活这么久的原因：**宽容的读取会把不一致的写入藏起来**。
 *
 * 绝对路径那一种藏不住的地方只有一个，而且它是这个字段存在的全部理由：
 * **数据目录一搬家，记录立刻失效**（D-02 §1.1「绝不存绝对路径」）。
 * 老路径不在新根的任何一个之内 ⇒ `assetCandidates` 返回**空数组** ⇒ 播放 404、
 * 自检报「读不出来」，而文件明明跟着搬过去了。`transcribe.ts` 的 `audio16k`
 * 曾经就是这个形态并真的炸过（见该文件 `archiveIntoMedia` 的注释），
 * T-095 修了它那一条，**录音这一条漏了**。
 *
 * 返回 `null` 而不是"兜底返回绝对路径"：兜底就等于把这个缺陷重新放进来一次，
 * 而且是静默的。调用方拿到 `null` 必须自己决定（归档进 media 根，或者报错），
 * **不许把绝对路径写进库**。
 *
 * ─── `platform` 是入参，不是 `process.platform` ────────────────────────────────
 * 与 `argGuard.isSafeExecutable` / `argGuard.assertWithinRoot` /
 * `rest/notes.ts` 的 `isWithinImportRoots` 同一形状（HANDOFF ⑤A-8）：
 * 宿主绑定的路径语义在本机 Linux 上**测不出来**，而这类 bug 恰恰只在别的平台显形
 * （`[CI 实测]` win32 上 `root + '/'` 前缀匹配永远不成立 → 本地导入 100% 403）。
 * 参数化之后 Linux 上就能把 win32 语义也测到。
 *
 * 判据用 `relative()` 而不是 `startsWith(root + sep)`：后者对
 * `/data-x` vs `/data` 这种「前缀相同但不是子路径」的形状会误判。
 */
export function canonicalAssetRelPath(
  dataDir: string,
  abs: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const p = platform === 'win32' ? win32 : posix;
  const d = p.resolve(dataDir);
  const target = p.resolve(abs);
  // 顺序即优先级，且必须与 `mediaAssetRoots` 的第一档一致：能相对 media 根就相对 media 根
  for (const root of [p.join(d, 'media'), d]) {
    const rel = p.relative(root, target);
    if (rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel)) return rel;
  }
  return null;
}

export interface AssetProbe {
  /** 第一个**真的打开成功**的候选；一个都打不开时为 null。 */
  readonly abs: string | null;
  /** 依次试过的候选（都在允许根内）。空数组 = 记录指到了根外。 */
  readonly tried: readonly string[];
  /**
   * 打开成功、但 `realpath` 之后**落到根外**因而被拒的候选（T-143 ①）。
   *
   * 非空 = 这条记录的路上有符号链接指向允许的根之外。调用方必须把它报成
   * **越界**（403），不许报成"文件不存在"（404）—— 文件明明在，只是不许从这里读。
   * 把两者混为一谈正是 ⑤A-20 那条规矩禁止的「替用户下一个假诊断」。
   */
  readonly escaped: readonly string[];
  /** 从 `abs` 读到的字节数（0…4）。`abs !== null && bytesRead === 0` = 空文件。 */
  readonly bytesRead: number;
  /** 读到时是首 4 字节的十六进制（可核对的证据）；读不到时是最后一次失败的 errno。 */
  readonly note: string;
}

/**
 * 按 `roots` 顺序找出**第一个真能打开、且解析之后仍在根内**的候选。
 *
 * 注意是"第一个能打开的"，不是"第一个落在根内的" —— T-136 的播放 404 正是后者：
 * 候选①永远落在 `mediaRoot` 内，于是它总是赢，后面两个根**从来没有被试过一次**，
 * `extraRoots` 这个参数存在了很久却等同于死代码。
 *
 * ─── ★ T-143 ①：**词法剔除挡不住符号链接** ──────────────────────────────────────
 * `assetCandidates` 是**纯字符串**运算：`resolve` 会把 `..` 按字面折叠掉，
 * 得出的结论是"这串字符落在根内"。而 `open()` 走的是**文件系统**，它**跟随符号链接**。
 * 两者对同一条路径可以给出完全相反的答案：
 *
 * ```
 * <mediaRoot>/escape.wav -> /etc/hostname     （根内的一条软链，指向根外）
 *   assetCandidates: "落在 mediaRoot 内" ✅   ← 字符串层面完全合法
 *   open():          打开的是 /etc/hostname   ← 实际读到的是根外的文件
 * ```
 *
 * 修复前 `probeAssetFile` 会返回 `abs = <mediaRoot>/escape.wav`，
 * 于是 `GET /media/asset/<ulid>` 把 `/etc/hostname` **以 200 原样流出去**。
 * `argGuard.assertWithinRoot` 从第一天起就是 realpath 的，这份规则漏了同一课。
 *
 * 所以打开成功之后**必须再校验一次**：`realpath` 把整条路上的每一跳都跟完
 * （不只是最后一段 —— 祖先目录是软链同样能逃逸），落到根外就拒掉、记进 `escaped`。
 *
 * **不会误杀正常的相对软链**：判据是"解析结果在不在根内"，不是"路上有没有软链"。
 * `libwhisper.so → .so.1 → .so.1.9.1` 这种同目录两级链解析后仍在根内，照样通过
 * （T-128 修好的那 8 条，见 `selfcheck.ts` 的 `checkBackendSymlinks`）。
 * 按类型一刀切地拒绝符号链接就会把产品自己的后端拆掉 —— `unpack.ts:170-183`
 * 为同一件事写过同样的结论。
 *
 * **⚠️ 根也必须 realpath，否则这条守卫会变成一场大误杀。**
 * 拿 `realpath(候选)` 去比**词法的**根，只要**数据目录自己**是经由软链访问的
 * （macOS 的 `os.tmpdir()` = `/var/…` → `/private/var/…`；`/home` → `/mnt/home` 这类布局
 * 也很常见），每一条资产的 realpath 都不会以词法根开头 —— **整个媒体库当场全 403**。
 * 所以两边都取 realpath 再比。这是加守卫时最容易自伤的一步，单独有用例钉住。
 *
 * **残留 TOCTOU（如实记下）**：realpath 与调用方随后的 `createReadStream(abs)`
 * 之间仍有一个窗口，能换掉软链的人可以钻。收窄它要把 fd 一路传给调用方，
 * 那是另一次改动；本函数与 `assertWithinRoot` 现在至少处在同一水位（D-06 §9 已记录该性质）。
 */
export async function probeAssetFile(
  roots: readonly string[],
  relOrAbs: string,
): Promise<AssetProbe> {
  const rs = await Promise.all(
    roots.map(async (r) => {
      const lex = resolve(r);
      // 根不存在时退回词法值 —— 不存在的根本来也不会有候选落进去
      return realpath(lex).catch(() => lex);
    }),
  );
  const tried = assetCandidates(roots, relOrAbs);
  const escaped: string[] = [];
  let note = tried.length === 0 ? '路径不在任何允许的根内' : 'ENOENT';
  for (const abs of tried) {
    let fh;
    try {
      // open() 跟随符号链接 —— 悬空链接在这里就会抛，`lstat` 不会
      fh = await open(abs, 'r');
      /*
       * ★ 解析之后再校验一次。realpath 跟完整条路（含祖先目录），
       * 所以 `<root>/link/x.wav`（link 是软链）与 `<root>/x.wav`（x.wav 自己是软链）
       * 两种形态都被同一句挡住。
       */
      const real = await realpath(abs);
      if (!insideAnyRoot(rs, real)) {
        escaped.push(abs);
        note = `符号链接指向根外：${abs} → ${real}`;
        continue;
      }
      const buf = Buffer.alloc(4);
      const { bytesRead } = await fh.read(buf, 0, 4, 0);
      return {
        abs,
        tried,
        escaped,
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
  return { abs: null, tried, escaped, bytesRead: 0, note };
}
