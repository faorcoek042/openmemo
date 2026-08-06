/**
 * Install orchestration — the layer that turns a manifest entry into installed files.
 *
 * Serves BOTH models and GPU backend packs (ADR-003 decision 6). They differ only in
 * which manifest they came from and where the result is linked; download, verify,
 * resume, mirror failover and GC are identical, so they share one implementation.
 *
 * Order of operations, and why:
 *   1. disk pre-check      — fail before transferring gigabytes
 *   2. download each file  — resumable, mirror-failing-over
 *   3. verify each file    — SHA-256; nothing is installed until this passes
 *   4. blob lands in store — atomic rename
 *   5. hardlink by-name    — human/native-tool visible path
 *   6. write manifest LAST — so a crash leaves a reclaimable orphan blob, never a
 *                            manifest pointing at a file that does not exist
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ArtifactFile, PlatformSelector } from '@openmemo/shared';
import { DownloadError, type DownloadSource, downloadFile } from './download.js';
import { type ProbeOutcome, type ProbeTarget, orderSourcesForDownload } from './probe.js';
import type { ArtifactStore, StoreKind } from './store.js';
import { toPortableRecord } from './store.js';
import { unpackArchive } from './unpack.js';

export interface InstallTarget {
  id: string;
  kind: StoreKind;
  displayName: string;
  files: ArtifactFile[];
}

export interface InstallOptions {
  store: ArtifactStore;
  target: InstallTarget;
  /** User's pinned provider, or "auto" / null for probe-ranked ordering. */
  pinnedProvider?: string | null;
  /** Latest probe results used to rank mirrors. */
  probes?: ProbeOutcome[];
  /** Current platform, used to filter platform-specific files. */
  platform?: PlatformSelector;
  /** Optional file roles to include beyond the required set. */
  includeOptional?: string[];
  signal?: AbortSignal;
  token?: string;
  maxParts?: number;
  /**
   * Expand the archive into this directory instead of `by-name/<bucket>/`,
   * relative to `dataRoot`.
   *
   * ⚠️ **This REPLACES the directory.** Extraction is made atomic by unpacking to a temp
   * directory, deleting the target, then renaming into place — so whatever was there
   * before is gone.
   *
   * Therefore it must never point at a directory that two packs share. This was almost
   * wired up to the manifests' `bin/ext`, which all eleven SQLite-extension packs
   * declare: installing libsimple and then sqlite-vec would have deleted libsimple, with
   * a successful job, a matching checksum and no error anywhere. Extensions that must
   * coexist are LINKED into place afterwards (`BackendPack.linkInto` +
   * `materializeSqliteExtensions`), which adds files rather than replacing a directory.
   *
   * The name is deliberately not `installPath`: "install path" reads as "where this pack
   * lives", which is exactly the reading that makes the destructive mistake look correct.
   */
  unpackInto?: string;
  /** Root that `unpackInto` is relative to. Defaults to the models root's parent. */
  dataRoot?: string;
  onProgress?: (p: {
    completedBytes: number;
    totalBytes: number;
    speedBps: number;
    etaSeconds: number | null;
    fileIndex: number;
    fileCount: number;
    currentFile: string;
    phase: string;
    provider: string;
  }) => void;
  onFileDone?: (f: InstalledFileRecord) => void;
}

export interface InstalledFileRecord {
  role: string;
  name: string;
  sha256: string;
  sizeBytes: number;
  /** Root for `relPath`. Portable across data-directory moves. */
  root: 'models';
  /** Path relative to the models root, POSIX separators. */
  relPath: string;
  /**
   * @deprecated Absolute path, emitted only so consumers that have not migrated keep
   * working. Read via `resolveInstalledFile()` instead.
   */
  path: string;
  provider: string;
  cached: boolean;
}

export interface InstallResult {
  id: string;
  files: InstalledFileRecord[];
  totalBytes: number;
  bytesTransferred: number;
  /** Absolute directory an archive was expanded into, when one was. */
  installedTo?: string;
}

/** Does this file apply to the current platform? */
export function fileAppliesTo(f: ArtifactFile, platform?: PlatformSelector): boolean {
  if (!f.platforms || f.platforms.length === 0) return true;
  if (!platform) return true;
  return f.platforms.some(
    (p) =>
      p.os === platform.os &&
      p.arch === platform.arch &&
      (p.backend == null || p.backend === platform.backend),
  );
}

export function selectFiles(
  files: ArtifactFile[],
  platform?: PlatformSelector,
  includeOptional: string[] = [],
): ArtifactFile[] {
  return files.filter((f) => {
    if (!fileAppliesTo(f, platform)) return false;
    if (f.optional && !includeOptional.includes(f.role)) return false;
    return true;
  });
}

