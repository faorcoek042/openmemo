/**
 * 测试专用：**把用例需要的鉴权档写死在用例里**，不要依赖 `OPENMEMO_AUTH` 的默认值。
 *
 * ## 这个文件因为一次真实事故而存在（T-135）
 *
 * `daemon.test.ts` 的「鉴权链路」与 `settings.roundtrip.test.ts` 的「仅凭 cookie 续签」
 * 一共 **7 条**用例，是在**鉴权强制开启**的年代写的。后来鉴权默认值被翻成 `none`
 * （用户显式决定，见 `auth.ts`），这 7 条的**前提在没人注意的情况下失效了**，
 * 于是它们从那天起一直是红的 —— 而 `pnpm -r test` 一路报绿，
 * 因为 `apps/daemon` 的 test 脚本当时用的 glob 根本扫不到这两个文件（同轮已修）。
 *
 * **两个缺陷叠在一起，效果是「7 条红的用例存在了几小时，没有任何人看得见」。**
 *
 * ## 判据（Manager 定的，比"让它们变绿"强得多）
 *
 * > **改完之后，默认值再翻一次也不该让它们红。**
 *
 * 所以修法不是"把断言改成 200 也算过"（那会把 token 档的全部边界一起删掉），
 * 而是**让每一组用例显式声明自己要哪一档**。默认值从此只是默认值，
 * 不再是任何测试的隐含前提。
 *
 * ## 为什么 `before` 里要断言一次
 *
 * 设 env 这个动作**本身可能不生效**（`authMode()` 曾经是模块加载时求值的
 * `export const AUTH_MODE`，那时用例改不动它 —— 正是"把开关做成单向门"）。
 * 一个不生效的 pin 会让用例**在错误的档位下悄悄通过或悄悄失败**，
 * 而这正是本轮要消灭的那类东西。所以 pin 完立刻回读一次：
 * **前提不成立就当场红，而不是让后面几十条断言去表达它。**
 */
import assert from 'node:assert/strict';
import { after, before } from 'node:test';

import { authMode, type AuthMode } from './auth.js';

/**
 * 在当前 `describe` 里把鉴权档钉成 `mode`，退出时还原。
 *
 * 必须在 `describe` 的**函数体里同步调用**（它内部注册 `before`/`after` 钩子）。
 * `authMode()` 每次都读环境变量，且 daemon 是在同进程里起的，
 * 所以钉在这里对**已经启动的实例**同样生效 —— 不需要为换档重启 daemon。
 */
export function pinAuthMode(mode: AuthMode): void {
  let prev: string | undefined;
  before(() => {
    prev = process.env['OPENMEMO_AUTH'];
    process.env['OPENMEMO_AUTH'] = mode;
    assert.equal(
      authMode(),
      mode,
      `钉鉴权档没有生效（想要 ${mode}，实际 ${authMode()}）—— 后面每一条断言都会在错误的前提下跑`,
    );
  });
  after(() => {
    if (prev === undefined) delete process.env['OPENMEMO_AUTH'];
    else process.env['OPENMEMO_AUTH'] = prev;
  });
}
