/**
 * Archive extraction with zip-slip / zip-bomb protection.
 *
 * Zero new dependencies (repo constraint): ZIP is parsed by hand against the format spec
 * (PKWARE APPNOTE.TXT) using `node:zlib`'s `inflateRawSync` for method 8 and a raw copy for
 * method 0 (stored); tar.gz is `gunzipSync` followed by a hand-rolled 512-byte-header tar
 * reader. Both are "just" binary format parsers — the actual engineering budget here goes
 * into the security properties, not the parsing:
 *
 *   - zip-slip: every entry name is validated BEFORE it touches the filesystem. Reject
 *     absolute paths (POSIX `/foo`, Windows `C:\foo`, UNC `\\server\share`), reject any
 *     path containing a literal `..` segment, and as defense-in-depth, re-check the
 *     resolved path against the destination root with `path.resolve` + a `path.sep`-aware
 *     prefix comparison (catches anything the segment check missed — e.g. a segment that
 *     is legal on its own but combines with others in a surprising way).
 *   - symlinks: never created. A symlink entry is a path-traversal primitive by another
 *     name (point it outside destDir, then a later "regular file" entry writes through it).
 *     Rejected outright rather than "safely" resolved, because there is no upstream use
 *     case for a backend pack or model archive shipping a symlink.
 *   - zip/tar bombs: two independent caps. `maxEntries` bounds entry COUNT, checked as
 *     central-directory / tar-header records are discovered (before we act on any of
 *     them — a crafted archive cannot even get us to allocate per-entry state past the
 *     cap). `maxTotalBytes` bounds uncompressed OUTPUT, enforced two ways: (a) a
 *     running-total check against each entry's declared size before we inflate it, and
 *     (b) `zlib`'s own `maxOutputLength` option on the inflate/gunzip call itself, which
 *     aborts mid-decompression rather than after — so a header that UNDER-declares its
 *     true size (lying in the other direction) still cannot blow memory, because the
 *     decompressor itself refuses to produce more bytes than the cap.
 *
 * Executable bit: backend packs ship real binaries (`llama-server` and friends). ZIP
 * stores Unix permissions in the upper 16 bits of the central-directory "external file
 * attributes" field when "version made by" reports a Unix host; tar stores them directly
 * in the header's octal mode field. Both are restored with `fs.chmod` post-write. Skipped
 * entirely on Windows, where chmod is meaningless.
 *
 * Known limitation, stated rather than hidden: ZIP64 (needed only for entries or archives
 * >4 GiB, or >65535 entries) is NOT implemented. Detected and rejected with a clear error
 * rather than silently mis-parsed — the backend packs and CoreML encoders we ship today
 * are nowhere near that size.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// `process` is used as the TypeScript/Node ambient global (see store.ts for the same
// pattern) rather than imported — this file is compiled, never run directly by node with
// bare specifiers, and the repo's eslint config supplies node globals for **/*.ts.

export interface UnpackResult {
  /** Absolute paths of every regular file written (directories are not included). */
  files: string[];
  /** Sum of the uncompressed bytes actually written. */
  totalBytes: number;
}

export interface UnpackOptions {
  /** Zip-bomb guard: refuse an archive whose uncompressed output exceeds this. Default 4 GiB. */
  maxTotalBytes?: number;
  /** Zip-bomb guard: refuse an archive with more entries than this. Default 20000. */
  maxEntries?: number;
  signal?: AbortSignal;
}

export type UnpackErrorCode =
  | 'PATH_TRAVERSAL'
  | 'SYMLINK_REJECTED'
  | 'LIMIT_EXCEEDED'
  | 'UNSUPPORTED'
  | 'CORRUPT'
  | 'ABORTED';

export class UnpackError extends Error {
  constructor(
    message: string,
    readonly code: UnpackErrorCode,
  ) {
    super(message);
    this.name = 'UnpackError';
  }
}

const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
const DEFAULT_MAX_ENTRIES = 20_000;

