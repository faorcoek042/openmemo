/**
 * 入口守卫（T-143 ③）。
 *
 * ★ 判据钉的是**后果**：「daemon 会不会启动」。所以每条用例都用
 * **`pathToFileURL` 独立算出来的真值**做期望，而不是重复一遍被测代码的写法 ——
 * 后者只会证明"我写的和我写的一样"。
 *
 * 每条用例都成对出现：
 *   - 手拼 `file://` + 路径 → 断言它**确实与真值不同**（证明这条用例钉的不是零）
 *   - `isDirectRun`         → 断言它**仍然认得出来**
 * 少了第一半，等哪天 Node 改了行为、这些路径不再需要编码，用例会静默变成空断言。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { isDirectRun } from './entrypoint.js';

/** 旧写法，一比一照抄事故当天那一行。 */
const legacyGuard = (moduleUrl: string, argv1: string): boolean =>
  moduleUrl === `file://${argv1}`;

describe('★ T-143 ③ 入口守卫：路径要被**转换**成 URL，不是**拼**成 URL', () => {
  /*
   * 这六条全部在 Linux 上就会发生 —— 安装路径里有一个空格或一个中文字符即可。
   * 第一列是目录名，`plain` 是对照组：旧写法在它身上是对的，所以坏在别处时
   * 没有人会怀疑到这一行。
   */
  const cases: Array<[name: string, dir: string, legacyWorksOnPosix: boolean]> = [
    ['对照：纯 ASCII', 'plain', true],
    ['空格', 'my dir', false],
    ['中文', '笔记', false],
    ['井号（URL 里是 fragment 分隔符）', 'a#b', false],
    ['问号（URL 里是 query 分隔符）', 'a?b', false],
    ['百分号（URL 里是转义引导符）', 'a%b', false],
  ];

  for (const [label, dir, legacyWorksOnPosix] of cases) {
    it(`${label} → daemon 必须仍然启动`, () => {
      /*
       * ★ T-147：路径要用本平台的形状造。
       *
       * 以前这里写死 `/opt/openmemo/${dir}/dist/main.js`。在 Windows 上
       * `pathToFileURL` 会把它补成当前盘符（`file:///D:/opt/...`），而手拼出来的是
       * `file:///opt/...` —— 于是**对照组也失配**，用例红在
       * 「旧写法在纯 ASCII 路径上本来就是对的」这句话上。
       */
      const argv1 = join(resolve('/opt/openmemo'), dir, 'dist', 'main.js');
      // 真值：由 node:url 算出来，不重复被测代码的实现
      const moduleUrl = pathToFileURL(argv1).href;

      /*
       * ★ 而那句话本身**只在 POSIX 上成立**。Windows 上手拼 `file://` 对
       * **任何**路径都是错的：盘符要多一个 `/`，分隔符还是反的
       * （`file://D:\x` vs `file:///D:/x`）。D-11 §3.1 实测：手拼 `file://` 与
       * `pathToFileURL()` 在**三个平台上全部不相等**。
       * 所以这里不是放宽断言，而是把对照组换成一句更强、且各平台都为真的话。
       */
      const legacyWorks = process.platform === 'win32' ? false : legacyWorksOnPosix;

      // 先证明这条用例钉的不是零：旧写法在这里到底对不对
      assert.equal(
        legacyGuard(moduleUrl, argv1),
        legacyWorks,
        legacyWorks
          ? '对照组：旧写法在纯 ASCII 的 POSIX 路径上本来就是对的'
          : `旧写法本应在此失配（${moduleUrl} vs file://${argv1}）——` +
              '如果它没失配，这条用例证明不了任何东西',
      );

      assert.equal(isDirectRun(moduleUrl, argv1), true);
    });
  }

  it('★ 经由软链调用：`pathToFileURL` 一个人也修不好，必须再比一次 realpath', () => {
    const box = mkdtempSync(join(tmpdir(), 'om-entry-'));
    const real = join(box, 'main.js');
    writeFileSync(real, '');
    const link = join(box, 'launcher.js');
    symlinkSync(real, link);

    // import.meta.url 是**解析过软链**的；argv[1] 是用户敲的那条软链
    const moduleUrl = pathToFileURL(realpathSync(real)).href;

    assert.equal(legacyGuard(moduleUrl, link), false, '旧写法失配');
    assert.equal(
      moduleUrl === pathToFileURL(link).href,
      false,
      '只换 pathToFileURL 仍然失配 —— 这就是为什么还要 realpath',
    );
    assert.equal(isDirectRun(moduleUrl, link), true);
  });

  it('被 import 时不许自启：argv[1] 是别的文件', () => {
    const moduleUrl = pathToFileURL(join(resolve('/opt/openmemo'), 'dist', 'main.js')).href;
    assert.equal(
      isDirectRun(moduleUrl, join(resolve('/usr/lib'), 'node_modules', 'npm', 'bin', 'npm-cli.js')),
      false,
    );
  });

  it('没有 argv[1]（`node -e`、REPL）→ 不自启', () => {
    assert.equal(
      isDirectRun(pathToFileURL(join(resolve('/opt/x'), 'main.js')).href, undefined),
      false,
    );
  });

  it('realpath 抛错（argv[1] 已被删掉）→ 不自启，也不许把异常抛出去', () => {
    const moduleUrl = pathToFileURL(join(resolve('/opt/openmemo'), 'dist', 'main.js')).href;
    const boom = (): string => {
      throw new Error('ENOENT');
    };
    assert.equal(isDirectRun(moduleUrl, join(resolve('/gone'), 'main.js'), boom), false);
  });
});
