/**
 * ★★ **产品不许删掉数据目录之外的文件 —— 而且不许因此变成"什么都删不掉"。**
 *
 * ## 这个文件守的是 ③，`bundledUninstallGuard.test.ts` 守的是 ②
 *
 * v0.7.2 那道守卫（`DELETE /api/backends/:id` 见到 `source: 'bundled'` 就 409）挡住的是
 * **已确证可达**的那一条路。底层成因是另一件事，在 `resolveInstalledFile()` 里：
 *
 * ```ts
 * if (rec.path) return rec.path;   // legacy —— 原样返回，不作任何检查
 * ```
 *
 * ⇒ **任何** `path` 指向库外的遗留安装记录，都会被 `dropInstalledFiles()` 的
 * `fs.rm` 删掉。守卫拦住的是"我们知道它叫 bundled"的那一类；这里钉的是
 * **"我们不拥有这个路径"**这条结构判据 —— 它不问记录自称是什么。
 *
 * ## 🔴 判据是**两条一起**，缺一条这个文件就没有意义
 *
 *   ① 越界的遗留记录 ⇒ **拒绝，且外面读得出为什么**；
 *   ② 正常的遗留记录 ⇒ **仍然删得掉，且仍然被 `claimedInstallPaths()` 认领**。
 *
 * 只有 ① 的话，「把删除整个禁掉」也能过 —— 那是把一个「删太多」换成一个「删不掉」。
 * 而 ② 里那半句"仍然被认领"是**真的踩过的坑**：把收紧写成「没有 root+relPath 就拒」，
 * 刚装完还没重启过的后端包（只有绝对 `path`，但路径就在库内）会从
 * `claimedInstallPaths()` 掉出去 ⇒ `collectUnclaimed()` 把它当"无法识别的残留"删掉
 * ⇒ **另一个方向的「删太多」**。所以第 ② 条钉的不只是"删得掉"。
 *
 * ## 判据落在文件系统上，不落在返回值上
 *
 * 与 `bundledUninstallGuard.test.ts` 同一条理由：这族缺陷的伤害是**磁盘上的字节没了**。
 * 每条用例都把盘上的文件读回来逐字节比对，返回值只用来核"它说得出为什么"。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/*
 * ⚠️ PROTOCOL §9-bis：模块顶层重定向，窗口为零。
 * `RestState.create()` 会 mkdir 模型根、读写 active.json —— 不重定向就会去动
 * 这台机器上真实的数据目录。
 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-record-bounds-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import type { BackendPack, InstalledBackendPack } from '@openmemo/shared';

import { migrateRecord } from '../../storage/migrateRecords.js';
import { SseHub } from '../sse.js';
import { toInstalledRecord } from './backends.js';
import { RestState } from './state.js';

/** 应用本体里那个文件的替身 —— 内容独一无二，好让"它变了"与"它没了"分得开。 */
const APP_OWNED = Buffer.from('bytes that belong to the installed application, not to the user\n');
/** 库内正常装着的那份 —— 对照组，它**应该**删得掉。 */
const STORE_OWNED = Buffer.from('bytes that live inside the artifact store\n');

interface Seeded {
  readonly state: RestState;
  readonly dataDir: string;
  readonly modelsRoot: string;
}

async function seed(tag: string): Promise<Seeded> {
  const dataDir = mkdtempSync(join(TEST_ROOT, `${tag}-`));
  const modelsRoot = join(dataDir, 'models');
  process.env['OPENMEMO_MODELS'] = modelsRoot;

  const manifestDir = mkdtempSync(join(TEST_ROOT, `${tag}-manifests-`));
  await writeFile(
    join(manifestDir, 'backends.json'),
    JSON.stringify({
      schemaVersion: 1,
      catalogVersion: '2026.08.13',
      generatedAt: '2026-08-13T00:00:00.000Z',
      packs: [],
    }),
    'utf8',
  );

  const state = await RestState.create({ sse: new SseHub(), dataDir, manifestDir });
  return { state, dataDir, modelsRoot };
}

