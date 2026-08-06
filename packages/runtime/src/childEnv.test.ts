/**
 * T-153 —— `packages/runtime` 三份 `execFile` 包装里查出的**两个真 bug**的护栏。
 *
 * 这不是"重复实现"的卫生问题（`debt-cleanup` §2.4 一开始也是那么归类的），
 * 三份实现已经分叉，而分叉出来的两条都有具体后果：
 *
 *   ① `selfTest.ts` **覆盖**而不是前置 `LD_LIBRARY_PATH` → 用户机器上原有的搜索路径被丢掉；
 *   ② `detect/system.ts` **缺 `killSignal`** → 默认 SIGTERM 可被忽略，
 *      于是那个 `timeout` 根本不是上界，硬件探测能在**启动时**把 daemon 挂住。
 *
 * 下面第 ② 组是**行为断言**，不是"某个字段等于某个字面量"：
 * 它真起一个忽略 SIGTERM 的子进程，断言 `run()` 在期限内 settle。
 * 断言字面量的话，把 `killSignal` 换成同样无效的 `'SIGINT'` 照样绿 ——
 * 而 SIGINT 一样是可捕获的。**钉后果，不钉形式**（HANDOFF ⑤A 规矩 7）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHILD_KILL_SIGNAL, libraryPathEnv, prependPathVar } from './childEnv.js';
import { run } from './detect/system.js';

describe('T-153 ① 动态库搜索路径：前置，不是覆盖', () => {
  it('★ 原来有值时必须整个保留下来（这条就是 selfTest.ts 那个 bug）', () => {
    const got = prependPathVar('/opt/conda/lib:/usr/local/lib', '/packs/whispercpp', 'linux');
    assert.equal(got, '/packs/whispercpp:/opt/conda/lib:/usr/local/lib');
  });

  it('我们的目录排在最前 —— 系统上同名的旧 ggml 不许赢', () => {
    const got = prependPathVar('/usr/lib', '/packs/whispercpp', 'linux');
    assert.equal(got.startsWith('/packs/whispercpp:'), true, got);
  });

  it('★ 原来没有值时不许留一个空段（":" 开头在 glibc 下 = 从当前目录加载 .so）', () => {
    assert.equal(prependPathVar(undefined, '/packs/x', 'linux'), '/packs/x');
    assert.equal(prependPathVar('', '/packs/x', 'linux'), '/packs/x');
  });

  it('分隔符跟平台走（win32 是 ";"）', () => {
    assert.equal(prependPathVar('C:\\old', 'C:\\packs', 'win32'), 'C:\\packs;C:\\old');
  });

  it('★ Linux 与 macOS 两个变量都要设，且都保留原值', () => {
    const env = libraryPathEnv(
      { LD_LIBRARY_PATH: '/a', DYLD_LIBRARY_PATH: '/b' },
      '/packs/x',
      'linux',
    );
    assert.deepEqual(env, {
      LD_LIBRARY_PATH: '/packs/x:/a',
      DYLD_LIBRARY_PATH: '/packs/x:/b',
    });
  });
});

describe('T-153 ② execFile 的 timeout 必须真的是上界', () => {
  /*
   * 子进程：装了 SIGTERM handler（大量 CLI 为了做清理本来就装），然后空转。
   *
   * ⚠️ 15 秒后自己退出。**这一条是给"这个测试失败时"准备的**：
   * 修复被撤掉的话，SIGTERM 杀不掉它，而我们不能因为跑了一次红灯就在
   * 用户机器上留一个永远转下去的孤儿进程（HANDOFF ⑤H 同族）。
   * 15s 远大于下面的 6s 期限，所以它不会把红灯变成绿灯。
   */
  const IGNORES_SIGTERM = [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000);",
  ];

  it('★ 忽略 SIGTERM 的子进程超时后，run() 仍然必须在期限内返回', { timeout: 20_000 }, async () => {
    if (process.platform === 'win32') return; // Windows 上没有信号语义，这条不适用

    const started = Date.now();
    const raced = await Promise.race([
      run(process.execPath, IGNORES_SIGTERM, 800).then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 6_000).unref()),
    ]);

    assert.equal(
      raced,
      'settled',
      `run() 在 6s 内没有 settle（子进程忽略了 SIGTERM，800ms 的 timeout 形同虚设）—— ` +
        `这正是硬件探测在启动时把 daemon 挂住的那条路径。已耗时 ${String(Date.now() - started)}ms`,
    );
  });

  it('超时返回的是 ok:false，而不是把"没跑成"伪装成空输出', { timeout: 20_000 }, async () => {
    if (process.platform === 'win32') return;
    const r = await run(process.execPath, IGNORES_SIGTERM, 800);
    assert.equal(r.ok, false, JSON.stringify(r));
  });

  it('信号取值必须是不可捕获的那个（SIGTERM/SIGINT 都能被忽略）', () => {
    assert.equal(CHILD_KILL_SIGNAL, 'SIGKILL');
  });
});
