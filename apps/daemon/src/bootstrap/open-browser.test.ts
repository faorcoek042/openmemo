/**
 * 自动打开浏览器：**默认关，只有双击入口才开。**
 *
 * ## 为什么这个开关的默认值要有用例钉着
 *
 * 「自动开浏览器」对**双击进来的人**是刚需（他没有别的入口），
 * 对**脚本 / CI** 是干扰（`cold-start-audit`、`verify-bundle-upgrade`
 * 直接跑 `dist/main.js`，不该被弹出浏览器）。两者的正确默认值**相反**。
 *
 * 所以开关放在**入口**上：启动脚本设 `OPENMEMO_OPEN_BROWSER=1`，全局默认是关。
 * 一旦有人"顺手"把默认值改成开，CI 会开始在无头 runner 上弹 `xdg-open`——
 * 那种失败很难追，所以这里当场钉住。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openerFor, shouldOpenBrowser } from './open-browser.js';

describe('① 默认必须是关的', () => {
  it('环境变量完全没设 → 不开', () => {
    assert.equal(shouldOpenBrowser({}), false);
  });

  it('设成 0 → 不开', () => {
    assert.equal(shouldOpenBrowser({ OPENMEMO_OPEN_BROWSER: '0' }), false);
  });

  it('设成一个看不懂的值 → 不开（默认安全的一侧）', () => {
    assert.equal(shouldOpenBrowser({ OPENMEMO_OPEN_BROWSER: 'maybe' }), false);
  });
});

describe('② 启动脚本设了才开', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes']) {
    it(`OPENMEMO_OPEN_BROWSER=${v} → 开`, () => {
      assert.equal(shouldOpenBrowser({ OPENMEMO_OPEN_BROWSER: v }), true);
    });
  }
});

describe('③ ★ 自我重启时不许再开一个标签页', () => {
  /*
   * 自我重启走的是 `OPENMEMO_BOOT_TOKEN` 接力棒那条路径，用户页面是活着的
   * （token 与会话跨进程延续）。再开一个标签页只是打扰。
   * 这一条容易在"把开关简化一下"时被顺手删掉，所以单独钉。
   */
  it('有 BOOT_TOKEN 时，即使开关是 1 也不开', () => {
    assert.equal(
      shouldOpenBrowser({ OPENMEMO_OPEN_BROWSER: '1', OPENMEMO_BOOT_TOKEN: 'abc' }),
      false,
    );
  });
});

describe('④ 各平台交给谁去开', () => {
  it('macOS 用 open', () => {
    assert.deepEqual(openerFor('darwin', 'http://x/'), { cmd: 'open', args: ['http://x/'] });
  });

  it('Linux 用 xdg-open', () => {
    assert.deepEqual(openerFor('linux', 'http://x/'), { cmd: 'xdg-open', args: ['http://x/'] });
  });

  /*
   * ★ Windows 的 `start` 第一个参数是**窗口标题位**。省掉那个空字符串的话，
   *   带引号的 URL 会被 `start` 当成标题吃掉，浏览器根本不开 ——
   *   这是 `start` 的经典陷阱，且失败是静默的。
   */
  it('Windows 走 cmd /c start，且**保留标题占位的空字符串**', () => {
    const r = openerFor('win32', 'http://x/#t=1');
    assert.deepEqual(r, { cmd: 'cmd', args: ['/c', 'start', '', 'http://x/#t=1'] });
    assert.equal(r.args[2], '', 'start 的标题占位不许被"顺手简化"掉');
  });
});
