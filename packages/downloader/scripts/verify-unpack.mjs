#!/usr/bin/env node
/**
 * Deterministic, offline verification of unpack.ts and signature.ts.
 *
 * Companion to verify-offline.mjs, same shape: plain node, no test framework, PASS/FAIL
 * lines, exit code carries the result. Everything here is built at runtime — no binary
 * fixtures are committed, so there is nothing in git that could silently rot or hide a
 * planted payload.
 *
 * ZIP archives are constructed BY HAND (a minimal writer using node:zlib deflateRaw),
 * because this box has no `zip` binary (only `unzip`+`tar`, confirmed at the top via
 * `which`). That is fine — it is also the more useful fixture generator here, since a
 * hand-rolled writer can trivially emit the exact malicious shapes (zip-slip names,
 * absolute paths, oversized declared sizes) that a real `zip` CLI would refuse to create.
 * tar.gz archives are built with the real `tar` binary, including a genuine symlink entry,
 * since GNU tar happily writes the deliberately-hostile fixtures we need there too.
 *
 * Covers:
 *   1  ZIP round-trip: nested dirs, stored + deflated methods, byte-for-byte content
 *   2  tar.gz round-trip via real `tar`, including executable-bit preservation
 *   3  zip-slip ("../evil.txt") rejected, and nothing written outside destDir
 *   4  absolute paths (POSIX and Windows-style) rejected
 *   5  symlink entry in a real tar archive rejected
 *   6  entry-count and total-bytes limits enforced (zip-bomb guard)
 *   7  executable bit preserved on Unix (ZIP external attrs + tar mode)
 *   8  Ed25519 sign/verify: happy path, tampered payload, tampered signature, raw key
 *   9  verifyCatalogSignature fails closed when no key is configured
 *
 * Run: node packages/downloader/scripts/verify-unpack.mjs
 */

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

const { unpackZip, unpackTarGz, unpackArchive, UnpackError } = await import(path.join(dist, 'unpack.js'));
const { verifyEd25519, parseEd25519PublicKey, OPENMEMO_CATALOG_PUBLIC_KEY } = await import(
  path.join(dist, 'signature.js')
);
const { verifyCatalogSignature } = await import(path.join(dist, 'manifest.js'));

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

