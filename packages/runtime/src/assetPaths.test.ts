/**
 * `assetPaths` —— `media_assets.rel_path` 唯一那份解析规则的单元测试（T-136）。
 *
 * 这里钉的是**候选顺序**和**"读得到"的判据**，因为播放端（`/media/asset/<ulid>`）、
 * `/api/selfcheck`、路径迁移三处现在共用它：任何一处再各写各的基准，
 * 就会重演"文件在盘上、红灯说它被删了"。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { assetCandidates, mediaAssetRoots, probeAssetFile } from './assetPaths.js';

const made: string[] = [];
after(async () => {
  for (const d of made) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function seed(files: Record<string, string>): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'om-ap-'));
  made.push(d);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel);
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return d;
}

describe('assetCandidates —— 纯函数：展开候选并挡住越界', () => {
  const roots = mediaAssetRoots('/d');

  it('三个根的顺序就是优先级：media → tmp → dataDir', () => {
    assert.deepEqual(assetCandidates(roots, 'a.wav'), ['/d/media/a.wav', '/d/tmp/a.wav', '/d/a.wav']);
  });

  it('绝对路径只有它自己一个候选，且必须落在根内', () => {
    assert.deepEqual(assetCandidates(roots, '/d/media/x.wav'), ['/d/media/x.wav']);
    assert.deepEqual(assetCandidates(roots, '/elsewhere/x.wav'), []);
  });

  it('★ `..` 穿越出去的候选被剔除，剩下的仍然可用', () => {
    // /d/media/../../etc/passwd → /etc/passwd（出界，剔除）
    // /d/tmp/../../etc/passwd   → /etc/passwd（同上）
    // /d/../etc/passwd          → /etc/passwd（同上）
    assert.deepEqual(assetCandidates(roots, '../../etc/passwd'), []);
    /*
     * `../jfk.wav`：从 media/ 和 tmp/ 退一级都落到 `/d/jfk.wav`（去重后只剩一个），
     * 从 dataDir 退一级是 `/jfk.wav` —— 出界，剔除。
     */
    assert.deepEqual(assetCandidates(roots, '../jfk.wav'), ['/d/jfk.wav']);
  });

  it('空路径 → 没有候选（否则候选会变成"根目录本身"）', () => {
    assert.deepEqual(assetCandidates(roots, ''), []);
  });
});

describe('probeAssetFile —— 判据是"真的打开并读到字节"', () => {
  it('★ 命中第一个**真能打开**的候选，而不是第一个落在根内的', async () => {
    const d = await seed({ 'media/legacy/x.wav': 'DATA' });
    // 候选① `<d>/media/media/legacy/x.wav` 落在根内但不存在 —— 旧实现就停在这儿，
    // 于是这条记录永远 404，而文件明明在。
    const p = await probeAssetFile(mediaAssetRoots(d), 'media/legacy/x.wav');
    assert.equal(p.abs, join(d, 'media', 'legacy', 'x.wav'));
    assert.equal(p.note, Buffer.from('DATA').toString('hex'));
    assert.equal(p.tried[0], join(d, 'media', 'media', 'legacy', 'x.wav'));
  });

  it('同名时按根的顺序取，media 根优先', async () => {
    const d = await seed({ 'media/dup.wav': 'MEDI', 'dup.wav': 'ROOT' });
    const p = await probeAssetFile(mediaAssetRoots(d), 'dup.wav');
    assert.equal(p.abs, join(d, 'media', 'dup.wav'));
  });

  it('★ 一个都打不开 → abs 为 null，但 tried 列出全部找过的位置', async () => {
    const d = await seed({});
    const p = await probeAssetFile(mediaAssetRoots(d), 'gone.wav');
    assert.equal(p.abs, null);
    assert.deepEqual(p.tried, [
      join(d, 'media', 'gone.wav'),
      join(d, 'tmp', 'gone.wav'),
      join(d, 'gone.wav'),
    ]);
    assert.equal(p.note, 'ENOENT');
  });

  it('★ 悬空符号链接算读不到（`lstat` 对它照样成功 —— T-128 的那盏假绿灯）', async () => {
    const d = await seed({ 'media/keep': 'x' });
    await fs.symlink(join(d, 'media', 'nope.wav'), join(d, 'media', 'dangling.wav'));
    // 先证明它确实是条"看起来存在"的链接，否则这条用例钉的是零
    assert.equal((await fs.lstat(join(d, 'media', 'dangling.wav'))).isSymbolicLink(), true);
    const p = await probeAssetFile(mediaAssetRoots(d), 'dangling.wav');
    assert.equal(p.abs, null);
  });

  it('★ 0 字节文件：能打开，但 bytesRead 为 0（调用方据此区分"在"和"能播"）', async () => {
    const d = await seed({ 'media/empty.wav': '' });
    const p = await probeAssetFile(mediaAssetRoots(d), 'empty.wav');
    assert.equal(p.abs, join(d, 'media', 'empty.wav'));
    assert.equal(p.bytesRead, 0);
    assert.equal(p.note, '0 字节');
  });

  it('候选恰好是个目录 → 跳过它继续试下一个根', async () => {
    const d = await seed({ 'sub/a.wav': 'REAL' });
    await fs.mkdir(join(d, 'media', 'sub'), { recursive: true });
    const p = await probeAssetFile(mediaAssetRoots(d), 'sub');
    assert.equal(p.abs, null, '目录不是资产');
  });

  it('越界 → tried 为空（"越界"和"文件不在"是两码事）', async () => {
    const d = await seed({});
    const p = await probeAssetFile(mediaAssetRoots(d), '/etc/hostname');
    assert.deepEqual(p.tried, []);
    assert.equal(p.abs, null);
  });
});
