/**
 * Upstream release lookup — "is there a newer version than the one we pinned?"
 *
 * Answers only that question. It never mutates a manifest and never triggers a download:
 * pinning stays authoritative, and moving to a new version is always a user action.
 *
 * Failure is expected and must be harmless. Offline, rate-limited or renamed-repo all
 * produce a `failed` probe plus a reason — never an exception that could block installing
 * what is already pinned. A version check is a convenience; an install is not.
 *
 * ★ 这个模块**不判「有没有更新」**，它只报「上游最新的那个 tag 是什么」。
 *   比较是 `listComponents()` 的事，因为只有它同时知道我们钉的是哪一版。
 *   这里原来有一个 `isUpdateAvailable(pinned, latest): boolean` —— 一台
 *   **三态进、二态出**的机器（`compareVersions` 的"比不了"和"相等"一起被 `> 0`
 *   压成 false）。它已经删掉；留着它就等于留着那台机器。
 */

import type { UpstreamSource, VersionScheme } from '@openmemo/shared';
import { compareVersions, compareVersionsForSort, versionScheme } from '@openmemo/shared';

export interface UpstreamRelease {
  version: string;
  publishedAt: string | null;
  htmlUrl: string | null;
  /** Asset name → { size, sha256 } when the registry exposes digests (GitHub does). */
  assets: { name: string; sizeBytes: number; sha256: string | null; url: string }[];
}

/**
 * 一次上游查询的结果 —— **判别联合，不是 `latestVersion|null` + `error|null`**。
 *
 * 旧形状名义上能表示 `latestVersion: null` + `error: null`（"没查到，也没出错"），
 * 那是个说不通的状态；而它真正的害处在下游：`checks.get(id)?.latestVersion ?? null`
 * 把「查到了」「查失败了」「压根没查」三件事压成同一个 null。
 */
export type UpstreamProbe =
  | {
      /** 问到了。 */
      readonly kind: 'ok';
      readonly checkedAt: string;
      /** 全部候选里排序最靠前的那个。**跨编号方案时这只是 tie-break 的产物**，见 `newestByScheme`。 */
      readonly version: string;
      readonly release: UpstreamRelease | null;
      /**
       * ★ 每套编号方案各自最新的那个。
       *
       * `[实测 2026-08-11]` 有仓库**同时在发好几族 tag**，而"最新"只在同一族内部有意义：
       *   · `ggml-org/whisper.cpp` → `v1.9.2`（semver）**和** `b2365`（build number）
       *   · `faorcoek042/openmemo` → `v0.7.0`（semver）**和** `model-mirror-2026.08.06`（date）
       *
       * 所以这里不替调用方挑：**只有 `listComponents()` 知道我们钉的是哪一族**
       * （`v1.9.1` 是 semver），由它按 pin 的方案取对应那一条。
       */
      readonly newestByScheme: Readonly<Partial<Record<VersionScheme, string>>>;
      /**
       * 这次筛出来的全部候选 tag（列表型 kind 才有；npm / huggingface 只回一个值，这里是空）。
       *
       * 用途只有一个，但很关键：判断**我们钉的那一版是不是压根不在这个仓的命名空间里**。
       * 在的话（`v1.9.1` ∈ ggml-org 的 tag 列表）比较是有意义的；
       * 不在的话（`v1.9.1` ∉ 我们镜像仓的 `v0.x` 一族）——那是拿两套编号硬比，
       * 结论必须是"不知道"，而不是一个绿勾。
       */
      readonly candidates: readonly string[];
    }
  | {
      /** 这个组件结构上就没有上游可问。**不是失败，别叫用户重试。** */
      readonly kind: 'no-upstream';
      readonly reason: string;
    }
  | {
      /** 问了没问到：超时、限流、改名、断网。重试是有意义的。 */
      readonly kind: 'failed';
      readonly checkedAt: string;
      readonly reason: string;
    };

const UA = 'OpenMemo/0.1 (+https://github.com/openmemo)';

