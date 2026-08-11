/**
 * Upstream release lookup — "is there a newer version than the one we pinned?"
 *
 * Answers only that question. It never mutates a manifest and never triggers a download:
 * pinning stays authoritative, and moving to a new version is always a user action.
 *
 * Failure is expected and must be harmless. Offline, rate-limited or renamed-repo all
 * produce `latestVersion: null` plus a reason — never an exception that could block
 * installing what is already pinned. A version check is a convenience; an install is not.
 */

import type { UpstreamSource, VersionOrder } from '@openmemo/shared';
import { compareVersions, compareVersionsForSort } from '@openmemo/shared';

export interface UpstreamRelease {
  version: string;
  publishedAt: string | null;
  htmlUrl: string | null;
  /** Asset name → { size, sha256 } when the registry exposes digests (GitHub does). */
  assets: { name: string; sizeBytes: number; sha256: string | null; url: string }[];
}

export interface UpstreamCheck {
  latestVersion: string | null;
  release: UpstreamRelease | null;
  error: string | null;
  checkedAt: string;
}

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
): Promise<UpstreamCheck> {
  const checkedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? 12_000;
  try {
    if (src.kind === 'static') {
      return {
        latestVersion: null,
        release: null,
        error: 'component has no upstream feed',
        checkedAt,
      };
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
          latestVersion: null,
          release: null,
          error: 'no release matched the tag pattern',
          checkedAt,
        };
      }
      // Sort by our own comparator rather than trusting list order, which is by date and
      // does not match build-number or date-tag ordering in every repo.
      candidates.sort((a, b) => compareVersionsForSort(b.tag_name, a.tag_name));
      const newest = candidates[0];
      return { latestVersion: newest.tag_name, release: toRelease(newest), error: null, checkedAt };
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
      if (!names.length)
        return { latestVersion: null, release: null, error: 'no tag matched', checkedAt };
      names.sort((a, b) => compareVersionsForSort(b, a));
      return { latestVersion: names[0], release: null, error: null, checkedAt };
    }

    if (src.kind === 'npm') {
      const meta = (await getJson(`https://registry.npmjs.org/${src.repo}/latest`, timeoutMs)) as {
        version?: string;
      };
      return {
        latestVersion: meta.version ?? null,
        release: null,
        error: meta.version ? null : 'no version field',
        checkedAt,
      };
    }

    if (src.kind === 'huggingface') {
      const meta = (await getJson(`https://huggingface.co/api/models/${src.repo}`, timeoutMs)) as {
        sha?: string;
        lastModified?: string;
      };
      // HF models have no releases; the commit sha IS the version.
      return {
        latestVersion: meta.sha ?? null,
        release: null,
        error: meta.sha ? null : 'no sha field',
        checkedAt,
      };
    }

    return {
      latestVersion: null,
      release: null,
      error: `unsupported upstream kind: ${src.kind}`,
      checkedAt,
    };
  } catch (e) {
    // Degrade quietly: a failed check must never look like "you are up to date", and must
    // never prevent installing the pinned version.
    return {
      latestVersion: null,
      release: null,
      error:
        (e as Error)?.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : String((e as Error)?.message ?? e),
      checkedAt,
    };
  }
}

/** Check many upstreams concurrently; one failure never affects the others. */
export async function checkAllUpstreams(
  sources: { id: string; upstream: UpstreamSource | null }[],
  opts: { timeoutMs?: number; token?: string } = {},
): Promise<Map<string, UpstreamCheck>> {
  const out = new Map<string, UpstreamCheck>();
  await Promise.all(
    sources.map(async (s) => {
      if (!s.upstream) {
        out.set(s.id, {
          latestVersion: null,
          release: null,
          error: 'no upstream configured',
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      out.set(s.id, await checkUpstream(s.upstream, opts));
    }),
  );
  return out;
}

/**
 * 上游那一版相对我们钉的那一版是什么关系 —— **三态原样传出去，不在这里压成布尔**。
 *
 * ★★ 这里原来是 `isUpdateAvailable(pinned, latest): boolean` —— 一台
 * **三态进、二态出**的机器：`compareVersions` 的「比不了」和「相等」被同一个 `> 0`
 * 一起压进 false，于是"我们没能判断"和"你已经是最新的"在下游长得一模一样。
 * `[实测 2026-08-11]` 这正是 `whispercpp-cpu-macos-arm64` 线上那句假话的下半段：
 * 比较器把 `model-mirror-2026.08.06` 的 `2026` 当成主版本号去和 `v1.9.1` 的 `1` 比，
 * 得 2025 > 0，报出假的「有新版本」。
 *
 * 现在把 `VersionOrder` 原样交给 `listComponents()`，由它决定
 * 「比不了」该显示成什么 —— 而不是在这里替它做掉。
 */
export function upstreamRelation(pinned: string, latest: string | null): VersionOrder | null {
  if (!latest) return null;
  return compareVersions(latest, pinned);
}
