/**
 * T-196 —— **随包出厂的东西，页面必须说它已经在这儿了；但不许顺口说"完好"。**
 *
 * ## 用户症状
 *
 * `[用户真机 v0.7.0 Windows]` 组件页对 ffmpeg / ffprobe 显示「可安装 · 145 MB」，
 * 而它们**就在包里**（`runtime/probe/ffmpeg.exe` 113,536,512 B，sha256 已核与用户手上同一份）。
 * Linux 包布局一致 ⇒ 三平台同病。点下去会把 145 MB 再下一遍。
 *
 * ⚠️ 它**不是"用不了"**：`RESOLUTION_PLANS` 里 ffmpeg 是 `['pack','bundle','path']`，
 * 真要转写时用的就是包内那份。坏的只有"页面说它没装"。
 *
 * ## 成因
 *
 * 对账只扫 `ArtifactStore`，按**归档文件名 + sha256** 认。内置那份既不在
 * `by-name/backend/`，也不是归档形态 —— 永远对不上 ⇒ 没有安装记录 ⇒ 页面只能说「可安装」。
 *
 * ## 这个文件守的三条
 *
 * 1. **认得出**：按 `providesFiles` 逐个核，不是给 ffmpeg 加白名单；
 * 2. **不多认**：`providesFiles` 只命中一部分时**不许**记成已安装
 *    （包里那份是裁剪过的基线）；
 * 3. ★ **不许顺口说"完好"**：内置的是解包后的二进制、清单里的 sha256 是归档的，
 *    我们**没有**做过逐字节校验 —— 记录必须能说出"随包出厂、未校验"这第三种状态，
 *    版本取不到就是 UNKNOWN。这一条是本轮最容易造出新谎的地方（Manager 裁决）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-bundled-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { ArtifactStore } from '@openmemo/downloader';
import type { BackendPack, InstalledBackendPack, PlatformSelector } from '@openmemo/shared';

import { BUNDLED_VERSION_UNKNOWN, reconcileBackendManifests } from './backendReconcile.js';

const PLATFORM: PlatformSelector = { os: 'linux', arch: 'x64' };

/** 目录里那条 media-tools 的真实形状（字段取自 v0.7.0 包内的 `vendor/manifests/backends.json`）。 */
function mediaToolsPack(): BackendPack {
  return {
    schemaVersion: 1,
    id: 'media-tools-linux-x64',
    engine: 'ffmpeg',
    engineVersion: 'n8.1.2-34-g9b6c8969e0',
    ggmlAbi: null,
    backend: 'cpu',
    tier: 'downloadable',
    os: 'linux',
    arch: 'x64',
    displayName: 'ffmpeg / ffprobe',
    displayNameZh: 'ffmpeg / ffprobe',
    files: [
      {
        role: 'archive',
        name: 'ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-lgpl-8.1.tar.xz',
        sizeBytes: 111_679_252,
        sha256: 'a'.repeat(64),
        unpack: 'tar.xz',
        mirrors: [{ provider: 'github', url: 'https://example.invalid/x.tar.xz', official: true }],
      },
    ],
    totalSizeBytes: 111_679_252,
    requiresDriver: null,
    license: { id: 'LGPL-2.1-or-later', gated: false, url: 'https://example.invalid' },
    providesFiles: ['ffmpeg', 'ffprobe'],
    priority: 10,
    benchmark: null,
    catalogVersion: '2026.08.10',
  } as unknown as BackendPack;
}

/** 造一个"包内 runtime/probe"目录，并让解析器指向它。 */
async function bundleWith(files: Record<string, number>): Promise<string> {
  const dir = mkdtempSync(join(TEST_ROOT, 'bundle-'));
  const probe = join(dir, 'runtime', 'probe');
  await mkdir(probe, { recursive: true });
  for (const [name, size] of Object.entries(files)) {
    await writeFile(join(probe, name), Buffer.alloc(size, 1));
  }
  // 与启动脚本设的是同一个变量 —— 解析器优先读它（`bundledRuntimeDir()`）
  process.env['OPENMEMO_BUNDLED_WHISPER_DIR'] = probe;
  return probe;
}

async function freshStore(): Promise<ArtifactStore> {
  const root = mkdtempSync(join(TEST_ROOT, 'store-'));
  const store = new ArtifactStore(root);
  await store.init();
  return store;
}

