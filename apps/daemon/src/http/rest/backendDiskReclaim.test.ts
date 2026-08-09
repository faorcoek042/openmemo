/**
 * T-192 ③ —— **卸载后端包不回收磁盘，而且"删掉"的包还在被解析到。**
 *
 * ## 缺陷原状
 *
 * `DELETE /api/backends/:id` 只做两件事：
 *
 * ```
 * store.removeManifest('backend', id)
 * store.collectGarbage(['orphan_blobs'])      → 事件里报一个 freedBytes
 * ```
 *
 * 而 `findGarbage()` **只扫 `blobs/`**，`by-name/backend/<归档名>` 那条硬链
 * 与解开的目录**原封不动**。硬链与 blob 共用 inode ⇒
 * **只要还有一条链指着，磁盘一个字节都不会回收**。
 *
 * 这与 T-164 在**模型**那一格修掉的是同一个 bug、同一个成因 ——
 * 那次的修法（`dropInstalledFiles()`）里写着 `if (kind === 'backend') continue`，
 * **backend 桶从来没有人清过**。
 *
 * ## 第二个后果比空间更重
 *
 * `by-name/backend/` 是 `findInBackendPacks()` / `resolveBackendTool()` 的**发现路径**。
 * 一个"已卸载"的后端包留在那儿 **仍然会被解析到并真的跑起来** ——
 * 用户以为删了，产品还在用它。所以这个文件既验字节，也验"还找不找得到"。
 *
 * ## 判据：**报出去的 freedBytes 必须等于磁盘上真的少掉的字节数**
 *
 * 不写成"by-name 下那个文件不存在了" —— 那是形式，可以用别的方式满足（改个名也行），
 * 而用户关心的是 `df` 上的数字。所以这里自己按 **(dev, ino) 去重**算真实占用
 * （`du` 的算法），删前删后各一次。缺陷版本下差值恒为 **0**。
 *
 * ⚠️ PROTOCOL §9-bis：模型根与扩展目录在**模块顶层**钉进 tmp，窗口为零。
 * `RestState.create()` 会 mkdir 模型根、读写 `active.json` / `prefs.json` ——
 * 不重定向就会去动这台机器上真实的数据目录（用户的 demo 就在那儿）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-bkreclaim-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { findInBackendPacks } from '@openmemo/pipeline';

import { SseHub } from '../sse.js';
import { RestState } from './state.js';

const REPO_ROOT = resolve(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
);
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

const PACK_ID = 'reclaim-test-backend';
/** 归档名 —— 安装器按它建 `by-name/backend/<unpackDirName(name)>/`。 */
const ARCHIVE = 'reclaim-test-pack.tar.gz';
/** 包里那个可执行文件：既是体积的大头，也是"还找不找得到"的判据。 */
const BINARY = 'reclaim-test-cli';
const PAYLOAD_BYTES = 4 * 1024 * 1024;
const PAYLOAD = Buffer.alloc(PAYLOAD_BYTES, 9);
const SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');

/** `du` 的算法：按 (dev, ino) 去重再求和 —— 不去重的话硬链会被数两遍。 */
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

/**
 * 造一台"装过一个后端包"的机器 —— 走 store 自己的 API，不手工摆目录：
 * blob 落 `blobs/sha256-…`、`linkByName` 硬链进 `by-name/backend/`、
 * 再摊一份解开后的目录（安装器对带 `unpack` 的包会做的那一步），
 * 最后写一份与安装器同形的 manifest。
 */
async function seed(): Promise<{ state: RestState; modelsRoot: string }> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  const state = await RestState.create({ sse: new SseHub(), dataDir, manifestDir: MANIFEST_DIR });
  const modelsRoot = state.store.root;

  await writeFile(state.store.blobPath(SHA256), PAYLOAD);
  await state.store.linkByName('backend', SHA256, ARCHIVE);

  // 解开后的目录：`by-name/backend/<归档名去掉后缀>/<可执行文件>`
  const unpacked = join(modelsRoot, 'by-name', 'backend', 'reclaim-test-pack');
  await mkdir(unpacked, { recursive: true });
  await writeFile(join(unpacked, BINARY), PAYLOAD, { mode: 0o755 });

  await state.store.writeManifest('backend', PACK_ID, {
    schemaVersion: 1,
    id: PACK_ID,
    engine: 'whisper.cpp',
    engineVersion: 'v1.9.1',
    backend: 'vulkan',
    installedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    integrity: 'ok',
    files: [
      {
        role: 'archive',
        name: ARCHIVE,
        sha256: SHA256,
        sizeBytes: PAYLOAD_BYTES,
        root: 'models',
        relPath: join('by-name', 'backend', ARCHIVE),
      },
    ],
    selfTest: null,
  });
  return { state, modelsRoot };
}

describe('卸载后端包必须真的回收磁盘，且不再被解析到（T-192 ③）', () => {
  it('★ freedBytes 必须等于磁盘上真的少掉的字节数（缺陷版本下差值恒为 0）', async () => {
    const { state, modelsRoot } = await seed();

    const before = await realBytes(modelsRoot);
    assert.ok(
      before >= PAYLOAD_BYTES,
      `种子没落地，这条就没在测回收：before=${before}，至少应有 ${PAYLOAD_BYTES}`,
    );

    // 这两步就是 `DELETE /api/backends/:id` 做的事
    await state.dropInstalledFiles(PACK_ID, ['backend']);
    await state.store.removeManifest('backend', PACK_ID);
    const gc = await state.store.collectGarbage(['orphan_blobs']);

    const after = await realBytes(modelsRoot);
    const actuallyFreed = before - after;

    assert.ok(
      actuallyFreed >= PAYLOAD_BYTES,
      `磁盘只少了 ${actuallyFreed} 字节，至少应当少 ${PAYLOAD_BYTES} ——\n` +
        `  硬链还在的话，blob 删了也不回收，而事件里照样报一个 freedBytes。`,
    );
    assert.ok(
      gc.freedBytes <= actuallyFreed,
      `报出去的 freedBytes(${gc.freedBytes}) 大于磁盘真的少掉的(${actuallyFreed}) —— 那是个假数字`,
    );
  });

  it('★ 卸载之后，`findInBackendPacks()` 必须再也找不到它', async () => {
    const { state, modelsRoot } = await seed();

    assert.equal(
      (await findInBackendPacks(modelsRoot, BINARY)) === null,
      false,
      '种子没落地：装着的时候就该找得到，否则下面那条否定断言没有意义',
    );

    await state.dropInstalledFiles(PACK_ID, ['backend']);
    await state.store.removeManifest('backend', PACK_ID);

    assert.equal(
      await findInBackendPacks(modelsRoot, BINARY),
      null,
      '"已卸载"的包仍然在发现路径里 —— 用户以为删了，产品还在用它',
    );
  });

  it('★ 默认参数不许把 backend 桶卷进来（模型那条路的行为一字不改）', async () => {
    const { state, modelsRoot } = await seed();
    // 不传 kinds ⇒ 只清模型那几个桶，后端包必须原封不动
    await state.dropInstalledFiles(PACK_ID);
    assert.equal(
      (await findInBackendPacks(modelsRoot, BINARY)) === null,
      false,
      '默认参数把后端包也删了 —— 模型 id 与后端包 id 撞名时会误删别人的东西',
    );
  });
});