async function mustThrow(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

function hasCmd(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------- ZIP writer -------------------------------- */
/**
 * Minimal hand-rolled ZIP writer, deliberately permissive: it will happily write entry
 * names that are absolute or contain "..", because the whole point is to feed those
 * shapes to unpackZip and assert it refuses them. CRC-32 is left as 0 throughout —
 * unpack.ts does not check it (the size checks + maxOutputLength cap are the integrity
 * backstop), so a real CRC would be untested code for no safety benefit.
 *
 * entries: { name, content: Buffer|null (null = directory), method: 'store'|'deflate', unixMode?: number }
 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const isDir = e.content == null;
    const content = isDir ? Buffer.alloc(0) : e.content;
    const method = isDir || e.method !== 'deflate' ? 0 : 8;
    const compressed = method === 8 ? zlib.deflateRawSync(content) : content;
    const nameBuf = Buffer.from(e.name, 'utf8');

    const localHeaderOffset = offset;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed to extract
    lfh.writeUInt16LE(0, 6); // general purpose flag
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0, 12); // mod date
    lfh.writeUInt32LE(0, 14); // crc-32 (unchecked by the reader — see doc comment above)
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(content.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length
    localParts.push(lfh, nameBuf, compressed);
    const localLen = lfh.length + nameBuf.length + compressed.length;

    const versionMadeBy = e.unixMode != null ? (3 << 8) | 20 : 20;
    const externalAttrs = e.unixMode != null ? (e.unixMode << 16) >>> 0 : 0;
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(versionMadeBy, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(0, 16); // crc-32
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(content.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra length
    cdh.writeUInt16LE(0, 32); // comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(externalAttrs, 38);
    cdh.writeUInt32LE(localHeaderOffset, 42);
    centralParts.push(cdh, nameBuf);

    offset += localLen;
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

async function writeZip(root, name, entries) {
  const p = path.join(root, name);
  await fs.writeFile(p, buildZip(entries));
  return p;
}

/* --------------------------------- setup ------------------------------------ */

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openmemo-unpack-'));
console.log(`\nOpenMemo downloader — unpack/signature verification`);
console.log(`scratch: ${root}`);
console.log(`zip binary present: ${hasCmd('zip')}  (using hand-rolled writer regardless — see header)`);
console.log(`tar binary present: ${hasCmd('tar')}\n`);

const t0 = Date.now();

/* --- 1. ZIP round-trip ------------------------------------------------------ */
console.log('[1] ZIP round-trip: nested dirs, stored + deflated, byte-for-byte content');
{
  const helloTxt = Buffer.from('hello from a deflated entry\n'.repeat(50), 'utf8');
  const binData = randomBytes(8192);
  const zipPath = await writeZip(root, 'roundtrip.zip', [
    { name: 'dir/', content: null },
    { name: 'dir/hello.txt', content: helloTxt, method: 'deflate' },
    { name: 'root.bin', content: binData, method: 'store' },
  ]);
  const destDir = path.join(root, 'rt-zip-out');
  const res = await unpackZip(zipPath, destDir);

  check('returns exactly the 2 file entries (dir excluded)', res.files.length === 2, `files=${res.files.length}`);
  check(
    'totalBytes matches sum of file contents',
    res.totalBytes === helloTxt.length + binData.length,
    `totalBytes=${res.totalBytes}`,
  );
  const gotHello = await fs.readFile(path.join(destDir, 'dir', 'hello.txt'));
  const gotBin = await fs.readFile(path.join(destDir, 'root.bin'));
  check('deflated entry content is byte-for-byte correct', Buffer.compare(gotHello, helloTxt) === 0);
  check('stored entry content is byte-for-byte correct', Buffer.compare(gotBin, binData) === 0);
}

/* --- 2. tar.gz round-trip via real tar --------------------------------------- */
console.log('\n[2] tar.gz round-trip (real GNU tar), including a subdirectory');
let tarAvailable = hasCmd('tar');
if (!tarAvailable) {
  check('tar binary available', false, 'skipping tar.gz round-trip entirely');
} else {
  const srcDir = path.join(root, 'tar-src');
  await fs.mkdir(path.join(srcDir, 'sub'), { recursive: true });
  const fileContent = Buffer.from('tar round trip content\n'.repeat(20), 'utf8');
  await fs.writeFile(path.join(srcDir, 'sub', 'data.txt'), fileContent);

  const archivePath = path.join(root, 'roundtrip.tar.gz');
  execFileSync('tar', ['-czf', archivePath, 'sub/data.txt'], { cwd: srcDir });

  const destDir = path.join(root, 'rt-tar-out');
  const res = await unpackTarGz(archivePath, destDir);
  check('one file extracted', res.files.length === 1, `files=${JSON.stringify(res.files.map((f) => path.basename(f)))}`);
  const got = await fs.readFile(path.join(destDir, 'sub', 'data.txt'));
  check('tar.gz content is byte-for-byte correct', Buffer.compare(got, fileContent) === 0);
}

/* --- 3. zip-slip rejected ----------------------------------------------------- */
console.log('\n[3] zip-slip ("../evil.txt") is rejected and nothing escapes destDir');
{
  const zipPath = await writeZip(root, 'slip.zip', [
    { name: '../evil.txt', content: Buffer.from('pwned'), method: 'deflate' },
  ]);
  const destDir = path.join(root, 'slip-out');
  await fs.mkdir(destDir, { recursive: true });
  const err = await mustThrow(() => unpackZip(zipPath, destDir));
  check('extraction throws', err != null, err?.message);
  check('throws with PATH_TRAVERSAL code', err instanceof UnpackError && err.code === 'PATH_TRAVERSAL', err?.code);
  const escaped = await fs
    .stat(path.join(destDir, '..', 'evil.txt'))
    .then(() => true)
    .catch(() => false);
  check('no file was written outside destDir', !escaped);
}

/* --- 4. absolute paths rejected ------------------------------------------------ */
console.log('\n[4] absolute paths (POSIX and Windows-style) are rejected');
{
  for (const badName of ['/etc/evil-posix.txt', 'C:\\evil-windows.txt', '\\\\server\\share\\evil.txt']) {
    const zipPath = await writeZip(root, `abs-${Buffer.from(badName).toString('hex').slice(0, 8)}.zip`, [
      { name: badName, content: Buffer.from('x'), method: 'store' },
    ]);
    const destDir = path.join(root, `abs-out-${Buffer.from(badName).toString('hex').slice(0, 8)}`);
    const err = await mustThrow(() => unpackZip(zipPath, destDir));
    check(
      `absolute path "${badName}" rejected`,
      err instanceof UnpackError && err.code === 'PATH_TRAVERSAL',
      err?.code ?? 'did not throw',
    );
  }
}

/* --- 5. symlink entry in tar rejected ------------------------------------------ */
console.log('\n[5] a real symlink entry in a tar archive is rejected');
if (!tarAvailable) {
  check('tar binary available', false, 'skipping symlink test');
} else {
  const srcDir = path.join(root, 'tar-symlink-src');
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(path.join(srcDir, 'real.txt'), 'real file\n');
  await fs.symlink('real.txt', path.join(srcDir, 'link.txt'));

  const archivePath = path.join(root, 'symlink.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '--no-recursion', 'real.txt', 'link.txt'], { cwd: srcDir });

  const destDir = path.join(root, 'symlink-out');
  const err = await mustThrow(() => unpackTarGz(archivePath, destDir));
  check('extraction throws', err != null, err?.message);
  check('throws with SYMLINK_REJECTED code', err instanceof UnpackError && err.code === 'SYMLINK_REJECTED', err?.code);
  const linkExists = await fs
    .lstat(path.join(destDir, 'link.txt'))
    .then(() => true)
    .catch(() => false);
  check('the symlink itself was never created', !linkExists);
}

/* --- 6. zip-bomb guards: entry count and total bytes --------------------------- */
console.log('\n[6] entry-count and total-bytes limits are enforced');
{
  const manyEntries = Array.from({ length: 50 }, (_, i) => ({
    name: `f${i}.txt`,
    content: Buffer.from('x'),
    method: 'store',
  }));
  const zipPath = await writeZip(root, 'many-entries.zip', manyEntries);
  const err = await mustThrow(() => unpackZip(zipPath, path.join(root, 'many-out'), { maxEntries: 10 }));
  check('maxEntries=10 rejects a 50-entry archive', err != null, err?.message);
  check('rejected with LIMIT_EXCEEDED', err instanceof UnpackError && err.code === 'LIMIT_EXCEEDED', err?.code);

  const bigContent = randomBytes(200_000);
  const bigZipPath = await writeZip(root, 'big-entry.zip', [
    { name: 'big.bin', content: bigContent, method: 'deflate' },
  ]);
  const err2 = await mustThrow(() => unpackZip(bigZipPath, path.join(root, 'big-out'), { maxTotalBytes: 1000 }));
  check('maxTotalBytes=1000 rejects a 200KB entry', err2 != null, err2?.message);
  check('rejected with LIMIT_EXCEEDED', err2 instanceof UnpackError && err2.code === 'LIMIT_EXCEEDED', err2?.code);

  // A declared-small-but-actually-large entry (lying header) must still be caught, via
  // zlib's maxOutputLength rather than the pre-check on the (false) declared size.
  const lyingCompressed = zlib.deflateRawSync(randomBytes(500_000));
  const lyingZip = buildLyingZip(lyingCompressed, 10); // header claims uncompressed size 10
  const lyingPath = path.join(root, 'lying.zip');
  await fs.writeFile(lyingPath, lyingZip);
  const err3 = await mustThrow(() => unpackZip(lyingPath, path.join(root, 'lying-out'), { maxTotalBytes: 100 }));
  check('a header that under-declares its size is still caught', err3 != null, err3?.message?.slice(0, 100));

  // Under a generous budget, the same shape of archive (small count, small declared size)
  // must still succeed — proves the limits reject BAD archives, not all archives.
  const okZip = await writeZip(root, 'ok-small.zip', [{ name: 'fine.txt', content: Buffer.from('fine'), method: 'store' }]);
  const okRes = await unpackZip(okZip, path.join(root, 'ok-small-out'), { maxEntries: 10, maxTotalBytes: 10_000 });
  check('a small archive within limits still succeeds', okRes.files.length === 1);
}

/** Build a ZIP with one deflate entry whose declared uncompressed size is a lie. */
function buildLyingZip(compressed, declaredUncompressedSize) {
  const nameBuf = Buffer.from('lying.bin', 'utf8');
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(8, 8); // deflate
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(0, 14);
  lfh.writeUInt32LE(compressed.length, 18);
  lfh.writeUInt32LE(declaredUncompressedSize, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 8);
  cdh.writeUInt16LE(8, 10);
  cdh.writeUInt16LE(0, 12);
  cdh.writeUInt16LE(0, 14);
  cdh.writeUInt32LE(0, 16);
  cdh.writeUInt32LE(compressed.length, 20);
  cdh.writeUInt32LE(declaredUncompressedSize, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30);
  cdh.writeUInt16LE(0, 32);
  cdh.writeUInt16LE(0, 34);
  cdh.writeUInt16LE(0, 36);
  cdh.writeUInt32LE(0, 38);
  cdh.writeUInt32LE(0, 42); // local header offset

  const localBuf = Buffer.concat([lfh, nameBuf, compressed]);
  const centralBuf = Buffer.concat([cdh, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* --- 7. executable bit preserved ------------------------------------------------ */
console.log('\n[7] executable bit is preserved on Unix');
if (process.platform === 'win32') {
  check('skipped on win32 (chmod is meaningless there)', true);
} else {
  const zipPath = await writeZip(root, 'exec.zip', [
    { name: 'run.sh', content: Buffer.from('#!/bin/sh\necho hi\n'), method: 'deflate', unixMode: 0o100755 },
  ]);
  const destDir = path.join(root, 'exec-zip-out');
  await unpackZip(zipPath, destDir);
  const st = await fs.stat(path.join(destDir, 'run.sh'));
  check('ZIP: extracted file has the executable bit set', (st.mode & 0o111) !== 0, `mode=${(st.mode & 0o777).toString(8)}`);

  if (tarAvailable) {
    const srcDir = path.join(root, 'tar-exec-src');
    await fs.mkdir(srcDir, { recursive: true });
    const scriptPath = path.join(srcDir, 'run.sh');
    await fs.writeFile(scriptPath, '#!/bin/sh\necho hi\n');
    await fs.chmod(scriptPath, 0o755);
    const archivePath = path.join(root, 'exec.tar.gz');
    execFileSync('tar', ['-czf', archivePath, 'run.sh'], { cwd: srcDir });
    const tarDestDir = path.join(root, 'exec-tar-out');
    await unpackTarGz(archivePath, tarDestDir);
    const tst = await fs.stat(path.join(tarDestDir, 'run.sh'));
    check('tar.gz: extracted file has the executable bit set', (tst.mode & 0o111) !== 0, `mode=${(tst.mode & 0o777).toString(8)}`);
  }
}

/* --- unpackArchive dispatch sanity ----------------------------------------------- */
console.log('\n[dispatch] unpackArchive(kind) routes to the right parser');
{
  const zipPath = await writeZip(root, 'dispatch.zip', [{ name: 'a.txt', content: Buffer.from('a'), method: 'store' }]);
  const res = await unpackArchive(zipPath, path.join(root, 'dispatch-out'), 'zip');
  check('unpackArchive("zip") works', res.files.length === 1);
  const errKind = await mustThrow(() => unpackArchive(zipPath, path.join(root, 'dispatch-out-2'), 'rar'));
  check('unpackArchive() rejects an unknown kind', errKind != null, errKind?.message);
}

/* --- 8. Ed25519 sign/verify ------------------------------------------------------- */
console.log('\n[8] Ed25519 detached-signature verification');
{
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const data = Buffer.from('the quick brown fox jumps over the lazy dog');
  const signature = cryptoSign(null, data, privateKey);

  check('verifies a genuine signature (KeyObject)', verifyEd25519(data, signature, publicKey) === true);
  check(
    'verifies a genuine signature (raw 32-byte public key)',
    verifyEd25519(data, signature, rawPublicKey) === true,
  );
  check(
    'parseEd25519PublicKey accepts a raw 32-byte key',
    parseEd25519PublicKey(rawPublicKey).asymmetricKeyType === 'ed25519',
  );
  check(
    'parseEd25519PublicKey accepts PEM',
    parseEd25519PublicKey(publicKey.export({ type: 'spki', format: 'pem' })).asymmetricKeyType === 'ed25519',
  );

  const tamperedData = Buffer.from(data);
  tamperedData[0] ^= 0xff;
  check('rejects a tampered payload', verifyEd25519(tamperedData, signature, publicKey) === false);

  const tamperedSig = Buffer.from(signature);
  tamperedSig[0] ^= 0xff;
  check('rejects a tampered signature', verifyEd25519(data, tamperedSig, publicKey) === false);

  check(
    'a mismatched (different) keypair fails to verify',
    verifyEd25519(data, signature, generateKeyPairSync('ed25519').publicKey) === false,
  );

  check(
    'garbage bytes as a "public key" return false, not throw',
    verifyEd25519(data, signature, Buffer.from([1, 2, 3])) === false,
  );
}

/* --- 9. verifyCatalogSignature fails closed --------------------------------------- */
console.log('\n[9] verifyCatalogSignature fails closed with no key configured');
{
  check('OPENMEMO_CATALOG_PUBLIC_KEY is honestly null (no key provisioned yet)', OPENMEMO_CATALOG_PUBLIC_KEY === null);

  const catalogBytes = Buffer.from('{"models":[]}');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = cryptoSign(null, catalogBytes, privateKey);

  const errDefault = await mustThrow(() => verifyCatalogSignature(catalogBytes, signature));
  check('throws using the default (unconfigured) key', errDefault != null, errDefault?.message?.slice(0, 90));

  const errExplicitNull = await mustThrow(() => verifyCatalogSignature(catalogBytes, signature, null));
  check('throws when explicitly passed a null key', errExplicitNull != null, errExplicitNull?.message?.slice(0, 60));

  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const ok = await verifyCatalogSignature(catalogBytes, signature, rawPublicKey);
  check('verifies correctly once a key IS supplied', ok === true);

  const tampered = Buffer.from(catalogBytes);
  tampered[0] ^= 0xff;
  const rejected = await verifyCatalogSignature(tampered, signature, rawPublicKey);
  check('a tampered catalog fails verification (does not throw, returns false)', rejected === false);
}

/* -------------------------------- summary --------------------------------- */

await fs.rm(root, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('='.repeat(60));
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
