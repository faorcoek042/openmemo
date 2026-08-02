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

export type StoreKind = 'asr' | 'llm' | 'backend';

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
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return path.join(local, 'OpenMemo', 'models');
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  return path.join(xdg, 'openmemo', 'models');
}

export function resolveModelsRoot(override?: string): string {
  return override ?? process.env.OPENMEMO_MODELS ?? defaultModelsRoot();
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
    for (const k of ['asr', 'llm', 'backend'] as StoreKind[]) {
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
          out.push(JSON.parse(await fs.readFile(path.join(this.manifestDir(kind), f), 'utf8')) as T);
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
    for (const kind of ['asr', 'llm', 'backend'] as StoreKind[]) {
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
    let entries: string[] = [];
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

      if (e.endsWith('.partial') || e.endsWith('.partial.json') || e.endsWith('.partial.json.tmp')) {
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

  /** Total bytes held under blobs/. */
  async usedBytes(): Promise<number> {
    let total = 0;
    try {
      for (const e of await fs.readdir(this.blobDir)) {
        try {
          const st = await fs.stat(path.join(this.blobDir, e));
          if (st.isFile()) total += st.size;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return total;
  }
}

/** Keep ids filesystem-safe; ids contain "/" to namespace by role. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
