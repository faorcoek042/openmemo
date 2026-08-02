#!/usr/bin/env node
/**
 * Live verification harness for @openmemo/downloader.
 *
 * Exercises the real network paths against a real 77 MB artifact
 * (ggml-tiny.bin from ggerganov/whisper.cpp).
 *
 * Checks:
 *   1  fresh chunked download + SHA-256 verification
 *   2  SHA-1 cross-check against whisper.cpp's published README table
 *   3  cache hit (second call transfers zero bytes)
 *   4  interrupt + resume (abort mid-flight, confirm sidecar, resume, verify)
 *   5  checksum mismatch is rejected and the partial discarded
 *   6  mirror failover (bad URL first, good URL second)
 *   7  ModelScope mirror serves byte-identical content
 *   8  content-addressed store: dedup, by-name hardlink, GC of orphans
 *
 * Run:  node packages/downloader/scripts/verify-download.mjs
 * Requires: `npx tsc -b packages/shared packages/downloader` first.
 */

// Node globals are imported explicitly rather than relying on eslint env config:
// eslint.config.js applies `globals.node` to `scripts/**` at the repo root only, and
// ADR-005 decision 3 puts this file under packages/downloader/scripts/. Explicit
// imports are better ESM practice anyway and keep this script config-independent.
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { AbortController } = globalThis;

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

const { downloadFile, DownloadError } = await import(path.join(dist, 'download.js'));
const { readSidecar, completedBytes } = await import(path.join(dist, 'sidecar.js'));
const { ArtifactStore } = await import(path.join(dist, 'store.js'));
const { probeAll, rankSources } = await import(path.join(dist, 'probe.js'));
const { sha256File } = await import(path.join(dist, 'verify.js'));

/* --------------------------- test fixtures ------------------------------- */

const TINY = {
  name: 'ggml-tiny.bin',
  sizeBytes: 77691713,
  // From HF tree API lfs.oid (== x-linked-etag on the resolve response).
  sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  // From whisper.cpp models/README.md "Available models" table.
  sha1: 'bd577a113a864445d4c299885e0cb97d4ba92b5f',
  hf: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  modelscope:
    'https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-tiny.bin',
};

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function mb(n) {
  return `${(n / 1e6).toFixed(1)} MB`;
}