describe('随包出厂的组件要被认出来，但不许被说成"完好"（T-196）', () => {
  it('★ ffmpeg/ffprobe 在包里 ⇒ 补出记录（用户那条「可安装 145 MB」的根因）', async () => {
    await bundleWith({ ffmpeg: 1024, ffprobe: 512 });
    const store = await freshStore();

    const report = await reconcileBackendManifests({
      store,
      packs: [mediaToolsPack()],
      platform: PLATFORM,
    });

    assert.deepEqual(
      report.reconciled.map((r) => r.packId),
      ['media-tools-linux-x64'],
      `包里明明有 ffmpeg/ffprobe 却没补出记录 ⇒ 页面继续说「可安装」，用户会把 145 MB 再下一遍。` +
        `skipped=${JSON.stringify(report.skipped)}`,
    );
    // 体积是**真的**（一次 stat 得来），不是目录里那个下载体积
    assert.equal(report.reconciled[0]?.bytes, 1536);
  });

  it('★★ 记录必须诚实：bundled / 未校验 / 版本 UNKNOWN，一条都不许含糊', async () => {
    await bundleWith({ ffmpeg: 1024, ffprobe: 512 });
    const store = await freshStore();
    await reconcileBackendManifests({ store, packs: [mediaToolsPack()], platform: PLATFORM });

    const rec = await store.readManifest<InstalledBackendPack>('backend', 'media-tools-linux-x64');
    assert.ok(rec, '记录没写出来');

    assert.equal(rec.source, 'bundled', '没有与 downloaded 区分开');
    assert.equal(
      rec.integrity,
      'unverified',
      '内置的是解包后的二进制、清单里的 sha256 是归档的 —— 没做逐字节校验就说"完好"，' +
        '正是这一轮反复在修的那种谎',
    );
    assert.equal(rec.verifiedAt, null, '没验过却盖了个校验时间戳');
    assert.equal(
      rec.engineVersion,
      BUNDLED_VERSION_UNKNOWN,
      '把目录里那个版本号顶替上去 ⇒ 「版本对不上不许记成已安装」那条保护被从内部绕开了',
    );
    for (const f of rec.files) {
      assert.equal(f.sha256, '', `${f.name} 带着一个我们从没算过的摘要`);
      assert.ok(f.sizeBytes > 0, `${f.name} 的体积没记下来`);
    }
    assert.equal(rec.selfTest, null, '从未运行 ≠ 通过');
  });

  it('★ providesFiles 只命中一部分 ⇒ 不许记成已安装（包里那份是裁剪过的基线）', async () => {
    /*
     * `[实测 v0.7.0 linux 包]` `whispercpp-cpu-linux-x64` 的 providesFiles 有 23 项，
     * 包内只有 7 项（缺 14 个 libggml-cpu-* 变体、libparakeet、whisper-bench、whisper-server）。
     * 认下来会让用户以为 15 个 CPU 变体都在。
     */
    await bundleWith({ ffmpeg: 1024 }); // 只有一半
    const store = await freshStore();

    const report = await reconcileBackendManifests({
      store,
      packs: [mediaToolsPack()],
      platform: PLATFORM,
    });

    assert.deepEqual(report.reconciled, [], '只命中一半也认了');
    assert.equal(report.skipped.length, 1, '既没认、也没说为什么 —— 那等于什么都没发生');
    assert.match(
      report.skipped[0]?.reason ?? '',
      /1\/2/,
      `理由里没说清命中几个：${JSON.stringify(report.skipped)}`,
    );
    assert.equal(await store.readManifest('backend', 'media-tools-linux-x64'), null, '不该有记录');
  });

  it('★ 一个都不在（这个包本来就不随包出厂）⇒ 静默跳过，不刷屏', async () => {
    await bundleWith({ 'something-else': 8 });
    const store = await freshStore();
    const report = await reconcileBackendManifests({
      store,
      packs: [mediaToolsPack()],
      platform: PLATFORM,
    });
    assert.deepEqual(report.reconciled, []);
    assert.deepEqual(report.skipped, [], '本来就没装的包不该进 skipped 刷屏');
  });

  it('★ 已经有记录时不覆盖（下载装的那份是更强的证据，不许被降级成 unverified）', async () => {
    await bundleWith({ ffmpeg: 1024, ffprobe: 512 });
    const store = await freshStore();
    const downloaded: InstalledBackendPack = {
      schemaVersion: 1,
      id: 'media-tools-linux-x64',
      engine: 'ffmpeg',
      engineVersion: 'n8.1.2-34-g9b6c8969e0',
      backend: 'cpu',
      installedAt: '2026-01-01T00:00:00.000Z',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      integrity: 'ok',
      source: 'downloaded',
      files: [],
      selfTest: null,
    };
    await store.writeManifest('backend', 'media-tools-linux-x64', downloaded);

    await reconcileBackendManifests({ store, packs: [mediaToolsPack()], platform: PLATFORM });

    const after = await store.readManifest<InstalledBackendPack>(
      'backend',
      'media-tools-linux-x64',
    );
    assert.equal(after?.integrity, 'ok', '把一条真校验过的记录覆盖成了 unverified');
    assert.equal(after?.source, 'downloaded');
  });

  it('★ 不是预编译包布局时（开发树）什么都不做', async () => {
    delete process.env['OPENMEMO_BUNDLED_WHISPER_DIR'];
    const store = await freshStore();
    const report = await reconcileBackendManifests({
      store,
      packs: [mediaToolsPack()],
      platform: PLATFORM,
    });
    assert.deepEqual(report.reconciled, [], '开发树上凭空补出了记录');
  });

  it('★ 平台不符的包不参与（三个 ytdlp 的归档名逐字相同那条教训的同族）', async () => {
    await bundleWith({ ffmpeg: 1024, ffprobe: 512 });
    const store = await freshStore();
    const win = { ...mediaToolsPack(), id: 'media-tools-win-x64', os: 'win32' } as BackendPack;
    const report = await reconcileBackendManifests({ store, packs: [win], platform: PLATFORM });
    assert.deepEqual(report.reconciled, [], '把别的平台的包也宣布成已安装了');
  });
});
