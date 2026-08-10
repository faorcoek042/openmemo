/**
 * T-193 ② —— 「无法识别的残留」要**看得见、删得掉**，而且**删之前得能证明它没在用**。
 *
 * ## 用户机器上真实存在的东西
 *
 * `[用户真机实测 2026-08-10，:10000]`
 * ```
 * by-name/backend/whisper-bin-ubuntu-x64/       24,259,400 B
 * by-name/backend/whisper-bin-ubuntu-x64.tar.gz  9,379,235 B
 * ```
 * 08-02 装的是当时目录指向的**上游归档**；08-07 T-167 把**同一个 id** 换成我们自建的
 * 那份。重装之后安装记录指向新归档，旧的两份**没有任何人认领** ——
 * 明细里查不到（它按记录列）、界面上删不掉、GC 也不扫（只扫 `blobs/`）。
 * 对账正好：`usedBytes − 明细合计 = 9,379,235`。
 * **他看到的就是一个"说不清、也删不掉"的 9.4 MB。**
 *
 * ## ★ 这个文件真正守的那条：**"没有记录认领" ≠ "没在用"**
 *
 * `by-name/backend/` 正是 `resolveBackendTool()` 的**发现路径**（T-192 已经证明）。
 * 一个没有 manifest 的目录**仍然可能正在被解析、被执行**。
 * 按"扫到没 manifest 的就删"去做，**用户的转写会当场坏掉，而且他不会知道为什么**。
 *
 * 所以判据是两道闸：① 没被任何安装记录认领；② **产品自己的解析器
 * （`discoverTools()`，与流水线装配调的是同一个）当前没有把任何工具解析到它里面**。
 *
 * ## 把名字遮住，这些断言什么时候会失败
 *
 * 任何人把第二道闸去掉（"反正没 manifest"）、
 * 或者反过来把残留藏起来不显示（"看不见就不用解释"）、
 * 或者在解析器失败时仍然照删（"我问不出来"被当成"它没在用"）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-unclaimed-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { SseHub } from '../sse.js';
import { RestState } from './state.js';

const REPO_ROOT = resolve(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
);
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

const PAYLOAD = Buffer.alloc(1024 * 1024, 3); // 1 MiB
const SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');

/** `du`：按 (dev,ino) 去重。 */
async function realBytes(root: string): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await stat(p);
      const key = `${String(st.dev)}:${String(st.ino)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total += st.size;
    }
  };
  await walk(root);
  return total;
}

async function seed(): Promise<RestState> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  return await RestState.create({ sse: new SseHub(), dataDir, manifestDir: MANIFEST_DIR });
}

/** 一份**有记录**的后端包（认领了归档 + 解开的目录）。 */
async function installClaimed(state: RestState): Promise<void> {
  const archive = 'claimed-pack.tar.gz';
  await writeFile(state.store.blobPath(SHA256), PAYLOAD);
  await state.store.linkByName('backend', SHA256, archive);
  const unpacked = join(state.store.root, 'by-name', 'backend', 'claimed-pack');
  await mkdir(unpacked, { recursive: true });
  await writeFile(join(unpacked, 'claimed-cli'), PAYLOAD, { mode: 0o755 });
  await state.store.writeManifest('backend', 'claimed-pack', {
    schemaVersion: 1,
    id: 'claimed-pack',
    engine: 'whisper.cpp',
    engineVersion: 'v1.9.1',
    backend: 'cpu',
    installedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    integrity: 'ok',
    files: [
      {
        role: 'archive',
        name: archive,
        sha256: SHA256,
        sizeBytes: PAYLOAD.length,
        root: 'models',
        relPath: join('by-name', 'backend', archive),
      },
    ],
    selfTest: null,
  });
}

/** 一份**没有记录**的残留 —— 用户机器上那两个的形状。 */
async function leaveOrphan(state: RestState, name: string, binary = 'orphan-cli'): Promise<void> {
  const dir = join(state.store.root, 'by-name', 'backend', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, binary), PAYLOAD, { mode: 0o755 });
}

describe('无法识别的残留：看得见 / 删得掉 / 删之前证明没在用（T-193 ②）', () => {
  it('★ 没人认领的目录必须被找出来，有人认领的一个都不许误报', async () => {
    const state = await seed();
    await installClaimed(state);
    await leaveOrphan(state, 'whisper-bin-ubuntu-x64');

    const found = await state.findUnclaimedFiles();
    const names = found.map((x) => x.relPath);

    assert.ok(
      names.some((n) => n.includes('whisper-bin-ubuntu-x64')),
      `残留没被找出来 —— 用户看到的差额仍然说不清：${names.join(', ')}`,
    );
    assert.equal(
      names.some((n) => n.includes('claimed-pack')),
      false,
      `把**有安装记录**的东西报成了残留 —— 照这个删会删掉用户正在用的包：${names.join(', ')}`,
    );
  });

  it('★ 残留必须进 `reclaimable.unclaimedBytes`，而且明细里看得见', async () => {
    const state = await seed();
    await installClaimed(state);
    await leaveOrphan(state, 'whisper-bin-ubuntu-x64');

    const storage = await state.buildStorage();
    assert.ok(
      (storage.reclaimable.unclaimedBytes ?? 0) >= PAYLOAD.length,
      `可回收里没算上残留：${String(storage.reclaimable.unclaimedBytes)}`,
    );
    assert.ok(
      storage.breakdown.some((b) => b.id === '__unclaimed__'),
      '明细里没有「无法识别的残留」这一项 —— 用户仍然只能看到一个对不上的差额',
    );
  });

  it('★★ 第二道闸：产品自己解析到的残留**不许**被算成可回收，也不许被删', async () => {
    const state = await seed();
    /*
     * 只留残留、不装任何有记录的包 ⇒ `resolveBackendTool()` 会从这个**没有 manifest**
     * 的目录里解析出 whisper-cli（T-192 证明过：没有记录的目录仍在发现路径里）。
     */
    await leaveOrphan(state, 'stale-but-live', 'whisper-cli');

    const found = await state.findUnclaimedFiles();
    const live = found.find((x) => x.relPath.includes('stale-but-live'));
    assert.ok(live, '残留本身没被找出来，这条就没在测第二道闸');
    assert.notEqual(
      live.inUseBy,
      null,
      '产品正从它里面解析 whisper-cli，却被判成"没在用" —— 删了转写当场坏，而用户不会知道为什么',
    );

    const storage = await state.buildStorage();
    assert.equal(
      storage.reclaimable.unclaimedBytes ?? 0,
      0,
      '正在被解析的残留被算进了"可回收" —— 那个数字在诱导用户删掉正在用的东西',
    );

    const before = await realBytes(state.store.root);
    const gc = await state.collectUnclaimed();
    const after = await realBytes(state.store.root);
    assert.equal(gc.removedFiles, 0, '正在被用的残留被删掉了');
    assert.equal(after, before, '磁盘少了字节 ⇒ 确实删了不该删的');
  });

  it('★ 确认没在用的残留：删得掉，且磁盘真的少了那么多', async () => {
    const state = await seed();
    await installClaimed(state);
    // 名字刻意不是任何工具名 ⇒ 解析器不会碰它
    await leaveOrphan(state, 'whisper-bin-ubuntu-x64', 'some-leftover.bin');

    const before = await realBytes(state.store.root);
    const gc = await state.collectUnclaimed();
    const after = await realBytes(state.store.root);

    assert.ok(gc.removedFiles > 0, '一个都没删');
    assert.ok(
      before - after >= PAYLOAD.length,
      `磁盘只少了 ${before - after} 字节，至少应当少 ${PAYLOAD.length} —— 又是一个假的 freedBytes`,
    );
    assert.ok(
      gc.freedBytes <= before - after,
      `报的 freedBytes(${gc.freedBytes}) 大于真的少掉的(${before - after})`,
    );
    // 有记录的那个包必须原封不动
    assert.equal(
      (await state.findUnclaimedFiles()).some((x) => x.relPath.includes('claimed-pack')),
      false,
    );
    const claimed = join(state.store.root, 'by-name', 'backend', 'claimed-pack', 'claimed-cli');
    assert.ok((await stat(claimed)).isFile(), '把有记录的包一起删了');
  });

  it('★★ 更新路径（同一个 id 换内容）留下的残留，必须被扫到、且可回收', async () => {
    /*
     * T-195 追加：Manager 点名要确认的那条。
     *
     * `POST /api/backends/install` 打到一个**已装**的 id 上时，安装器写新 blob、
     * 新硬链、解开到 `by-name/backend/<新归档名>/`，然后**覆盖**安装记录。
     * 旧归档与旧解压目录**没有任何人认领** —— 既不在新记录的 `files[]` 里，
     * 也不在任何别的记录里。
     *
     * `[用户真机实测 2026-08-10，:10000]` 这正是他机器上那 33.6 MB 的来源
     * （08-02 装上游包 → 08-07 同一个 id 换成自建包）；另有 279 MB 是同一形状的
     * 布局约定变更留下的。合计 298 MB，全部确认没在用。
     *
     * ⚠️ 这条只证明**事后扫得到、收得回**。**根治仍然在安装器写新落点那一刻**
     * （Manager 2026-08-10 裁定）—— 事后扫是网，不是治。
     */
    const state = await seed();

    // ① 旧版：装上去（有记录、被认领）
    await installClaimed(state);
    assert.equal(
      (await state.findUnclaimedFiles()).some((x) => x.relPath.includes('claimed-pack')),
      false,
      '前提：装着的时候它必须是"被认领"的，否则下面证明不了残留是更新造成的',
    );

    // ② 更新：同一个 id、另一个归档 —— 安装记录被覆盖，旧文件原地留下
    const v2 = Buffer.concat([PAYLOAD, Buffer.from('v2')]);
    const newSha = createHash('sha256').update(v2).digest('hex');
    const newArchive = 'claimed-pack-v2.tar.gz';
    await writeFile(state.store.blobPath(newSha), v2);
    await state.store.linkByName('backend', newSha, newArchive);
    const newUnpacked = join(state.store.root, 'by-name', 'backend', 'claimed-pack-v2');
    await mkdir(newUnpacked, { recursive: true });
    await writeFile(join(newUnpacked, 'claimed-cli'), v2, { mode: 0o755 });
    await state.store.writeManifest('backend', 'claimed-pack', {
      schemaVersion: 1,
      id: 'claimed-pack',
      engine: 'whisper.cpp',
      engineVersion: 'v1.9.2',
      backend: 'cpu',
      installedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      integrity: 'ok',
      files: [
        {
          role: 'archive',
          name: newArchive,
          sha256: newSha,
          sizeBytes: v2.length,
          root: 'models',
          relPath: join('by-name', 'backend', newArchive),
        },
      ],
      selfTest: null,
    });

    // ③ 旧的那两份现在没人认领 —— 扫得到吗？
    const found = await state.findUnclaimedFiles();
    assert.ok(
      found.some((x) => /claimed-pack(\.tar\.gz)?$/.test(x.relPath)),
      '更新留下的旧文件没被扫到 —— 用户会看到一份说不清也删不掉的死重：' +
        found.map((x) => x.relPath).join(', '),
    );
    assert.equal(
      found.some((x) => x.relPath.includes('claimed-pack-v2')),
      false,
      '把**刚更新上去的**那一份报成了残留 —— 照这个删会删掉用户刚装的东西',
    );

    // ④ 收得回吗？按 du 量，不是按"文件不见了"
    const before = await realBytes(state.store.root);
    const gc = await state.collectUnclaimed();
    const after = await realBytes(state.store.root);
    assert.ok(gc.removedFiles > 0, '一个都没回收');
    assert.ok(before - after > 0, `磁盘一个字节都没少（报了 ${gc.freedBytes}）`);
    assert.ok(
      (await stat(join(newUnpacked, 'claimed-cli'))).isFile(),
      '把刚更新上去的那一份删掉了',
    );
  });
  it('★ 「报的可回收」与「真删掉的」必须出自同一份判断（否则界面会承诺一件不会发生的事）', async () => {
    const state = await seed();
    await installClaimed(state);
    await leaveOrphan(state, 'whisper-bin-ubuntu-x64', 'some-leftover.bin');

    /*
     * 上一版 `collectUnclaimed()` 自己又跑了一次 `discoverTools()` 判断能不能删，
     * 而 `buildStorage()` 用的是 `findUnclaimedFiles()` 的结果 —— **两处各自决定**。
     * 解析器一失败，界面报一个 298 MB 的可回收，而点下去一个字节都不删。
     * 现在只有一处判断（`inUseBy`），这条断言把"只有一处"钉住。
     */
    const promised = (await state.buildStorage()).reclaimable.unclaimedBytes ?? 0;
    const delivered = (await state.collectUnclaimed()).freedBytes;
    assert.equal(
      delivered,
      promised,
      `界面承诺可回收 ${promised}，实际删了 ${delivered} —— 两份判断漂移了`,
    );
    assert.ok(promised > 0, '两个都是 0 的话这条断言在空跑');
  });

  it('★ `usedBytes` 必须把解开的目录算进去（那正是少算 840 MB 的成因）', async () => {
    const state = await seed();
    await installClaimed(state);

    const used = await state.store.usedBytes();
    const real = await realBytes(state.store.root);
    assert.equal(
      used,
      real,
      `usedBytes(${used}) 与按 (dev,ino) 去重的真实占用(${real}) 对不上 —— ` +
        `用户机器上这个差额是 840,494,883 字节`,
    );
    // 归档与 blob 是同一个 inode，不许被数两遍
    assert.ok(used < PAYLOAD.length * 3, `硬链被数了两遍：used=${used}`);
  });
});