async function getJson(
  url: string,
  timeoutMs: number,
  token?: string,
  accept = 'application/json',
): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        // Accept must match the registry: sending GitHub's vendor type to npm gets a 406.
        accept,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: ac.signal,
    });
    if (res.status === 403 || res.status === 429) {
      throw new Error(`rate limited by upstream (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

interface GhAsset {
  name: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
}
interface GhRelease {
  tag_name: string;
  published_at: string | null;
  html_url: string | null;
  prerelease: boolean;
  draft: boolean;
  assets: GhAsset[];
}

function toRelease(r: GhRelease): UpstreamRelease {
  return {
    version: r.tag_name,
    publishedAt: r.published_at,
    htmlUrl: r.html_url,
    assets: (r.assets ?? []).map((a) => ({
      name: a.name,
      sizeBytes: a.size,
      // GitHub exposes `digest` on newer assets; older ones have none. Null means
      // "must be computed by downloading", not "unverified is fine".
      sha256: a.digest ? a.digest.replace(/^sha256:/, '') : null,
      url: a.browser_download_url,
    })),
  };
}

/**
 * Query an upstream for its newest release.
 *
 * `tagPattern` matters more than it looks: BtbN's FFmpeg-Builds publishes both a moving
 * `latest` tag and dated `autobuild-<date>` tags from the same repo. Taking "the
 * latest release" blindly would hand back `latest` — a moving target whose sha256 changes
 * under us, which defeats pinning entirely.
 *
 * ★★ T-161 更正：**这里原来写的是「immutable `autobuild-<date>` tags」——那句是错的，
 * 而且它直接导致我们钉了一个约 9 天后就会 404 的 tag。**
 * `[实测]` 上游 `util/prunetags.sh` 只保留「最近 14 个日构建」+「每月最后一个（24 个月）」，
 * 其余 `gh release delete --cleanup-tag`；GitHub API 上 BtbN 全仓库只剩 37 个 release
 * （22 个月末 + 最近 14 个日构建）。
 * → **只有「每月最后一天」的 autobuild tag 才是真的能长期存活的**，
 *   所以 `components.json` 里的 `tagPattern` 现在带日期段（`(2[89]|3[01])`），
 *   守卫在 `apps/daemon/src/pipeline/ffmpegPinRot.test.ts`。
 */
export async function checkUpstream(
  src: UpstreamSource,
  opts: { timeoutMs?: number; token?: string } = {},
): Promise<UpstreamProbe> {
  const checkedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? 12_000;
  try {
    if (src.kind === 'static') {
      // 不是失败：`static` 的意思就是"没有可问的上游"。叫用户重试是把他送上死路。
      return { kind: 'no-upstream', reason: '这个组件没有上游发布源（upstream.kind = static）' };
    }

    if (src.kind === 'github-release') {
      const re = src.tagPattern ? new RegExp(src.tagPattern) : null;
      // Ask for a page of releases, not /latest: /latest ignores tag families and can
      // return a prerelease-free but wrong-family tag.
      const list = (await getJson(
        `https://api.github.com/repos/${src.repo}/releases?per_page=30`,
        timeoutMs,
        opts.token,
        'application/vnd.github+json',
      )) as GhRelease[];
      const candidates = list
        .filter((r) => !r.draft)
        .filter((r) => (src.stableOnly ? !r.prerelease : true))
        .filter((r) => (re ? re.test(r.tag_name) : true));
      if (candidates.length === 0) {
        return {
          kind: 'failed',
          checkedAt,
          reason: src.tagPattern
            ? `没有 release 匹配 tagPattern ${src.tagPattern}`
            : '这个仓一个 release 都没有',
        };
      }
      // Sort by our own comparator rather than trusting list order, which is by date and
      // does not match build-number or date-tag ordering in every repo.
      candidates.sort((a, b) => compareVersionsForSort(b.tag_name, a.tag_name));
      const newest = candidates[0]!;
      return {
        kind: 'ok',
        checkedAt,
        version: newest.tag_name,
        release: toRelease(newest),
        newestByScheme: newestByScheme(candidates.map((r) => r.tag_name)),
        candidates: candidates.map((r) => r.tag_name),
      };
    }

    if (src.kind === 'github-tag') {
      const tags = (await getJson(
        `https://api.github.com/repos/${src.repo}/tags?per_page=50`,
        timeoutMs,
        opts.token,
        'application/vnd.github+json',
      )) as { name: string }[];
      const re = src.tagPattern ? new RegExp(src.tagPattern) : null;
      const names = tags.map((t) => t.name).filter((n) => (re ? re.test(n) : true));
      if (!names.length) {
        return {
          kind: 'failed',
          checkedAt,
          reason: src.tagPattern ? `没有 tag 匹配 tagPattern ${src.tagPattern}` : '这个仓没有 tag',
        };
      }
      names.sort((a, b) => compareVersionsForSort(b, a));
      return {
        kind: 'ok',
        checkedAt,
        version: names[0]!,
        release: null,
        newestByScheme: newestByScheme(names),
        candidates: names,
      };
    }

    if (src.kind === 'npm') {
      const meta = (await getJson(`https://registry.npmjs.org/${src.repo}/latest`, timeoutMs)) as {
        version?: string;
      };
      return meta.version
        ? {
            kind: 'ok',
            checkedAt,
            version: meta.version,
            release: null,
            newestByScheme: { [versionScheme(meta.version)]: meta.version },
            // npm 的 `/latest` 只回一个值，没有候选列表可比对。
            candidates: [],
          }
        : { kind: 'failed', checkedAt, reason: 'npm 返回里没有 version 字段' };
    }

    if (src.kind === 'huggingface') {
      const meta = (await getJson(`https://huggingface.co/api/models/${src.repo}`, timeoutMs)) as {
        sha?: string;
        lastModified?: string;
      };
      // HF models have no releases; the commit sha IS the version.
      return meta.sha
        ? {
            kind: 'ok',
            checkedAt,
            version: meta.sha,
            release: null,
            newestByScheme: { [versionScheme(meta.sha)]: meta.sha },
            // HF 只回一个整仓 commit sha，没有候选列表可比对。
            candidates: [],
          }
        : { kind: 'failed', checkedAt, reason: 'HuggingFace 返回里没有 sha 字段' };
    }

    return { kind: 'failed', checkedAt, reason: `unsupported upstream kind: ${src.kind}` };
  } catch (e) {
    // Degrade quietly: a failed check must never look like "you are up to date", and must
    // never prevent installing the pinned version.
    return {
      kind: 'failed',
      checkedAt,
      reason:
        (e as Error)?.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : String((e as Error)?.message ?? e),
    };
  }
}

