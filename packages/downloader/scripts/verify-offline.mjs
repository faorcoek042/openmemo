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
const { ArtifactStore, findInstalledByRole } = await import(path.join(dist, 'store.js'));
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

/* --- 10. role 与目录必须解耦（VAD 不得被当成 ASR）------------------------------ */
/*
 * Regression guard for a silent, high-consequence bug: a VAD model whose record was
 * filed under manifests/asr/ was returned as the active ASR model, so whisper would have
 * transcribed using a voice-activity net — and every health check stayed green, because
 * the check only asked "is there a file under by-name/asr".
 *
 * The fix is that `role` lives IN the record and lookups filter on it. These cases pin
 * that behaviour, including the deliberately hostile "misfiled record" case.
 */
console.log('\n[10] role 与目录解耦：VAD 不得被当成 ASR');
{
  const store = new ArtifactStore(path.join(root, 'store-roles'));
  await store.init();

  // 正常安装：各自进各自的桶
  await store.writeManifest('asr', 'asr/whisper-tiny', {
    id: 'asr/whisper-tiny', role: 'asr', integrity: 'ok',
    files: [{ role: 'weights', name: 'ggml-tiny.bin', sha256: 'a'.repeat(64) }],
  });
  await store.writeManifest('vad', 'vad/silero-vad-ggml', {
    id: 'vad/silero-vad-ggml', role: 'vad', integrity: 'ok',
    files: [{ role: 'weights', name: 'ggml-silero.bin', sha256: 'b'.repeat(64) }],
  });

  const asr = await findInstalledByRole(store, 'asr');
  const vad = await findInstalledByRole(store, 'vad');
  check('ASR 查询只返回 ASR', asr.length === 1 && asr[0].id === 'asr/whisper-tiny', asr.map((r) => r.id).join(','));
  check('VAD 查询只返回 VAD', vad.length === 1 && vad[0].id === 'vad/silero-vad-ggml', vad.map((r) => r.id).join(','));
  check('VAD 没有混进 ASR 结果', !asr.some((r) => String(r.id).startsWith('vad/')));

  // ★ 恶意/历史情况：VAD 记录被错误地写进了 manifests/asr/ 目录
  await store.writeManifest('asr', 'vad/misfiled', {
    id: 'vad/misfiled', role: 'vad', integrity: 'ok',
    files: [{ role: 'weights', name: 'ggml-silero.bin', sha256: 'c'.repeat(64) }],
  });
  const asr2 = await findInstalledByRole(store, 'asr');
  check(
    '错放进 asr/ 目录的 VAD 记录仍不被当成 ASR',
    !asr2.some((r) => r.role === 'vad'),
    'asr 结果: ' + asr2.map((r) => `${r.id}(${r.role})`).join(', '),
  );
  const vad2 = await findInstalledByRole(store, 'vad');
  check('且它仍能被 VAD 查询找到', vad2.some((r) => r.id === 'vad/misfiled'), vad2.map((r) => r.id).join(','));

  // 没有 role 字段 → 不猜，直接不算候选
  await store.writeManifest('asr', 'legacy/no-role', {
    id: 'legacy/no-role', integrity: 'ok',
    files: [{ role: 'weights', name: 'x.bin', sha256: 'd'.repeat(64) }],
  });
  const asr3 = await findInstalledByRole(store, 'asr');
  check('缺 role 的旧记录不被猜成 ASR', !asr3.some((r) => r.id === 'legacy/no-role'),
    '（宁可显示"未安装"，也不要拿一个类型不明的权重去推理）');

  // 校验失败的记录不得被选用
  await store.writeManifest('asr', 'asr/corrupt', {
    id: 'asr/corrupt', role: 'asr', integrity: 'corrupt',
    files: [{ role: 'weights', name: 'y.bin', sha256: 'e'.repeat(64) }],
  });
  const asr4 = await findInstalledByRole(store, 'asr');
  check('integrity!=ok 的记录被排除', !asr4.some((r) => r.id === 'asr/corrupt'));
}

