/**
 * 安装记录迁移的回归测试。
 *
 * 重点不是"能转格式"，而是三条**不能出错**的性质：
 *   1. **幂等** —— 跑第二遍不能再改（否则每次启动都在重写用户的库）
 *   2. **找不到文件时不删记录** —— 悄悄删掉安装记录比留一条坏记录更糟
 *   3. **已是新格式的不动** —— 迁移不能把好数据碰坏
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { migrateInstallRecords, migrateRecord, listExistingRelPaths } from './migrateRecords.js';

const made: string[] = [];
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), `om-mig-${p}-`));
  made.push(d);
  return d;
}
after(async () => {
  for (const d of made) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/** 造一个 models 根：by-name 下有真文件，manifests 下有旧格式记录。 */
async function seedStore(root: string, recs: Record<string, unknown>): Promise<void> {
  await fs.mkdir(join(root, 'by-name', 'asr'), { recursive: true });
  await fs.mkdir(join(root, 'by-name', 'backend'), { recursive: true });
  await fs.writeFile(join(root, 'by-name', 'asr', 'ggml-base-q5_1.bin'), 'W');
  await fs.writeFile(join(root, 'by-name', 'backend', 'whisper-bin.tar.gz'), 'A');
  for (const [rel, body] of Object.entries(recs)) {
    const f = join(root, 'manifests', rel);
    await fs.mkdir(join(f, '..'), { recursive: true });
    await fs.writeFile(f, JSON.stringify(body, null, 2));
  }
}

describe('migrateRecord —— 单条记录', () => {
  it('绝对路径且在库内 → 转成 root+relPath', () => {
    const r = migrateRecord(
      { files: [{ name: 'a', path: '/store/by-name/asr/x.bin' }] },
      '/store',
      new Set(['by-name/asr/x.bin']),
    );
    assert.equal(r.changed, true);
    assert.equal(r.record.files?.[0]?.relPath, 'by-name/asr/x.bin');
    assert.equal(r.record.files?.[0]?.root, 'models');
    assert.ok(!('path' in (r.record.files?.[0] ?? {})), '旧的绝对 path 应被移除');
  });

  it('★ 路径已失效但同名文件在库里 → 重新指向（数据目录搬过家就是这种）', () => {
    const r = migrateRecord(
      { files: [{ name: 'a', path: '/tmp/cold4/models/by-name/asr/x.bin' }] },
      '/store',
      new Set(['by-name/asr/x.bin']),
    );
    assert.equal(r.changed, true);
    assert.equal(r.record.files?.[0]?.relPath, 'by-name/asr/x.bin');
  });

  it('★ 找不到对应文件 → **不改也不删**，计入 unresolved', () => {
    const rec = { files: [{ name: 'gone', path: '/tmp/gone/y.bin' }] };
    const r = migrateRecord(rec, '/store', new Set(['by-name/asr/x.bin']));
    assert.equal(r.changed, false);
    assert.equal(r.record.files?.[0]?.path, '/tmp/gone/y.bin', '记录被改动了');
    assert.equal(r.unresolved.length, 1);
  });

  it('残留 installPath 被移除', () => {
    const r = migrateRecord({ installPath: 'bin/ext', files: [] }, '/store', new Set());
    assert.equal(r.changed, true);
    assert.ok(!('installPath' in r.record));
  });

  it('已是新格式 → 不动（changed=false）', () => {
    const r = migrateRecord(
      { files: [{ name: 'a', root: 'models', relPath: 'by-name/asr/x.bin' }] },
      '/store',
      new Set(['by-name/asr/x.bin']),
    );
    assert.equal(r.changed, false);
  });
});

describe('migrateInstallRecords —— 整库', () => {
  it('迁移旧记录，且**第二遍是幂等的**', async () => {
    const root = tmp('store');
    await seedStore(root, {
      'asr/whisper.json': {
        id: 'asr/whisper-base-q5_1',
        role: 'asr',
        integrity: 'ok',
        files: [{ name: 'ggml-base-q5_1.bin', path: '/tmp/cold4/models/by-name/asr/ggml-base-q5_1.bin' }],
      },
      'backend/whispercpp.json': {
        id: 'whispercpp-cpu-linux-x64',
        installPath: 'whispercpp/v1.9.1/cpu',
        files: [{ name: 'whisper-bin.tar.gz', path: join(root, 'by-name', 'backend', 'whisper-bin.tar.gz') }],
      },
    });

    const first = await migrateInstallRecords(root);
    assert.equal(first.scanned, 2);
    assert.equal(first.migrated, 2);

    const asr = JSON.parse(
      await fs.readFile(join(root, 'manifests', 'asr', 'whisper.json'), 'utf8'),
    ) as { files: Array<{ relPath?: string; path?: string }> };
    assert.equal(asr.files[0]?.relPath, join('by-name', 'asr', 'ggml-base-q5_1.bin'));
    assert.equal(asr.files[0]?.path, undefined);

    const be = JSON.parse(
      await fs.readFile(join(root, 'manifests', 'backend', 'whispercpp.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.ok(!('installPath' in be), '残留 installPath 没被清掉');

    // ★ 幂等：第二遍不能再改任何东西
    const second = await migrateInstallRecords(root);
    assert.equal(second.migrated, 0, '迁移不幂等 —— 每次启动都会重写用户的库');
  });

  it('坏 JSON 不阻塞、不改动、如实报告', async () => {
    const root = tmp('bad');
    await seedStore(root, {});
    await fs.mkdir(join(root, 'manifests', 'asr'), { recursive: true });
    await fs.writeFile(join(root, 'manifests', 'asr', 'broken.json'), '{ not json');
    const r = await migrateInstallRecords(root);
    assert.equal(r.migrated, 0);
    assert.equal(r.unresolved.length, 1);
    assert.equal(await fs.readFile(join(root, 'manifests', 'asr', 'broken.json'), 'utf8'), '{ not json');
  });

  it('listExistingRelPaths 只列 by-name 下的真实文件', async () => {
    const root = tmp('list');
    await seedStore(root, {});
    const s = await listExistingRelPaths(root);
    assert.ok(s.has(join('by-name', 'asr', 'ggml-base-q5_1.bin')));
    assert.equal(s.size, 2);
  });
});