/**
 * 每套编号方案下最新的那个 tag。
 *
 * `[实测 2026-08-11]` 为什么必须按方案分组而不是全局挑一个：
 * `ggml-org/whisper.cpp` 一个仓里同时有 `v1.9.2`（semver 发布）和 `b2365`（build number），
 * 而我们钉的是 `v1.9.1` —— 只有 semver 那一族的最新值回答得了「有没有更新」。
 * 全局挑一个的话，挑中哪个取决于排序 tie-break，那是**字典序的产物，不是事实**。
 */
function newestByScheme(tags: readonly string[]): Partial<Record<VersionScheme, string>> {
  const out: Partial<Record<VersionScheme, string>> = {};
  for (const t of tags) {
    const sc = versionScheme(t);
    const cur = out[sc];
    // 同族内部才比 —— 这里的比较一定是有定义的。
    if (cur === undefined || compareVersions(t, cur) === 'newer') out[sc] = t;
  }
  return out;
}

/**
 * Check many upstreams concurrently; one failure never affects the others.
 *
 * ★★ **按查询去重，不按组件去重。** 27 个组件只对应 **9 个不同的查询**
 * （key = kind + repo + tagPattern + stableOnly）—— 6 条 whisper.cpp 问同一个
 * `ggml-org/whisper.cpp`，6 条 libsimple 问同一个 `wangfenjin/simple`，等等。
 *
 * 这不是"省事"，是**能不能拿到答案**的区别：
 *   · 限额：GitHub 匿名 60 次/小时/IP。27 次一扫，**两次刷新就见底**；9 次一扫，
 *     一小时能扫 6 次。
 *   · 延迟：`[实测 2026-08-11，本机]` 单次 GitHub API 往返 ~1.3–2.6s；
 *     **9 个查询并发全部答上，总耗时 2.6s**；而同一时刻的真 daemon
 *     （27 个并发、8s 超时）实测 **27/27 全是 `timed out after 8000ms`，0 个答上**
 *     （`GET http://127.0.0.1:10000/api/components?check=1`）。
 *     并发数本身就是失败原因 —— 去重把它从 27 降到 9。
 */
export async function checkAllUpstreams(
  sources: { id: string; upstream: UpstreamSource | null }[],
  opts: { timeoutMs?: number; token?: string } = {},
): Promise<Map<string, UpstreamProbe>> {
  // 同一个查询只发一次。key 必须覆盖**所有影响结果的字段** —— 少一个（例如漏了
  // tagPattern）就会把两个不同的问题合并成一个，那比多问一次糟得多。
  const byQuery = new Map<string, { src: UpstreamSource; ids: string[] }>();
  const out = new Map<string, UpstreamProbe>();

  for (const s of sources) {
    if (!s.upstream) {
      out.set(s.id, {
        kind: 'no-upstream',
        reason: '这个组件没有登记上游发布源（components.json 里 upstream 为 null）',
      });
      continue;
    }
    const key = upstreamQueryKey(s.upstream);
    const slot = byQuery.get(key);
    if (slot) slot.ids.push(s.id);
    else byQuery.set(key, { src: s.upstream, ids: [s.id] });
  }

  await Promise.all(
    [...byQuery.values()].map(async ({ src, ids }) => {
      const probe = await checkUpstream(src, opts);
      for (const id of ids) out.set(id, probe);
    }),
  );
  return out;
}

/**
 * 两个组件"问的是同一个问题"的判据。
 *
 * ⚠️ **必须逐字覆盖 `UpstreamSource` 里所有会改变答案的字段。** `stableOnlyReason`
 * 故意不在里面：它是写给人看的理由，不影响查询结果。将来给 `UpstreamSource` 加一个
 * **会改变答案**的字段而忘了加到这里，去重会**静默地把两个不同的问题当成一个** ——
 * 守卫见 `packages/downloader/src/upstreamDedup.test.ts`（它把这个 key 的字段集
 * 与 `UpstreamSource` 的字段集对起来数）。
 */
export function upstreamQueryKey(src: UpstreamSource): string {
  return JSON.stringify([src.kind, src.repo, src.tagPattern ?? null, src.stableOnly ?? false]);
}
