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
 *   - symlinks: created, but only after the target has been resolved AGAINST THE REAL
 *     FILESYSTEM and shown to stay inside destDir. Blanket rejection was tried and is
 *     wrong: upstream whisper.cpp ships `libwhisper.so -> libwhisper.so.1.9.1`, and a
 *     guard that stops the product from installing its own backend is a broken guard.
 *     Purely lexical target validation is ALSO wrong, and was a real, reproduced sandbox
 *     escape — `path.resolve` cancels `s/..` as text while the kernel follows `s` first.
 *     Every entry destination and every link target therefore goes through
 *     `resolveWithinRoot()`, which walks `lstat`/`readlink` itself. Read the long comment
 *     there before touching any of it: three separate ways to get this wrong are recorded
 *     with measurements, and two of them look correct.
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
  /**
   * 解包进度。**两种格式都给得出真分母，一个都不用编**：
   *
   * | 格式 | `done` / `total` | 依据 |
   * |---|---|---|
   * | zip | 已处理条目 / 中央目录条目总数 | EOCD 里的 `entriesTotal`，**解包前就已知** |
   * | tar | 已消费字节 / 解压后总字节 | `extractTar` 先整个解压进 `raw`，`raw.length` 是真值 |
   *
   * `unit` 让调用方能说人话（"第 N/M 个文件" vs 字节比例）而不必猜语义。
   *
   * ⚠️ **本回调不节流**：它每个条目都调一次。节流是调用方的事
   * （`installer.ts` 与下载那条共用同一个理由与同一个速率）——
   * 在这里节流会让"解包到底走到哪了"这件事本身变得不可观测。
   */
  onProgress?: (done: number, total: number, unit: 'entries' | 'bytes') => void;
}

export type UnpackErrorCode =
  'PATH_TRAVERSAL' | 'SYMLINK_REJECTED' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED' | 'CORRUPT' | 'ABORTED';

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

/**
 * The lexical (string-only) half of every path check takes `platform` as an ARGUMENT.
 *
 * Not for portability — for testability. `path.resolve`/`path.sep` bind to the host, so
 * the win32 branch of a path guard written on Linux is a branch that has never executed
 * once. That is the exact shape of this repo's "false green light #8" (`isSafeExecutable`)
 * and of T-143 ② (`assertWithinRoot`): the guard looked right, was never run, and nobody
 * could tell. With `platform` as a parameter, `path.win32` rules are reachable from a
 * Linux test run, so "wrong on Windows" fails here rather than on a user's machine.
 *
 * Defaulting to `process.platform` keeps behaviour byte-identical on both hosts
 * (`path === path.posix` on Linux/macOS, `path === path.win32` on Windows).
 */
function lex(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * macOS 打包副产物 —— **从来不是载荷**，一律不落盘。
 *
 * ─── 为什么这是一条独立的规则（判据与"修正层级"不同）───────────────────────────
 *
 * macOS 上用 Finder「压缩」或 `zip` 打出来的归档，会把每个文件的资源分支与扩展属性
 * 另存成 AppleDouble 边车（`._<原名>`），zip 把它们集中到一个 `__MACOSX/` 顶层目录里，
 * tar 则直接放在原文件旁边。`.DS_Store` 是 Finder 的窗口状态。
 * 这三样**在任何一个包里都不是内容**：删掉它们，包该干的事一件不少。
 *
 * 判据因此是**"这条目有没有可能是载荷"**（纯粹由名字决定，与目的地、与消费方无关），
 * 而不是"目录层级对不对"（那要知道消费方去哪里找，见 installer.ts 的
 * `collapseRedundantTopLevel`）。两件事判据不同，所以是两处代码、两组测试 ——
 * 混成一件事的话，其中一条改了会悄悄改掉另一条的行为。
 *
 * ─── 不清掉的代价（`[实测]`，不是假设）───────────────────────────────────────────
 *
 * `ggml-large-v3-encoder.mlmodelc.zip` 的真中央目录（HTTP Range 从镜像读回，9 条）：
 *
 *     ggml-large-v3-encoder.mlmodelc/…            ← 载荷（含 coremldata.bin）
 *     __MACOSX/ggml-large-v3-encoder.mlmodelc/._metadata.json   ← 就这一条
 *
 * `collapseRedundantTopLevel` 要求"顶层恰好一个条目"，而 `__MACOSX` 让它变成两个 ——
 * 于是压不掉，装出来是个空壳，whisper.cpp 静默回退到 Metal/CPU，用户白付 1.17 GB。
 * **一条 171 字节的边车文件，废掉了整条修复。**
 */
export function isMacArchiveJunk(rawName: string): boolean {
  const segments = rawName.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return false;
  if (segments[0] === '__MACOSX') return true;
  const base = segments[segments.length - 1] as string;
  // `._x` 是 AppleDouble 的固定前缀；`.DS_Store` 是 Finder 的窗口状态。
  return base === '.DS_Store' || base.startsWith('._');
}

function assertSafeEntryName(rawName: string): void {
  if (rawName.length === 0) {
    throw new UnpackError('Archive entry has an empty name', 'CORRUPT');
  }
  if (
    rawName.startsWith('/') ||
    rawName.startsWith('\\') ||
    WINDOWS_ABS_RE.test(rawName) ||
    UNC_RE.test(rawName)
  ) {
    throw new UnpackError(`Archive entry uses an absolute path: "${rawName}"`, 'PATH_TRAVERSAL');
  }
  // Split on both separators: ZIP mandates '/', but a hostile entry can still embed '\'
  // and rely on the extractor being run on Windows to reinterpret it as a separator.
  const segments = rawName.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new UnpackError(
      `Archive entry escapes destination via "..": "${rawName}"`,
      'PATH_TRAVERSAL',
    );
  }
}

