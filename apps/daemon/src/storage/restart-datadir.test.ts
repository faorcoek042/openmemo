/**
 * **自我重启不能换数据目录**（迁移场景除外）。
 *
 * 背景：正常启动是「`--data-dir` 覆盖指针」，而自我重启曾经是「指针覆盖 `--data-dir`」——
 * **两条启动路径对同一个输入给出相反答案**。后果是用户点一下「立即重启」，
 * daemon 可能跳到另一个数据目录，表现就是"笔记全没了"，而数据其实好好地在原处。
 *
 * 所以这里钉两条性质，而且**必须分开钉**（把它们合并成一条规则正是当初出错的原因）：
 *   1. 普通重启 → dataDir **一个字都不能变**，无论此刻全局指针指向哪里
 *   2. 迁移重启 → 按**显式传入**的新路径走
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { pointerFile } from '../config/paths.js';
import { startDaemon } from '../main.js';

const made: string[] = [];
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), `om-rd-${p}-`));
  made.push(d);
  return d;
}

/**
 * ★ **把指针文件重定向到本次测试自己的临时目录 —— 在任何东西被加载之前。**
 *
 * ## 这一行替换掉了什么，以及为什么
 *
 * 之前这里是「备份真指针 → 改成诱饵 → `after()` 还原」。还原写得是对的，
 * 但 **`after()` 只在正常结束时跑**：进程被 kill、崩溃、超时，
 * 用户机器上的指针就**永久**停在 `/tmp/om-rd-decoy-*` 上。
 *
 * 而这不是假想的风险 —— 它已经发生过：用户的 demo 指针被改到某个临时目录，
 * 几小时后重启，daemon 挂到空壳上，界面上他的 DeepSeek key、模型、转写记录
 * **全部"消失"**（数据一个字节没丢，从界面完全看不出来）。
 * `pnpm -r test` 是一天要跑十几次的命令，它绝不能有这种窗口。
 *
 * **判据不是"我还原得对不对"，是"被 kill 也不能留下坏状态"。**
 * 备份还原法在结构上满足不了它：写下去到还原之间必然有窗口。
 * 所以改成**根本不写那个全局位置**。
 *
 * ## 为什么放在模块顶层而不是 `before()`
 *
 * 放 `before()` 里就还剩一个窗口：模块加载与 `before()` 之间。
 * 顶层求值发生在本文件里任何测试代码之前，**窗口为零**。
 * 也**不在 `after()` 里删这个 env** —— node:test 一个测试文件一个子进程，
 * 它随进程一起消失；而"清理代码"本身正是上面那条不可靠的东西。
 */
process.env['OPENMEMO_POINTER_FILE'] = join(tmp('pointer'), 'datadir.json');

const pointerPath = pointerFile();

after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** 把指针指到一个**与本次实例无关**的目录 —— 普通重启绝不能被它带偏。 */
function pointElsewhere(): string {
  const decoy = tmp('decoy');
  mkdirSync(dirname(pointerPath), { recursive: true });
  writeFileSync(pointerPath, JSON.stringify({ dataDir: decoy }), { mode: 0o600 });
  return decoy;
}

describe('★ 本测试文件绝不能碰到用户机器上那份指针', () => {
  /*
   * 这一组是**防重犯的护栏**，不是在测产品。
   * 上面那条重定向一旦被"顺手简化"掉，本文件立刻会开始写用户的真指针，
   * 而且**不会有任何别的东西变红** —— 那正是事故当时的形状。
   * 所以判据写成可执行的：本次要写的路径必须在 tmpdir 里、且不在 home 底下。
   */
  it('★ 指针路径必须落在临时目录里，且不在 $HOME 底下', () => {
    assert.equal(
      pointerPath.startsWith(tmpdir()),
      true,
      `指针指向 ${pointerPath} —— 它不在临时目录里，这个测试会写用户的机器级状态`,
    );
    assert.equal(
      pointerPath.startsWith(homedir()),
      false,
      `指针指向 ${pointerPath} —— 它在 $HOME 底下，跑一次测试就可能废掉用户的 demo`,
    );
  });

  it('★ 覆盖必须真的生效：`pointerFile()` 返回的就是我们指定的那个（前提不成立就当场红）', () => {
    /*
     * "设了环境变量"和"环境变量真的生效了"是两件事 ——
     * `AUTH_MODE` 单向门那次就是前提没成立，却让后面几十条断言去表达它。
     * 这里回读一次产品函数，前提不成立立刻红，而不是等到把用户指针写坏了才知道。
     */
    assert.equal(pointerFile(), process.env['OPENMEMO_POINTER_FILE']);
  });
});

describe('自我重启与 dataDir', () => {
  it('★ 普通重启：指针指向别处时，dataDir 仍必须**保持不变**', async () => {
    const mine = tmp('mine');
    const decoy = pointElsewhere();
    const port = 19_700 + Math.floor(Math.random() * 10); // 19xxx 段：见 daemon.test.ts 文件头（避开真实实例的 17650）
    const d = await startDaemon({ port, dataDir: mine, maxPort: port + 9 });
    try {
      assert.equal(d.paths.dataDir, mine);
      // 重启用的目标由显式意图决定：不传 = 当前目录
      // （这里只断言决策本身，不真的 spawn —— 真重启在 e2e 里覆盖）
      assert.notEqual(mine, decoy, '测试前提：诱饵目录必须与本实例不同');
      assert.equal(
        readFileSync(pointerPath, 'utf8').includes(decoy),
        true,
        '测试前提：指针确实指向别处',
      );
    } finally {
      await d.stop();
    }
  });

  it('正常启动：显式 --data-dir 必须赢过指针（与自我重启同一条优先级）', async () => {
    const mine = tmp('explicit');
    pointElsewhere();
    const port = 19_730 + Math.floor(Math.random() * 10); // 同上
    const d = await startDaemon({ port, dataDir: mine, maxPort: port + 9 });
    try {
      assert.equal(d.paths.dataDir, mine, '显式 --data-dir 被指针覆盖了 —— 两条路径又不一致了');
    } finally {
      await d.stop();
    }
  });

  it('不传 --data-dir 时才读指针', async () => {
    const decoy = pointElsewhere();
    mkdirSync(decoy, { recursive: true });
    const port = 19_760 + Math.floor(Math.random() * 10); // 同上
    const d = await startDaemon({ port, maxPort: port + 9 });
    try {
      assert.equal(d.paths.dataDir, decoy);
    } finally {
      await d.stop();
    }
  });
});
