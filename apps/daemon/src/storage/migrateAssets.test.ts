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
import { probeAssetFile } from '@openmemo/runtime';

import { migrateMediaAssets, __testing } from './migrateAssets.js';

/**
 * 迁移完之后要断言的**不是** rel_path 长什么样，而是
 * **产品照着它真的能读到那份内容** —— 判据钉后果，不钉形式（T-136）。
 *
 * 旧版这两条断言写的是 `fs.readFile(join(dataDir, rel_path))`，也就是把
 * "rel_path 相对 dataDir" 这个**当时的巧合**写成了期望。而同一列上
 * `transcribe.ts` 写的是相对 media 根 —— 两种约定并存正是 T-136 的病根，
 * 一个把好文件报成"已被删除"的假红灯。现在统一用播放端那份解析规则来断言。
 */
async function readViaProduct(dataDir: string, rel: string): Promise<string> {
  const roots = [join(dataDir, 'media'), join(dataDir, 'tmp'), dataDir];
  const probe = await probeAssetFile(roots, rel);
  assert.ok(probe.abs !== null, `产品解析不到 ${rel}（找过：${probe.tried.join('、')}）`);
  return fs.readFile(probe.abs, 'utf8');
}

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
    assert.equal(await readViaProduct(d, paths[0] ?? ''), 'job-AAA');
    assert.equal(await readViaProduct(d, paths[1] ?? ''), 'job-BBB');
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
    assert.equal(await readViaProduct(d, row?.rel_path ?? ''), 'x');
    h.close();
  });

  it('已是相对路径且读得到的不动，且整体幂等', async () => {
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

  /* ---- T-136：相对路径也会指错，而且比绝对路径隐蔽 ------------------------------- */

  it('★ 相对但指错（记录 foo.wav / 文件在 media/legacy/foo.wav）→ 重挂到规范形态', async () => {
    const d = tmp('relwrong');
    const h = await seed(d, [{ role: 'original', rel: 'foo.wav' }]);
    await fs.mkdir(join(d, 'media', 'legacy'), { recursive: true });
    await fs.writeFile(join(d, 'media', 'legacy', 'foo.wav'), 'FOO');
    // 前置条件：迁移前产品**确实读不到**（否则这条用例钉的是零）
    const before = await probeAssetFile([join(d, 'media'), join(d, 'tmp'), d], 'foo.wav');
    assert.equal(before.abs, null, '前置条件不成立：迁移前就能读到，这条用例证明不了任何事');

    const r = await migrateMediaAssets(h.db, d, join(d, 'media'));
    assert.equal(r.migrated, 1);
    const row = h.db.prepare<{ rel_path: string }>('SELECT rel_path FROM media_assets').get();
    assert.equal(row?.rel_path, join('legacy', 'foo.wav'));
    assert.equal(await readViaProduct(d, row?.rel_path ?? ''), 'FOO');
    // 幂等：第二遍不再改
    assert.equal((await migrateMediaAssets(h.db, d, join(d, 'media'))).migrated, 0);
    h.close();
  });

  it('★ 相对且指错、但同名文件不止一个 → 不猜，记 unresolved 且记录不动', async () => {
    const d = tmp('ambig');
    const h = await seed(d, [{ role: 'audio16k', rel: 'audio16k.wav' }]);
    for (const j of ['job-AAA', 'job-BBB']) {
      await fs.mkdir(join(d, 'media', j), { recursive: true });
      await fs.writeFile(join(d, 'media', j, 'audio16k.wav'), j);
    }
    const r = await migrateMediaAssets(h.db, d, join(d, 'media'));
    assert.equal(r.migrated, 0);
    assert.equal(r.unresolved.length, 1);
    const row = h.db.prepare<{ rel_path: string }>('SELECT rel_path FROM media_assets').get();
    assert.equal(row?.rel_path, 'audio16k.wav', '记录被猜着改了');
    h.close();
  });

  it('★ 相对且指错、但目标已被别的资产占用 → 不迁，绝不把两条挂到同一个文件', async () => {
    const d = tmp('claimed');
    const h = await seed(d, [
      { role: 'original', rel: join('legacy', 'b.wav') }, // 已经挂在那儿
      { role: 'audio16k', rel: 'b.wav' }, // 指错，唯一候选正是上面那份
    ]);
    await fs.mkdir(join(d, 'media', 'legacy'), { recursive: true });
    await fs.writeFile(join(d, 'media', 'legacy', 'b.wav'), 'B');
    const r = await migrateMediaAssets(h.db, d, join(d, 'media'));
    assert.equal(r.migrated, 0);
    assert.equal(r.unresolved.length, 1);
    const paths = h.db
      .prepare<{ rel_path: string }>('SELECT rel_path FROM media_assets ORDER BY id')
      .all()
      .map((x) => x.rel_path);
    assert.deepEqual(paths, [join('legacy', 'b.wav'), 'b.wav']);
    h.close();
  });

  it('★ 相对路径解析得到、但记的是相对 dataDir 的老形态 → 保持能读（不制造假红灯）', async () => {
    // 这就是用户库里那两条 `media/legacy/…`：相对 dataDir 存的，
    // 播放端与自检都必须认得它，不许报"文件已不存在"。
    const d = tmp('legacyform');
    const h = await seed(d, [{ role: 'audio16k', rel: 'media/legacy/x.wav' }]);
    await fs.mkdir(join(d, 'media', 'legacy'), { recursive: true });
    await fs.writeFile(join(d, 'media', 'legacy', 'x.wav'), 'X');
    const r = await migrateMediaAssets(h.db, d, join(d, 'media'));
    assert.equal(r.migrated, 0, '读得到的记录不该被动');
    assert.equal(await readViaProduct(d, 'media/legacy/x.wav'), 'X');
    h.close();
  });
});