/** 写一条**遗留形状**的后端安装记录：只有绝对 `path`，没有 `root`/`relPath`。 */
async function writeLegacyRecord(
  state: RestState,
  id: string,
  files: { name: string; path: string }[],
): Promise<void> {
  await state.store.writeManifest('backend', id, {
    schemaVersion: 1,
    id,
    engine: 'ffmpeg',
    engineVersion: 'x',
    backend: 'cpu',
    installedAt: '2026-07-01T00:00:00.000Z',
    verifiedAt: '2026-07-01T00:00:00.000Z',
    integrity: 'ok',
    files: files.map((f) => ({ name: f.name, sha256: '', sizeBytes: 1, path: f.path })),
    selfTest: null,
  } as unknown as InstalledBackendPack);
}

/* ══════════════════ ① 越界 ⇒ 拒绝，而且说得出为什么 ══════════════════ */

describe('T-107 ① 指向数据目录之外的遗留安装记录', () => {
  it('★★ 删除时必须被拒 —— 盘上那个文件一个字节都不许少', async () => {
    const { state, dataDir } = await seed('outside');

    // 应用自己的安装目录（**不在**数据目录里，正是随包出厂那份所在的位置）
    const appDir = join(TEST_ROOT, 'installed-app', 'runtime', 'probe');
    await mkdir(appDir, { recursive: true });
    const victim = join(appDir, 'ffmpeg');
    await writeFile(victim, APP_OWNED);
    assert.equal(
      victim.startsWith(dataDir + sep),
      false,
      '夹具搭错了：这个路径落在数据目录里，那就测不到越界',
    );

    await writeLegacyRecord(state, 'bundled-shaped', [{ name: 'ffmpeg', path: victim }]);

    const report = await state.dropInstalledFiles('bundled-shaped', ['backend']);

    /*
     * ★ 第一条断言落在文件系统上。红出来的那一行要直接说
     * 「应用本体的字节被删了」，而不是「期望 1 得到 0」。
     */
    assert.deepEqual(
      await readFile(victim).catch(() => null),
      APP_OWNED,
      '产品删掉了**已安装应用本体**的文件 —— 真机上那是 ~115 MB 的 ffmpeg，' +
        '不在用户的数据目录里，除了把整个产品重下一遍拿不回来',
    );

    /*
     * ★ 第二条：拒绝必须**能被外面读到**。
     *
     * 这一条不是装饰 —— 没有它，「我们拒绝了」和「这条记录本来就没有文件」
     * 在函数外面长得一模一样，于是**把整道闸抽掉，行为观察不出区别**。
     */
    assert.equal(report.refused.length, 1, `拒绝没有留下任何痕迹：${JSON.stringify(report)}`);
    assert.equal(report.refused[0]?.name, 'ffmpeg');
    assert.ok(
      report.refused[0]?.reason.includes(victim),
      `理由里没说是哪个路径，用户和日志都对不上号：${report.refused[0]?.reason ?? '(空)'}`,
    );
    assert.equal(report.removed, 0, '一个都不该删掉');
  });

  it('★ 派生出来的解包目录也要过同一道边界（那一句是 recursive rm）', async () => {
    const { state, modelsRoot } = await seed('derived');

    /*
     * `dropInstalledFiles()` 拿到 `abs` 之后还会算
     * `join(dirname(abs), unpackDirName(name))` 并对它做**递归** `rm`。
     * `abs` 过了闸不代表它过得了：`name` 是记录里的字符串，能带 `../`。
     */
    const archive = join(modelsRoot, 'by-name', 'backend', 'pack.tar.gz');
    await mkdir(join(modelsRoot, 'by-name', 'backend'), { recursive: true });
    await writeFile(archive, STORE_OWNED);

    const escaped = join(TEST_ROOT, 'derived-escape-target');
    await mkdir(escaped, { recursive: true });
    const inside = join(escaped, 'precious.txt');
    await writeFile(inside, APP_OWNED);

    // 从 `<models>/by-name/backend` 往上爬到 TEST_ROOT 再拐进目标目录
    const upToTestRoot = ['..', '..', '..', '..'].join('/');
    await writeLegacyRecord(state, 'derived-escape', [
      { name: `${upToTestRoot}/derived-escape-target`, path: archive },
    ]);

    const report = await state.dropInstalledFiles('derived-escape', ['backend']);

    assert.deepEqual(
      await readFile(inside).catch(() => null),
      APP_OWNED,
      '派生出来的解包目录被递归删了 —— 同一个洞的第二个出口，' + '边界检查只挡住 abs 是不够的',
    );
    assert.ok(
      report.refused.some((r) => r.reason.includes('outside every allowed root')),
      `越界的派生目录被静默跳过了（没进账）：${JSON.stringify(report)}`,
    );
  });
});