interface Budget {
  maxTotalBytes: number;
  maxEntries: number;
  totalBytes: number;
  entryCount: number;
}

function newBudget(opts?: UnpackOptions): Budget {
  return {
    maxTotalBytes: opts?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxEntries: opts?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    totalBytes: 0,
    entryCount: 0,
  };
}

/** Count one more entry (file, dir, or pseudo-header); throws once the archive-wide cap is hit. */
function noteEntry(budget: Budget): void {
  budget.entryCount++;
  if (budget.entryCount > budget.maxEntries) {
    throw new UnpackError(
      `Archive has more than ${budget.maxEntries} entries — refusing to extract (zip-bomb guard)`,
      'LIMIT_EXCEEDED',
    );
  }
}

/** Charge bytes against the running uncompressed-output total; throws once the cap is hit. */
function noteBytes(budget: Budget, extraBytes: number, name: string): void {
  budget.totalBytes += extraBytes;
  if (budget.totalBytes > budget.maxTotalBytes) {
    throw new UnpackError(
      `Archive exceeds ${budget.maxTotalBytes} total uncompressed bytes ` +
        `(while extracting "${name}") — refusing to extract (zip-bomb guard)`,
      'LIMIT_EXCEEDED',
    );
  }
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new UnpackError('Unpack aborted', 'ABORTED');
}

/* --------------------------- shared path safety --------------------------- */

// Windows drive-letter absolute path (`C:\foo`, `C:/foo`) and UNC share (`\\server\share`).
// Checked unconditionally regardless of host platform: a malicious archive extracted on
// Linux with a Windows-style absolute name is otherwise just treated as a relative path
// containing literal backslashes, which is *also* unsafe, so both forms are rejected.
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;
const UNC_RE = /^[\\/]{2}/;

function assertSafeEntryName(rawName: string): void {
  if (rawName.length === 0) {
    throw new UnpackError('Archive entry has an empty name', 'CORRUPT');
  }
  if (rawName.startsWith('/') || rawName.startsWith('\\') || WINDOWS_ABS_RE.test(rawName) || UNC_RE.test(rawName)) {
    throw new UnpackError(`Archive entry uses an absolute path: "${rawName}"`, 'PATH_TRAVERSAL');
  }
  // Split on both separators: ZIP mandates '/', but a hostile entry can still embed '\'
  // and rely on the extractor being run on Windows to reinterpret it as a separator.
  const segments = rawName.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new UnpackError(`Archive entry escapes destination via "..": "${rawName}"`, 'PATH_TRAVERSAL');
  }
}

/**
 * Resolve an entry name against destDir, rejecting anything that would land outside it.
 * `assertSafeEntryName` is the fast, readable gate; the resolve+prefix check below is the
 * authoritative one and is what actually has to be correct.
 */
function safeJoin(destDir: string, rawName: string): string {
  assertSafeEntryName(rawName);
  const destRoot = path.resolve(destDir);
  const resolved = path.resolve(destRoot, rawName);
  if (resolved !== destRoot && !resolved.startsWith(destRoot + path.sep)) {
    throw new UnpackError(`Archive entry resolves outside destination: "${rawName}"`, 'PATH_TRAVERSAL');
  }
  return resolved;
}

/* --------------------------------- ZIP ------------------------------------ */
// Reference: PKWARE .ZIP File Format Specification (APPNOTE.TXT). Only what backend packs
// and model archives actually use is implemented: methods 0 (stored) and 8 (deflate),
// single-disk archives, optional Unix external attributes. No ZIP64, no encryption.

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const EOCD_FIXED_LEN = 22;
const MAX_COMMENT_LEN = 0xffff;
const UNIX_HOST = 3; // "version made by" upper byte == 3 means the Unix external-attrs layout
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

