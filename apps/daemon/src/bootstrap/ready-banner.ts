/**
 * 「就绪」横幅 —— 双击进来的人**看到的第一屏**。
 *
 * ## 为什么它值得一个独立模块
 *
 * 它原来是 `main.ts` 里的一行 `console.log`，夹在 1000 行引导逻辑中间。
 * 后果有两个，2026-08-08 同时发作：
 *
 *   1. **它没有测试**。于是「鉴权关着却照样打 token」这种事没有任何东西挡着。
 *      用户的原话：「怎么还有 token？不是早都删除了这套安全验证流程吗」。
 *   2. **它是按"给开发者看日志"写的**，而不是按"给一个刚双击开包的人看"写的：
 *      一个裸 URL，没有一句他能照着做的话。
 *
 * 抽成纯函数之后，"横幅里该有什么、不该有什么"变成可断言的性质。
 */

export interface ReadyBannerInput {
  /** `http` 或 `https`。 */
  scheme: string;
  /** 绑定地址（`BIND_HOST`）。 */
  host: string;
  /** **实际**绑定到的端口 —— 不是请求的那个（端口会漂移）。 */
  port: number;
  /** 启动令牌。**仅在 `authRequired` 为真时才允许出现在输出里。** */
  token: string;
  /** `OPENMEMO_AUTH=token` 时为真。 */
  authRequired: boolean;
}

/** 用户该在浏览器里打开的那个地址。鉴权关闭时**不带 token**。 */
export function readyUrl(i: ReadyBannerInput): string {
  const base = `${i.scheme}://${i.host}:${i.port}/`;
  return i.authRequired ? `${base}#t=${i.token}` : base;
}

/**
 * 横幅的每一行（不含 `[daemon] ` 前缀由调用方加）。
 *
 * ★ 判据一：**鉴权关着的时候，token 一个字节都不许出现。**
 *   它今天不承担任何作用，只会让人以为还要过一道验证 ——
 *   与一句假注释是同一类东西：让读的人对系统建立了错误的模型。
 *
 * ★ 判据二：**必须有一句人能照着做的话**，而不只是一个 URL。
 *   双击进来的人面对的是一个陌生的控制台窗口，他需要知道
 *   ①去哪 ②这串 #t= 是什么 ③怎么退出。
 */
export function readyBannerLines(i: ReadyBannerInput): string[] {
  const lines = ['就绪。请在浏览器里打开这个地址：', `    ${readyUrl(i)}`];
  if (i.authRequired) {
    lines.push('    （地址末尾的 #t= 是登录令牌，OPENMEMO_AUTH=token 时才需要，请勿外传）');
  }
  lines.push('    要停止 OpenMemo：回到这个窗口按 Ctrl+C，或直接关掉窗口。');
  return lines;
}
