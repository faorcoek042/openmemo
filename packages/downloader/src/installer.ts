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
  path: string;
  provider: string;
  cached: boolean;
}

export interface InstallResult {
  id: string;
  files: InstalledFileRecord[];
  totalBytes: number;
  bytesTransferred: number;
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
    if (f.unpack) {
      await unpackArchive(linked, path.join(store.byNameDir(target.kind), stripExt(f.name)), f.unpack);
    }

    const rec: InstalledFileRecord = {
      role: f.role,
      name: f.name,
      sha256: res.sha256,
      sizeBytes: res.sizeBytes,
      path: linked,
      provider: res.provider,
      cached: res.cached,
    };
    records.push(rec);
    opts.onFileDone?.(rec);
  }

  return { id: target.id, files: records, totalBytes, bytesTransferred };
}

function stripExt(name: string): string {
  return name.replace(/\.(zip|tar\.gz|tgz)$/i, '');
}

/**
 * Archive expansion.
 *
 * Deliberately not implemented with a bundled extractor yet: the only archives we need
 * are backend packs and the macOS CoreML encoder, neither of which the Linux spike
 * exercises. Throwing loudly beats a silently wrong stub.
 * TODO(T-020): wire up an extractor with path-traversal (zip-slip) guards.
 */
async function unpackArchive(_src: string, _dest: string, kind: 'zip' | 'tar.gz'): Promise<void> {
  throw new DownloadError(
    `Archive extraction (${kind}) is not implemented yet — see TODO(T-020)`,
    'UNPACK_FAILED',
    false,
  );
}