async function readAt(fh: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let filled = 0;
  // A single fh.read() call is not guaranteed to fill the buffer on every platform/fs;
  // loop until we either have everything or hit true EOF.
  while (filled < length) {
    const { bytesRead } = await fh.read(buf, filled, length - filled, position + filled);
    if (bytesRead === 0) {
      throw new UnpackError('Unexpected end of archive while reading', 'CORRUPT');
    }
    filled += bytesRead;
  }
  return buf;
}

interface ZipCentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isUnix: boolean;
  externalAttrs: number;
}

async function findEndOfCentralDirectory(
  fh: fs.FileHandle,
  fileSize: number,
): Promise<{ entriesTotal: number; cdSize: number; cdOffset: number }> {
  const searchLen = Math.min(fileSize, EOCD_FIXED_LEN + MAX_COMMENT_LEN);
  const start = fileSize - searchLen;
  const buf = await readAt(fh, start, searchLen);

  for (let i = buf.length - EOCD_FIXED_LEN; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    // A real EOCD's comment must run exactly to the end of the buffer/file; this rules
    // out the (rare) false positive of the signature bytes appearing inside a comment.
    if (i + EOCD_FIXED_LEN + commentLen !== buf.length) continue;

    const entriesTotal = buf.readUInt16LE(i + 10);
    const cdSize = buf.readUInt32LE(i + 12);
    const cdOffset = buf.readUInt32LE(i + 16);
    if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new UnpackError('ZIP64 archives are not supported', 'UNSUPPORTED');
    }
    return { entriesTotal, cdSize, cdOffset };
  }
  throw new UnpackError('Not a valid ZIP file (End Of Central Directory record not found)', 'CORRUPT');
}

function parseCentralDirectory(cdBuf: Buffer, budget: Budget): ZipCentralEntry[] {
  const entries: ZipCentralEntry[] = [];
  let p = 0;
  while (p + 46 <= cdBuf.length) {
    const sig = cdBuf.readUInt32LE(p);
    if (sig !== CD_SIG) break;

    const versionMadeBy = cdBuf.readUInt16LE(p + 4);
    const method = cdBuf.readUInt16LE(p + 10);
    const compressedSize = cdBuf.readUInt32LE(p + 20);
    const uncompressedSize = cdBuf.readUInt32LE(p + 24);
    const nameLen = cdBuf.readUInt16LE(p + 28);
    const extraLen = cdBuf.readUInt16LE(p + 30);
    const commentLen = cdBuf.readUInt16LE(p + 32);
    const externalAttrs = cdBuf.readUInt32LE(p + 38);
    const localHeaderOffset = cdBuf.readUInt32LE(p + 42);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new UnpackError('ZIP64 entries are not supported', 'UNSUPPORTED');
    }

    const nameStart = p + 46;
    const name = cdBuf.toString('utf8', nameStart, nameStart + nameLen);
    p = nameStart + nameLen + extraLen + commentLen;

    noteEntry(budget); // counted as each CD record is discovered, before any extraction work
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isUnix: (versionMadeBy >>> 8) === UNIX_HOST,
      externalAttrs,
    });
  }
  return entries;
}

