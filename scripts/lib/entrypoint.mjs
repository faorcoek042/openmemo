/**
 * 「这个模块是被**直接执行**的，还是被 `import` 进来的？」—— `.mjs` 脚本用的那一份。
 *
 * ## 这是同一个坑的第 4 次，所以它必须有且只有一份实现
 *
 * | 次 | 地点 | 形态 |
 * |---|---|---|
 * | 1 | T-143 `apps/daemon/src/main.ts` | 手拼 `` `file://${argv[1]}` `` |
 * | 2 | T-145 `scripts/selfcheck.mjs` | 同上 |
 * | 3 | #95 `scripts/ci/check-duplicate-declarations.mjs` | 同上 |
 * | 4 | 本文件收编的这 8 个脚本 | `pathToFileURL(argv[1]) === import.meta.url`、
 *      `fileURLToPath(import.meta.url) === argv[1]`、`resolve(a) === resolve(b)` 三种变体 |
 *
 * 第 4 次的三种写法都**修掉了百分号编码那一半**，却都漏掉另一半：
 *
 * > **`import.meta.url` 是 realpath 过的真实路径，`process.argv[1]` 是用户敲的那一个。**
 *
 * 经由软链调用时两者天生不同，而 `resolve()` **不解符号链接**（它只做词法归一化：
 * `.` / `..` / 相对转绝对），所以第三种变体也接不住。
 *
 * ## 失配的后果不是报错，是**整个脚本变成空转**
 *
 * CLI 主体一行不执行 → stdout 零行 → **exit 0** → CI 记 ✔。
 * `[实测]` 这 8 个脚本经软链路径调用时全部 **exit 0、零行输出**，
 * 而从真实路径跑各打 16–24 行。
 *
 * 会踩响它的现实路径（不是假想）：
 *   · **macOS**：`mkdtemp()` 落在 `/var/folders/…`，而 `/var → /private/var` 是软链 ——
 *     #95 踩的正是这一枚；
 *   · `git worktree` / 包管理器装的启动软链（`/usr/local/bin/x → …/dist/main.js`）/
 *     任何别名调用。
 *
 * ## 权威实现在别处，这里是它的 `.mjs` 孪生
 *
 * 判据与逐条实测记在 `apps/daemon/src/bootstrap/entrypoint.ts` 的文件头
 * （含空格 / 中文 / `#` / `?` / `%` 五种目录名的实测表）。
 * `scripts/` 下的 `.mjs` 没法 `import` 那个 TS 模块，所以这里有一份等价物 ——
 * **两份，不是三份**：`scripts/ci/check-duplicate-declarations.mjs` 原来内联的那一份
 * 已经改成 import 本文件。
 *
 * ## 反向验证
 *
 * `scripts/ci/selftest-entry-guards.mjs` 用**行为判据**盯着全仓：链上每一环
 * 都要经一条软链跑一遍，仍然出活才算数。把这里的 `realpathSync` 那一段删掉，
 * 那条自检当场红（它就是拿这 8 个当夹具校准的）。
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} moduleUrl 调用方的 `import.meta.url`
 * @param {string | undefined} argv1 `process.argv[1]`（被 `node` 直接执行时是入口脚本路径）
 * @param {(p: string) => string} [realpath] 仅供测试注入；默认走真实文件系统
 * @returns {boolean}
 */
export function isDirectRun(moduleUrl, argv1, realpath = realpathSync) {
  if (!argv1) return false;

  let asUrl;
  try {
    asUrl = pathToFileURL(argv1).href;
  } catch {
    return false;
  }
  if (moduleUrl === asUrl) return true;

  // argv[1] 可能是一条软链（或 macOS 的 /var、Windows 的 8.3 短名），
  // 而 import.meta.url 已经是解析后的真路径 —— 所以还要再比一次 realpath。
  try {
    return moduleUrl === pathToFileURL(realpath(argv1)).href;
  } catch {
    return false;
  }
}
