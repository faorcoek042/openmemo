/**
 * 数据目录的移动（用户点名的「移动」能力）。
 *
 * ## 为什么这个文件写得这么小心
 * 搬的是**用户全部的笔记与转写结果**，而且**出错时没有任何信号** ——
 * 用户不会去数文件，他只会在三个月后发现某条笔记不见了。
 * 所以这里的标准跟「标题覆盖」那次一样：**逻辑抽成可测函数 + 回归测试**，
 * 而不是写一串 fs 调用然后靠"跑一次看起来没事"。
 *
 * ## 硬要求（逐条对应实现）
 * 1. **原子性**：同盘走 `rename`（内核级原子）；跨盘退化成 复制→校验→删源，
 *    **校验通过之前一个字节都不删**。任何一步失败都回滚，绝不留下"两边各一半"。
 * 2. **跨设备**：`rename` 跨文件系统会抛 `EXDEV`，必须接住并走复制路径 ——
 *    这是最容易漏的一条，本机测不出来（同一个 /tmp），所以用 `forceCopy` 显式覆盖测。
 * 3. **空间预检**：目标盘装不下就提前拒绝。搬到一半没空间是最糟的失败方式。
 * 4. **不许自套娃**：把 `/a` 搬进 `/a/sub` 会无限递归复制，必须在计划阶段就否掉。
 * 5. **符号链接必须原样搬过去，并且必须被校验**（T-128，这条是用真实事故换来的）。
 *
 * ## 关于第 5 条：一次真实发生过的静默损坏
 * 用户把数据目录搬到新位置后，whisper 后端**完全无法加载** —— 8 条 `.so` 符号链接
 * 全部指向搬迁前的旧位置，旧位置被清理后链接就全断了。而**自检报告一切正常**。
 *
 * 两个独立的缺陷叠在一起才有这个后果，缺一不可：
 *   - `fs.cp` **默认会把相对符号链接改写成指向【源目录】的绝对路径**
 *     （`libwhisper.so -> libwhisper.so.1` 变成 `libwhisper.so -> /旧路径/libwhisper.so.1`），
 *     紧接着本函数就把源目录删了 → 链接当场全部悬空。修法是 `verbatimSymlinks: true`。
 *   - `measureTree()` / `verifyTreesMatch()` 当时**显式跳过符号链接**，
 *     所以"两棵树一致"这句话根本没有覆盖到被破坏的那部分 → **绿灯是假的**。
 *
 * 后一个比前一个严重：前者是坏了，后者是**坏了还告诉你没坏**。
 * 因此本文件的规则是：**跳过 = 撒谎**。符号链接要么被校验，要么就别声称两棵树一致。
 */
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface MovePlan {
  readonly ok: boolean;
  readonly reason?: string;
  readonly reasonZh?: string;
  readonly from: string;
  readonly to: string;
}

/**
 * 计划阶段的**纯字符串校验**（不碰磁盘，因此可以穷举测试）。
 *
 * 单独抽出来的理由：这几条判断错了都是灾难级的，而它们全都只依赖路径字符串 ——
 * 没有理由让它们只能靠"真搬一次"来验证。
 */
export function planMove(fromRaw: string, toRaw: string): MovePlan {
  const from = resolve(fromRaw);
  const to = resolve(toRaw);
  const base = { from, to };

  if (from === to) {
    return {
      ...base,
      ok: false,
      reason: 'source and target are the same',
      reasonZh: '新位置与当前位置相同',
    };
  }
  // 目标在源**内部** → 复制会把自己不断 copy 进自己，必须否掉
  if (isInside(from, to)) {
    return {
      ...base,
      ok: false,
      reason: 'target is inside source',
      reasonZh: '新位置在当前数据目录内部，会导致无限递归',
    };
  }
  // 源在目标内部 → 搬完源就成了目标的子目录，语义混乱，同样否掉
  if (isInside(to, from)) {
    return {
      ...base,
      ok: false,
      reason: 'source is inside target',
      reasonZh: '当前数据目录在新位置内部，不支持这种嵌套',
    };
  }
  return { ...base, ok: true };
}