export async function unpackZip(src: string, destDir: string, opts?: UnpackOptions): Promise<UnpackResult> {
  const budget = newBudget(opts);
  const files: string[] = [];
  const destRoot = path.resolve(destDir);
  await fs.mkdir(destRoot, { recursive: true });

  const fh = await fs.open(src, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    if (fileSize < EOCD_FIXED_LEN) {
      throw new UnpackError('Not a valid ZIP file (too small)', 'CORRUPT');
    }
    const eocd = await findEndOfCentralDirectory(fh, fileSize);
    const cdBuf = await readAt(fh, eocd.cdOffset, eocd.cdSize);
    const entries = parseCentralDirectory(cdBuf, budget);

    for (const entry of entries) {
      checkAborted(opts?.signal);

      const isDir = entry.name.endsWith('/');
      const dest = safeJoin(destRoot, entry.name);

      if (entry.isUnix && ((entry.externalAttrs >>> 16) & S_IFMT) === S_IFLNK) {
        throw new UnpackError(`Archive contains a symlink entry, which is rejected: "${entry.name}"`, 'SYMLINK_REJECTED');
      }

      if (isDir) {
        await fs.mkdir(dest, { recursive: true });
        continue;
      }

      noteBytes(budget, entry.uncompressedSize, entry.name);

      // Local header lengths, not the central directory's, determine where file data
      // starts — the two are usually identical but the spec only guarantees the local one.
      const lfh = await readAt(fh, entry.localHeaderOffset, 30);
      if (lfh.readUInt32LE(0) !== LFH_SIG) {
        throw new UnpackError(`Corrupt local file header for "${entry.name}"`, 'CORRUPT');
      }
      const lfhNameLen = lfh.readUInt16LE(26);
      const lfhExtraLen = lfh.readUInt16LE(28);
      const dataOffset = entry.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
      const compressed = await readAt(fh, dataOffset, entry.compressedSize);

      let data: Buffer;
      if (entry.method === 0) {
        if (compressed.length !== entry.uncompressedSize) {
          throw new UnpackError(`Stored entry "${entry.name}" size mismatch`, 'CORRUPT');
        }
        data = compressed;
      } else if (entry.method === 8) {
        try {
          // maxOutputLength is the real zip-bomb backstop: it caps memory during
          // decompression itself, so a header that understates its true output size
          // cannot use that lie to blow past the budget before we get to check anything.
          data = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
        } catch (e) {
          throw new UnpackError(`Failed to inflate "${entry.name}": ${(e as Error).message}`, 'CORRUPT');
        }
      } else {
        throw new UnpackError(`Unsupported ZIP compression method ${entry.method} for "${entry.name}"`, 'UNSUPPORTED');
      }
      if (data.length !== entry.uncompressedSize) {
        throw new UnpackError(`"${entry.name}" decompressed to an unexpected size`, 'CORRUPT');
      }

      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);

      if (entry.isUnix && process.platform !== 'win32') {
        const unixMode = entry.externalAttrs >>> 16;
        if (unixMode !== 0 && (unixMode & 0o111) !== 0) {
          await fs.chmod(dest, unixMode & 0o777);
        }
      }
      files.push(dest);
    }
  } finally {
    await fh.close();
  }

  return { files, totalBytes: budget.totalBytes };
}

/* -------------------------------- tar.gz ----------------------------------- */
// gunzip fully into memory (bounded by maxOutputLength == maxTotalBytes, so this can never
// exceed the configured zip-bomb cap), then walk 512-byte tar headers by hand. ustar,
// pre-POSIX v7 (no prefix field, harmless to read as empty), and the GNU/pax long-name
// extensions used by real-world tar writers are all handled; anything else (character/block
// devices, FIFOs) is skipped without creating anything.

const TAR_BLOCK = 512;

function isZeroBlock(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function readCString(buf: Buffer): string {
  const nul = buf.indexOf(0);
  return (nul === -1 ? buf : buf.subarray(0, nul)).toString('utf8');
}

/** Tar numeric fields are octal ASCII, or GNU base-256 (high bit of byte 0 set) for values too large for that. */
function parseTarNumeric(buf: Buffer): number {
  if (buf.length > 0 && (buf[0] & 0x80) !== 0) {
    let value = BigInt(buf[0] & 0x7f);
    for (let i = 1; i < buf.length; i++) value = (value << 8n) | BigInt(buf[i]);
    return Number(value);
  }
  const str = readCString(buf).trim();
  return str.length ? parseInt(str, 8) || 0 : 0;
}

/** PAX extended header record: "<len> <key>=<value>\n", length-prefixed and self-delimiting. */
function parsePaxRecords(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const len = parseInt(data.toString('ascii', offset, spaceIdx), 10);
    if (!Number.isFinite(len) || len <= 0 || offset + len > data.length) break;
    const recordEnd = offset + len;
    const kv = data.toString('utf8', spaceIdx + 1, recordEnd - 1); // drop trailing '\n'
    const eq = kv.indexOf('=');
    if (eq !== -1) result[kv.slice(0, eq)] = kv.slice(eq + 1);
    offset = recordEnd;
  }
  return result;
}