/**
 * Resolve an entry name against destDir, rejecting anything that would land outside it.
 *
 * ⚠️ This is the LEXICAL gate only. It is fast, readable and pure — and on its own it is
 * NOT sufficient, because `path.resolve` folds `..` as string arithmetic while the kernel
 * folds it after following symlinks. See {@link resolveWithinRoot} for the check that
 * actually decides.
 */
export function lexicalEntryPath(
  destDir: string,
  rawName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  assertSafeEntryName(rawName);
  const p = lex(platform);
  const destRoot = p.resolve(destDir);
  const resolved = p.resolve(destRoot, rawName);
  if (resolved !== destRoot && !resolved.startsWith(destRoot + p.sep)) {
    throw new UnpackError(
      `Archive entry resolves outside destination: "${rawName}"`,
      'PATH_TRAVERSAL',
    );
  }
  return resolved;
}

/**
 * The LEXICAL half of the link-target check.
 *
 * Rejecting EVERY symlink is too blunt and breaks real software: the official
 * whisper.cpp tarball ships `libwhisper.so -> libwhisper.so.1.7.6`, which is ordinary
 * shared-library versioning, not an attack. A guard that blocks the product from
 * installing its own backend is a broken guard.
 *
 * The actual threat is a link that ESCAPES the destination — `evil -> /etc/passwd`, or
 * `evil -> ../../../home/user/.ssh/id_rsa` — because a later write through that path
 * lands outside the sandbox. So the rule is target-based, not type-based.
 *
 * ⚠️ Again: lexical only. It stops the blunt forms early and produces a readable error;
 * {@link resolveWithinRoot} is what makes the guard true.
 */
export function lexicalLinkTarget(
  destRoot: string,
  entryName: string,
  linkTarget: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (linkTarget.length === 0) {
    throw new UnpackError(`Archive link "${entryName}" has an empty target`, 'CORRUPT');
  }
  if (
    linkTarget.startsWith('/') ||
    linkTarget.startsWith('\\') ||
    WINDOWS_ABS_RE.test(linkTarget)
  ) {
    throw new UnpackError(
      `Archive link "${entryName}" points outside the archive via an absolute path: "${linkTarget}"`,
      'SYMLINK_REJECTED',
    );
  }
  const p = lex(platform);
  const root = p.resolve(destRoot);
  const linkDir = p.dirname(p.resolve(root, entryName));
  const resolved = p.resolve(linkDir, linkTarget);
  if (resolved !== root && !resolved.startsWith(root + p.sep)) {
    throw new UnpackError(
      `Archive link "${entryName}" escapes the destination: "${linkTarget}"`,
      'SYMLINK_REJECTED',
    );
  }
  return resolved;
}

/* ------------------- resolve-then-check (the authoritative half) ------------------- */

