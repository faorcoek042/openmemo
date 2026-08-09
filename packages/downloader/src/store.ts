/**
 * Content-addressed artifact store.
 *
 * Layout (R-04 §6.2):
 *   <root>/blobs/sha256-<hex>                 verified content, name IS the digest
 *   <root>/blobs/sha256-<hex>.partial[.json]  in-flight transfer + resume state
 *   <root>/manifests/<kind>/<id>.json         what is installed
 *   <root>/by-name/<kind>/<name>              hardlink view for humans and native tools
 *
 * Why content-addressed: the same bytes reached via different mirrors dedup for free
 * (verified — HF and ModelScope serve byte-identical files), resume state is keyed to
 * content rather than to whichever source produced it, and verification is inherent
 * because the filename is the expected hash.
 *
 * Why the by-name hardlink view on top: a bare blob directory is hostile to users and to
 * debugging ("where did my 5 GB go?"), and native binaries want a real path. Hardlinks
 * cost no extra disk. Hardlinks specifically, not symlinks: on Windows, CreateHardLink
 * needs no special privilege while symlinks require Developer Mode.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { blobFileName, normalizeDigest } from './verify.js';

/**
 * Physical storage bucket.
 *
 * ⚠️ A bucket is NOT a role, and must never be treated as one.
 *
 * These were previously collapsed into three values (asr|llm|backend), so a VAD model —
 * whose role is `vad` — had nowhere to go and was filed under `asr`. `resolveActiveModel`
 * then read the directory NAME as the role and handed a VAD net to whisper as if it were
 * a transcription model, while every health check stayed green because a file did exist
 * in `by-name/asr`.
 *
 * Two independent corrections, deliberately both:
 *   1. one bucket per role, so a correctly-installed model lands in the right place;
 *   2. `role` written INTO the record, so a misfiled record is still self-describing.
 * (1) alone would be a rename; (2) is what makes the mistake unrepresentable, because
 * consumers can stop inferring type from a path.
 */
export const STORE_KINDS = [
  'asr',
  'llm',
  'vad',
  'punctuation',
  'diarization',
  'embedding',
  'tts',
  'backend',
] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

/**
 * Default models root per platform.
 *
 * macOS uses Application Support, NOT Caches — the OS purges Caches under disk pressure
 * and silently deleting multi-GB models would be a disaster. (Buzz stores models in
 * user_cache_dir and has exactly this exposure.)
 * Windows uses LocalAppData, NOT Roaming — roaming profiles try to sync the directory.
 */
export function defaultModelsRoot(platform: NodeJS.Platform = process.platform): string {
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'OpenMemo', 'models');
  }
  if (platform === 'win32') {
    // APPDATA (Roaming) — must match apps/daemon/src/config/paths.ts, which is canonical.
    //
    // This used to read LOCALAPPDATA. The mismatch was invisible on Linux/macOS and fatal
    // on Windows: the downloader wrote packs to ...\AppData\Local\OpenMemo\models while
    // the pipeline looked in ...\AppData\Roaming\OpenMemo\models, so every install
    // "succeeded" and was then never found. Consistency wins over the original rationale
    // (see the note in resolveModelsRoot) because a split-brain layout breaks outright.
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'OpenMemo', 'models');
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  return path.join(xdg, 'openmemo', 'models');
}

/**
 * Resolve the artifact store root.
 *
 * Precedence is identical to `resolveStoreRoot()` in `packages/pipeline/src/tools.ts`,
 * which is the single definition this mirrors:
 *   1. OPENMEMO_MODELS      explicit store override
 *   2. explicit dataDir     (`--data-dir`)
 *   3. OPENMEMO_DATA_DIR
 *   4. platform default
 *
 * NOT imported from there on purpose: `packages/pipeline` already depends on
 * `packages/downloader`, so importing back would create a dependency cycle. The two
 * implementations must therefore be kept in step by hand — if you change one, change the
 * other. (Better long-term home: `packages/shared`, which both already depend on.)
 */
export function resolveModelsRoot(dataDir?: string): string {
  const explicit = process.env.OPENMEMO_MODELS;
  if (explicit) return explicit;
  // NOTE: `dataDir` is the DATA directory (what `--data-dir` gives), not the models
  // directory — the 'models' segment is appended here, exactly as resolveStoreRoot does.
  // Named `dataDir` rather than `override` so the two cannot be confused at a call site.
  if (dataDir) return path.join(dataDir, 'models');
  const envDataDir = process.env.OPENMEMO_DATA_DIR;
  if (envDataDir) return path.join(envDataDir, 'models');
  return defaultModelsRoot();
}

