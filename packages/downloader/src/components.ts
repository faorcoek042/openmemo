/**
 * Component registry — the data behind `GET /api/components`.
 *
 * Joins three sources the user needs to see together:
 *   1. the pinned version + provenance from `vendor/manifests/components.json` (in git)
 *   2. what is actually installed on this machine
 *   3. what upstream currently offers
 *
 * Design constraints that shaped this:
 *   - Upstream lookups are OPTIONAL. `listComponents()` returns a complete, useful answer
 *     with the network unplugged; version checking is layered on top, never a precondition.
 *   - A failed check yields `latestVersion: null` + a reason, never a silent "up to date".
 *     Reporting "no update" when we simply could not ask is the kind of green light that
 *     teaches people to distrust the screen.
 *   - Nothing here mutates state. Updating is a separate, explicit user action that goes
 *     through the ordinary installer, so it inherits verification, resume, dedup and the
 *     temp-dir-then-rename rollback safety already proven there.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ComponentStatus, GetComponentsResponse, Provenance, UpstreamSource } from '@openmemo/shared';
import { checkAllUpstreams } from './upstream.js';
import { isUpdateAvailable } from './upstream.js';
import type { ArtifactStore } from './store.js';

export interface ComponentRecord {
  id: string;
  displayName: string;
  displayNameZh: string;
  category: string;
  pinnedVersion: string;
  provenance: Provenance;
  upstream: UpstreamSource | null;
  sizeBytes: number;
  sha256: string;
}

export interface ComponentRegistry {
  schemaVersion: 1;
  catalogVersion: string;
  generatedAt: string;
  components: ComponentRecord[];
}

export async function loadComponentRegistry(manifestPath: string): Promise<ComponentRegistry> {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as ComponentRegistry;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.components)) {
    throw new Error(`Invalid component registry at ${manifestPath}`);
  }
  return raw;
}

/**
 * What version of a component is installed right now.
 *
 * Reads the install manifests the installer writes, so it reflects reality rather than
 * intent. Returns null when absent — "not installed" and "installed at an unknown
 * version" must not look the same to the UI.
 */
async function readInstalledVersions(store: ArtifactStore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const kind of ['asr', 'llm', 'backend'] as const) {
    const records = await store.listManifests<{ id?: string; version?: string; catalogVersion?: string }>(kind);
    for (const r of records) {
      if (r.id) out.set(r.id, r.version ?? r.catalogVersion ?? 'installed');
    }
  }
  return out;
}

/** Previous version kept on disk for rollback, if the installer retained one. */
async function readRollbackVersions(store: ArtifactStore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const kind of ['asr', 'llm', 'backend'] as const) {
    const dir = store.byNameDir(kind);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      // The installer parks the superseded tree as "<name>.prev-<version>".
      const m = /^(.+)\.prev-(.+)$/.exec(e);
      if (m) out.set(m[1], m[2]);
    }
  }
  return out;
}

export interface ListComponentsOptions {
  registryPath: string;
  store: ArtifactStore;
  /** Query upstreams. When false (or offline) everything still works, just without latestVersion. */
  checkUpstream?: boolean;
  timeoutMs?: number;
  /** Optional GitHub token; raises the anonymous rate limit. */
  token?: string;
}

export async function listComponents(opts: ListComponentsOptions): Promise<GetComponentsResponse> {
  const reg = await loadComponentRegistry(opts.registryPath);
  const installed = await readInstalledVersions(opts.store);
  const rollback = await readRollbackVersions(opts.store);

  let checks = new Map<string, { latestVersion: string | null; error: string | null; checkedAt: string }>();
  let online = false;
  if (opts.checkUpstream) {
    checks = await checkAllUpstreams(
      reg.components.map((c) => ({ id: c.id, upstream: c.upstream })),
      { timeoutMs: opts.timeoutMs, token: opts.token },
    );
    // "Online" means at least one upstream answered — not that every one did.
    online = [...checks.values()].some((c) => c.latestVersion !== null);
  }

  const components: ComponentStatus[] = reg.components.map((c) => {
    const chk = checks.get(c.id);
    const latest = chk?.latestVersion ?? null;
    return {
      id: c.id,
      displayName: c.displayName,
      displayNameZh: c.displayNameZh,
      category: c.category,
      pinnedVersion: c.pinnedVersion,
      installedVersion: installed.get(c.id) ?? null,
      latestVersion: latest,
      updateAvailable: isUpdateAvailable(c.pinnedVersion, latest),
      checkError: chk?.error ?? null,
      checkedAt: chk?.checkedAt ?? null,
      provenance: c.provenance,
      upstream: c.upstream,
      sizeBytes: c.sizeBytes,
      sha256: c.sha256,
      rollbackVersion: rollback.get(c.id) ?? null,
    };
  });

  return {
    components,
    online,
    checkedAt: opts.checkUpstream ? new Date().toISOString() : null,
  };
}

/**
 * Move an installed tree aside so a failed update can be rolled back.
 *
 * Rename, not copy: instant and atomic, and it cannot half-succeed on a full disk. Paired
 * with the installer's temp-dir-then-rename extraction, an update has exactly two
 * outcomes — new tree in place, or the previous tree restored. There is no state where
 * the component is partially replaced.
 */
export async function stashForRollback(
  store: ArtifactStore,
  kind: 'asr' | 'llm' | 'backend',
  name: string,
  version: string,
): Promise<string | null> {
  const dir = path.join(store.byNameDir(kind), name);
  try {
    await fs.access(dir);
  } catch {
    return null; // nothing installed yet — no rollback point needed
  }
  const stash = `${dir}.prev-${version}`;
  await fs.rm(stash, { recursive: true, force: true });
  await fs.rename(dir, stash);
  return stash;
}

/** Restore a stashed tree after a failed update. */
export async function rollback(
  store: ArtifactStore,
  kind: 'asr' | 'llm' | 'backend',
  name: string,
  version: string,
): Promise<boolean> {
  const dir = path.join(store.byNameDir(kind), name);
  const stash = `${dir}.prev-${version}`;
  try {
    await fs.access(stash);
  } catch {
    return false;
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rename(stash, dir);
  return true;
}

/** Drop the rollback copy once the new version has proven itself. */
export async function discardRollback(
  store: ArtifactStore,
  kind: 'asr' | 'llm' | 'backend',
  name: string,
  version: string,
): Promise<void> {
  await fs.rm(path.join(store.byNameDir(kind), `${name}.prev-${version}`), {
    recursive: true,
    force: true,
  });
}