/* --- 11. unpackInto 必须被实现，不能只写在选项里 ------------------------ */
console.log('\n[13] linkInto 只属于 sqlite-ext，后端包不许有');
{
  // 把 T-097 的结论钉住：一个名字曾经同时表示"引擎运行时布局"和"链接目标"，
  // 而两者语义冲突时，执行它比忽略它更糟（后端包会被搬出 by-name/，ffmpeg 当场找不到；
  // sqlite-ext 共用 bin/ext，解压式安装会把上一个扩展整个删掉）。
  const read = async (f) =>
    JSON.parse(await fs.readFile(new URL('../../../vendor/manifests/' + f, import.meta.url), 'utf8'));
  const be = await read('backends.json');
  const ext = await read('sqlite-ext.json');
  const stale = [...be.packs, ...ext.packs].filter((p) => 'installPath' in p);
  check('两份清单里都没有 installPath 残留', stale.length === 0, stale.map((p) => p.id).join(',') || '无');
  check(
    '后端包一律不带 linkInto（否则会被搬出 by-name/，工具发现失效）',
    be.packs.every((p) => p.linkInto === undefined),
    be.packs.filter((p) => p.linkInto).map((p) => p.id).join(',') || '无',
  );
  check(
    'sqlite-ext 每个包都带 linkInto=bin/ext',
    ext.packs.length > 0 && ext.packs.every((p) => p.linkInto === 'bin/ext'),
    `${ext.packs.filter((p) => p.linkInto === 'bin/ext').length}/${ext.packs.length}`,
  );
}

console.log('\n[12] 后端包里的可执行文件必须能被找到（含 bin/ 子目录）');
{
  // 回归守卫：ffmpeg 曾经"装成功了也用不了" —— BtbN 的包把二进制放在 <top>/bin/ 下，
  // 而查找只扫两层裸目录，于是安装成功、校验通过、selfcheck 却因为本机恰好有
  // /usr/bin/ffmpeg 而显示绿灯。装得上 ≠ 找得到，这里把后者也钉住。
  const { findInBackendPacks } = await import('../../pipeline/dist/tools.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'om-toolscan-'));
  const deep = path.join(root, 'by-name', 'backend', 'ffmpeg-x.tar.xz', 'ffmpeg-x', 'bin');
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(deep, 'ffmpeg'), '#!/bin/sh\n');
  await fs.chmod(path.join(deep, 'ffmpeg'), 0o755);
  const found = await findInBackendPacks(root, 'ffmpeg');
  check('嵌套在 <包>/<顶层>/bin/ 里的可执行文件能被找到', found !== null, found ?? '(null)');

  // 老布局（whisper.cpp 那样平铺）不能因此失效
  const flat = path.join(root, 'by-name', 'backend', 'whisper-x', 'whisper-x');
  await fs.mkdir(flat, { recursive: true });
  await fs.writeFile(path.join(flat, 'whisper-cli'), '#!/bin/sh\n');
  await fs.chmod(path.join(flat, 'whisper-cli'), 0o755);
  check('平铺布局仍然找得到（没有为了新布局牺牲旧的）', (await findInBackendPacks(root, 'whisper-cli')) !== null);
  check('不存在的工具仍返回 null（不误报找到）', (await findInBackendPacks(root, 'nope-cli')) === null);
  await fs.rm(root, { recursive: true, force: true });
}

console.log('\n[11] unpackInto 生效（解压到指定目录而不是 by-name）');
{
  const dataRoot = path.join(root, 'dataroot');
  const store = new ArtifactStore(path.join(dataRoot, 'models'));
  await store.init();
  // a real tar.gz built on the fly
  const { execFileSync } = await import('node:child_process');
  const srcDir = path.join(root, 'ext-src');
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(path.join(srcDir, 'libsimple.so'), Buffer.alloc(2048, 9));
  const arc = path.join(root, 'ext.tar.gz');
  execFileSync('tar', ['-czf', arc, '-C', srcDir, 'libsimple.so'], { stdio: 'ignore' });
  const bytes = await fs.readFile(arc);
  const arcSha = sha256(bytes);

  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.writeHead(200, { 'content-length': String(bytes.length), 'accept-ranges': 'bytes' });
    res.end(bytes);
  });

  const res = await install({
    store,
    dataRoot,
    unpackInto: 'bin/ext',
    target: {
      id: 'sqlite-ext', kind: 'backend', displayName: 'ext',
      files: [{ role: 'archive', name: 'ext.tar.gz', sizeBytes: bytes.length, sha256: arcSha,
                unpack: 'tar.gz', mirrors: [{ provider: 'local', url: `${base}/ext.tar.gz`, official: true }] }],
    },
    maxParts: 1,
  });
  const landed = path.join(dataRoot, 'bin', 'ext', 'libsimple.so');
  const ok = await fs.stat(landed).then(() => true).catch(() => false);
  check('解压到指定的 unpackInto', ok, res.installedTo ?? '(未记录)');
  check('installedTo 如实回报落点', res.installedTo === path.join(dataRoot, 'bin', 'ext'), res.installedTo ?? '');
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