/** Free bytes on the volume holding `dir`. Returns null when the platform cannot report it. */
export async function freeSpaceBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  const { store, target } = opts;
  await store.init();

  const files = selectFiles(target.files, opts.platform, opts.includeOptional);
  if (files.length === 0) {
    throw new DownloadError(
      `No files applicable to this platform for ${target.id}`,
      'NOT_FOUND',
      false,
    );
  }

  // Only count what we actually have to fetch — an already-present blob costs nothing.
  let needBytes = 0;
  for (const f of files) {
    if (!(await store.hasBlob(f.sha256))) needBytes += f.sizeBytes;
  }

  // Disk pre-check with 10% headroom for the concurrent .partial + final file.
  const free = await freeSpaceBytes(store.root);
  if (free != null && free < needBytes * 1.1) {
    throw new DownloadError(
      `Not enough disk space: need ~${Math.ceil((needBytes * 1.1) / 1e6)} MB, ${Math.floor(free / 1e6)} MB free`,
      'DISK_FULL',
      false,
    );
  }

  const totalBytes = files.reduce((a, f) => a + f.sizeBytes, 0);
  const records: InstalledFileRecord[] = [];
  let completedBefore = 0;
  let bytesTransferred = 0;
  let expandedTo: string | undefined;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];

    const targets: ProbeTarget[] = f.mirrors.map((m) => ({
      provider: m.provider,
      url: m.url,
      official: m.official,
    }));
    const ordered = orderSourcesForDownload(targets, opts.probes ?? [], opts.pinnedProvider);
    const sources: DownloadSource[] = ordered.map((t) => ({
      provider: t.provider,
      url: t.url,
      official: t.official,
    }));

    const res = await downloadFile({
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
      sources,
      blobDir: store.blobDir,
      signal: opts.signal,
      token: opts.token,
      maxParts: opts.maxParts,
      onProgress: (p) => {
        opts.onProgress?.({
          completedBytes: completedBefore + p.completedBytes,
          totalBytes,
          speedBps: p.speedBps,
          etaSeconds: p.etaSeconds,
          fileIndex: i,
          fileCount: files.length,
          currentFile: f.name,
          phase: p.phase,
          provider: p.provider,
        });
      },
    });

    bytesTransferred += res.bytesTransferred;
    completedBefore += f.sizeBytes;

    const linked = await store.linkByName(target.kind, f.sha256, f.name);

    // Archives are expanded only after their digest has been verified — never unpack
    // unverified bytes.
    //
    // Extraction goes to a TEMP directory and is renamed into place only on success.
    //
    // Why: a failure partway through used to leave a half-extracted directory behind.
    // That state is worse than no state at all — the blob is already verified and cached,
    // so a retry skips the download, sees the directory exists, and the user is stuck
    // permanently at "installed but unusable" with clicking again changing nothing.
    // Observed for real: a 43-entry tarball left 3 files after aborting on the first
    // symlink entry, and whisper-cli was simply absent with no way to recover from the UI.
    // Temp-then-rename makes a partial directory impossible, so "directory exists" is
    // once again a truthful signal that the install completed.
    if (f.unpack) {
      // Honour an explicit unpack target when given; otherwise keep the by-name layout.
      const finalDir = opts.unpackInto
        ? path.resolve(opts.dataRoot ?? path.join(store.root, '..'), opts.unpackInto)
        : path.join(store.byNameDir(target.kind), stripExt(f.name));
      const tmpDir = `${finalDir}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
        await unpackArchive(linked, tmpDir, f.unpack, { signal: opts.signal });
        // Replace any previous (possibly incomplete) install atomically.
        await fs.rm(finalDir, { recursive: true, force: true });
        await fs.mkdir(path.dirname(finalDir), { recursive: true });
        /*
         * ★ 归档自带一层同名顶层目录时，把它压掉（见 `collapseRedundantTopLevel` 的说明）。
         * 不压的话结果是 `<X>/<X>/…`，外层是个空壳 —— 而消费方按 `<X>/…` 去找。
         */
        const source = await collapseRedundantTopLevel(tmpDir, path.basename(finalDir));
        await fs.rename(source, finalDir);
        if (source !== tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
        expandedTo = finalDir;
      } catch (e) {
        // Leave nothing behind: no temp dir, no stale final dir that would make a retry
        // look unnecessary, and no by-name link to the archive either — a dangling link
        // makes "is this installed?" ambiguous for both the UI and the GC scan.
        // (The blob itself stays: it is verified, and keeping it makes the retry free.
        // If the user never retries, GC reclaims it as an orphan because no manifest
        // references it.)
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(linked, { force: true }).catch(() => undefined);
        throw new DownloadError(
          `Archive extraction (${f.unpack}) failed for ${f.name}: ${(e as Error).message}`,
          'UNPACK_FAILED',
          // Retryable: the bytes are verified, so a retry is cheap and may well succeed
          // (transient FS error, disk pressure). Marking it terminal would strand the user.
          true,
        );
      }
    }

    /*
     * A standalone executable has to be marked executable, or installing it is a no-op.
     *
     * Blobs are written by `downloadFile` with the default 0644, and `linkByName` is a
     * hardlink — it shares the inode, so the by-name view inherits 0644 too. Every
     * consumer that looks for a native tool goes through `isExecutable()`
     * (`access(X_OK)`), so a pack whose payload is a bare binary rather than an archive
     * would download, verify, hardlink, write its manifest, report success — and then be
     * invisible to tool discovery, forever, with no error anywhere. This is the same
     * shape as T-093's "all packs installed, extension still not loaded".
     *
     * Archives are excluded on purpose: `unpackArchive` already restores each entry's
     * recorded mode, and chmod'ing the archive blob itself would be meaningless.
     *
     * Windows has no exec bit; `access(X_OK)` there does not gate on one, so skipping is
     * correct rather than a gap. (chmod on Windows can only toggle read-only.)
     */
    if (!f.unpack && f.role === 'binary' && process.platform !== 'win32') {
      await fs.chmod(linked, 0o755);
    }

    const portable = toPortableRecord(linked, store.root);
    const rec: InstalledFileRecord = {
      role: f.role,
      name: f.name,
      sha256: res.sha256,
      sizeBytes: res.sizeBytes,
      root: portable.root,
      relPath: portable.relPath,
      // Kept during the migration window; see InstalledFile.path in @openmemo/shared.
      path: linked,
      provider: res.provider,
      cached: res.cached,
    };
    records.push(rec);
    opts.onFileDone?.(rec);
  }

  return { id: target.id, files: records, totalBytes, bytesTransferred, installedTo: expandedTo };
}

function stripExt(name: string): string {
  return name.replace(/\.(zip|tar\.gz|tgz)$/i, '');
}

/**
 * Collapse `tmp/<name>/…` down to `tmp/…` when the archive shipped a redundant
 * same-named top-level directory. Returns the directory that should be renamed into
 * place — `tmpDir` itself when there is nothing to collapse.
 *
 * ─── 这是一个真 bug，不是整洁问题（T-146 §3.3 #1 → T-153）─────────────────────────
 *
 * `install()` 把 `<X>.mlmodelc.zip` 解到 `by-name/asr/<X>.mlmodelc/`（目录名由
 * `stripExt(f.name)` 得到）。而上游那个 zip **内部自带一层同名顶层目录**，
 * 于是磁盘上真实结构是：
 *
 *     by-name/asr/ggml-large-v3-encoder.mlmodelc/
 *                 └── ggml-large-v3-encoder.mlmodelc/
 *                     ├── coremldata.bin
 *                     └── …
 *
 * whisper.cpp 从 `-m` 参数推出来的路径是**外层**那个（`whisper.cpp:3326-3348`），
 * 而外层是个只含一个子目录的空壳 → CoreML 加载失败。
 * 加载失败之后 **`WHISPER_COREML_ALLOW_FALLBACK=ON` 会打一行 ERROR 然后照常跑**
 * （`whisper.cpp:3440-3452`），而那行 ERROR 被 `--no-prints` 关掉的日志通道吞了
 * （`whisperCpp.ts:101` → `cli.cpp:1039-1040`）。
 * 结果就是**装了 ANE 却没变快，且没有任何地方会说话** —— 本仓最贵的那类 bug。
 * （`packages/runtime` 的 `asr.coreml` 自检项现在会把这个空壳报成 `fail`，
 *  所以它至少不再是静默的；这里修的是让它根本不发生。）
 *
 * ─── 判据为什么收得这么窄 ────────────────────────────────────────────────────────
 *
 * 只在**三个条件同时成立**时才压：顶层恰好一个条目、它是目录、且它的名字**逐字等于**
 * 我们要落地的目录名。任何更宽的规则（比如"只有一个目录就压"）都会改变别的包的布局 ——
 * 比如一个正当地把所有内容放在 `bin/` 下的后端包，压掉之后 `providesFiles` 里
 * 记的路径就全错了，而且同样不会有任何东西报错。
 * **这条修复必须只对它真正要修的那个形状生效。**
 *
 * 归档没有这层冗余目录时它是彻底的 no-op，所以对既有包零影响。
 */
async function collapseRedundantTopLevel(tmpDir: string, finalName: string): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return tmpDir;
  }
  if (entries.length !== 1) return tmpDir;
  const only = entries[0];
  if (!only || !only.isDirectory() || only.name !== finalName) return tmpDir;
  return path.join(tmpDir, only.name);
}