/**
 * `child` 是否在 `parent` 之内（真子路径，不含相等）。
 *
 * 用 `relative()` 而不是字符串前缀比较：`/data` 与 `/data-backup` 前缀相同但毫无关系，
 * 前缀比较会把后者误判成子目录并直接拒掉一次完全合法的移动。
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface TreeSize {
  readonly bytes: number;
  readonly files: number;
  /**
   * 符号链接数量，**单独计数**。
   *
   * 为什么不并进 `files`：这两种东西的失败方式完全不同 —— 文件搬错了是字节数对不上，
   * 链接搬错了是字节数**完全正确而功能全废**（见文件头 T-128）。合并计数会让
   * "N 个文件都在"这句话继续掩盖链接的问题。
   *
   * 为什么不能像原来那样干脆不计：`whisper.cpp` 后端目录里就有 8 条（`libwhisper.so`
   * → `.so.1` → `.so.1.9.1` 这种两级链），不计 = 搬迁校验根本没看这部分。
   */
  readonly links: number;
}

/**
 * 递归统计目录占用（字节）、普通文件数与符号链接数。用于空间预检和搬完后的校验。
 *
 * **不跟随符号链接**（`readdir` 的 dirent 是 lstat 语义）：跟随会把链接目标重复计一遍，
 * 指向父目录的链接还会直接死循环。链接自身按 `lstat().size`（= 目标字符串长度）计入 ——
 * 几乎不占空间，但**不是 0，也不是"不存在"**。
 */
export async function measureTree(dir: string): Promise<TreeSize> {
  let bytes = 0;
  let files = 0;
  let links = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      // 顺序要紧：符号链接必须在 isFile()/isDirectory() 之前判。
      // 指向目录的链接 isDirectory() 为 false，若把它当普通条目忽略就又回到老问题。
      if (e.isSymbolicLink()) {
        links += 1;
        bytes += (await fs.lstat(p)).size;
      } else if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile()) {
        const st = await fs.stat(p);
        bytes += st.size;
        files += 1;
      }
      // 其余（fifo/socket/设备节点）不计：数据目录里不该有，且它们没有可搬迁的语义
    }
  };
  await walk(dir);
  return { bytes, files, links };
}

/** 目标所在盘的可用字节数。拿不到就返回 undefined（**不猜、也不假装够**）。 */
export async function freeSpaceAt(dir: string): Promise<number | undefined> {
  try {
    const st = await fs.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return undefined;
  }
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

/**
 * 目录树里的一个条目。**符号链接不是"内容为空的文件"，而是一种独立的东西** ——
 * 它的全部内容就是那串目标路径，所以它的"字节数"毫无意义，要比的是 `readlink` 的结果。
 */
type TreeEntry =
  | { readonly kind: 'file'; readonly size: number }
  | { readonly kind: 'link'; readonly target: string }
  | { readonly kind: 'other' };

function kindZh(e: TreeEntry): string {
  return e.kind === 'file' ? '普通文件' : e.kind === 'link' ? '符号链接' : '其它类型';
}

/** 列出一棵树的全部条目（相对路径 → 条目）。**不跟随符号链接**，理由同 `measureTree`。 */
async function listTree(root: string): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      const rel = relative(root, p);
      if (e.isSymbolicLink()) out.set(rel, { kind: 'link', target: await fs.readlink(p) });
      else if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.set(rel, { kind: 'file', size: (await fs.stat(p)).size });
      else out.set(rel, { kind: 'other' });
    }
  };
  await walk(root);
  return out;
}

/**
 * 校验两棵树一致（相对路径集合 + 普通文件字节数 + **符号链接的目标**）。
 *
 * **这是"敢不敢删源"的唯一依据**。只比总字节数是不够的：
 * 少一个文件、多一个文件、某个文件被截断，总数都可能碰巧对得上。
 *
 * 符号链接**必须比 `readlink` 的结果本身，而不能跟随它去比内容**：
 * 跟随的话，被 `fs.cp` 改写成"指向源目录的绝对路径"的链接在删源之前**照样读得通**，
 * 校验会顺利通过，然后源目录一删链接就全断 —— 这正是 T-128 事故的形状。
 * 比目标字符串则当场报「链接目标不一致」。
 */