async function sha1File(p) {
  const h = createHash('sha1');
  const fh = await fs.open(p, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

async function sizeOf(p) {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return -1;
  }
}

/* ------------------------------- run ------------------------------------- */

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openmemo-dl-'));
const blobDir = path.join(root, 'blobs');
console.log(`\nOpenMemo downloader — live verification`);
console.log(`scratch: ${root}\n`);

const t0 = Date.now();

/* --- 1. fresh download ---------------------------------------------------- */
console.log('[1] fresh chunked download + SHA-256 verification');
let lastPct = -1;
const r1 = await downloadFile({
  sha256: TINY.sha256,
  sizeBytes: TINY.sizeBytes,
  sources: [{ provider: 'hf', url: TINY.hf, official: true }],
  blobDir,
  maxParts: 4,
  onProgress: (p) => {
    if (p.phase !== 'downloading') return;
    const pct = Math.floor((p.completedBytes / p.totalBytes) * 100);
    if (pct >= lastPct + 25) {
      lastPct = pct;
      process.stdout.write(
        `      ${pct}%  ${mb(p.completedBytes)}/${mb(p.totalBytes)}  ${(p.speedBps / 1e6).toFixed(1)} MB/s\n`,
      );
    }
  },
});
check('downloaded and verified', !r1.cached && r1.sha256 === TINY.sha256);
check('size matches manifest', r1.sizeBytes === TINY.sizeBytes, `${r1.sizeBytes} bytes`);
check('blob filename is its digest', path.basename(r1.blobPath) === `sha256-${TINY.sha256}`);
check('on-disk size correct', (await sizeOf(r1.blobPath)) === TINY.sizeBytes);
const actualSha = await sha256File(r1.blobPath);
check('independent re-hash matches', actualSha === TINY.sha256);

/* --- 2. SHA-1 cross-check ------------------------------------------------- */
console.log('\n[2] cross-check against whisper.cpp published SHA-1');
const gotSha1 = await sha1File(r1.blobPath);
check(
  'SHA-1 matches whisper.cpp README',
  gotSha1 === TINY.sha1,
  `${gotSha1.slice(0, 16)}…`,
);

/* --- 3. cache hit --------------------------------------------------------- */
console.log('\n[3] second request hits the content-addressed cache');
const r2 = await downloadFile({
  sha256: TINY.sha256,
  sizeBytes: TINY.sizeBytes,
  sources: [{ provider: 'hf', url: TINY.hf, official: true }],
  blobDir,
});
check('served from cache', r2.cached === true);
check('zero bytes transferred', r2.bytesTransferred === 0);

/* --- 4. interrupt + resume ------------------------------------------------ */
console.log('\n[4] interrupt mid-download, then resume');
const resumeDir = path.join(root, 'resume-blobs');
const ac = new AbortController();
const partialPath = path.join(resumeDir, `sha256-${TINY.sha256}.partial`);

const interrupted = downloadFile({
  sha256: TINY.sha256,
  sizeBytes: TINY.sizeBytes,
  sources: [{ provider: 'hf', url: TINY.hf, official: true }],
  blobDir: resumeDir,
  maxParts: 4,
  signal: ac.signal,
  onProgress: (p) => {
    // Abort once a meaningful chunk has landed.
    if (p.phase === 'downloading' && p.completedBytes > 12_000_000) ac.abort();
  },
}).catch((e) => e);

const err = await interrupted;
check('abort surfaced as CANCELLED', err instanceof DownloadError && err.code === 'CANCELLED',
  err?.code ?? String(err));

const sidecar = await readSidecar(partialPath);
const partialSize = await sizeOf(partialPath);
check('.partial retained after cancel', partialSize === TINY.sizeBytes,
  `sparse file, apparent ${mb(partialSize)}`);
check('sidecar written', sidecar != null && sidecar.digest === TINY.sha256);
const resumeFrom = sidecar ? completedBytes(sidecar) : 0;
check('sidecar records real progress', resumeFrom > 0 && resumeFrom < TINY.sizeBytes,
  `${mb(resumeFrom)} already done`);
// Actual disk usage of a sparse file, to prove we are not preallocating 77 MB of blocks.
const duOut = await new Promise((res) => {
  execFile('du', ['-B1', '--apparent-size=0', partialPath], (e, so) => res(e ? '' : so));
});
if (duOut) console.log(`      sparse on-disk usage: ${duOut.trim().split(/\s+/)[0]} bytes`);

const r4 = await downloadFile({
  sha256: TINY.sha256,
  sizeBytes: TINY.sizeBytes,
  sources: [{ provider: 'hf', url: TINY.hf, official: true }],
  blobDir: resumeDir,
  maxParts: 4,
});
check('resumed download verified', r4.sha256 === TINY.sha256 && !r4.cached);
check(
  'resume transferred less than full file',
  r4.bytesTransferred < TINY.sizeBytes,
  `transferred ${mb(r4.bytesTransferred)} of ${mb(TINY.sizeBytes)} (saved ${mb(TINY.sizeBytes - r4.bytesTransferred)})`,
);
check('sidecar cleaned up', (await readSidecar(partialPath)) === null);
check('final file correct', (await sha256File(r4.blobPath)) === TINY.sha256);

/* --- 5. checksum mismatch rejected ---------------------------------------- */
console.log('\n[5] wrong digest must be rejected (this is the gap Ollama has)');
const badDir = path.join(root, 'bad-blobs');
const wrongSha = 'de'.repeat(32);
let caught = null;
try {
  await downloadFile({
    sha256: wrongSha,
    // Real size, wrong hash: forces a full transfer then a hash failure.
    sizeBytes: TINY.sizeBytes,
    sources: [{ provider: 'hf', url: TINY.hf, official: true }],
    blobDir: badDir,
    maxParts: 4,
  });
} catch (e) {
  caught = e;
}
check('rejected with CHECKSUM_MISMATCH', caught?.code === 'CHECKSUM_MISMATCH', caught?.message?.slice(0, 90));
check('no blob committed for bad content', (await sizeOf(path.join(badDir, `sha256-${wrongSha}`))) === -1);
check('partial discarded', (await sizeOf(path.join(badDir, `sha256-${wrongSha}.partial`))) === -1);

/* --- 6. mirror failover --------------------------------------------------- */
console.log('\n[6] mirror failover: unreachable source, then a good one');
const foDir = path.join(root, 'failover-blobs');
const r6 = await downloadFile({
  sha256: TINY.sha256,
  sizeBytes: TINY.sizeBytes,
  sources: [
    { provider: 'broken', url: 'https://huggingface.co/this-repo/does-not-exist/resolve/main/x.bin', official: false },
    { provider: 'hf', url: TINY.hf, official: true },
  ],
  blobDir: foDir,
  maxParts: 4,
});
check('failed over to a working mirror', r6.sha256 === TINY.sha256 && r6.provider === 'hf',
  `used ${r6.provider} after ${r6.attempts} attempt(s)`);

/* --- 7. ModelScope mirror ------------------------------------------------- */
console.log('\n[7] ModelScope mirror serves byte-identical content');
const msDir = path.join(root, 'ms-blobs');
let msOk = false;
let msNote;
try {
  const r7 = await downloadFile({
    sha256: TINY.sha256,
    sizeBytes: TINY.sizeBytes,
    sources: [{ provider: 'modelscope', url: TINY.modelscope, official: false }],
    blobDir: msDir,
    maxParts: 4,
  });
  msOk = r7.sha256 === TINY.sha256;
  msNote = `same digest as HF (${mb(r7.sizeBytes)})`;
} catch (e) {
  msNote = `ModelScope unreachable from here: ${e.message?.slice(0, 70)}`;
}
check('ModelScope content digest identical to HF', msOk, msNote);

/* --- 8. store: dedup, hardlink, GC ---------------------------------------- */
console.log('\n[8] content-addressed store: hardlink view and GC');
const store = new ArtifactStore(path.join(root, 'store'));
await store.init();
await fs.copyFile(r1.blobPath, store.blobPath(TINY.sha256));
check('store reports blob present', await store.hasBlob(TINY.sha256));

const linked = await store.linkByName('asr', TINY.sha256, TINY.name);
const linkStat = await fs.stat(linked);
const blobStat = await fs.stat(store.blobPath(TINY.sha256));
check('by-name path exists', linkStat.size === TINY.sizeBytes, linked.replace(root, '<scratch>'));
check('hardlink shares one inode (no extra disk)', linkStat.ino === blobStat.ino,
  `inode ${linkStat.ino}, nlink ${linkStat.nlink}`);

let g = await store.findGarbage();
check('unreferenced blob detected as orphan', g.orphanBlobs.length === 1,
  `${g.orphanBlobs.length} orphan(s), ${mb(g.orphanBlobs[0]?.bytes ?? 0)}`);

await store.writeManifest('asr', 'asr/whisper-tiny', {
  schemaVersion: 1,
  id: 'asr/whisper-tiny',
  files: [{ name: TINY.name, sha256: TINY.sha256, sizeBytes: TINY.sizeBytes }],
});
g = await store.findGarbage();
check('referenced blob is NOT collected', g.orphanBlobs.length === 0);

await store.removeManifest('asr', 'asr/whisper-tiny');
const gc = await store.collectGarbage(['orphan_blobs']);
check('GC reclaims after manifest removal', gc.freedBytes === TINY.sizeBytes,
  `freed ${mb(gc.freedBytes)}`);

/* --- 9. source probing ---------------------------------------------------- */
console.log('\n[9] mirror probing and ranking');
const probes = await probeAll([
  { provider: 'hf', url: TINY.hf, official: true },
  { provider: 'modelscope', url: TINY.modelscope, official: false },
]);
for (const p of probes) {
  console.log(
    `      ${p.provider.padEnd(12)} ok=${String(p.ok).padEnd(5)} ttfb=${String(p.ttfbMs ?? '-').padStart(5)}ms  ${String(p.throughputKbps ?? '-').padStart(7)} KB/s  ${p.error ?? ''}`,
  );
}
check('at least one source probed OK', probes.some((p) => p.ok));
const ranked = rankSources(
  [
    { provider: 'hf', url: TINY.hf, official: true },
    { provider: 'modelscope', url: TINY.modelscope, official: false },
  ],
  probes,
);
check('ranking produced an ordering', ranked.length > 0,
  ranked.map((r) => r.provider).join(' > '));

/* ------------------------------ summary ---------------------------------- */

await fs.rm(root, { recursive: true, force: true });

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${'='.repeat(64)}`);
console.log(`  ${pass} passed, ${fail} failed  (${secs}s)`);
console.log('='.repeat(64));
if (fail > 0) {
  console.log('\nFailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
}
process.exit(fail === 0 ? 0 : 1);