/**
 * ★ Why a lexical check is not a containment check.
 *
 * `path.resolve` cancels `s/..` as *text*. The kernel does not: it follows `s` first and
 * then applies `..` to wherever that landed. Feed both the same string and they disagree:
 *
 * ```
 * destRoot/s          ->  "."                      (a link to destRoot itself; lexically OK)
 * destRoot/evil       ->  "s/../OUTSIDE.txt"       lexical: destRoot/OUTSIDE.txt   ✅ allowed
 *                                                  kernel : <parent>/OUTSIDE.txt   🔴 escaped
 * ```
 *
 * `[实测]` against the pre-fix build this was not merely a read primitive: a third entry,
 * an ordinary file also named `evil`, was written THROUGH the link and overwrote a file
 * outside destRoot. Arbitrary write, not arbitrary read.
 *
 * ── Three traps this function exists to avoid, each one hit for real while writing it ──
 *
 * 1. **`path.join`/`path.resolve` destroy the evidence.** `path.join(d,'s','..','x')`
 *    returns `d/x` — the escape is gone before any syscall happens. So the walk below
 *    splits the raw string and never joins across a `..`.
 * 2. **`fs.realpath` is not the kernel.** `[实测]` on the exact shape above, Node's
 *    `fs.realpathSync` throws ENOENT while `fs.realpathSync.native` returns the escaped
 *    path and `readFileSync` happily reads it. A guard built on `fs.realpath` would
 *    therefore fail *closed* here by accident and fail *open* elsewhere. We walk
 *    `lstat`/`readlink` ourselves instead, which also lets us resolve a path whose tail
 *    does not exist yet — mandatory, because tar hands us `libwhisper.so ->
 *    libwhisper.so.1.9.1` before the target file has been written.
 * 3. **The root must be resolved the same way.** Comparing a resolved candidate against a
 *    *lexical* root nukes the whole media/backend tree the moment the data directory is
 *    itself reached through a link (macOS `/var -> /private/var`). T-143 ① hit this.
 */
const MAX_LINK_HOPS = 40;

/**
 * Split an absolute path into its root and the remainder BELOW that root.
 *
 * ── ★ Why this exists (T-63, a real Windows-only hole in the guard below) ─────────────
 * `walk()` takes a *relative* remainder and applies it segment by segment. Feeding it a
 * full absolute path works on POSIX by luck — `'/a/b'.split(/[\\/]+/)` yields a leading
 * empty segment, which the loop skips. On Windows it does not:
 *
 * ```
 * 'C:\\Users\\x\\dest'.split(/[\\/]+/)   →  ['C:', 'Users', 'x', 'dest']
 * path.win32.join('C:\\', 'C:')          →  'C:\\C:'          ← the drive became a segment
 * ```
 *
 * `[本机实测]` replaying `walk()`'s segment loop under `path.win32`, the resolved root
 * came out as `C:\C:\Users\…\dest` — **a path that does not exist**. Everything downstream
 * then walks a phantom tree: every `lstat` misses, so nothing is ever seen as a symlink,
 * and `real.startsWith(rootReal + sep)` is trivially true for every candidate.
 *
 * > **Consequence: the entire resolve-then-check half of the symlink-escape guard was
 * > INERT on Windows.** The lexical half still ran, and the lexical half is exactly the
 * > one this file exists to prove insufficient. `[CI 实测 run 31304708529, win32-x64]`
 * > all four T-157 ① escape cases came back "解包本该被拒，却成功返回了".
 *
 * The same defect applied to an ABSOLUTE symlink target (`walk`'s recursive branch),
 * so both call sites go through here.
 *
 * `p` is injectable so both platforms' behaviour is reachable from a test on any host —
 * `realpath` is host-bound, but this decomposition is pure string work and is where the
 * bug lived.
 */
export function splitAbsolute(
  abs: string,
  p: path.PlatformPath = path,
): { root: string; rest: string } {
  const root = p.parse(abs).root;
  return { root, rest: abs.slice(root.length) };
}

async function walk(startReal: string, rest: string, hops: { n: number }): Promise<string> {
  let cur = startReal;
  // Split on BOTH separators: a tar written on Windows can embed `\`, and on a Windows
  // host that is a separator. Splitting on both everywhere is strictly more conservative.
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      cur = path.dirname(cur); // dirname('/') === '/', so this cannot climb past the root
      continue;
    }
    const next = path.join(cur, seg);
    let st;
    try {
      st = await fs.lstat(next);
    } catch {
      // Does not exist (yet). Everything from here on is purely nominal — which is
      // correct and is why `fs.realpath` cannot be used: it would just throw.
      cur = next;
      continue;
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++hops.n > MAX_LINK_HOPS) {
      throw new UnpackError(
        `Too many symbolic links while resolving "${rest}" (loop?)`,
        'PATH_TRAVERSAL',
      );
    }
    const target = await fs.readlink(next);
    if (path.isAbsolute(target)) {
      // ★ split the root OFF — see splitAbsolute: passing the whole absolute path makes
      // the drive letter a path segment on Windows and lands us in a phantom tree.
      const { root, rest: below } = splitAbsolute(target);
      cur = await walk(root, below, hops);
    } else {
      cur = await walk(cur, target, hops);
    }
  }
  return cur;
}