/* ══════════ ② 正常的遗留记录：仍然删得掉，仍然被认领 ══════════ */

describe('T-107 ② 收紧不许误伤"路径就在库内"的遗留记录', () => {
  it('★★ 只有绝对 path、但落在库内 ⇒ 照旧删得掉（否则只是把功能关了）', async () => {
    const { state, modelsRoot } = await seed('inside');

    const target = join(modelsRoot, 'by-name', 'backend', 'yt-dlp');
    await mkdir(join(modelsRoot, 'by-name', 'backend'), { recursive: true });
    await writeFile(target, STORE_OWNED);

    await writeLegacyRecord(state, 'legacy-inside', [{ name: 'yt-dlp', path: target }]);

    const report = await state.dropInstalledFiles('legacy-inside', ['backend']);

    await assert.rejects(
      () => readFile(target),
      '库内的遗留记录删不掉了 —— 收紧收过了头，这是把「删太多」换成「删不掉」',
    );
    assert.deepEqual(
      report.refused,
      [],
      `一条完全正常的记录被拒了：${JSON.stringify(report.refused)}`,
    );
    assert.equal(report.removed, 1);
  });

  it('★★ 而且它必须仍然在 `claimedInstallPaths()` 里 —— 否则 GC 会替我们删掉它', async () => {
    /*
     * 🔴 这条是**陷阱守卫**，别删。
     *
     * 把收紧写成「没有 root+relPath 就拒」时，这个形状（`toInstalledRecord()` 写出来的
     * 原样，要到下次启动 `migrateInstallRecords()` 才升级成 root+relPath）会解析失败。
     * 而 `claimedInstallPaths()` 用的是**同一个** `resolveInstalledFile()` ⇒ 这个包
     * 不再被任何记录认领 ⇒ `collectUnclaimed()` 把它当"无法识别的残留"删掉。
     *
     * 于是"修好了删太多"的那一版，会在**另一条路上**把用户刚装好的包删掉。
     * 上面那条"删得掉"的断言**抓不到它** —— 只有这一条抓得到。
     */
    const { state, modelsRoot } = await seed('claimed');

    const target = join(modelsRoot, 'by-name', 'backend', 'yt-dlp');
    await mkdir(join(modelsRoot, 'by-name', 'backend'), { recursive: true });
    await writeFile(target, STORE_OWNED);
    await writeLegacyRecord(state, 'legacy-claimed', [{ name: 'yt-dlp', path: target }]);

    const claimed = await state.claimedInstallPaths();

    assert.ok(
      claimed.has(resolve(target)),
      `刚装完还没重启过的包没被认领 ⇒ collectUnclaimed() 会删掉它。` +
        `认领集合：${JSON.stringify([...claimed])}`,
    );
  });
});

/* ══════════ ③ 治本：库外的文件，记录里根本写不出路径 ══════════ */

