/**
 * 双击打开的人**没有控制台可以读 URL** —— 这里替他把浏览器打开。
 *
 * ## 为什么这件事在 daemon 里做，而不是在启动脚本里
 *
 * 端口会漂移。`start.cmd` / `OpenMemo.command` 在 spawn daemon **之前**并不知道
 * 最终绑到了哪个端口（17650 被占时会往上找，见 single-instance.ts）。
 * 启动脚本里硬编码 17650 就会在"端口漂移"那条路径上打开一个**错误的地址** ——
 * 而端口漂移恰恰是本仓已经写过警告的既有行为。
 * daemon 知道 `boundPort` 的真值，所以这件事只能在这里做。
 *
 * ## 为什么默认是关的
 *
 * 「自动开浏览器」对**双击进来的人**是刚需，对**脚本/CI**是干扰：
 * `cold-start-audit` 与 `verify-bundle-upgrade` 直接跑 `dist/main.js`，
 * 它们不该被弹出一个浏览器。所以默认关，**由启动器显式打开**
 * （启动器 = 双击入口，那里开着才是对的）。
 *
 * 判据：**开关的默认值应该服务于"不知道有这个开关的人"**。
 * 直接跑 `main.js` 的人是脚本，双击的人是用户 —— 两者的正确默认值相反，
 * 所以开关放在**入口**上，而不是放在一个全局默认值上。
 *
 * ## 取舍：URL 里可能带 token
 *
 * `OPENMEMO_AUTH=token` 时地址带 `#t=<token>`，把它作为 argv 传给 `open`/`start`
 * 会让它**在进程列表里短暂可见**。这是真实代价，不掩饰。
 * 但两点让它可接受：① 默认鉴权是 `none`，此时 URL 里**根本没有 token**
 * （见 main.ts 的横幅逻辑）；② 开着 token 时，替代方案是让用户从终端里
 * 手抄一串 43 字符的 base64url —— 那条路的实际安全性并不更好（会被截图、
 * 会被贴进聊天窗口），可用性却差得多。
 */
/*
 * ⚠️ 本文件**刻意不 import `node:child_process`**。
 *
 * D-01 §8.4 L1：子进程只能从 `packages/pipeline/src/subprocess/runner.ts` 出去，
 * 白名单**恰好 7 个文件**，且有守卫测试断言"能通过 lint 的文件集合"就是那 7 个。
 * 为了一个"开浏览器"再往那张表里加一行，等于把一条**可清点**的架构约束
 * 换成一条"每次有新需求就松一格"的约定 —— 那正是它要防的东西。
 *
 * 所以这里只放**决策与形状**（纯函数、好测），真正的 spawn 留在
 * `main.ts`（它因为 detached 自重启已经在白名单里，且已有定性说明）。
 * 换来的是：需要判断的那部分有用例钉着，而例外集合一个没多。
 */

/**
 * 是否要替用户打开浏览器。
 *
 * **默认 false。** 只有启动脚本会设 `OPENMEMO_OPEN_BROWSER=1`。
 *
 * ⚠️ 自我重启（`OPENMEMO_BOOT_TOKEN` 存在）时**不开**：那条路径上
 * 用户的页面是活着的（token 与会话跨进程延续，见 main.ts 的"接力棒"注释），
 * 再开一个标签页只是打扰。
 */
export function shouldOpenBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['OPENMEMO_BOOT_TOKEN']) return false;
  const v = env['OPENMEMO_OPEN_BROWSER']?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** 各平台把"用默认浏览器打开一个 URL"这件事交给谁。 */
export function openerFor(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  /*
   * Windows：`start` 是 cmd 的内建命令，必须经 `cmd /c`。
   * 第一个空字符串参数是 `start` 的**窗口标题位**——省掉它的话，
   * 带引号的 URL 会被当成标题，浏览器就不会打开（这是 `start` 的经典陷阱）。
   */
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * 打不开时给用户的那句话。
 *
 * 无头 Linux 上没有 `xdg-open`，SSH 进来的会话里 `open` 也可能没有意义 ——
 * 那都**不是错误**，只是"这台机器上打不开"。所以只说一句话，不抛、不退出，
 * 并且**明确把人指回上面那个地址** —— 否则用户只知道"有什么没成功"。
 */
export function openFailedHint(cmd: string): string {
  return `[daemon] 没能自动打开浏览器（${cmd} 不可用）。请手动复制上面那个地址到浏览器里。`;
}