export async function verifyTreesMatch(a: string, b: string): Promise<VerifyResult> {
  const [ma, mb] = await Promise.all([listTree(a), listTree(b)]);
  const mismatches: string[] = [];
  for (const [k, v] of ma) {
    const other = mb.get(k);
    if (other === undefined) {
      mismatches.push(`缺失: ${k}`);
    } else if (other.kind !== v.kind) {
      // 例如 dereference 打开后链接被复制成了真文件：字节数甚至可能"更对"，但语义已经变了
      mismatches.push(`类型不一致: ${k} (${kindZh(v)} → ${kindZh(other)})`);
    } else if (v.kind === 'file' && other.kind === 'file' && v.size !== other.size) {
      mismatches.push(`大小不一致: ${k} (${v.size} → ${other.size})`);
    } else if (v.kind === 'link' && other.kind === 'link' && v.target !== other.target) {
      mismatches.push(`链接目标不一致: ${k} (${v.target} → ${other.target})`);
    }
  }
  for (const k of mb.keys()) if (!ma.has(k)) mismatches.push(`多出: ${k}`);
  return { ok: mismatches.length === 0, mismatches };
}

export interface StaleLink {
  /** 相对新数据目录的路径 */
  readonly rel: string;
  /** `readlink` 的原样结果 */
  readonly target: string;
  /** 解析成的绝对路径（落在旧数据目录里，所以它已经断了） */
  readonly resolved: string;
}

/**
 * 找出 `root` 里**解析后落在 `oldRoot` 之内**的符号链接。
 *
 * 为什么单独要这一条（`verifyTreesMatch` 不够）：
 * 两棵树"完全一致"和"链接还能用"是**两个不同的命题**。
 * 如果用户的数据目录里本来就有一条**绝对路径**链接指向它自己
 * （`/旧位置/a/libx.so → /旧位置/a/libx.so.1`），那么原样搬过去之后两棵树逐字相同、
 * 校验必然通过，**而链接照样是断的** —— 因为旧位置马上要被删掉。
 * `verbatimSymlinks` 修不了这种情况（原样保留正是它的职责）。
 *
 * 所以这里查的是**后果**而不是形式：搬完之后还有没有东西指着一个即将消失的地方。
 * 这条检查对 `rename` 快路径同样有效 —— 而快路径根本不会调用 `verifyTreesMatch`。
 */
export async function findStaleLinks(root: string, oldRoot: string): Promise<readonly StaleLink[]> {
  const old = resolve(oldRoot);
  const out: StaleLink[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        const target = await fs.readlink(p);
        const resolved = isAbsolute(target) ? resolve(target) : resolve(dirname(p), target);
        if (resolved === old || isInside(old, resolved)) {
          out.push({ rel: relative(root, p), target, resolved });
        }
      } else if (e.isDirectory()) {
        await walk(p);
      }
    }
  };
  await walk(root).catch(() => {});
  return out;
}

/**
 * 这个目录**是不是一个 OpenMemo 数据目录**。
 *
 * 用途：区分"目标非空"的两种完全不同的情况 ——
 * 一种是**用户上次已经迁移成功了**（目录里就是他自己的数据，再搬一次毫无意义，
 * 应该提供「直接使用此目录」）；另一种是**里面装着别人的东西**（必须拒绝，保护它）。
 * 原来两种都一律硬拒 409，于是迁移成功过的用户再点一次就被卡死，
 * 而报错文案还说"原数据完好" —— 他根本不知道数据其实已经在那边了。
 *
 * 判据取**主库文件**：`openmemo.db` 是这个应用独有且必然存在的产物。
 * 只看目录名或只看"非空"都会误判。
 */
export async function looksLikeDataDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(join(dir, 'openmemo.db'));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export interface MoveOptions {
  /** 强制走复制路径（用于测试跨设备分支，本机同盘时 rename 会成功而测不到）。 */
  readonly forceCopy?: boolean;
  /** 空间预检的安全余量倍数，默认 1.05（留 5%）。 */
  readonly headroom?: number;
  readonly onStep?: (step: string) => void;
}

