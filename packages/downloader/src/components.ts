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
 *   - A failed check yields `upstreamCheck.kind === 'failed'` + a reason, never a silent
 *     "up to date". Reporting "no update" when we simply could not ask is the kind of
 *     green light that teaches people to distrust the screen.
 *   - ★ 「从没查过」「没有上游可问」「查了但失败了」是**三件事**，各占一条腿。
 *     旧形状里它们挤在同一个 `latestVersion === null`，而界面对那一格只有一句话
 *     （「我们**没能问到**上游 …… 点『检查更新』**重试**」）—— 首屏 27 条全落在那一格，
 *     可 daemon 一次都没问过；其中还有结构上就没有上游可问的，对它说"重试"是死路。
 *   - Nothing here mutates state. Updating is a separate, explicit user action that goes
 *     through the ordinary installer, so it inherits verification, resume, dedup and the
 *     temp-dir-then-rename rollback safety already proven there.
 */

import { promises as fs } from 'node:fs';
import type {
  BinarySource,
  ComponentStatus,
  GetComponentsResponse,
  InstalledVersion,
  Provenance,
  Sha256Verification,
  UpstreamCheck,
  UpstreamSource,
} from '@openmemo/shared';
import {
  installedVersionOf,
  NOT_INSTALLED,
  upstreamKnownVersion,
  upstreamVerdict,
  versionScheme,
} from '@openmemo/shared';
import type { UpstreamProbe } from './upstream.js';
import { checkAllUpstreams } from './upstream.js';
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
  /**
   * 见 `@openmemo/shared` 的 `Sha256Verification`：**渲染判断只许读这一格。**
   *
   * ⚠️ 清单里缺这一格时**不许静默当成"本机复算"** —— 那正好是强度更高的那一档，
   * 沉默的默认值会把一个抄来的摘要说成我们自己算过的。退法写在 `listComponents()` 里。
   */
  sha256Verification?: Sha256Verification | null;
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
  /**
   * Query upstreams. When false (or offline) everything still works — every component
   * just carries `upstreamCheck: { kind: 'never-checked' }`, which the UI must render as
   * "we have not asked", **not** as "we asked and failed".
   */
  checkUpstream?: boolean;
  timeoutMs?: number;
  /** Optional GitHub token; raises the anonymous rate limit. */
  token?: string;
}

/**
 * 「问版本的仓」和「发二进制的仓」是不是同一个 —— **在这里算一次，不在 UI 层重推**。
 *
 * 事实本来就在 manifest 里（`upstream.repo` vs `provenance.releaseUrl`），
 * 只是从来没人读出来。`[实测 2026-08-11]` `provenance.releaseUrl` 与 `backends.json`
 * 里真正的下载 URL **14/14 个包完全一致**，所以不需要给 manifest 加新字段。
 */
function binarySourceOf(c: ComponentRecord): BinarySource {
  const src = c.upstream;
  // npm / huggingface：registry 既是版本来源也是制品来源。`provenance.repoUrl` 指向
  // GitHub 只是"项目主页"，**不构成镜像关系** —— 不许一刀切。
  if (!src || (src.kind !== 'github-release' && src.kind !== 'github-tag')) {
    return { kind: 'same-source', repo: src?.repo ?? c.provenance.repoUrl };
  }
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)(?:\/|$)/.exec(c.provenance.releaseUrl);
  const binaryRepo = m?.[1];
  if (!binaryRepo || binaryRepo === src.repo) {
    return { kind: 'same-source', repo: src.repo };
  }
  return { kind: 'our-mirror', versionRepo: src.repo, binaryRepo };
}

/**
 * 把一次上游查询的结果 + 我们钉的版本，收成 `UpstreamCheck` 的一条腿。
 *
 * ★★ **这是全仓唯一构造 `UpstreamCheck` 的地方。** 不变量不再靠"每个消费方自己
 * 推导得一致"维持 —— 消费方读 `kind` 就行，读不出别的。
 */
