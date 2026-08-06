/**
 * 子进程环境：动态库搜索路径 + 超时信号。**一份实现，三个调用点。**
 *
 * ─── 为什么这个文件存在（T-153 / `debt-cleanup` §2.4）───────────────────────────
 *
 * `packages/runtime` 里有三处各自写了一遍 `execFile` 的包装
 * （`detect/system.ts`、`probe/runProbe.ts`、`selfTest.ts`）。
 * 复查它们的时候查出的**不是"重复"，是两个真 bug** —— 三份实现已经分叉了：
 *
 * **① `LD_LIBRARY_PATH` 被覆盖，而不是前置。**
 *   `selfTest.ts` 写的是 `LD_LIBRARY_PATH: dirOf(whisperCliPath)`，
 *   `runProbe.ts` 写的是 `joinPathVar(process.env.LD_LIBRARY_PATH, backendDir)`。
 *   用户机器上本来就有 `LD_LIBRARY_PATH` 的场景一点都不罕见（conda / nix / HPC / Homebrew），
 *   覆盖掉之后**自检会把它整个丢掉** —— 表现是「自检说后端跑不起来，而真的转写好好的」，
 *   或者反过来。判据是**"原来有什么必须还在"**，不是"我们要的那个在不在"。
 *
 * **② 超时信号缺失 ⇒ `execFile` 的超时可能永远不生效。**
 *   `detect/system.ts` 没有 `killSignal`，默认是 **SIGTERM**。
 *   一个忽略 SIGTERM 的子进程被"超时杀掉"之后**照样活着**，`close` 事件永不触发，
 *   promise 永不 settle。这条路径上跑的正是 `lspci` / `wmic` / `sw_vers` 之类
 *   **硬件探测**，而硬件探测是在**启动时**跑的 —— 于是 daemon 卡在启动上，
 *   没有任何超时会救它（超时本身就是坏的那个东西）。
 *   与 ADR-014「冷启动 probe 死锁」同一族：**那次的教训是"探测必须有上界"，
 *   而一个不会真的杀掉进程的超时不是上界。**
 *
 * 两条都不是风格问题，所以修法不是"抽个函数少写几行"，而是
 * **把这两个性质变成没有第二种写法可选**。
 */

/** `process.platform === 'win32'` 时是 `;`，其余是 `:`。 */
export function pathVarSeparator(platform: string = process.platform): string {
  return platform === 'win32' ? ';' : ':';
}

/**
 * 把 `dir` **前置**到一个 PATH 形状的环境变量上，保留原值。
 *
 * - 原值为空/未设置 → 只有 `dir`（不留一个空段：`":"` 开头在 glibc 下等价于 `"."`，
 *   那会让子进程从 **当前工作目录** 加载 `.so`，是一条实打实的提权面）。
 * - 原值非空 → `dir + sep + 原值`。**前置**而非追加：我们随包发的 ggml 必须赢过
 *   系统上碰巧同名的那一份，否则 ABI 对不上时的报错会指向完全错误的方向。
 */
export function prependPathVar(
  existing: string | undefined,
  dir: string,
  platform: string = process.platform,
): string {
  if (existing === undefined || existing.length === 0) return dir;
  return `${dir}${pathVarSeparator(platform)}${existing}`;
}

/**
 * 子进程要用的动态库搜索路径。Linux 看 `LD_LIBRARY_PATH`，macOS 看 `DYLD_LIBRARY_PATH`，
 * 两个都设是因为**同一份代码要在两个平台上跑**，设错平台的那个无害。
 *
 * @param base 通常是 `process.env`。显式传入而不是在函数里读全局，是为了能测
 *             「原来有值时会不会被丢掉」—— 那正是 ① 那个 bug。
 */
export function libraryPathEnv(
  base: NodeJS.ProcessEnv,
  dir: string,
  platform: string = process.platform,
): { LD_LIBRARY_PATH: string; DYLD_LIBRARY_PATH: string } {
  return {
    LD_LIBRARY_PATH: prependPathVar(base['LD_LIBRARY_PATH'], dir, platform),
    DYLD_LIBRARY_PATH: prependPathVar(base['DYLD_LIBRARY_PATH'], dir, platform),
  };
}

/**
 * 所有带 `timeout` 的 `execFile` 都必须用这个信号。
 *
 * `execFile` 的 `timeout` 只是"到点发一个信号"，**不是"到点一定结束"**。
 * 默认的 SIGTERM 可以被子进程忽略（`process.on('SIGTERM', () => {})` 就够了，
 * 而且大量 CLI 为了做清理本来就装了 handler），此时回调永不触发。
 * SIGKILL 不可捕获、不可忽略 —— 这是唯一能让"超时"真的是一个上界的取值。
 */
export const CHILD_KILL_SIGNAL = 'SIGKILL' as const;
