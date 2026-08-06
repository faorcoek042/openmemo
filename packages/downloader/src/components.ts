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
import { STORE_KINDS } from './store.js';

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
  sha256Provenance?: string | null;
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
  for (const kind of STORE_KINDS) {
    const records = await store.listManifests<{ id?: string; version?: string; catalogVersion?: string }>(kind);
    for (const r of records) {
      if (r.id) out.set(r.id, r.version ?? r.catalogVersion ?? 'installed');
    }
  }
  return out;
}

/**
 * Previous version kept on disk for rollback, if the installer retained one.
 *
 * ⚠️ **今天它永远返回空 Map，而且不止一个原因。** 详见 `stashForRollback` 上方那段。
 * 这里单独记一条，因为它自己就是其中之一：
 *
 * 它用**目录名**做键（`<name>.prev-<version>` 里的 `<name>`），而 `listComponents`
 * 用**组件 id** 查表。两者在这台机器上 4 个已装后端组件里有 3 个不同 ——
 * `by-name/backend/` 里躺着 `whisper-bin-ubuntu-x64`（= 归档名去扩展名，
 * `installer.ts` 的 `stripExt(f.name)`），而组件 id 是 `whispercpp-cpu-linux-x64`。
 * 也就是说：**哪怕 `.prev-` 目录被创建出来，这张表也查不中。**
 *
 * ⚠️ 原注释写的是「The installer parks the superseded tree as `<name>.prev-<version>`」
 * —— `[实测]` `installer.ts` 里 `.prev` **零命中**，它从来没有 park 过任何东西。
 * 一句陈述句写在这里，读的人会当成事实。已改成陈述现状。
 */
async function readRollbackVersions(store: ArtifactStore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const kind of STORE_KINDS) {
    const dir = store.byNameDir(kind);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      // 约定的形态是 `<name>.prev-<version>`。**没有任何代码会产出它**（见上）。
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
      sha256Provenance: c.sha256Provenance ?? null,
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
 *
 * ─── ⚠️ 零调用方。T-157 ② 的裁决与理由，别当成"忘了接线" ────────────────────────
 *
 * 这个函数从写下来那天起**没有任何调用方**，所以 `.prev-<version>` 目录从来不存在，
 * `rollbackVersion` 恒为 null，前端的回滚按钮**一次都没渲染过**，
 * `POST /api/components/:id/rollback` 恒回 409。
 *
 * T-157 ② 的处理是：**把前端那个恒不渲染的按钮和那句"出问题可以一键回滚"的承诺删掉**，
 * 而不是把这个函数接上。理由不是"回滚不重要"，是**现在接上会造出一个更坏的东西**：
 *
 * 1. **`by-name/backend/` 是工具发现的搜索路径。**
 *    `pipeline/tools.ts` 的 `findInBackendPacks()` 枚举该目录下**每一个**子目录（两层），
 *    取**第一个命中**。多出一个 `whisper-bin-ubuntu-x64.prev-v1.9.1/`，
 *    `whisper-cli` 就有了两个候选，谁赢取决于 `readdir` 顺序 ——
 *    **静默跑到旧二进制上**，本仓最贵的那类 bug。
 * 2. **磁盘无人回收。** 后端包最大 678 MB（`whispercpp-cuda-12.4-win-x64`）。
 *    `collectGarbage` 只认 `orphan_blobs` / `stale_partials`，`buildStorage` 也不统计
 *    `.prev-*` —— 用户会平白少掉几百 MB 且**在界面上看不到**。
 *    `discardRollback` 同样零调用方，没有任何东西会丢弃它。
 * 3. **索引键与查表键不同**（见 `readRollbackVersions`）：目录名 vs 组件 id，
 *    这台机器上 4 个里 3 个对不上。`rollback()` 也用 `<id>` 拼路径，同样对不上。
 * 4. **`kind` 映射对模型是错的。** `rollbackKindOf('model') === 'asr'`，
 *    而模型是**单文件**（`by-name/asr/ggml-base-q5_1.bin`），不是目录；
 *    `fs.rename` 会把文件改名成 `xxx.bin.prev-<v>`，于是"模型不见了"。
 *
 * **要真的做回滚，这四件事得先做完**：把备份挪出 `by-name/`（例如
 * `<root>/rollback/<kind>/<组件 id>@<version>/`，顺带解决键不匹配）、给 GC 与存储统计
 * 加上这一项、定一个保留策略（留几份、什么时候丢）、并且区分单文件与目录。
 * 那是一次独立的改动，不是"接上一个调用"。
 *
 * ⚠️ **更新失败本来就不会破坏当前版本**，这一点不依赖本函数：`install()` 先解压到
 * temp，成功之后才 `rm(finalDir)` + `rename`；任一步失败都只清 temp。
 * 也就是说，rollback 真正要救的是"**更新成功、但新版本坏了**"这一种 ——
 * 界面上现在如实这么说。
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
