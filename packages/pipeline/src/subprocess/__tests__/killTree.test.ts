/**
 * ★ 「注释描述了一个不存在的实现」—— `runner.ts` 的 taskkill 那条。
 *
 * ## 修之前那里是什么
 *
 * `runner.ts` 的 spawn 选项上写着：
 *
 * ```
 * // Own process group so the timeout can kill the whole tree (ffmpeg and yt-dlp
 * // both spawn helpers). On Windows this is emulated via taskkill below.
 * ```
 *
 * 而 "below" 的 win32 分支是**光秃秃一句 `child.kill(sig)`**。
 * `[实测 grep]` 全仓 `taskkill` 在 `apps/` + `packages/` 里**只有那一条注释本身**，零调用。
 *
 * 这比"没做"更贵：**注释让下一个读代码的人不去做**。`closure-audit` 独立记到过（🟡-3），
 * `backlog-sweep.md:141` 与 `platform.md:544` 也各自记过一次 —— 三个人分别发现，
 * 三次都停在"记一笔"，因为源码里它看起来是**已经做完**的。
 *
 * ## 这些用例钉的是什么
 *
 * 1. **纯函数两条**：argv 里必须有 `/T`（没有它，taskkill 只是个更慢的 `child.kill()`），
 *    `/F` 只许出现在 SIGKILL 那一级，路径必须是绝对路径（PATH 搜索 = 可被劫持的收尸路径）。
 * 2. **行为一条，跨平台同一份断言**：真的起一棵 父→孙 进程树，让 `run()` 超时，
 *    然后断言**孙进程也死了**。这条在 Linux/macOS 上验的是进程组，
 *    在 Windows CI 上验的就是 taskkill 本身 —— 同一条断言，不需要两套代码。
 *
 * ## 阴性对照为什么是必须的
 *
 * 「孙进程死了」这句话，在**孙进程压根没起来**时也成立。
 * 所以下面记了 `aliveWhenReported` —— 不先证明它活过，"它死了"就什么都没证明。
 * （本仓 `collapseRedundantTopLevel` 那次栽的正是这个形状：判据一次没触发，而夹具全是干净的。）
 *
 * ## 被 kill -9 会留下什么（PROTOCOL §9-bis 的判据）
 *
 * 孙进程**自己 15 秒后退出**，不依赖本文件的任何清理代码。
 * 所以最坏情况是机器上多一个 idle 的 node 15 秒，**零机器级状态**。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run, taskkillPath, windowsKillTreeArgv } from '../runner.js';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 一个"会派生 helper 的工具"的最小复制品 —— yt-dlp 调 ffmpeg 就是这个形状。
 *
 * 孙进程的 stdio 必须是 `ignore`：如果它继承了父进程的 stdout 管道，
 * `run()` 等的那个 `'close'` 事件会一直等到**孙进程**也退出，
 * 于是这个用例会在"泄漏"的情况下超时而不是红 —— 又一个假绿灯的形状。
 */
const TOOL_SRC = `
const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
process.stdout.write('GRANDCHILD=' + g.pid + '\\n');
setInterval(() => {}, 1000);
`;

describe('★ runner.killTree：注释声称的进程树回收，现在真的有实现了', () => {
  it('windowsKillTreeArgv：/T 必须在，/F 只许跟着 SIGKILL 出现', () => {
    assert.deepEqual(
      windowsKillTreeArgv(1234, false),
      ['/PID', '1234', '/T'],
      'SIGTERM 那一级不许带 /F —— 那一级按 D-01 §2.5 是"礼貌请求"',
    );
    assert.deepEqual(windowsKillTreeArgv(1234, true), ['/PID', '1234', '/T', '/F']);

    for (const force of [false, true]) {
      assert.equal(
        windowsKillTreeArgv(1, force).includes('/T'),
        true,
        '/T 掉了的话 taskkill 只是个更慢的 child.kill()，孙进程照样泄漏',
      );
    }
  });

  it('taskkillPath：绝对路径，且跟随 SystemRoot（裸名字 = 收尸路径可被 PATH 劫持）', () => {
    assert.equal(taskkillPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\taskkill.exe');
    assert.equal(taskkillPath({ windir: 'E:\\W' }), 'E:\\W\\System32\\taskkill.exe');
    // 两个都没有时也不许退化成裸 'taskkill'
    assert.equal(taskkillPath({}), 'C:\\Windows\\System32\\taskkill.exe');
    assert.equal(taskkillPath({}).includes('\\'), true, '必须是绝对路径，不许是裸名字');
  });

  it('★ 超时后孙进程也必须被回收（Linux/macOS 验进程组，Windows CI 验 taskkill）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'om-killtree-'));
    const tool = join(dir, 'tool.cjs');
    await writeFile(tool, TOOL_SRC, 'utf8');

    let grandchild: number | null = null;
    let aliveWhenReported = false;

    try {
      const result = await run({
        bin: process.execPath,
        argv: [tool],
        cwd: dir,
        timeoutMs: 2_000,
        onStdoutLine: (line) => {
          const m = /GRANDCHILD=(\d+)/.exec(line);
          if (m?.[1] === undefined) return;
          grandchild = Number(m[1]);
          aliveWhenReported = isAlive(grandchild);
        },
      });

      assert.equal(result.timedOut, true, 'run() 没有超时 —— 这条用例什么都没验到');
      assert.notEqual(grandchild, null, '工具没有报出孙进程 pid —— 树根本没建起来');

      // ★ 阴性对照：不先证明它活过，"它死了"就是空话。
      assert.equal(aliveWhenReported, true, '孙进程从来没活过 —— 下面那条断言毫无意义');

      const gpid = grandchild as unknown as number;
      let stillAlive = true;
      for (let i = 0; i < 60 && stillAlive; i++) {
        stillAlive = isAlive(gpid);
        if (stillAlive) await sleep(100);
      }

      assert.equal(
        stillAlive,
        false,
        `孙进程 ${String(gpid)} 在整棵树被 kill 之后仍然活着 —— 这正是 win32 分支修之前的行为`,
      );
    } finally {
      if (grandchild !== null && isAlive(grandchild)) {
        try {
          process.kill(grandchild, 'SIGKILL');
        } catch {
          /* 已经没了 */
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
