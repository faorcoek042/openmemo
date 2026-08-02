/**
 * 数据目录移动的回归测试。
 *
 * 这里测的**不是"能搬成功"** —— 那是最容易过的一条。
 * 真正要钉住的是**失败路径**：搬砸了以后用户的数据还在不在。
 * 一个只测 happy path 的移动功能，等于没测。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { measureTree, moveDataDir, planMove, verifyTreesMatch } from './move.js';

const roots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `om-move-${prefix}-`));
  roots.push(d);
  return d;
}
after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

/** 造一个像真数据目录的树（含中文文件名与嵌套）。 */
async function seed(dir: string): Promise<void> {
  await fs.mkdir(join(dir, 'media'), { recursive: true });
  await fs.mkdir(join(dir, 'models', 'by-name', 'asr'), { recursive: true });
  await fs.writeFile(join(dir, 'openmemo.db'), 'X'.repeat(4096));
  await fs.writeFile(join(dir, 'media', '会议录音.m4a'), 'A'.repeat(2048));
  await fs.writeFile(join(dir, 'models', 'by-name', 'asr', 'ggml-base.bin'), 'B'.repeat(1024));
}

describe('planMove —— 纯路径校验', () => {
  it('相同路径必须拒绝', () => {
    const p = planMove('/data/openmemo', '/data/openmemo');
    assert.equal(p.ok, false);
  });

  it('**目标在源内部**必须拒绝（否则复制会自我递归）', () => {
    const p = planMove('/data/openmemo', '/data/openmemo/sub');
    assert.equal(p.ok, false);
    assert.match(p.reason ?? '', /inside source/);
  });

  it('源在目标内部必须拒绝', () => {
    const p = planMove('/data/openmemo/sub', '/data/openmemo');
    assert.equal(p.ok, false);
    assert.match(p.reason ?? '', /inside target/);
  });

  it('**同前缀但不同目录必须放行**（/data 与 /data-backup 无关）', () => {
    // 这条是防"用字符串前缀判父子"的经典误伤：一次完全合法的移动被拒
    assert.equal(planMove('/data', '/data-backup').ok, true);
    assert.equal(planMove('/srv/om', '/srv/om2').ok, true);
  });

  it('正常的兄弟目录放行', () => {
    assert.equal(planMove('/a/openmemo', '/b/openmemo').ok, true);
  });
});

describe('verifyTreesMatch —— 敢不敢删源的依据', () => {
  it('完全一致时通过', async () => {
    const a = tmp('va');
    const b = tmp('vb');
    await seed(a);
    await fs.cp(a, b, { recursive: true });
    assert.equal((await verifyTreesMatch(a, b)).ok, true);
  });

  it('**少一个文件**必须报出来（总字节数可能碰巧对得上）', async () => {
    const a = tmp('ma');
    const b = tmp('mb');
    await seed(a);
    await fs.cp(a, b, { recursive: true });
    await fs.rm(join(b, 'media', '会议录音.m4a'));
    const v = await verifyTreesMatch(a, b);
    assert.equal(v.ok, false);
    assert.ok(v.mismatches.some((m) => m.includes('缺失')));
  });

  it('**文件被截断**必须报出来', async () => {
    const a = tmp('ta');
    const b = tmp('tb');
    await seed(a);
    await fs.cp(a, b, { recursive: true });
    await fs.writeFile(join(b, 'openmemo.db'), 'X'.repeat(10)); // 截断
    const v = await verifyTreesMatch(a, b);
    assert.equal(v.ok, false);
    assert.ok(v.mismatches.some((m) => m.includes('大小不一致')));
  });
});

describe('moveDataDir', () => {
  it('同盘：rename 快路径，数据完整搬到新位置', async () => {
    const base = tmp('r');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    const before = await measureTree(from);

    const r = await moveDataDir(from, to);
    assert.equal(r.ok, true);
    assert.equal(r.strategy, 'rename');
    assert.equal((await measureTree(to)).files, before.files);
    await assert.rejects(() => fs.access(from)); // 源已不在
    // 中文文件名必须原样保留
    await fs.access(join(to, 'media', '会议录音.m4a'));
  });

  it('**跨设备（forceCopy）：复制→校验→才删源**，数据完整', async () => {
    const base = tmp('c');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    const before = await measureTree(from);

    const steps: string[] = [];
    const r = await moveDataDir(from, to, { forceCopy: true, onStep: (s) => steps.push(s) });
    assert.equal(r.ok, true);
    assert.equal(r.strategy, 'copy');
    assert.equal((await measureTree(to)).bytes, before.bytes);
    // 顺序必须是先校验后删源 —— 反过来就是"校验没过数据已经没了"
    assert.ok(steps.indexOf('verifying') < steps.indexOf('removing-source'));
  });

  it('★ 目标非空必须拒绝，且**源原封不动**', async () => {
    const base = tmp('ne');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await fs.mkdir(to, { recursive: true });
    await seed(from);
    await fs.writeFile(join(to, '别人的文件.txt'), 'keep me');
    const before = await measureTree(from);

    const r = await moveDataDir(from, to);
    assert.equal(r.ok, false);
    assert.equal(r.sourceIntact, true);
    assert.deepEqual(await measureTree(from), before); // 源一个字节没动
    await fs.access(join(to, '别人的文件.txt')); // 目标原有内容也没被吃掉
  });

  it('★ 空间不足必须**提前拒绝**，不留半个副本', async () => {
    const base = tmp('sp');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    const before = await measureTree(from);

    // headroom 拉到天文数字 = 模拟"目标盘装不下"
    const r = await moveDataDir(from, to, { headroom: 1e12 });
    assert.equal(r.ok, false);
    assert.equal(r.sourceIntact, true);
    assert.match(r.errorZh ?? '', /空间不足/);
    assert.deepEqual(await measureTree(from), before);
    // 预检失败时不能留下一个空的目标目录冒充"搬过了"
    await assert.rejects(() => fs.access(to));
  });

  it('★ 目标在源内部必须拒绝，源不动', async () => {
    const base = tmp('in');
    const from = join(base, 'src');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    const before = await measureTree(from);

    const r = await moveDataDir(from, join(from, 'inner'));
    assert.equal(r.ok, false);
    assert.equal(r.sourceIntact, true);
    assert.deepEqual(await measureTree(from), before);
  });
});