/**
 * Resolve `rel` against `rootReal` following symlinks, and assert the result is inside.
 *
 * @param rootReal destination root, ALREADY put through {@link resolveRoot}.
 * @param rel      path relative to the root; may contain `..` and either separator.
 */
async function resolveWithinRoot(
  rootReal: string,
  rel: string,
  what: string,
  code: UnpackErrorCode,
): Promise<string> {
  const real = await walk(rootReal, rel, { n: 0 });
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new UnpackError(
      `${what} resolves outside the destination once symlinks are followed: ` +
        `"${rel}" → "${real}" (destination is "${rootReal}")`,
      code,
    );
  }
  return real;
}

/** Resolve the destination root itself with the same walker (see trap 3 above). */
async function resolveRoot(destDir: string): Promise<string> {
  const abs = path.resolve(destDir);
  const { root, rest } = splitAbsolute(abs);
  const real = await walk(root, rest, { n: 0 });
  /*
   * ★ 守卫，而不是纪律：**解析出来的根必须真的存在。**
   *
   * 两个调用点都在紧挨着的上一行 `fs.mkdir(destRoot, {recursive:true})`，
   * 所以"根存在"是**这个函数被调用时的既定事实**，不是期望。
   *
   * 加这一条是因为上面那个 bug 的形状：解析器悄悄算出一个**不存在**的根
   * （`C:\C:\Users\…`），然后所有包含性判断都在那棵幻影树里做，
   * 而幻影树里一切都"在根内" —— **守卫没有变红，它变成了恒真**。
   * 这类失败不会以"报错"的形式出现，只会以"再也拦不住任何东西"的形式出现。
   * 现在它会当场炸，而不是安静地放行。
   */
  try {
    await fs.lstat(real);
  } catch {
    throw new UnpackError(
      `Resolved destination root does not exist: "${destDir}" → "${real}". ` +
        `The containment guard cannot run against a path that is not there.`,
      'CORRUPT',
    );
  }
  return real;
}

/** Directory part of an archive entry name, in the archive's own (separator-agnostic) terms. */
function entryDir(name: string): string {
  const idx = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return idx === -1 ? '' : name.slice(0, idx);
}

/**
 * Where this entry will REALLY be created, once every symlink on the way is followed.
 *
 * Called for files AND directories, before `mkdir`/`writeFile` — not after. An earlier
 * entry can have installed a directory symlink, and `fs.mkdir(..., {recursive:true})`
 * follows it, so "check afterwards" would mean checking a directory we already created
 * outside the sandbox.
 */
function resolveEntryDest(rootReal: string, entryName: string): Promise<string> {
  return resolveWithinRoot(rootReal, entryName, `Archive entry "${entryName}"`, 'PATH_TRAVERSAL');
}

/**
 * Final sweep: every link we created must STILL resolve inside the root.
 *
 * Per-entry checks alone are order-dependent, and the archive picks the order. Given
 * `evil -> "s/../OUTSIDE.txt"` FIRST and `s -> "."` second, the check on `evil` runs while
 * `s` does not exist yet, so `evil` legitimately resolves inside at that instant — and the
 * second entry silently re-points it outside. `[实测]` on the pre-sweep build the archive
 * unpacked with exit status "success" and left a link pointing out of the sandbox, which
 * anything later walking the pack directory would follow.
 *
 * So the per-entry check is not replaced by this one; both are needed. The per-entry check
 * is what stops a write from landing outside *during* extraction; this is what stops the
 * finished tree from containing a door.
 */
async function assertLinksStillInside(rootReal: string, linkNames: string[]): Promise<void> {
  for (const name of linkNames) {
    await resolveWithinRoot(
      rootReal,
      name,
      `Archive link "${name}" (re-checked after extraction)`,
      'SYMLINK_REJECTED',
    );
  }
}

