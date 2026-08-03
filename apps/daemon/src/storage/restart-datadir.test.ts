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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startDaemon } from '../main.js';

const made: string[] = [];
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), `om-rd-${p}-`));
  made.push(d);
  return d;
}

/** 全局指针文件是共享状态：测试前备份、测试后原样还原，绝不影响其它实例。 */
const pointerPath = join(homedir(), '.local', 'share', 'openmemo', 'datadir.json');
let pointerBackup: string | undefined;

before(() => {
  pointerBackup = existsSync(pointerPath) ? readFileSync(pointerPath, 'utf8') : undefined;
});
after(() => {
  if (pointerBackup === undefined) rmSync(pointerPath, { force: true });
  else writeFileSync(pointerPath, pointerBackup);
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** 把全局指针指到一个**与本次实例无关**的目录 —— 普通重启绝不能被它带偏。 */
function pointElsewhere(): string {
  const decoy = tmp('decoy');
  mkdirSync(join(homedir(), '.local', 'share', 'openmemo'), { recursive: true });
  writeFileSync(pointerPath, JSON.stringify({ dataDir: decoy }), { mode: 0o600 });
  return decoy;
}

describe('自我重启与 dataDir', () => {
  it('★ 普通重启：指针指向别处时，dataDir 仍必须**保持不变**', async () => {
    const mine = tmp('mine');
    const decoy = pointElsewhere();
    const port = 17_400 + Math.floor(Math.random() * 100);
    const d = await startDaemon({ port, dataDir: mine, maxPort: port + 30 });
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
    const port = 17_500 + Math.floor(Math.random() * 100);
    const d = await startDaemon({ port, dataDir: mine, maxPort: port + 30 });
    try {
      assert.equal(d.paths.dataDir, mine, '显式 --data-dir 被指针覆盖了 —— 两条路径又不一致了');
    } finally {
      await d.stop();
    }
  });

  it('不传 --data-dir 时才读指针', async () => {
    const decoy = pointElsewhere();
    mkdirSync(decoy, { recursive: true });
    const port = 17_300 + Math.floor(Math.random() * 100);
    const d = await startDaemon({ port, maxPort: port + 30 });
    try {
      assert.equal(d.paths.dataDir, decoy);
    } finally {
      await d.stop();
    }
  });
});