export interface MoveResult {
  readonly ok: boolean;
  readonly strategy: 'rename' | 'copy' | 'none';
  readonly bytes: number;
  readonly files: number;
  /** 搬过去的符号链接数量（`files` 只数普通文件）。 */
  readonly links: number;
  readonly error?: string;
  readonly errorZh?: string;
  /**
   * 移动成功了，但这些符号链接仍指向**旧位置**，因而已经失效。
   *
   * 不作为失败处理：数据确实全部搬到位了，回滚只会让用户更糟。
   * 但**必须报出来** —— 这正是 T-128 里"绿灯背后功能已经坏了"的那一格。
   */
  readonly staleLinks: readonly StaleLink[];
  /** 非致命但用户需要知道的情况（目前只有 `staleLinks`）。 */
  readonly warningZh?: string;
  /** 失败后源目录是否完好无损。**任何失败路径上它都必须是 true。** */
  readonly sourceIntact: boolean;
}

/**
 * 移动数据目录。
 *
 * 失败语义：**要么完全搬过去，要么源目录原封不动**。没有第三种状态。
 */
export async function moveDataDir(
  fromRaw: string,
  toRaw: string,
  opts: MoveOptions = {},
): Promise<MoveResult> {
  const step = opts.onStep ?? ((): void => {});
  const plan = planMove(fromRaw, toRaw);
  const { from, to } = plan;
  if (!plan.ok) {
    return {
      ok: false,
      strategy: 'none',
      bytes: 0,
      files: 0,
      links: 0,
      staleLinks: [],
      ...(plan.reason ? { error: plan.reason } : {}),
      ...(plan.reasonZh ? { errorZh: plan.reasonZh } : {}),
      sourceIntact: true,
    };
  }

  step('measuring');
  let size: TreeSize;
  try {
    size = await measureTree(from);
  } catch (err) {
    return {
      ok: false,
      strategy: 'none',
      bytes: 0,
      files: 0,
      links: 0,
      staleLinks: [],
      error: `cannot read source: ${String(err)}`,
      errorZh: '读不到当前数据目录',
      sourceIntact: true,
    };
  }

  /**
   * 移动成功后的收尾：查一遍新目录里还有没有指着旧位置的符号链接。
   * 两条策略（rename / copy）都要走这一步 —— **快路径同样会踩到**，
   * 而它根本不调用 `verifyTreesMatch`，是原来完全没有任何符号链接检查的一条路。
   */
  const succeeded = async (
    strategy: 'rename' | 'copy',
    removeSourceError?: string,
  ): Promise<MoveResult> => {
    step('checking-links');
    const staleLinks = await findStaleLinks(to, from);
    const warnings: string[] = [];
    if (staleLinks.length > 0) {
      warnings.push(
        `数据已全部移动到新位置，但有 ${staleLinks.length} 个符号链接仍指向旧位置` +
          `（例如 ${staleLinks[0]?.rel} → ${staleLinks[0]?.target}），旧位置删除后它们会失效。` +
          `这类链接多来自已安装的后端（如 whisper.cpp 的 .so），可能需要重新安装该后端。`,
      );
    }
    if (removeSourceError !== undefined) {
      warnings.push(
        `数据已完整复制到新位置并校验通过，但旧目录 ${from} 没能删干净（${removeSourceError}）。` +
          `新位置的数据是完整的，旧目录可以手动删除。`,
      );
    }
    return {
      ok: true,
      strategy,
      bytes: size.bytes,
      files: size.files,
      links: size.links,
      staleLinks,
      ...(warnings.length > 0 ? { warningZh: warnings.join(' ') } : {}),
      sourceIntact: false,
    };
  };

  // 目标已存在且非空 → 拒绝。往一个有东西的目录里搬会混在一起，之后分不开
  try {
    const existing = await fs.readdir(to);
    if (existing.length > 0) {
      return {
        ok: false,
        strategy: 'none',
        bytes: size.bytes,
        files: size.files,
        links: size.links,
        staleLinks: [],
        error: 'target exists and is not empty',
        errorZh: '新位置已存在且不是空目录',
        sourceIntact: true,
      };
    }
  } catch {
    /* 不存在最好 */
  }

  step('checking-space');
  await fs.mkdir(to, { recursive: true });
  const free = await freeSpaceAt(to);
  const need = size.bytes * (opts.headroom ?? 1.05);
  if (free !== undefined && free < need) {
    await fs.rm(to, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      strategy: 'none',
      bytes: size.bytes,
      files: size.files,
      links: size.links,
      staleLinks: [],
      error: `insufficient space: need ~${Math.ceil(need)}, free ${free}`,
      errorZh: `目标磁盘空间不足（约需 ${(need / 1e6).toFixed(1)}MB，可用 ${(free / 1e6).toFixed(1)}MB）`,
      sourceIntact: true,
    };
  }

  // ---- 快路径：同盘 rename，内核级原子 ----
  if (!opts.forceCopy) {
    // rename 成不成功要用一个标志带出 try —— **不能在 try 里 return `succeeded()`**：
    // 收尾步骤一旦抛错就会被这个 catch 接住，然后从"源已经不在了"的状态掉进复制路径。
    let renamed = false;
    try {
      step('rename');
      await fs.rm(to, { recursive: true, force: true }); // rename 要求目标不存在
      await fs.rename(from, to);
      renamed = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EXDEV = 跨文件系统，这是**预期内**的，退到复制路径；其它错误也一并退，反正复制路径更保守
      if (code !== 'EXDEV') {
        // 非跨设备错误：确认源还在，然后如实报错
        step('rename-failed');
      }
      await fs.mkdir(to, { recursive: true }).catch(() => {});
    }
    if (renamed) return await succeeded('rename');
  }

  // ---- 慢路径：复制 → 校验 → 通过后才删源 ----
  try {
    step('copying');
    /*
     * `verbatimSymlinks: true` 是 T-128 的核心修复，**不要删**。
     *
     * 不加这个选项时，`fs.cp` 会把每条符号链接的目标**解析成绝对路径再写下去**：
     *   libwhisper.so -> libwhisper.so.1        （源，相对，正确）
     *   libwhisper.so -> /旧路径/libwhisper.so.1（目标，绝对，指着马上要被删的地方）
     * 下面第 `removing-source` 步一执行，这些链接全部悬空，whisper 后端直接加载不了。
     * 用户身上真实发生过（8 条 `.so`，两级链）。
     *
     * 加上它之后语义与 `cp -a` / `mv` 一致：**链接里存着什么就搬什么**。
     * 相对链接在新目录里依然相对、依然指向同一个兄弟文件，因此依然可用。
     */
    await fs.cp(from, to, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });

    step('verifying');
    const v = await verifyTreesMatch(from, to);
    if (!v.ok) {
      // 校验没过：**删掉刚复制出来的那份，源一个字节都不动**
      step('rollback');
      await fs.rm(to, { recursive: true, force: true }).catch(() => {});
      return {
        ok: false,
        strategy: 'copy',
        bytes: size.bytes,
        files: size.files,
        links: size.links,
        staleLinks: [],
        error: `verification failed: ${v.mismatches.slice(0, 5).join('; ')}`,
        errorZh: `复制后校验不一致（${v.mismatches.length} 处），已回滚，原数据未动`,
        sourceIntact: true,
      };
    }
  } catch (err) {
    step('rollback');
    await fs.rm(to, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      strategy: 'copy',
      bytes: size.bytes,
      files: size.files,
      links: size.links,
      staleLinks: [],
      error: String(err),
      errorZh: '移动失败，已回滚，原数据未动',
      sourceIntact: true,
    };
  }

  /*
   * ───── 校验通过之后就是不归点：从这里往下，`to` 再也不许被删 ─────
   *
   * 删源**必须在上面那个 try 之外**。它原来在里面，而那个 catch 会 `fs.rm(to)` ——
   * 于是"删源删到一半失败"（权限、文件被占用、EBUSY…）会触发回滚，
   * 把**刚刚校验通过的唯一一份完整数据删掉**，而源已经缺了一半。
   * 那不是回滚，那是两份都毁掉。
   *
   * 正确语义：过了校验这条线，"移动"就算成功了。源目录删不干净是**残留**，
   * 是一条要如实告诉用户的警告，不是一个该拿数据去赌的错误。
   */
  step('removing-source');
  let removeSourceError: string | undefined;
  try {
    await fs.rm(from, { recursive: true, force: true });
  } catch (err) {
    removeSourceError = String(err);
  }

  // 同快路径：收尾**放在 try 之外**，否则它抛错会触发回滚。
  return await succeeded('copy', removeSourceError);
}
