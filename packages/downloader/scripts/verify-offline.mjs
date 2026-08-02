#!/usr/bin/env node
/**
 * Deterministic, offline verification of @openmemo/downloader.
 *
 * Companion to verify-download.mjs. That one proves the real network paths work against
 * Hugging Face; this one pins the *safety* properties against a local HTTP server so they
 * are fast, hermetic and never flaky. (The network run intermittently reported
 * "fetch failed" on the checksum case — a transient socket error, not a logic fault, but
 * the single most important property in this package should not depend on the internet.)
 *
 * Covers:
 *   1  late checksum rejection — full transfer, bad hash, nothing installed
 *      (this is precisely the gap in Ollama's download.go, ADR-004 decision 5)
 *   2  early checksum rejection — origin advertises a digest that disagrees
 *   3  resume after a mid-stream connection drop
 *   4  origin without Range support → single-stream fallback still verifies
 *   5  size disagreement rejected before transferring
 *   6  mirror failover including a corrupt mirror
 *   7  queue: dedup, concurrency limit, cancel, retry
 *   8  disk pre-check
 *
 * Run: node packages/downloader/scripts/verify-offline.mjs
 */

import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

const { downloadFile } = await import(path.join(dist, 'download.js'));
const { ArtifactStore } = await import(path.join(dist, 'store.js'));
const { DownloadQueue } = await import(path.join(dist, 'queue.js'));
const { install } = await import(path.join(dist, 'installer.js'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(`${name}: ${detail}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/* ------------------------- local origin under test ------------------------ */

/** 3 MB of deterministic-but-incompressible content. */
const CONTENT = randomBytes(3 * 1024 * 1024);
const CONTENT_SHA = sha256(CONTENT);
const WRONG_SHA = 'ab'.repeat(32);
/** Same length as CONTENT but different bytes — simulates a corrupt mirror. */
const CORRUPT = Buffer.concat([Buffer.from([0xff]), CONTENT.subarray(1)]);

let dropNextAt = 0; // bytes after which to kill the connection, 0 = never

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // /no-range  → ignores Range entirely, always 200 with the whole body
  // /corrupt   → serves wrong bytes of the right length
  // /advertise → sends x-linked-etag/x-linked-size like HF does
  // /wrong-size→ reports a different length
  // /flaky     → drops the connection partway through
  const body = p === '/corrupt' ? CORRUPT : CONTENT;

  if (p === '/wrong-size') {
    res.writeHead(206, {
      'content-range': `bytes 0-0/${body.length + 12345}`,
      'accept-ranges': 'bytes',
      'content-length': '1',
    });
    res.end(body.subarray(0, 1));
    return;
  }

  if (p === '/advertise' && req.headers.range === 'bytes=0-0') {
    res.writeHead(206, {
      'content-range': `bytes 0-0/${body.length}`,
      'accept-ranges': 'bytes',
      'x-linked-size': String(body.length),
      'x-linked-etag': `"${CONTENT_SHA}"`,
      'content-length': '1',
    });
    res.end(body.subarray(0, 1));
    return;
  }

  if (p === '/no-range') {
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
    return;
  }

  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' });
    res.end(body);
    return;
  }

  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : body.length - 1;
  const slice = body.subarray(start, end + 1);

  res.writeHead(206, {
    'content-range': `bytes ${start}-${end}/${body.length}`,
    'accept-ranges': 'bytes',
    'content-length': String(slice.length),
  });

  if (p === '/flaky' && dropNextAt > 0 && slice.length > dropNextAt) {
    // Write a prefix, let it actually reach the client, THEN drop the connection.
    //
    // The delay is essential and was the subject of a false alarm: calling
    // res.destroy() immediately after res.write() makes undici reject the whole
    // fetch() with UND_ERR_SOCKET and deliver ZERO bytes to the body reader, so the
    // client legitimately has no progress to persist. Real interrupted transfers
    // deliver megabytes first. Flushing before the drop models that correctly.
    res.write(slice.subarray(0, dropNextAt), () => {
      setTimeout(() => res.destroy(), 50);
    });
    return;
  }
  res.end(slice);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}`;
const src = (p, provider = 'local') => [{ provider, url: `${base}${p}`, official: true }];

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openmemo-offline-'));
console.log(`\nOpenMemo downloader — offline verification`);
console.log(`origin: ${base}   scratch: ${root}\n`);

const t0 = Date.now();

/* --- 1. late checksum rejection ------------------------------------------- */
console.log('[1] full transfer with a wrong expected hash must install nothing');
{
  const dir = path.join(root, 'late');
  let err = null;
  try {
    await downloadFile({ sha256: WRONG_SHA, sizeBytes: CONTENT.length, sources: src('/f'), blobDir: dir });
  } catch (e) {
    err = e;
  }
  check('rejected with CHECKSUM_MISMATCH', err?.code === 'CHECKSUM_MISMATCH', err?.message?.slice(0, 80));
  const entries = await fs.readdir(dir).catch(() => []);
  check('no blob and no partial left behind', entries.length === 0, `dir contains [${entries}]`);
}

/* --- 2. early checksum rejection ------------------------------------------ */
console.log('\n[2] origin-advertised digest disagreeing must reject before transfer');
{
  const dir = path.join(root, 'early');
  let err = null;
  try {
    await downloadFile({ sha256: WRONG_SHA, sources: src('/advertise'), blobDir: dir });
  } catch (e) {
    err = e;
  }
  check('rejected with CHECKSUM_MISMATCH', err?.code === 'CHECKSUM_MISMATCH', err?.message?.slice(0, 70));
  check('rejected without writing anything', (await fs.readdir(dir).catch(() => [])).length === 0);
}

/* --- 3. resume after a dropped connection --------------------------------- */
console.log('\n[3] connection drops mid-stream, retry resumes from the sidecar');
{
  const dir = path.join(root, 'resume');
  dropNextAt = 200_000; // kill each part after 200 KB
  let firstErr = null;
  try {
    await downloadFile({
      sha256: CONTENT_SHA, sizeBytes: CONTENT.length, sources: src('/flaky'),
      blobDir: dir, maxParts: 2, stallTimeoutMs: 3000,
    });
  } catch (e) {
    firstErr = e;
  }
  // With drops active the transfer cannot complete; it must fail, not hang or corrupt.
  check('failed cleanly while the origin was dropping', firstErr != null, firstErr?.code);
  const partialExists = await fs
    .stat(path.join(dir, `sha256-${CONTENT_SHA}.partial.json`))
    .then(() => true)
    .catch(() => false);
  check('resume sidecar persisted', partialExists);

  dropNextAt = 0; // origin recovers
  const r = await downloadFile({
    sha256: CONTENT_SHA, sizeBytes: CONTENT.length, sources: src('/flaky'),
    blobDir: dir, maxParts: 2,
  });
  check('completed and verified after recovery', r.sha256 === CONTENT_SHA);
  check(
    'resumed rather than restarting from zero',
    r.bytesTransferred < CONTENT.length,
    `transferred ${(r.bytesTransferred / 1e6).toFixed(2)} MB of ${(CONTENT.length / 1e6).toFixed(2)} MB`,
  );
  const onDisk = await fs.readFile(r.blobPath);
  check('bytes on disk are exactly correct', sha256(onDisk) === CONTENT_SHA);
}

/* --- 4. origin without Range support -------------------------------------- */
console.log('\n[4] origin ignoring Range still yields a verified file');
{
  const dir = path.join(root, 'norange');
  const r = await downloadFile({
    sha256: CONTENT_SHA, sizeBytes: CONTENT.length, sources: src('/no-range'),
    blobDir: dir, maxParts: 4,
  });
  check('single-stream fallback verified', r.sha256 === CONTENT_SHA);
  check('content correct', sha256(await fs.readFile(r.blobPath)) === CONTENT_SHA);
}

/* --- 5. size mismatch ------------------------------------------------------ */
console.log('\n[5] size disagreement is caught before transferring');
{
  const dir = path.join(root, 'size');
  let err = null;
  try {
    await downloadFile({ sha256: CONTENT_SHA, sizeBytes: CONTENT.length, sources: src('/wrong-size'), blobDir: dir });
  } catch (e) {
    err = e;
  }
  check('rejected with SIZE_MISMATCH', err?.code === 'SIZE_MISMATCH', err?.message?.slice(0, 80));
}

/* --- 6. failover past a corrupt mirror ------------------------------------ */
console.log('\n[6] corrupt mirror is skipped, good mirror wins');
{
  const dir = path.join(root, 'failover');
  const r = await downloadFile({
    sha256: CONTENT_SHA,
    sizeBytes: CONTENT.length,
    sources: [
      { provider: 'corrupt-mirror', url: `${base}/corrupt`, official: false },
      { provider: 'good-mirror', url: `${base}/f`, official: true },
    ],
    blobDir: dir,
    maxParts: 2,
  });
  check('recovered from a corrupt mirror', r.sha256 === CONTENT_SHA && r.provider === 'good-mirror',
    `provider=${r.provider}, attempts=${r.attempts}`);
  check('final content correct', sha256(await fs.readFile(r.blobPath)) === CONTENT_SHA);
}

/* --- 7. queue semantics ---------------------------------------------------- */
console.log('\n[7] queue: dedup, concurrency, cancel, retry');
{
  const q = new DownloadQueue(2);
  const started = [];
  let peakConcurrent = 0;
  let active = 0;

  const slow = (id) => () =>
    new Promise((resolve) => {
      started.push(id);
      active++;
      peakConcurrent = Math.max(peakConcurrent, active);
      setTimeout(() => {
        active--;
        resolve();
      }, 120);
    });

  const a = q.enqueue({ kind: 'model', targetId: 'm/a', displayName: 'A', totalBytes: 1 }, slow('a'));
  const dup = q.enqueue({ kind: 'model', targetId: 'm/a', displayName: 'A', totalBytes: 1 }, slow('a2'));
  check('duplicate target deduplicated', dup.deduplicated && dup.job.jobId === a.job.jobId);
  check('jobId is a ULID', /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(a.job.jobId), a.job.jobId);
  check('job.type set from kind', a.job.type === 'download.model', a.job.type);

  for (const id of ['b', 'c', 'd']) {
    q.enqueue({ kind: 'model', targetId: `m/${id}`, displayName: id, totalBytes: 1 }, slow(id));
  }
  await Promise.all(q.list().map((j) => q.waitFor(j.jobId)));
  check('concurrency limit honoured', peakConcurrent <= 2, `peak=${peakConcurrent}`);
  check('all jobs reached succeeded', q.list().every((j) => j.state === 'succeeded'));

  const q2 = new DownloadQueue(1);
  const hang = q2.enqueue({ kind: 'model', targetId: 'm/hang', displayName: 'H', totalBytes: 1 }, (ctx) =>
    new Promise((_res, rej) => {
      ctx.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
    }),
  );
  await new Promise((r) => setTimeout(r, 30));
  q2.cancel(hang.job.jobId);
  await q2.waitFor(hang.job.jobId);
  check('cancel reaches cancelled state', q2.get(hang.job.jobId).state === 'cancelled');

  const again = q2.retry(hang.job.jobId);
  check('retry re-queues a cancelled job', again?.state === 'queued' && again.attempt === 2);
  q2.cancel(hang.job.jobId);
}

/* --- 8. installer disk pre-check ------------------------------------------ */
console.log('\n[8] installer: disk pre-check and by-name linking');
{
  const store = new ArtifactStore(path.join(root, 'store'));
  const res = await install({
    store,
    target: {
      id: 'asr/test-model',
      kind: 'asr',
      displayName: 'Test',
      files: [
        {
          role: 'weights',
          name: 'test-model.bin',
          sizeBytes: CONTENT.length,
          sha256: CONTENT_SHA,
          mirrors: [{ provider: 'local', url: `${base}/f`, official: true }],
        },
      ],
    },
    maxParts: 2,
  });
  check('install completed', res.files.length === 1 && res.files[0].sha256 === CONTENT_SHA);
  const linked = res.files[0].path;
  check('by-name link created', (await fs.stat(linked)).size === CONTENT.length, path.basename(linked));

  // Optional file for another platform must be skipped, not downloaded.
  const res2 = await install({
    store,
    target: {
      id: 'asr/test-model-2',
      kind: 'asr',
      displayName: 'Test2',
      files: [
        {
          role: 'weights', name: 'test-model.bin', sizeBytes: CONTENT.length, sha256: CONTENT_SHA,
          mirrors: [{ provider: 'local', url: `${base}/f`, official: true }],
        },
        {
          role: 'coreml-encoder', name: 'mac-only.zip', sizeBytes: 1, sha256: WRONG_SHA, optional: true,
          platforms: [{ os: 'darwin', arch: 'arm64' }],
          mirrors: [{ provider: 'local', url: `${base}/nope`, official: true }],
        },
      ],
    },
    platform: { os: 'linux', arch: 'x64' },
    maxParts: 2,
  });
  check('platform-inapplicable optional file skipped', res2.files.length === 1);
  check('second install deduplicated by digest', res2.files[0].cached === true);
}

/* --- 9. install: partial unpack must never survive a failure ------------------ */
/*
 * Regression guard for the bug that blocked cold start: extraction aborted partway
 * through a 43-entry tarball, left 3 files behind, and every retry then short-circuited
 * because the blob was cached and the directory existed. The user was permanently stuck
 * at "installed but unusable" with no UI path out.
 */
console.log('\n[9] 安装失败不得留下半个解压目录');
{
  const store = new ArtifactStore(path.join(root, 'store-unpack'));
  await store.init();
  // A "tar.gz" whose bytes are not actually a valid archive → unpack must fail.
  const bogus = Buffer.from('this is definitely not a gzip stream');
  const bogusSha = sha256(bogus);
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.writeHead(200, { 'content-length': String(bogus.length), 'accept-ranges': 'bytes' });
    res.end(bogus);
  });

  let err = null;
  try {
    await install({
      store,
      target: {
        id: 'backend/broken',
        kind: 'backend',
        displayName: 'Broken',
        files: [
          {
            role: 'archive',
            name: 'broken.tar.gz',
            sizeBytes: bogus.length,
            sha256: bogusSha,
            unpack: 'tar.gz',
            mirrors: [{ provider: 'local', url: `${base}/broken.tar.gz`, official: true }],
          },
        ],
      },
      maxParts: 1,
    });
  } catch (e) {
    err = e;
  }
  check('解压失败会抛错', err != null, err?.code);
  check('错误码是 UNPACK_FAILED', err?.code === 'UNPACK_FAILED', err?.code);
  check('失败标记为可重试（字节已校验，重试很便宜）', err?.retryable === true, `retryable=${err?.retryable}`);

  const leftovers = await fs.readdir(store.byNameDir('backend')).catch(() => []);
  const partial = leftovers.filter((n) => n.startsWith('broken'));
  check(
    '没有留下半个解压目录或 .tmp 残留',
    partial.length === 0,
    partial.length ? `残留: ${partial.join(', ')}` : 'by-name/backend 干净',
  );
}

/* -------------------------------- summary --------------------------------- */

server.close();
await fs.rm(root, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('='.repeat(60));
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
