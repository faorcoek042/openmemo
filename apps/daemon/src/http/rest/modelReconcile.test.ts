/**
 * D-20 §11.2 —— 首次运行把包内模型导入 ArtifactStore。
 *
 * ## 修的是哪个洞
 *
 * `[实测]` `grep -rn "BUNDLED_MODELS|bundledModels|resolveBundledModel"` 在这个改动之前
 * 是 0 命中：模型的唯一发现路径是 `ArtifactStore`，只把字节塞进包，产品一个都读不到，
 * 也不会报任何错。这份测试断言的是**导入之后 `ArtifactStore` 真的认得它**——
 * 不是"文件被复制了"，而是 `readManifest`/`hasBlob`/`by-name` 三处都对得上。
 *
 * ## 夹具：真实目录条目 + 合成字节
 *
 * 与 `retiredRoles.test.ts` 同一条教训："手搓一份 ModelEntry"连撞两轮 schema 校验，
 * 且与本测试要验的事情无关。所以这里的骨架（role/family/engines/license/…）
 * 全部来自 `vendor/manifests` 里真实的三条，只把 `files` 换成磁盘上真实存在、
 * 内容已知的合成字节——真实模型字节有几十 MB，单测不下载它们。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-modelrc-'));

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ArtifactStore } from '@openmemo/downloader';
import type { InstalledModel, ModelEntry } from '@openmemo/shared';

import { reconcileBundledModels } from './modelReconcile.js';
import { roleToStoreKind } from './roleMap.js';

const MANIFEST_DIR = fileURLToPath(new URL('../../../../../vendor/manifests', import.meta.url));

function realModels(file: string): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(join(MANIFEST_DIR, file), 'utf8')) as {
    models?: Record<string, unknown>[];
  };
  return raw.models ?? [];
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** `INSTALLED_AT` 的语义：包内文件本身的 mtime，不是"现在"——用来断言这一条没被抄错。 */
const INSTALLED_AT = new Date('2026-07-01T08:09:10.000Z');

/**
 * 合成字节的登记表：`<模型 id>/<文件名>` → 内容。
 * 用文件名（而不是模型 id）当唯一约束，因为 sherpa 那条有 4 个文件。
 */
function synthBytes(id: string, name: string): Buffer {
  return Buffer.from(`synthetic bytes for ${id}/${name}, not the real model weights`);
}