/** Lexical gate + resolve-then-check for a link entry. Returns the REAL target path. */
async function resolveLinkEntry(
  destRoot: string,
  rootReal: string,
  entryName: string,
  linkTarget: string,
): Promise<string> {
  lexicalLinkTarget(destRoot, entryName, linkTarget);
  const dir = entryDir(entryName);
  return resolveWithinRoot(
    rootReal,
    dir === '' ? linkTarget : `${dir}/${linkTarget}`,
    `Archive link "${entryName}" -> "${linkTarget}"`,
    'SYMLINK_REJECTED',
  );
}

/**
 * Create a link that has already been validated as internal.
 *
 * Falls back to copying on Windows, where symlink creation needs Developer Mode or
 * elevation. A copy is functionally equivalent here (these are small `.so`/`.dll`
 * version aliases) and costs less than making the user change an OS setting.
 */
async function materialiseLink(
  dest: string,
  linkTarget: string,
  resolvedTarget: string,
  hard: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { force: true });
  try {
    if (hard) await fs.link(resolvedTarget, dest);
    else await fs.symlink(linkTarget, dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOSYS' || code === 'EXDEV' || code === 'ENOENT') {
      // Target may legitimately not exist yet (tar order) — retry as a copy if possible.
      try {
        await fs.copyFile(resolvedTarget, dest);
      } catch {
        throw new UnpackError(
          `Could not materialise link "${dest}" -> "${linkTarget}": ${String((e as Error).message)}`,
          'CORRUPT',
        );
      }
    } else {
      throw e;
    }
  }
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
  throw new UnpackError(
    'Not a valid ZIP file (End Of Central Directory record not found)',
    'CORRUPT',
  );
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

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
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
      isUnix: versionMadeBy >>> 8 === UNIX_HOST,
      externalAttrs,
    });
  }
  return entries;
}

