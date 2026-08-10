/**
 * 随预编译包出厂的 **CPU 基线运行时**目录（包内 `runtime/probe/`）。
 *
 * ## 为什么要有这一份，而且要放在 `@openmemo/runtime`
 *
 * "包内自带一个能用的 whisper-cli" 这件事，**有三个互不相干的消费者**，
 * 而它们此前各自漏了一半：
 *
 * | 消费者 | 此前怎么找 | 漏在哪 |
 * |---|---|---|
 * | `pipeline` 的 `discoverTools()` | 只读 `OPENMEMO_BUNDLED_WHISPER_DIR` | **不经启动器**起的 daemon / `scripts/selfcheck.mjs` 看不见 |
 * | daemon 自检 `resolveBackendTool()` | **压根没有包内这一档** | 即使经启动器起，自检也看不见（`[实测]` 用户 v0.5.0 撞的就是这条） |
 * | `runtime` 的 `selfcheck.ts` | 不在 store 里 → 归成「来自系统 PATH」 | **把自家的东西说成借来的** |
 *
 * 三处同源，所以解析规则收敛到这一份。放在 `runtime` 是因为
 * `pipeline → runtime` 这条依赖已经存在（反过来不行），而 `shared` 被网页引用、
 * 不能碰 `node:fs`。
 *
 * ## 判据：**不依赖你从哪儿启动**
 *
 * 环境变量仍然排第一（启动脚本会设，开发/测试也要能覆盖）；
 * 取不到就**从本模块所在位置向上找** —— 因为两种布局里这个目录相对包根都在同一处，
 * 而"包根离本模块几层"在两种布局里并不相同：
 *
 * ```
 * 包内   <包根>/app/node_modules/@openmemo/{runtime,pipeline}/dist/…   → 上溯 5 层是包根
 * 仓库   <仓库根>/packages/{runtime,pipeline}/dist/…                   → 上溯 3 层是仓库根
 * ```
 *
 * 所以**不写死层数**，而是逐层向上找"有没有 `runtime/probe`"。
 * 仓库根下没有 `runtime/` 目录（已核实），所以开发树上它一定返回 `null` ——
 * 那也是对的：开发树本来就该走已安装的后端包。
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 向上找几层就放弃。8 层足够覆盖两种布局，又不会一路走到文件系统根。 */
const MAX_UP = 8;

/**
 * 包内 CPU 基线运行时目录；不是这种布局就返回 `null`。
 *
 * @param fromDir 起点（默认本模块所在目录）。测试用它来验判据本身。
 */
export function bundledRuntimeDir(fromDir?: string): string | null {
  const fromEnv = process.env['OPENMEMO_BUNDLED_WHISPER_DIR'];
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv;

  let cur = fromDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_UP; i += 1) {
    const candidate = join(cur, 'runtime', 'probe');
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* 这一层没有，继续往上 */
    }
    const up = dirname(cur);
    if (up === cur) break; // 到文件系统根了
    cur = up;
  }
  return null;
}

/**
 * 这个路径是不是**包内自带**的那一份。
 *
 * 用途：自检要把它标成「随包出厂」而不是「来自系统 PATH」。
 * 判据是**目录归属**而不是文件名 —— 同名的二进制在 store 里、在 PATH 上都可能有，
 * 说错了会让用户以为我们在借他机器上的东西（实际是我们自己发的）。
 */
export function isBundledRuntimePath(p: string | null | undefined): boolean {
  if (p === undefined || p === null || p.length === 0) return false;
  const dir = bundledRuntimeDir();
  if (dir === null) return false;
  const a = resolve(dir);
  const b = resolve(p);
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/**
 * 不需要装任何包就能用的后端 —— **今天只可能是 `cpu`，而且只在包内布局下**。
 *
 * ## 为什么这件事值得一个函数
 *
 * 「cpu 装了没有」此前被三处各答一次，其中两处**无条件写死 `true`**
 * （`models.ts` 与 `setup.ts`），第三处（`/api/backends/catalog`）说的是相反的话 ——
 * 干净机器上同一屏因此自相矛盾：顶部「CPU ⚡使用中」，下面「CPU ⬇可安装 · 42 MB」。
 *
 * 写死的那两处**想说的事情是对的**（包内那份 whisper-cli 确实兜得住 CPU），
 * 错在把它写成了 `installed`——那个字段的语义是"包在不在盘上"。
 * 所以拆成两个名字（见 `BackendStatus.bundled`），而这里是**唯一**回答后一个问题的地方。
 *
 * ## 判据是真的去看文件系统，不是一个常量
 *
 * `bundledRuntimeDir()` 逐层向上找包内 `runtime/probe/`；**开发树上恒为 `null`**
 * （仓库根下没有 `runtime/`，那边本来就该走已安装的后端包）。
 * 所以这里在开发树上返回**空集** —— 那正是此前两处写死 `cpu → true` 说谎的地方。
 *
 * ⚠️ 只给 `cpu`：包内目录**只有 CPU 后端模块**（`tools.ts` 的 `whisperCli.reason`
 * 写明了这一点，也正是内置那一档排在已安装包之后的理由）。
 * 将来包内真的带了别的后端，改这里一处即可。
 */
export function bundledBackends(): ReadonlySet<'cpu'> {
  return bundledRuntimeDir() === null ? new Set() : new Set(['cpu'] as const);
}