/**
 * ★ T-143 ④：`matchBySuffix` 对**文件系统路径**硬编码了 `/`。
 *
 * 这一组用 `path.win32` 的分隔符**在 Linux 上**把 Windows 那半边跑一遍 ——
 * 因为「必须有一台 Windows 才能验证」等价于「永远不会被验证」
 * （platform 报告实测：全仓 42 处平台分支，34 处在本机永远走不到）。
 *
 * 判据钉的是后果：**迁移后那条记录还找不找得回它的文件**。
 */
describe('★ T-143 ④ 路径匹配器的分隔符（Windows 那半边，在 Linux 上验）', () => {
  const WIN = '\\';
  const POSIX = '/';

  /** Windows 上 `indexFiles` 产出的索引长这样：`relative()` 用的是宿主分隔符。 */
  const winIndex = new Set([
    'tmp\\job-AAA\\audio16k.wav',
    'tmp\\job-BBB\\audio16k.wav',
    'media\\legacy\\foo.wav',
  ]);

  it('★ 失效的 Windows 绝对路径 → 按最长后缀找回来（旧写法在这里永远返回 undefined）', () => {
    const abs = 'C:\\old-datadir\\tmp\\job-AAA\\audio16k.wav';

    // 先证明这条用例钉的不是零：旧写法（对文件系统路径 split('/')）在这里是瞎的
    const legacy = ((): string | undefined => {
      const parts = abs.split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const cand = parts.slice(i).join('/');
        if (winIndex.has(cand)) return cand;
      }
      return undefined;
    })();
    assert.equal(legacy, undefined, '旧写法本应在此失效；它若能命中，本用例证明不了任何东西');

    assert.equal(__testing.matchBySuffix(abs, winIndex, WIN), 'tmp\\job-AAA\\audio16k.wav');
  });

  it('★ 返回的是**索引里的原始条目**（调用方要拿它 join，形态必须与文件系统一致）', () => {
    const hit = __testing.matchBySuffix('C:\\x\\tmp\\job-BBB\\audio16k.wav', winIndex, WIN);
    assert.equal(hit, 'tmp\\job-BBB\\audio16k.wav');
    assert.equal(hit?.includes('/'), false, '不许把 Windows 路径改写成 / 形态');
  });

  it('★ 最长后缀优先：绝不能退化成"按文件名匹配"（两条笔记的 audio16k.wav 会互串）', () => {
    // 只给文件名，两条都以它结尾 → 必须放弃，而不是随便挑一条
    assert.equal(__testing.matchByTail('audio16k.wav', winIndex, WIN), undefined);
    // 带上目录段就唯一了
    assert.equal(
      __testing.matchByTail('job-AAA\\audio16k.wav', winIndex, WIN),
      'tmp\\job-AAA\\audio16k.wav',
    );
  });

  it('★ 相对但指错（记录少了前缀）在 Windows 形态下同样救得回来', () => {
    assert.equal(__testing.matchByTail('foo.wav', winIndex, WIN), 'media\\legacy\\foo.wav');
  });

  it('★ posix 行为一个字都不许变（这是用户库真正跑的那一条）', () => {
    const idx = new Set(['tmp/job-AAA/audio16k.wav', 'media/legacy/foo.wav', 'jfk.wav']);
    assert.equal(
      __testing.matchBySuffix('/tmp/dd55/tmp/job-AAA/audio16k.wav', idx, POSIX),
      'tmp/job-AAA/audio16k.wav',
    );
    assert.equal(__testing.matchBySuffix('/gone/nothing.wav', idx, POSIX), undefined);
    assert.equal(__testing.matchByTail('foo.wav', idx, POSIX), 'media/legacy/foo.wav');
    assert.equal(__testing.matchByTail('audio16k.wav', idx, POSIX), 'tmp/job-AAA/audio16k.wav');
  });

  it('★ 不给分隔符时用宿主的 —— 产品路径上的默认行为不变', () => {
    const idx = new Set(['tmp/job-AAA/audio16k.wav']);
    assert.equal(
      __testing.matchBySuffix('/old/tmp/job-AAA/audio16k.wav', idx),
      'tmp/job-AAA/audio16k.wav',
    );
  });
});