describe('T-107 ③ `toInstalledRecord()` 的结构判据', () => {
  const pack = {
    id: 'media-tools-x',
    engine: 'ffmpeg',
    engineVersion: 'n8.1.2',
    backend: 'cpu',
    priority: 10,
  } as unknown as BackendPack;

  it('★ 库内的文件 → 写可移植记录（root+relPath），不再写绝对 path', () => {
    const modelsRoot = resolve(join(TEST_ROOT, 'shape', 'models'));
    const rec = toInstalledRecord(
      pack,
      [
        {
          name: 'yt-dlp',
          sha256: 'a'.repeat(64),
          sizeBytes: 7,
          path: join(modelsRoot, 'by-name', 'backend', 'yt-dlp'),
        },
      ],
      { modelsRoot },
    );

    assert.equal(rec.files[0]?.root, 'models');
    assert.equal(
      rec.files[0]?.relPath,
      'by-name/backend/yt-dlp',
      '没写可移植路径 —— 搬一次数据目录，这条记录就再也指不对了（T-192 同一个结局）',
    );
    assert.equal(
      rec.files[0]?.path,
      undefined,
      '还在写废弃的绝对 path —— 那正是让"库外路径"能被写进记录的那个字段',
    );
  });

  it('★★ 库外的文件 → **一个路径字段都不写**（让删除在形状上不可能）', () => {
    const modelsRoot = resolve(join(TEST_ROOT, 'shape', 'models'));
    const outside = resolve(join(TEST_ROOT, 'shape', 'app', 'runtime', 'probe', 'ffmpeg'));

    const rec = toInstalledRecord(
      pack,
      [{ name: 'ffmpeg', sha256: '', sizeBytes: 9, path: outside }],
      { modelsRoot },
    );

    const f = rec.files[0];
    assert.ok(f, '文件条目整个丢了 —— 记录必须仍然说得出"有哪些文件、多大"');
    assert.equal(f.name, 'ffmpeg');
    assert.equal(f.sizeBytes, 9, '体积是真的（一次 stat 得来），不该跟着路径一起丢掉');

    /*
     * ★ 三个路径字段一个都不许有。
     *
     * 这是这一轮的主线：**让错误写不出来，而不是让它被守卫拦住**。
     * 记录里没有路径 ⇒ `resolveInstalledFile()` 抛「既没 root+relPath 也没 path」
     * ⇒ 删除路径**拿不到可 rm 的路径**，而不是依赖谁记得在入口写
     * `if (source === 'bundled')`。
     */
    assert.equal(f.path, undefined, '把库外的绝对路径写进了记录 —— 删除路径会照着它 rm');
    assert.equal(f.root, undefined);
    assert.equal(f.relPath, undefined);
  });
});

/* ══════════ ④ 守卫不许被自家的启动迁移绕过去 ══════════ */

describe('T-107 ④ 启动迁移的重指判据', () => {
  const STORE = resolve('/store');

  it('★★ 不许把"原本指向库外"的记录，重指到库内一个只是重名的文件上', () => {
    /*
     * `[隔离实例实测]` 上一版按 **basename** 找回来，于是随应用出厂那条记录
     * （path = `<安装目录>/runtime/probe/ffmpeg`）在用户**同时也下载装了**
     * media-tools 时，被启动迁移**悄悄改成**指向
     * `by-name/backend/media-tools-linux-x64/ffmpeg`。
     *
     * 后果不是"多迁了一条"：**一道守卫被自家另一段代码绕过去了** ——
     * 任何把"不许删随包出厂那份"的判据改写成"路径在不在库内"的修法，
     * 都会被这条迁移在启动时悄悄满足掉。
     */
    const bundled = join(resolve('/opt/OpenMemo'), 'runtime', 'probe', 'ffmpeg');
    const decoy = join('by-name', 'backend', 'media-tools-linux-x64', 'ffmpeg');

    const r = migrateRecord(
      { files: [{ name: 'ffmpeg', path: bundled }] },
      STORE,
      new Set([decoy]),
    );

    assert.equal(
      r.changed,
      false,
      `迁移把一条指向应用本体的记录重指到了库里另一个同名文件上 —— ` +
        `笔记：${JSON.stringify(r.notes)}`,
    );
    assert.equal(r.record.files?.[0]?.relPath, undefined);
    assert.equal(
      r.record.files?.[0]?.path,
      bundled,
      '记录被改动了（应当原样保留并计入 unresolved）',
    );
    assert.equal(r.unresolved.length, 1, '既没迁、也没说为什么 —— 那等于什么都没发生');
  });

  it('★ 而"数据目录真的搬过家"仍然要修好（否则只是把自愈关了）', () => {
    /*
     * 两条一起才有意义：上面那条单独看，"把重指整个关掉"也能过 ——
     * 而那会让搬过家的库退回到"记录指向一个不存在的旧路径、删除静默 no-op"。
     */
    const rel = join('by-name', 'asr', 'x.bin');
    const stale = join(resolve('/tmp/old-data-dir'), 'models', rel);

    const r = migrateRecord({ files: [{ name: 'x.bin', path: stale }] }, STORE, new Set([rel]));

    assert.equal(r.changed, true, '搬过家的记录不再自愈了 —— 删除会退回静默 no-op');
    assert.equal(r.record.files?.[0]?.relPath, rel);
    assert.equal(r.record.files?.[0]?.root, 'models');
  });
});