export async function unpackZip(
  src: string,
  destDir: string,
  opts?: UnpackOptions,
): Promise<UnpackResult> {
  const budget = newBudget(opts);
  const files: string[] = [];
  const links: string[] = [];
  const destRoot = path.resolve(destDir);
  await fs.mkdir(destRoot, { recursive: true });
  const rootReal = await resolveRoot(destRoot);

  const fh = await fs.open(src, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    if (fileSize < EOCD_FIXED_LEN) {
      throw new UnpackError('Not a valid ZIP file (too small)', 'CORRUPT');
    }
    const eocd = await findEndOfCentralDirectory(fh, fileSize);
    const cdBuf = await readAt(fh, eocd.cdOffset, eocd.cdSize);
    const entries = parseCentralDirectory(cdBuf, budget);
    // 真分母：中央目录里的条目总数，**解包一个字节之前就已知**
    const entriesTotal = entries.length;
    let entriesDone = 0;

    for (const entry of entries) {
      checkAborted(opts?.signal);
      /*
       * ★ 在**循环开头**计数，不在各个出口。
       * 这个循环体里有三条 `continue`（目录 / 符号链接 / mac 垃圾条目），
       * 在出口计数必然漏一条，而且漏得不显眼 —— 进度会停在 97% 那种。
       * 语义是"正在处理第 N 个 / 共 M 个"，对每条路径都成立。
       */
      entriesDone += 1;
      opts?.onProgress?.(entriesDone, entriesTotal, 'entries');

      /*
       * 垃圾条目：**先验名，再整条跳过**（见 `isMacArchiveJunk`）。
       * 顺序是有意的 —— 把穿越藏在 `__MACOSX/../../x` 里的恶意归档仍然要当场
       * `PATH_TRAVERSAL` 报出来，而不是被"跳过"悄悄咽下去。
       * 跳过发生在 `noteBytes`/inflate **之前**，所以垃圾一个字节也不会被解压。
       */
      if (isMacArchiveJunk(entry.name)) {
        assertSafeEntryName(entry.name);
        continue;
      }

      const isDir = entry.name.endsWith('/');
      const dest = lexicalEntryPath(destRoot, entry.name);
      await resolveEntryDest(rootReal, entry.name);

      const isSymlink = entry.isUnix && ((entry.externalAttrs >>> 16) & S_IFMT) === S_IFLNK;

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
          data = zlib.inflateRawSync(compressed, {
            maxOutputLength: Math.max(entry.uncompressedSize, 1),
          });
        } catch (e) {
          throw new UnpackError(
            `Failed to inflate "${entry.name}": ${(e as Error).message}`,
            'CORRUPT',
          );
        }
      } else {
        throw new UnpackError(
          `Unsupported ZIP compression method ${entry.method} for "${entry.name}"`,
          'UNSUPPORTED',
        );
      }
      if (data.length !== entry.uncompressedSize) {
        throw new UnpackError(`"${entry.name}" decompressed to an unexpected size`, 'CORRUPT');
      }

      if (isSymlink) {
        // In ZIP, a symlink's file CONTENT is its target path.
        const linkTarget = data.toString('utf8').trim();
        const resolved = await resolveLinkEntry(destRoot, rootReal, entry.name, linkTarget);
        await materialiseLink(dest, linkTarget, resolved, false);
        files.push(dest);
        links.push(entry.name);
        continue;
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

  await assertLinksStillInside(rootReal, links);
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

export async function unpackTarGz(
  src: string,
  destDir: string,
  opts?: UnpackOptions,
): Promise<UnpackResult> {
  const budget = newBudget(opts);
  const compressed = await fs.readFile(src);
  let raw: Buffer;
  try {
    raw = zlib.gunzipSync(compressed, { maxOutputLength: budget.maxTotalBytes });
  } catch (e) {
    throw new UnpackError(`Failed to gunzip "${src}": ${(e as Error).message}`, 'CORRUPT');
  }
  return extractTar(raw, destDir, budget, opts);
}

/**
 * Extract a decompressed tar stream.
 *
 * Deliberately shared by `.tar.gz` and `.tar.xz`: the compression codec is the ONLY
 * difference between them, so routing both through one extractor means every guard
 * (path traversal, absolute paths, symlink target checks, entry/byte limits) applies to
 * a new format automatically. Adding a codec must never open a hole — the way that
 * happens is a second, subtly different extraction path, so there isn't one.
 */
async function extractTar(
  raw: Buffer,
  destDir: string,
  budget: Budget,
  opts?: UnpackOptions,
): Promise<UnpackResult> {
  const destRoot = path.resolve(destDir);
  await fs.mkdir(destRoot, { recursive: true });
  const rootReal = await resolveRoot(destRoot);

  const files: string[] = [];
  const links: string[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + TAR_BLOCK <= raw.length) {
    checkAborted(opts?.signal);
    /*
     * 真分母：`raw` 是**已经整个解压出来**的 buffer（见 `unpackTarGz`/`unpackTarXz`），
     * 所以 `raw.length` 是真值，`offset/raw.length` 是**真实**比例，不是估的。
     * 报字节而不是条目：tar 的条目总数要走完才知道，而字节数一开始就知道。
     */
    opts?.onProgress?.(offset, raw.length, 'bytes');

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

    /*
     * 与 zip 那侧同一条规则、同一个顺序（先验名再跳过）。
     * tar 这侧不能只挡 `__MACOSX/`：macOS 的 `tar` 不建那个目录，
     * 而是把 `._<原名>` 直接放在原文件旁边 —— 同一个东西，另一种形状。
     * 放在链接/目录/普通文件三个分支**之前**，这样三种类型一视同仁。
     */
    if (isMacArchiveJunk(name)) {
      assertSafeEntryName(name);
      continue;
    }

    if (typeFlag === '2' || typeFlag === '1') {
      // linkname field, bytes 157..257
      const linkTarget = readCString(header.subarray(157, 257));
      const dest = lexicalEntryPath(destRoot, name);
      await resolveEntryDest(rootReal, name);
      const resolved = await resolveLinkEntry(destRoot, rootReal, name, linkTarget);
      await materialiseLink(dest, linkTarget, resolved, typeFlag === '1');
      files.push(dest);
      links.push(name);
      continue;
    }

    const isDir = typeFlag === '5' || name.endsWith('/');
    if (typeFlag !== '0' && typeFlag !== '\0' && !isDir) {
      // Device files, FIFOs, etc. — not meaningful for backend packs/models; skip quietly.
      continue;
    }

    const dest = lexicalEntryPath(destRoot, name);
    await resolveEntryDest(rootReal, name);

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

  await assertLinksStillInside(rootReal, links);
  return { files, totalBytes: budget.totalBytes };
}

/* ------------------------------- dispatch ---------------------------------- */

/**
 * `.tar.xz` — decompress with a pure-WASM xz decoder, then reuse the shared tar extractor.
 *
 * Why this matters beyond "one more format": several upstreams ship ONLY `.tar.xz`
 * (ffmpeg being the notable one). Supporting it means we can point manifests straight at
 * upstream release artifacts instead of repackaging and republishing them ourselves —
 * which removes a whole publication step from the critical path.
 *
 * `xz-decompress` is WASM, not a native addon: no node-gyp, no per-platform prebuilds,
 * works the same on Windows as on Linux. The system `xz` binary was rejected precisely
 * because it does not exist on a default Windows install.
 */
export async function unpackTarXz(
  src: string,
  destDir: string,
  opts?: UnpackOptions,
): Promise<UnpackResult> {
  const budget = newBudget(opts);
  const compressed = await fs.readFile(src);

  let raw: Buffer;
  try {
    // xz-decompress ships a CJS bundle: under ESM the named export lands on `.default`,
    // not at the top level. Reading it from the top level yields undefined and fails with
    // a misleading "not a constructor". Accept both shapes so a future ESM build of the
    // package keeps working.
    const mod = (await import('xz-decompress')) as unknown as {
      XzReadableStream?: new (s: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
      default?: {
        XzReadableStream?: new (s: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
      };
    };
    const XzReadableStream = mod.XzReadableStream ?? mod.default?.XzReadableStream;
    if (typeof XzReadableStream !== 'function') {
      throw new UnpackError('xz-decompress did not expose XzReadableStream', 'UNSUPPORTED');
    }
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(compressed));
        c.close();
      },
    });
    const reader = new XzReadableStream(source).getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      // Enforce the byte ceiling DURING decompression, not after: an xz bomb that
      // expands to hundreds of GB must not be fully materialised before we notice.
      if (total > budget.maxTotalBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UnpackError(
          `Archive exceeds ${budget.maxTotalBytes} total uncompressed bytes — refusing to extract (xz-bomb guard)`,
          'LIMIT_EXCEEDED',
        );
      }
      chunks.push(Buffer.from(value));
    }
    raw = Buffer.concat(chunks);
  } catch (e) {
    if (e instanceof UnpackError) throw e;
    throw new UnpackError(`Failed to xz-decompress "${src}": ${(e as Error).message}`, 'CORRUPT');
  }

  return extractTar(raw, destDir, budget, opts);
}