/** 真实条目，`files` 换成合成字节；除 files/totalSizeBytes 外每个字段都来自真实清单。 */
function synthEntry(raw: Record<string, unknown>): ModelEntry {
  const id = raw['id'] as string;
  const files = (raw['files'] as Record<string, unknown>[]).map((f) => {
    const bytes = synthBytes(id, f['name'] as string);
    return { ...f, sizeBytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    ...raw,
    files,
    totalSizeBytes: files.reduce((a, f) => a + (f['sizeBytes'] as number), 0),
  } as unknown as ModelEntry;
}

const RAW_VAD = realModels('models-asr-support.json').find(
  (m) => m['id'] === 'vad/silero-vad-ggml',
);
const RAW_TINY = realModels('models-whisper.json').find((m) => m['id'] === 'asr/whisper-tiny-q5_1');
const RAW_STREAMING = realModels('models-asr-support.json').find(
  (m) => m['id'] === 'asr/sherpa-streaming-zh-14m',
);
assert.ok(RAW_VAD, '真清单里没有 vad/silero-vad-ggml —— BUNDLED_MODEL_IDS 与目录已经不同步');
assert.ok(RAW_TINY, '真清单里没有 asr/whisper-tiny-q5_1');
assert.ok(RAW_STREAMING, '真清单里没有 asr/sherpa-streaming-zh-14m');

const VAD = synthEntry(RAW_VAD);
const TINY = synthEntry(RAW_TINY);
const STREAMING = synthEntry(RAW_STREAMING);
const ALL_THREE = [VAD, TINY, STREAMING];

/** 把一个（合成过的）ModelEntry 的全部文件真实落到 `<bundledDir>/<id>/<name>`。 */
async function seedBundledFile(bundledDir: string, entry: ModelEntry): Promise<void> {
  const dir = join(bundledDir, entry.id);
  await mkdir(dir, { recursive: true });
  for (const f of entry.files) {
    const bytes = synthBytes(entry.id, f.name);
    const p = join(dir, f.name);
    await writeFile(p, bytes);
    await utimes(p, INSTALLED_AT, INSTALLED_AT);
  }
}

async function freshStore(): Promise<ArtifactStore> {
  const root = mkdtempSync(join(TEST_ROOT, 'store-'));
  const store = new ArtifactStore(root);
  await store.init();
  return store;
}

describe('D-20 §11.2 reconcileBundledModels', () => {
  it('★★ 三个都在：全部导入，ArtifactStore 三处读取都对得上（不只是"文件存在"）', async () => {
    const store = await freshStore();
    const bundledDir = mkdtempSync(join(TEST_ROOT, 'bundled-'));
    for (const e of ALL_THREE) await seedBundledFile(bundledDir, e);

    const report = await reconcileBundledModels({
      store,
      models: ALL_THREE,
      bundledModelsDir: bundledDir,
    });
    assert.equal(report.imported.length, 3, `期望 3 个导入，实得 ${JSON.stringify(report)}`);
    assert.equal(report.skipped.length, 0, `不该有任何跳过：${JSON.stringify(report.skipped)}`);

    for (const e of ALL_THREE) {
      const kind = roleToStoreKind(e.role);
      const rec = await store.readManifest<InstalledModel>(kind, e.id);
      assert.ok(rec, `${e.id} 没有写出安装记录`);
      assert.equal(rec!.integrity, 'ok');
      assert.equal(rec!.benchmark, null, '内置 ≠ 在本机测过基准');
      assert.equal(
        rec!.installedAt,
        INSTALLED_AT.toISOString(),
        `installedAt 应当是包内文件本身的 mtime，不是"现在"`,
      );
      assert.ok(
        Date.now() - Date.parse(rec!.verifiedAt ?? '') < 60_000,
        'verifiedAt 才是"现在"——刚刚逐字节校验过',
      );
      assert.equal(rec!.files.length, e.files.length);
      for (const f of rec!.files) {
        assert.equal(f.root, 'models');
        assert.ok(f.relPath, `${e.id}/${f.name} 缺 relPath`);
        assert.equal(
          await store.hasBlob(f.sha256),
          true,
          `${f.name} 的 blob 没有真的落到 store 里`,
        );
      }
    }
  });

  it('★ 同盘落地是硬链接：blob 与包内源文件共享同一个 inode（零额外字节）', async () => {
    const store = await freshStore();
    const bundledDir = mkdtempSync(join(TEST_ROOT, 'bundled-'));
    await seedBundledFile(bundledDir, VAD);

    await reconcileBundledModels({ store, models: [VAD], bundledModelsDir: bundledDir });
    const kind = roleToStoreKind(VAD.role);
    const rec = await store.readManifest<InstalledModel>(kind, VAD.id);
    const digest = rec!.files[0]!.sha256;

    const srcPath = join(bundledDir, VAD.id, VAD.files[0]!.name);
    const srcIno = statSync(srcPath).ino;
    const blobIno = statSync(store.blobPath(digest)).ino;
    assert.equal(
      blobIno,
      srcIno,
      'Manager 裁决"两份都留、永不删包内那份"负担得起的前提就是这一条：同盘时是同一个 inode',
    );
  });

  it('★ 已经装过（任意来源）绝不覆盖：跑两遍，第二遍是纯粹的 no-op', async () => {
    const store = await freshStore();
    const bundledDir = mkdtempSync(join(TEST_ROOT, 'bundled-'));
    await seedBundledFile(bundledDir, TINY);

    // 传入完整的 ALL_THREE（更贴近真实调用方式），但只给 TINY 造了字节——另外两个
    // 因为"包内完全没有痕迹"而静默跳过，不应该污染下面对 skipped.length 的断言。
    const first = await reconcileBundledModels({
      store,
      models: ALL_THREE,
      bundledModelsDir: bundledDir,
    });
    assert.equal(first.imported.length, 1);
    assert.equal(first.skipped.length, 0);

    // 模拟"用户后来真的用这个模型跑过一次基准"——真实字段会变化
    const kind = roleToStoreKind(TINY.role);
    const before = await store.readManifest<InstalledModel>(kind, TINY.id);
    await store.writeManifest(kind, TINY.id, {
      ...before,
      benchmark: { rtf: 0.05, measuredAt: '2026-08-09T00:00:00.000Z' },
    });

    const second = await reconcileBundledModels({
      store,
      models: ALL_THREE,
      bundledModelsDir: bundledDir,
    });
    assert.equal(second.imported.length, 0, '第二遍不该再"导入"一次已经装好的模型');
    assert.equal(second.skipped.length, 0, '"已经装了"不是异常，不该出现在 skipped 里刷屏');

    const after = await store.readManifest<InstalledModel>(kind, TINY.id);
    assert.deepEqual(
      (after as unknown as { benchmark: unknown }).benchmark,
      { rtf: 0.05, measuredAt: '2026-08-09T00:00:00.000Z' },
      '对账把一份已有的记录覆盖掉了——它只该补缺失的那些',
    );
  });

  it('★ 阴性对照一：sha256 对不上 → 不装，且必须出声说明原因', async () => {
    const store = await freshStore();
    const bundledDir = mkdtempSync(join(TEST_ROOT, 'bundled-'));
    await seedBundledFile(bundledDir, VAD);
    // 把包内那份内容悄悄换掉——保持字节数不变（否则先撞上的是大小检查），
    // 只让内容变化，逼真正要测的是 sha256 这一步。
    const original = synthBytes(VAD.id, VAD.files[0]!.name);
    const tampered = Buffer.alloc(original.length, 0x58 /* 'X' */);
    await writeFile(join(bundledDir, VAD.id, VAD.files[0]!.name), tampered);

    const report = await reconcileBundledModels({
      store,
      models: ALL_THREE,
      bundledModelsDir: bundledDir,
    });
    assert.equal(report.imported.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0]!.reason, /sha256/, '跳过原因必须点名是摘要不符，不能只说"失败"');

    const kind = roleToStoreKind(VAD.role);
    assert.equal(
      await store.readManifest(kind, VAD.id),
      null,
      '摘要对不上的字节绝不能被记成"已安装"——那是发明一条不成立的证据',
    );
  });

  it('★ 阴性对照二：包内完全没有这个模型的痕迹 → 静默跳过（不是异常，例如开发树）', async () => {
    const store = await freshStore();
    const bundledDir = mkdtempSync(join(TEST_ROOT, 'bundled-'));
    await seedBundledFile(bundledDir, VAD);
    await seedBundledFile(bundledDir, TINY);
    // 故意不给 STREAMING 造任何文件——目录里连 asr/sherpa-streaming-zh-14m/ 都不存在

    const report = await reconcileBundledModels({
      store,
      models: ALL_THREE,
      bundledModelsDir: bundledDir,
    });
    assert.equal(report.imported.length, 2, 'vad 与 tiny 仍应正常导入');
    assert.equal(
      report.skipped.some((s) => s.modelId === STREAMING.id),
      false,
      '完全没有痕迹不该出现在 skipped 里刷屏——那不是异常，是"这个平台/这棵树本来就没带它"',
    );
  });

  it('★ 阴性对照三：BUNDLED_MODEL_IDS 与传入目录不同步 → 必须出声（同一族"两处映射会漂"）', async () => {
    const store = await freshStore();
    const bundledDir = mkdtempSync(join(TEST_ROOT, 'bundled-'));
    await seedBundledFile(bundledDir, VAD);
    await seedBundledFile(bundledDir, TINY);
    await seedBundledFile(bundledDir, STREAMING);

    // 传入的目录里"漏了" streaming 这一条（模拟目录加载失败/被误删的场景）
    const report = await reconcileBundledModels({
      store,
      models: [VAD, TINY],
      bundledModelsDir: bundledDir,
    });
    const missed = report.skipped.find((s) => s.modelId === STREAMING.id);
    assert.ok(missed, 'BUNDLED_MODEL_IDS 里的一个 id 在目录里找不到时必须出现在 skipped 里');
    assert.match(missed!.reason, /不同步/);
  });

  it('★ bundledModelsDir 为 null（不是包内布局，例如开发树）→ 整体 no-op', async () => {
    const store = await freshStore();
    const report = await reconcileBundledModels({
      store,
      models: ALL_THREE,
      bundledModelsDir: null,
    });
    assert.deepEqual(report, { imported: [], skipped: [] });
  });
});