function verdictFor(c: ComponentRecord, probe: UpstreamProbe | undefined): UpstreamCheck {
  const pinnedVersion = c.pinnedVersion;
  // 这次请求压根没查上游。**不是失败**，所以界面上不该说"没能问到"、更不该说"重试"。
  if (!probe) return { kind: 'never-checked' };

  switch (probe.kind) {
    case 'no-upstream':
      return { kind: 'no-upstream', reason: probe.reason };
    case 'failed':
      return { kind: 'failed', checkedAt: probe.checkedAt, reason: probe.reason };
    case 'ok': {
      /*
       * ★★ 多族 tag 的仓库要挑对那一族 —— **只有这里知道我们钉的是哪一族**。
       *
       * `[实测 2026-08-11]` 全仓 9 个上游配置里有 2 个仓同时在发多族 tag：
       *   · `ggml-org/whisper.cpp` → `v1.9.2`（semver）**和** `b2365`（build number）
       *   · `faorcoek042/openmemo` → `v0.7.0`（semver）**和** `model-mirror-2026.08.06`（date）
       * 两者都是"多族"，但**该给的答案完全相反**，所以"多族"本身不是判据：
       *   · 前者我们钉的 `v1.9.1` **就在**它的 semver 一族里 ⇒ 比得有意义 ⇒ `newer`（v1.9.2）
       *   · 后者我们钉的 `v1.9.1` 是 **whisper.cpp 的版本号**，压根不在这个仓的任何一族里
       *     （它只有 `v0.x` 应用发布和 `model-mirror-*` 镜像 tag）⇒ 拿两套编号硬比 ⇒ 不知道
       *
       * 判据因此是两条**同时**成立：**这个仓发了不止一族 tag**，
       * 而且**我们钉的那一版不在它的候选里**。
       *
       * ⚠️ 只用"多族"会把上面第一种也判成不知道（实测会误伤 6 条 whisper.cpp）；
       *    只用"pin 不在候选里"会误伤"pin 比 30 条 release 的窗口还老"的正常情形。
       */
      const pinScheme = versionScheme(pinnedVersion);
      const schemes = Object.keys(probe.newestByScheme);
      const picked = probe.newestByScheme[pinScheme] ?? probe.version;
      const pinOutsideNamespace =
        probe.candidates.length > 0 && !probe.candidates.includes(pinnedVersion);
      if (schemes.length > 1 && pinOutsideNamespace) {
        return {
          kind: 'indeterminate',
          checkedAt: probe.checkedAt,
          version: picked,
          /*
           * #106：原来是一整句中文，被 `apps/web` 插进
           * `components.upstream.indeterminate`（一句英文）里。现在只交出
           * **是哪一种排不出先后** + 每一族各自最新的那个（数据，照实列），
           * 措辞归 `apps/web` 的两份 locale。
           */
          reason: {
            kind: 'pin_outside_all_tag_families',
            newestPerFamily: Object.values(probe.newestByScheme),
            pinnedVersion,
          },
        };
      }
      return upstreamVerdict({
        pinnedVersion,
        upstreamVersion: picked,
        checkedAt: probe.checkedAt,
        binarySource: binarySourceOf(c),
      });
    }
  }
}

export async function listComponents(opts: ListComponentsOptions): Promise<GetComponentsResponse> {
  const reg = await loadComponentRegistry(opts.registryPath);
  const installed = await readInstalledVersions(opts.store);

  let probes = new Map<string, UpstreamProbe>();
  if (opts.checkUpstream) {
    probes = await checkAllUpstreams(
      reg.components.map((c) => ({ id: c.id, upstream: c.upstream })),
      { timeoutMs: opts.timeoutMs, token: opts.token },
    );
  }

  const components: ComponentStatus[] = reg.components.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    displayNameZh: c.displayNameZh,
    category: c.category,
    pinnedVersion: c.pinnedVersion,
    installedVersion: installed.get(c.id) ?? NOT_INSTALLED,
    upstreamCheck: verdictFor(c, probes.get(c.id)),
    provenance: c.provenance,
    upstream: c.upstream,
    sizeBytes: c.sizeBytes,
    sha256: c.sha256,
    /*
     * ★★ 缺这一格时**退到强度更低的那一档**，不是更高的那一档。
     *
     * 诱惑是写 `?? 'local-recomputed'`（清单里今天 27 条全是它）。但那条默认值
     * 说的是「**我们自己把每个字节都下下来算过**」—— 一句关于我们做过什么的断言。
     * 一条忘了填这一格的新组件会**自动获得这句我们没有做过的保证**，而且不会有
     * 任何东西报错。退到 `upstream-provided` 则只会让界面多一个警告色：
     * **错的方向是"少信我们一点"，不是"多信我们一点"。**
     */
    sha256Verification: c.sha256Verification ?? 'upstream-provided',
    sha256Provenance: c.sha256Provenance ?? null,
  }));

  /*
   * ★ `online: boolean` 换成 `sweep`。旧字段的意思是"至少有一个上游答上了"，
   *   而 `false` 同时表示「没查」和「查了一个都没答」—— 页面靠
   *   `data?.checkedAt && !data.online` 拼出第三态。现在三态各占一格，
   *   而且 `reached / total` 让"27 个里问到了 0 个"这句话说得出来
   *   （旧形状只能说 `online: false`）。
   */
  const sweep: GetComponentsResponse['sweep'] = opts.checkUpstream
    ? {
        kind: 'attempted',
        at: new Date().toISOString(),
        reached: components.filter((c) => upstreamKnownVersion(c.upstreamCheck) !== null).length,
        total: components.length,
      }
    : { kind: 'not-attempted' };

  return { components, sweep };
}
