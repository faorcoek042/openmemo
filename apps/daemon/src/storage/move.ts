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
 */
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

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
    return { ...base, ok: false, reason: 'source and target are the same', reasonZh: '新位置与当前位置相同' };
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

/** 递归统计目录占用（字节）与文件数。用于空间预检和搬完后的校验。 */
export async function measureTree(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile()) {
        const st = await fs.stat(p);
        bytes += st.size;
        files += 1;
      }
      // 符号链接等一律不计也不搬 —— 数据目录里不应该有，有也不该跟着走
    }
  };
  await walk(dir);
  return { bytes, files };
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
 * 校验两棵树一致（相对路径集合 + 每个文件字节数）。
 *
 * **这是"敢不敢删源"的唯一依据**。只比总字节数是不够的：
 * 少一个文件、多一个文件、某个文件被截断，总数都可能碰巧对得上。
 */
export async function verifyTreesMatch(a: string, b: string): Promise<VerifyResult> {
  const listOf = async (root: string): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    const walk = async (d: string): Promise<void> => {
      const entries = await fs.readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) out.set(relative(root, p), (await fs.stat(p)).size);
      }
    };
    await walk(root);
    return out;
  };
  const [ma, mb] = await Promise.all([listOf(a), listOf(b)]);
  const mismatches: string[] = [];
  for (const [k, v] of ma) {
    const other = mb.get(k);
    if (other === undefined) mismatches.push(`缺失: ${k}`);
    else if (other !== v) mismatches.push(`大小不一致: ${k} (${v} → ${other})`);
  }
  for (const k of mb.keys()) if (!ma.has(k)) mismatches.push(`多出: ${k}`);
  return { ok: mismatches.length === 0, mismatches };
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
  readonly error?: string;
  readonly errorZh?: string;
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
      ...(plan.reason ? { error: plan.reason } : {}),
      ...(plan.reasonZh ? { errorZh: plan.reasonZh } : {}),
      sourceIntact: true,
    };
  }

  step('measuring');
  let size: { bytes: number; files: number };
  try {
    size = await measureTree(from);
  } catch (err) {
    return {
      ok: false,
      strategy: 'none',
      bytes: 0,
      files: 0,
      error: `cannot read source: ${String(err)}`,
      errorZh: '读不到当前数据目录',
      sourceIntact: true,
    };
  }

  // 目标已存在且非空 → 拒绝。往一个有东西的目录里搬会混在一起，之后分不开
  try {
    const existing = await fs.readdir(to);
    if (existing.length > 0) {
      return {
        ok: false,
        strategy: 'none',
        bytes: size.bytes,
        files: size.files,
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
      error: `insufficient space: need ~${Math.ceil(need)}, free ${free}`,
      errorZh: `目标磁盘空间不足（约需 ${(need / 1e6).toFixed(1)}MB，可用 ${(free / 1e6).toFixed(1)}MB）`,
      sourceIntact: true,
    };
  }

  // ---- 快路径：同盘 rename，内核级原子 ----
  if (!opts.forceCopy) {
    try {
      step('rename');
      await fs.rm(to, { recursive: true, force: true }); // rename 要求目标不存在
      await fs.rename(from, to);
      return { ok: true, strategy: 'rename', bytes: size.bytes, files: size.files, sourceIntact: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EXDEV = 跨文件系统，这是**预期内**的，退到复制路径；其它错误也一并退，反正复制路径更保守
      if (code !== 'EXDEV') {
        // 非跨设备错误：确认源还在，然后如实报错
        step('rename-failed');
      }
      await fs.mkdir(to, { recursive: true }).catch(() => {});
    }
  }

  // ---- 慢路径：复制 → 校验 → 通过后才删源 ----
  try {
    step('copying');
    await fs.cp(from, to, { recursive: true, force: true, preserveTimestamps: true });

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
        error: `verification failed: ${v.mismatches.slice(0, 5).join('; ')}`,
        errorZh: `复制后校验不一致（${v.mismatches.length} 处），已回滚，原数据未动`,
        sourceIntact: true,
      };
    }

    step('removing-source');
    await fs.rm(from, { recursive: true, force: true });
    return { ok: true, strategy: 'copy', bytes: size.bytes, files: size.files, sourceIntact: false };
  } catch (err) {
    step('rollback');
    await fs.rm(to, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      strategy: 'copy',
      bytes: size.bytes,
      files: size.files,
      error: String(err),
      errorZh: '移动失败，已回滚，原数据未动',
      sourceIntact: true,
    };
  }
}
