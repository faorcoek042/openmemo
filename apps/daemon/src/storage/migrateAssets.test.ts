/**
 * `media_assets` 路径迁移的回归测试。
 *
 * 钉的性质与安装记录那套一致，外加一条这次血的教训：
 * **两条不同笔记的 `audio16k.wav` 绝不能被挂到同一个文件上。**
 */
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { openAppDatabase, type AppDatabase } from '@openmemo/db';

import { migrateMediaAssets } from './migrateAssets.js';

const made: string[] = [];
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), `om-ma-${p}-`));
  made.push(d);
  return d;
}
after(async () => {
  for (const d of made) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function seed(dir: string, rows: Array<{ role: string; rel: string }>): Promise<AppDatabase> {
  await fs.mkdir(join(dir, 'media'), { recursive: true });
  const h = openAppDatabase({ filename: join(dir, 'openmemo.db') });
  h.db.prepare(
    `INSERT INTO notes(uid,title,kind,status,created_at,updated_at) VALUES ('N1','t','media','ready',1,1)`,
  ).run();
  let i = 0;
  for (const r of rows) {
    i += 1;
    h.db
      .prepare(
        `INSERT INTO media_assets(uid,note_id,role,rel_path,state,created_at)
         VALUES (:u,1,:r,:p,'ready',1)`,
      )
      .run({ u: `A${i}`, r: r.role, p: r.rel });
  }
  return h;
}

describe('migrateMediaAssets', () => {
  it('★ 失效的绝对路径按**最长后缀**重挂，两条同名文件不会撞在一起', async () => {
    const d = tmp('two');
    // 两条不同 job 的归一化音频，文件名完全一样
    for (const j of ['job-AAA', 'job-BBB']) {
      await fs.mkdir(join(d, 'tmp', j), { recursive: true });
      await fs.writeFile(join(d, 'tmp', j, 'audio16k.wav'), j);
    }
    const h = await seed(d, [
      { role: 'audio16k', rel: '/old/dir/tmp/job-AAA/audio16k.wav' },
      { role: 'audio16k', rel: '/other/dir/tmp/job-BBB/audio16k.wav' },
    ]);
    const r = await migrateMediaAssets(h.db, d, join(d, 'media'));
    assert.equal(r.migrated, 2);
    const paths = h.db
      .prepare<{ rel_path: string }>('SELECT rel_path FROM media_assets ORDER BY id')
      .all()
      .map((x) => x.rel_path);
    assert.notEqual(paths[0], paths[1], '两条资产被挂到了同一个文件');
    // 内容对得上 = 各自挂回了自己的那份
    assert.equal(await fs.readFile(join(d, paths[0] ?? ''), 'utf8'), 'job-AAA');
    assert.equal(await fs.readFile(join(d, paths[1] ?? ''), 'utf8'), 'job-BBB');
    h.close();
  });

  it('★ 找不到对应文件 → 不改不删，计入 unresolved', async () => {
    const d = tmp('miss');
    const h = await seed(d, [{ role: 'original', rel: '/gone/nowhere.wav' }]);
    const r = await migrateMediaAssets(h.db, d, join(d, 'media'));
    assert.equal(r.migrated, 0);
    assert.equal(r.unresolved.length, 1);
    const row = h.db.prepare<{ rel_path: string }>('SELECT rel_path FROM media_assets').get();
    assert.equal(row?.rel_path, '/gone/nowhere.wav', '记录被动过了');
    h.close();
  });

  it('★ 迁移后没有资产留在 tmp/ 下（tmp 被标为"可随时删"）', async () => {
    const d = tmp('arch');
    await fs.mkdir(join(d, 'tmp', 'job-X'), { recursive: true });
    await fs.writeFile(join(d, 'tmp', 'job-X', 'audio16k.wav'), 'x');
    const h = await seed(d, [{ role: 'audio16k', rel: '/old/tmp/job-X/audio16k.wav' }]);
    await migrateMediaAssets(h.db, d, join(d, 'media'));
    const row = h.db.prepare<{ rel_path: string }>('SELECT rel_path FROM media_assets').get();
    assert.ok(!row?.rel_path.startsWith('tmp/'), `资产仍留在 tmp/：${row?.rel_path}`);
    await fs.access(join(d, row?.rel_path ?? ''));
    h.close();
  });

  it('已是相对路径的不动，且整体幂等', async () => {
    const d = tmp('idem');
    // seed() 才会建 media/ —— 必须先 seed 再写文件（第一版写反了，测试自己 ENOENT）
    const h = await seed(d, [{ role: 'original', rel: 'a.wav' }]);
    await fs.writeFile(join(d, 'media', 'a.wav'), 'a');
    const first = await migrateMediaAssets(h.db, d, join(d, 'media'));
    assert.equal(first.migrated, 0);
    const second = await migrateMediaAssets(h.db, d, join(d, 'media'));
    assert.equal(second.migrated, 0);
    h.close();
  });
});
