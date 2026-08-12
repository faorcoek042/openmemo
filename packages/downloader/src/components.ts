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
import type {
  ComponentStatus,
  GetComponentsResponse,
  InstalledVersion,
  Provenance,
  UpstreamSource,
} from '@openmemo/shared';
import { installedVersionOf, NOT_INSTALLED } from '@openmemo/shared';
import { checkAllUpstreams, upstreamRelation } from './upstream.js';
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
 *
 * ★★ **上面那句是规格，而这个函数曾经违反的正是它自己那句。**
 *
 * 原来的一行是 `out.set(r.id, r.version ?? r.catalogVersion ?? 'installed')` ——
 * 「装了、但记录里没有版本号」被压成字符串哨兵 `'installed'`，也就是规格里
 * 「must not look the same to the UI」点名禁止的那个塌陷；而且它**从不返回 null**，
 * 所以那句 "Returns null when absent" 也早就不成立了。
 *
 * 后果是恒真的判据：卡片按钮判 `installedVersion !== pinnedVersion`，
 * `'installed'` 永远不等于 `autobuild-2026-07-31-14-10`
 * ⇒ 每个随包出厂的后端包都长期挂着一颗白下 145 MB 的按钮。
 *
 * 现在走 `installedVersionOf()` 这个**唯一构造点**（`@openmemo/shared`），
 * 三态在类型里，哨兵没有地方可写。为什么 `engineVersion` / `catalogVersion`
 * **不能**顶替这一栏，见那个函数的注释（一句话：它们和 `pinnedVersion` 不是同一套编号）。
 */
async function readInstalledVersions(store: ArtifactStore): Promise<Map<string, InstalledVersion>> {
  const out = new Map<string, InstalledVersion>();
  for (const kind of STORE_KINDS) {
    const records = await store.listManifests<{
      id?: string;
      version?: string;
    }>(kind);
    for (const r of records) {
      if (r.id) out.set(r.id, installedVersionOf(r));
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

  let checks = new Map<
    string,
    { latestVersion: string | null; error: string | null; checkedAt: string }
  >();
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
    const found = chk?.latestVersion ?? null;
    /*
     * ★★ **「比不了」不许再塌成「已是最新」。**
     *
     * `compareVersions` 现在分得出四态，而这一栏的旧形状只有三格
     * （有新版本 / 已是最新 / 未检测）。把 `incomparable` 放进哪一格是有对错的：
     *   · 放进「已是最新」= **UNKNOWN 塌成 PASS**，一个绿勾说着我们根本没判断出来的事；
     *   · 放进「未检测」= 说"我们不知道"，**这是真话**，而且下面那句解释会把
     *     `checkError` 原样显示出来，用户看得到到底为什么不知道。
     * 所以这里把它归到后者，并写清原因。
     *
     * `[实测 2026-08-11，真 daemon :10000]` 这条路径今天有一个真实的走法：
     * `whispercpp-cpu-macos-arm64` 的 `upstream.repo` 指向我们自己的镜像仓
     * （里面同时有 `v0.7.0` 一族和 `model-mirror-2026.08.06` 一族），没配 tagPattern，
     * 于是"最新"挑出 `model-mirror-2026.08.06`，与 pin `v1.9.1` 一比 —— 旧比较器
     * 刮出 2026 vs 1 得 2025，**报出假的「有新版本」并被算进页面顶部的横幅**。
     * 现在它是 date vs semver ⇒ `incomparable` ⇒ 显示「未检测 + 原因」。
     *
     * ⚠️ **补 `tagPattern` 在这一条上不是解，是换一句假话。** 那个仓里真正驮着这个
     * 二进制的是 `v0.6.0`（`backends.json` 的下载 URL 实测），也就是 `^v\d+\.\d+\.\d+$`
     * 一族；配上之后"最新"变成 `v0.7.0`，而 pin 是 `v1.9.1`（whisper.cpp 的版本号）——
     * 两个都是 semver 形状，比得出来，结论是 `v0.7.0 < v1.9.1` ⇒ **绿勾「已是最新」**。
     * 那比现在这句假话更坏。真正的解是让"这个仓同时在发两族 tag"变成一条会说话的
     * 结论（#66 主线的 `indeterminate`），而不是靠配置去躲。
     */
    const rel = upstreamRelation(c.pinnedVersion, found);
    const incomparable = rel === 'incomparable';
    const latest = incomparable ? null : found;
    const incomparableNote = incomparable
      ? `上游给的 ${found} 与目录钉的 ${c.pinnedVersion} 不是同一套编号，排不出先后`
      : null;
    return {
      id: c.id,
      displayName: c.displayName,
      displayNameZh: c.displayNameZh,
      category: c.category,
      pinnedVersion: c.pinnedVersion,
      installedVersion: installed.get(c.id) ?? NOT_INSTALLED,
      latestVersion: latest,
      updateAvailable: rel === 'newer',
      checkError: incomparableNote ?? chk?.error ?? null,
      checkedAt: chk?.checkedAt ?? null,
      provenance: c.provenance,
      upstream: c.upstream,
      sizeBytes: c.sizeBytes,
      sha256: c.sha256,
      sha256Provenance: c.sha256Provenance ?? null,
    };
  });

  return {
    components,
    online,
    checkedAt: opts.checkUpstream ? new Date().toISOString() : null,
  };
}
