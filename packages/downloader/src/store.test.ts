/**
 * `ArtifactStore.importBlob()` — landing externally-verified bytes without a download.
 *
 * Written for the bundled-model first-run import path (D-20 §11.2,
 * `apps/daemon/src/http/rest/modelReconcile.ts`): the daemon hashes a file already sitting
 * inside the package and, once it matches the catalog's sha256, calls this to make the
 * ArtifactStore know about it — same content-addressed blob store, no HTTP involved.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ArtifactStore } from './store.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('ArtifactStore.importBlob', () => {
  it('lands the file under blobs/sha256-<hex> and it is readable as a normal blob', async () => {
    const root = mkdtempSync(join(tmpdir(), 'om-import-'));
    const store = new ArtifactStore(root);
    await store.init();

    const bytes = Buffer.from('bundled model bytes, pretend this is ggml-tiny-q5_1.bin');
    const digest = sha256(bytes);
    const src = join(root, 'source-copy.bin');
    writeFileSync(src, bytes);

    assert.equal(await store.hasBlob(digest), false, '前提：这份 digest 之前不该存在于 store 里');
    await store.importBlob(src, digest);
    assert.equal(await store.hasBlob(digest), true, 'importBlob 之后 hasBlob 必须能看到它');
    assert.equal(statSync(store.blobPath(digest)).size, bytes.length);
  });

  it('same-volume: 落地是硬链接，不是复制 —— 两个路径共享同一个 inode，零额外字节', async () => {
    const root = mkdtempSync(join(tmpdir(), 'om-import-'));
    const store = new ArtifactStore(root);
    await store.init();

    const bytes = Buffer.alloc(4096, 7);
    const digest = sha256(bytes);
    const src = join(root, 'source-copy.bin');
    writeFileSync(src, bytes);

    await store.importBlob(src, digest);

    const srcIno = statSync(src).ino;
    const blobIno = statSync(store.blobPath(digest)).ino;
    assert.equal(
      blobIno,
      srcIno,
      '同一个 inode 才是"零额外字节、删掉任意一边另一边还在" —— 这是 Manager 裁决"两份都留"' +
        '之所以负担得起的原因。inode 不同说明退化成了复制（本该只在跨盘时发生）',
    );
  });

  it('幂等：blob 已存在时不重新落地（重启不会每次重复 I/O ~56 MB）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'om-import-'));
    const store = new ArtifactStore(root);
    await store.init();

    const bytes = Buffer.from('idempotency check');
    const digest = sha256(bytes);
    const src = join(root, 'source-copy.bin');
    writeFileSync(src, bytes);

    await store.importBlob(src, digest);
    const firstMtimeMs = statSync(store.blobPath(digest)).mtimeMs;
    const firstIno = statSync(store.blobPath(digest)).ino;

    // 注意：同盘落地是硬链接（见上一条用例），第一次调用之后 src 与 dest 已经是
    // 同一个 inode——再对 src 做 writeFileSync 会连带改掉 dest（因为它们是同一份
    // 数据），并不能证明"第二次调用碰没碰 dest"。所以这里换一个全新的、从未被
    // importBlob 处理过的源路径，谎称它是同一个 digest；如果第二次调用真的提前
    // 返回，这个新文件应该从未被 link 到 dest 上——dest 的 inode/mtime/内容都不变。
    const decoy = join(root, 'decoy-source.bin');
    writeFileSync(decoy, Buffer.from('a different file that must NOT overwrite the blob'));
    await store.importBlob(decoy, digest);

    const blobStat = statSync(store.blobPath(digest));
    assert.equal(
      blobStat.mtimeMs,
      firstMtimeMs,
      '第二次调用不该碰这个文件——hasBlob 应该让它提前返回',
    );
    assert.equal(blobStat.ino, firstIno, 'dest 不该被重新 link 成 decoy 的 inode');
    assert.notEqual(blobStat.ino, statSync(decoy).ino, 'decoy 不该被 link 进 store');
  });

  it('目标 digest 目录不存在时也能落地（blobDir 会被 mkdir -p）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'om-import-'));
    // 刻意不调用 store.init() —— 验证 importBlob 自己会创建 blobDir，
    // 不依赖调用方先初始化过（防御性：万一有调用方在 init() 之前调用它）。
    const store = new ArtifactStore(root);

    const bytes = Buffer.from('no init() called first');
    const digest = sha256(bytes);
    const src = join(root, 'source-copy.bin');
    writeFileSync(src, bytes);

    await store.importBlob(src, digest);
    assert.equal(await store.hasBlob(digest), true);
  });
});