/**
 * Expand `src` into `destDir`.
 *
 * ## Failure contract (C-19 / B-4) — **this function is NOT self-cleaning**
 *
 * On failure it throws `UnpackError` and **leaves whatever it had already written in
 * `destDir`**. There is no rollback: entries are streamed to disk as they are read, so a
 * limit/corruption/traversal rejection at entry 500 leaves entries 1–499 on disk. It also
 * does not remove `destDir` itself (it creates it with `mkdir -p` before extracting).
 *
 * **Callers own atomicity.** The contract is deliberately this weak because the only
 * production caller already provides something stronger and cheaper: `install()`
 * (`installer.ts`) unpacks into a sibling `<final>.tmp-<rand>` directory and only
 * `rename()`s it into place after a clean return, deleting the temp directory on failure.
 * That is what makes "the directory exists" a truthful signal that the install completed.
 *
 * ⚠️ **Therefore: never point `destDir` at a directory a user depends on.** Doing so
 * converts any extraction failure into a half-replaced installation, which is strictly
 * worse than no installation — the verified blob is already cached, so a retry skips the
 * download, sees a directory, and the user is stuck at "installed but unusable" with no
 * way out from the UI. This happened for real: a 43-entry tarball aborted on its first
 * symlink entry and left 3 files behind, with `whisper-cli` simply absent.
 *
 * The invariant that matters to users therefore lives one layer up and is pinned by
 * `installer.test.ts` → "解包失败时不许动用户已经装好的那一份":
 * a failed unpack must leave the previous `finalDir` byte-for-byte intact and leave no
 * `.tmp-*` residue behind.
 */
export async function unpackArchive(
  src: string,
  destDir: string,
  kind: 'zip' | 'tar.gz' | 'tar.xz',
  opts?: UnpackOptions,
): Promise<UnpackResult> {
  if (kind === 'zip') return unpackZip(src, destDir, opts);
  if (kind === 'tar.gz') return unpackTarGz(src, destDir, opts);
  if (kind === 'tar.xz') return unpackTarXz(src, destDir, opts);
  throw new UnpackError(`Unsupported archive kind: ${kind}`, 'UNSUPPORTED');
}