export class ArtifactStore {
  constructor(readonly root: string) {}

  get blobDir(): string {
    return path.join(this.root, 'blobs');
  }
  manifestDir(kind: StoreKind): string {
    return path.join(this.root, 'manifests', kind);
  }
  byNameDir(kind: StoreKind): string {
    return path.join(this.root, 'by-name', kind);
  }
  blobPath(digest: string): string {
    return path.join(this.blobDir, blobFileName(digest));
  }

  async init(): Promise<void> {
    await fs.mkdir(this.blobDir, { recursive: true });
    for (const k of STORE_KINDS) {
      await fs.mkdir(this.manifestDir(k), { recursive: true });
      await fs.mkdir(this.byNameDir(k), { recursive: true });
    }
  }

  async hasBlob(digest: string): Promise<boolean> {
    try {
      const st = await fs.stat(this.blobPath(digest));
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Expose a blob under a human-readable name via hardlink.
   * Falls back to a copy across filesystems; returns the path either way.
   */
  async linkByName(kind: StoreKind, digest: string, name: string): Promise<string> {
    const dir = this.byNameDir(kind);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    const src = this.blobPath(digest);
    await fs.rm(target, { force: true });
    try {
      await fs.link(src, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP') {
        await fs.copyFile(src, target);
      } else {
        throw e;
      }
    }
    return target;
  }

  /**
   * Land externally-verified bytes into the blob store under their digest, without going
   * through the downloader at all.
   *
   * For bundled-model first-run import (`apps/daemon/src/http/rest/modelReconcile.ts`):
   * the caller has already recomputed `digest` from `sourcePath` and confirmed it matches
   * what the catalog declares. This method trusts that check — it does not hash anything
   * itself — and only moves bytes into place.
   *
   * Idempotent: a no-op if the blob already exists, so calling this on every daemon start
   * does not re-copy ~56 MB every time. Hardlink-with-copy-fallback, same policy as
   * `linkByName`: same-volume costs zero extra disk, cross-volume (or a filesystem that
   * refuses hardlinks — `EXDEV`/`EPERM`/`ENOTSUP`) degrades silently to a copy. Any other
   * error (e.g. disk full) propagates rather than being swallowed.
   *
   * Lands via temp-name-then-rename, unlike a plain `fs.link`/`fs.copyFile` to the final
   * path: the blob's filename IS the integrity promise (`sha256-<hex>`), so no
   * partial-content window is acceptable at that path, exactly as `writeManifest` uses
   * tmp+rename for the same reason on the manifest side.
   */
  async importBlob(sourcePath: string, digest: string): Promise<void> {
    if (await this.hasBlob(digest)) return;
    await fs.mkdir(this.blobDir, { recursive: true });
    const dest = this.blobPath(digest);
    const tmp = `${dest}.importing-${process.pid}-${Date.now()}`;
    try {
      await fs.link(sourcePath, tmp);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP') {
        await fs.copyFile(sourcePath, tmp);
      } else {
        throw e;
      }
    }
    await fs.rename(tmp, dest);
  }

  async writeManifest(kind: StoreKind, id: string, data: unknown): Promise<string> {
    const dir = this.manifestDir(kind);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sanitizeId(id)}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, file);
    return file;
  }

  async readManifest<T>(kind: StoreKind, id: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(
        path.join(this.manifestDir(kind), `${sanitizeId(id)}.json`),
        'utf8',
      );
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async listManifests<T>(kind: StoreKind): Promise<T[]> {
    try {
      const files = await fs.readdir(this.manifestDir(kind));
      const out: T[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          out.push(
            JSON.parse(await fs.readFile(path.join(this.manifestDir(kind), f), 'utf8')) as T,
          );
        } catch {
          /* skip unreadable manifest */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async removeManifest(kind: StoreKind, id: string): Promise<void> {
    await fs.rm(path.join(this.manifestDir(kind), `${sanitizeId(id)}.json`), { force: true });
  }

  /**
   * Digests still referenced by at least one manifest.
   *
   * Scan-based rather than a maintained refcount file: a refcount drifts from reality
   * after any crash, whereas a scan is always correct.
   */
  async referencedDigests(): Promise<Set<string>> {
    const refs = new Set<string>();
    for (const kind of STORE_KINDS) {
      const manifests = await this.listManifests<{ files?: { sha256?: string }[] }>(kind);
      for (const m of manifests) {
        for (const f of m.files ?? []) {
          if (f.sha256) refs.add(normalizeDigest(f.sha256));
        }
      }
    }
    return refs;
  }

  /**
   * Find reclaimable space: blobs no manifest references, and stale `.partial` files.
   *
   * Ordering invariant that makes this safe: write the blob FIRST, the manifest SECOND.
   * A crash in between leaves an orphan blob, which GC reclaims harmlessly. The reverse
   * order would leave a manifest pointing at a missing file, so it is forbidden.
   */
  async findGarbage(stalePartialMs = 7 * 24 * 3600 * 1000): Promise<{
    orphanBlobs: { path: string; bytes: number }[];
    stalePartials: { path: string; bytes: number }[];
  }> {
    const refs = await this.referencedDigests();
    const orphanBlobs: { path: string; bytes: number }[] = [];
    const stalePartials: { path: string; bytes: number }[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(this.blobDir);
    } catch {
      return { orphanBlobs, stalePartials };
    }
    const now = Date.now();
    for (const e of entries) {
      const p = path.join(this.blobDir, e);
      let st;
      try {
        st = await fs.stat(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      if (
        e.endsWith('.partial') ||
        e.endsWith('.partial.json') ||
        e.endsWith('.partial.json.tmp')
      ) {
        if (now - st.mtimeMs > stalePartialMs) stalePartials.push({ path: p, bytes: st.size });
        continue;
      }
      const m = /^sha256-([a-f0-9]{64})$/.exec(e);
      if (!m) continue;
      if (!refs.has(m[1])) orphanBlobs.push({ path: p, bytes: st.size });
    }
    return { orphanBlobs, stalePartials };
  }

  async collectGarbage(
    targets: ('orphan_blobs' | 'stale_partials')[],
  ): Promise<{ freedBytes: number; removedFiles: number }> {
    const { orphanBlobs, stalePartials } = await this.findGarbage();
    let freed = 0;
    let removed = 0;
    const list = [
      ...(targets.includes('orphan_blobs') ? orphanBlobs : []),
      ...(targets.includes('stale_partials') ? stalePartials : []),
    ];
    for (const f of list) {
      try {
        await fs.rm(f.path, { force: true });
        freed += f.bytes;
        removed++;
      } catch {
        /* best effort */
      }
    }
    return { freedBytes: freed, removedFiles: removed };
  }

  /**
   * 这个 store 在磁盘上**真正**占了多少字节 —— `du` 的语义，按 (dev, ino) 去重。
   *
   * ## ★★ T-193：上一版只数 `blobs/`，在用户机器上少算了 **3.5 倍**
   *
   * `[用户真机实测 2026-08-10，:10000]`：
   *
   * ```
   * usedBytes 报                  240,162,578      ← 只有 blobs/
   * du -sb /root/data-memo/models 1,080,661,687    ← 真实
   * 差额                          840,494,883      = by-name/ 整个目录
   * ```
   *
   * 成因是一个**没写下来的前提**：`buildStorage()` 里那句注释写着
   * 「后端包也占 blobs/ 的空间」—— 它假定 `by-name/` 全是硬链（与 blob 同 inode，
   * 不占额外空间）。**对归档本身成立，对解开的目录不成立**：
   * 带 `unpack` 的包解压出来的是**第二份真实副本**，与 blob 不共享 inode。
   *
   * `[实测同一台机器]` 一个 ffmpeg 因此占 715 MB：
   * ```
   * by-name/backend/ffmpeg-…-gpl-7.1.tar.xz/…/bin/ffmpeg  ino=1097021  139,397,096 B
   * by-name/backend/media-tools-linux-x64/ffmpeg          ino=314125   139,397,096 B
   *                                                        ↑ 同样大小、**不同 inode**
   * ```
   * 而"已用空间"里一个字节都没算它们 —— 用户看到的数字与 `df` 对不上，
   * 而这正是他定过的硬要求「数据位置要可统计大小」的那一半。
   *
   * ## 为什么必须按 (dev, ino) 去重
   *
   * `by-name/<kind>/<归档名>` 与 `blobs/sha256-…` **是同一个 inode**
   * （`linkByName()` 打的硬链，`[实测]` `ino=289895 links=2`）。
   * 不去重就会把它数两遍 —— 那是另一个方向的错，而且同样对不上 `df`。
   */
  async usedBytes(): Promise<number> {
    const seen = new Set<string>();
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p);
          continue;
        }
        // 软链不占内容的空间，而且它的目标本来就在这棵树里 —— 数它等于数两遍
        if (!e.isFile()) continue;
        try {
          const st = await fs.stat(p);
          const key = `${String(st.dev)}:${String(st.ino)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          total += st.size;
        } catch {
          /* ignore */
        }
      }
    };
    await walk(this.root);
    return total;
  }
}

/**
 * Resolve an installed-file record to an absolute path.
 *
 * Handles both shapes so the migration is invisible to callers:
 *   - new records: `root` + `relPath`  (portable)
 *   - old records: `path`              (absolute, written before the change)
 *
 * Consumers should call this rather than reading either field, so that when the legacy
 * field is finally dropped only this function changes.
 */
export function resolveInstalledFile(
  rec: { root?: string; relPath?: string; path?: string },
  roots: { models: string; runtimes?: string; data?: string },
): string {
  if (rec.root && rec.relPath) {
    const base =
      rec.root === 'models'
        ? roots.models
        : rec.root === 'runtimes'
          ? (roots.runtimes ?? path.join(roots.models, '..', 'runtimes'))
          : (roots.data ?? path.join(roots.models, '..'));
    const abs = path.resolve(base, rec.relPath);
    // Defence in depth: a record that escapes its root is corrupt, not merely odd.
    const root = path.resolve(base);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Installed-file record escapes its root: ${rec.relPath}`);
    }
    return abs;
  }
  if (rec.path) return rec.path; // legacy
  throw new Error('Installed-file record has neither root+relPath nor a legacy path');
}

/** Build a portable record from an absolute path under the models root. */
export function toPortableRecord(
  absPath: string,
  modelsRoot: string,
): { root: 'models'; relPath: string } {
  const rel = path.relative(path.resolve(modelsRoot), path.resolve(absPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path ${absPath} is not inside the models root ${modelsRoot}`);
  }
  // Always store POSIX separators so a record written on Windows resolves on Linux.
  return { root: 'models', relPath: rel.split(path.sep).join('/') };
}

/** An install record, as written by whoever completed the install. */
export interface InstallRecordLike {
  id?: string;
  /** Authoritative type. Never infer this from the containing directory. */
  role?: string;
  integrity?: string;
  files?: {
    role?: string;
    name?: string;
    sha256?: string;
    root?: string;
    relPath?: string;
    path?: string;
  }[];
}

/**
 * Find installed entries for a role, judged by the record's own `role` field.
 *
 * Scans EVERY bucket rather than just `manifests/<role>/`, then filters on `role`. That
 * ordering is the whole point: a record misfiled into the wrong directory is still
 * classified correctly, and — more importantly — a VAD model sitting in `manifests/asr/`
 * can no longer be handed out as an ASR model.
 *
 * Records without a `role` are SKIPPED, not guessed from their location. Guessing is what
 * produced a green health check while whisper was pointed at a VAD net; refusing to guess
 * turns that silent mistype into a visible "not installed", which is the failure we want.
 */
export async function findInstalledByRole(
  store: ArtifactStore,
  role: string,
  opts: { requireIntegrityOk?: boolean } = {},
): Promise<InstallRecordLike[]> {
  const requireOk = opts.requireIntegrityOk ?? true;
  const out: InstallRecordLike[] = [];
  for (const kind of STORE_KINDS) {
    for (const rec of await store.listManifests<InstallRecordLike>(kind)) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.role == null) continue; // no role → unknown type → not a candidate
      if (rec.role !== role) continue;
      if (requireOk && rec.integrity !== 'ok') continue;
      out.push(rec);
    }
  }
  return out;
}

/** Bucket a role should be stored in. Identity for known roles; unknown roles go to their own name. */
export function bucketForRole(role: string): StoreKind {
  return (STORE_KINDS as readonly string[]).includes(role) ? (role as StoreKind) : 'backend';
}

/** Keep ids filesystem-safe; ids contain "/" to namespace by role. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
