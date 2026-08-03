/**
 * 「这个模块是被**直接执行**的，还是被 `import` 进来的？」
 *
 * ─── 为什么这值得一个单独的文件（而不是 main.ts 末尾那一行）────────────────────────
 * 原来的写法是手拼字符串：
 *
 * ```ts
 * if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) void mainCli();
 * ```
 *
 * `import.meta.url` 是一个 **URL**，`process.argv[1]` 是一个**文件系统路径**。
 * 把后者拼上 `file://` **不等于**把它转成 URL —— URL 要百分号编码，路径不要。
 * 实测（Linux x64，本机，`[实测]`）：
 *
 * | 目录名 | `import.meta.url` | 手拼结果 | 匹配 |
 * |---|---|---|---|
 * | `plain`   | `…/plain/main.js`        | 同左 | ✅ |
 * | `my dir`  | `…/my%20dir/main.js`     | `…/my dir/main.js` | 🔴 |
 * | `笔记`    | `…/%E7%AC%94%E8%AE%B0/…` | `…/笔记/…`         | 🔴 |
 * | `a#b`     | `…/a%23b/main.js`        | `…/a#b/main.js`    | 🔴 |
 * | `a?b`     | `…/a%3Fb/main.js`        | `…/a?b/main.js`    | 🔴 |
 * | `a%b`     | `…/a%25b/main.js`        | `…/a%b/main.js`    | 🔴 |
 *
 * 后果不是报错，是 **`mainCli()` 永不执行、进程静默退出 0**：
 * `node dist/main.js` 打印零行、退出码 0、什么也没启动。
 * 用 systemd / launchd 拉起来时表现为「服务反复"成功"退出」。
 * **这在 Linux 上今天就是活的** —— 只要安装路径里有一个空格或一个中文字符。
 * （`#` `?` `%` 在 URL 里各有语法含义，所以它们也各自中招，成因不止"没编码空格"。）
 *
 * ─── 第二种形态：`pathToFileURL` 一个人修不好 ───────────────────────────────────
 * `import.meta.url` 是**解析过符号链接**的真实路径，而 `process.argv[1]` 是用户敲的那个。
 * 经由一条启动软链调用（`/usr/local/bin/openmemo → …/dist/main.js`，包管理器与
 * 安装包的标准做法）时，两者天生不同 `[实测]`：
 *
 * ```
 * argv[1]         = /tmp/…/link.js
 * import.meta.url = file:///tmp/…/plain/probe.js     ← 已经 realpath 过
 * ```
 *
 * 只换 `pathToFileURL` 仍然不匹配 —— 症状与上面一模一样。所以还要**再比一次 realpath**。
 *
 * ★ 提成纯函数是为了能被测试执行：`main.ts` 一被 import 就会拉起整条启动链，
 * 那意味着这一行**只能靠人肉验证**，而这正是它坏了这么久没人发现的原因。
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param moduleUrl 调用方的 `import.meta.url`
 * @param argv1     `process.argv[1]`（被 `node` 直接执行时是入口脚本路径）
 * @param realpath  仅供测试注入；默认走真实文件系统
 */
export function isDirectRun(
  moduleUrl: string,
  argv1: string | undefined,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (!argv1) return false;

  let asUrl: string;
  try {
    asUrl = pathToFileURL(argv1).href;
  } catch {
    return false;
  }
  if (moduleUrl === asUrl) return true;

  // argv[1] 可能是一条软链，而 import.meta.url 已经是解析后的真路径
  try {
    return moduleUrl === pathToFileURL(realpath(argv1)).href;
  } catch {
    return false;
  }
}