export async function unpackTarGz(src: string, destDir: string, opts?: UnpackOptions): Promise<UnpackResult> {
  const budget = newBudget(opts);
  const destRoot = path.resolve(destDir);
  await fs.mkdir(destRoot, { recursive: true });

  const compressed = await fs.readFile(src);
  let raw: Buffer;
  try {
    raw = zlib.gunzipSync(compressed, { maxOutputLength: budget.maxTotalBytes });
  } catch (e) {
    throw new UnpackError(`Failed to gunzip "${src}": ${(e as Error).message}`, 'CORRUPT');
  }

  const files: string[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + TAR_BLOCK <= raw.length) {
    checkAborted(opts?.signal);

    const header = raw.subarray(offset, offset + TAR_BLOCK);
    if (isZeroBlock(header)) break; // end-of-archive marker (two zero blocks; one is enough to stop)
    offset += TAR_BLOCK;
    noteEntry(budget);

    const typeFlag = String.fromCharCode(header[156]);
    const size = parseTarNumeric(header.subarray(124, 136));
    const data = raw.subarray(offset, offset + size);
    if (data.length !== size) {
      throw new UnpackError('Truncated tar archive', 'CORRUPT');
    }
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    // GNU long-name extension: this "entry" is actually the name for the NEXT header.
    if (typeFlag === 'L') {
      pendingLongName = readCString(data);
      continue;
    }
    // GNU long-linkname: only meaningful for symlinks/hardlinks, which are rejected below
    // regardless — consumed here purely so the archive keeps parsing correctly.
    if (typeFlag === 'K') {
      continue;
    }
    // PAX extended header: pull `path` for the next entry; global headers ('g') are noted
    // but not applied — no per-entry field we care about is commonly set globally.
    if (typeFlag === 'x') {
      const pax = parsePaxRecords(data);
      if (pax.path) pendingLongName = pax.path;
      continue;
    }
    if (typeFlag === 'g') {
      continue;
    }

    const magic = header.toString('ascii', 257, 263);
    const prefix = magic.startsWith('ustar') ? readCString(header.subarray(345, 500)) : '';
    const baseName = readCString(header.subarray(0, 100));
    const name = pendingLongName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    pendingLongName = null;

    if (typeFlag === '2' || typeFlag === '1') {
      throw new UnpackError(`Archive contains a symlink/hardlink entry, which is rejected: "${name}"`, 'SYMLINK_REJECTED');
    }

    const isDir = typeFlag === '5' || name.endsWith('/');
    if (typeFlag !== '0' && typeFlag !== '\0' && !isDir) {
      // Device files, FIFOs, etc. — not meaningful for backend packs/models; skip quietly.
      continue;
    }

    const dest = safeJoin(destRoot, name);

    if (isDir) {
      await fs.mkdir(dest, { recursive: true });
      continue;
    }

    noteBytes(budget, data.length, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);

    const mode = parseTarNumeric(header.subarray(100, 108)) & 0o7777;
    if (process.platform !== 'win32' && (mode & 0o111) !== 0) {
      await fs.chmod(dest, mode);
    }
    files.push(dest);
  }

  return { files, totalBytes: budget.totalBytes };
}

/* ------------------------------- dispatch ---------------------------------- */

export async function unpackArchive(
  src: string,
  destDir: string,
  kind: 'zip' | 'tar.gz',
  opts?: UnpackOptions,
): Promise<UnpackResult> {
  if (kind === 'zip') return unpackZip(src, destDir, opts);
  if (kind === 'tar.gz') return unpackTarGz(src, destDir, opts);
  throw new UnpackError(`Unsupported archive kind: ${kind}`, 'UNSUPPORTED');
}
