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

import type {
  NoUpstreamReason,
  UpstreamFailure,
  UpstreamSource,
  VersionScheme,
} from '@openmemo/shared';
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
      readonly reason: NoUpstreamReason;
    }
  | {
      /** 问了没问到：超时、限流、改名、断网。重试是有意义的。 */
      readonly kind: 'failed';
      /**
       * ⚠️ **机器可读，不是一句话**（#106）。措辞归 `apps/web` 的两份 locale ——
       * 这一格会被插进 `components.upstream.failed` 那句英文里，
       * 塞一句中文进去就是给英文用户一句半中文的话。
       */
      readonly checkedAt: string;
      readonly reason: UpstreamFailure;
    };

const UA = 'OpenMemo/0.1 (+https://github.com/openmemo)';

/**
 * 响应里那套配额头 —— **每一格都可能没有，没有就是 `null`，不编一个**。
 *
 * `[实测 2026-08-12]` 真实取到的形状（同一台机器，两次真请求）：
 *
 * ```
 * 200  x-ratelimit-limit:60  remaining:59  reset:1786532531  resource:core   used:1
 * 403  x-ratelimit-limit:10  remaining:0   reset:1786528992  resource:search used:10
 * ```
 *
 * 两条从实测里学到、写死在这里会出错的事：
 *   1. **`limit` 不是常数 60。** 不同的桶不一样（core 60、search 10），
 *      所以那句「每小时 N 次」要**读出来**，不能照抄文档里的 60。
 *   2. **主配额限流不带 `retry-after`。** 上面那个真的 403 里没有这个头 ——
 *      恢复时刻只能从 `x-ratelimit-reset`（epoch 秒）算。
 *      `retry-after` 是**次级限流**才有的（这一条来自上游文档，**我没有实测到**）。
 */
export interface RateLimitSnapshot {
  /** 这一刻还剩多少次。 */
  readonly remaining: number | null;
  /** 这个桶的上限。**读出来的，不写死。** */
  readonly limit: number | null;
  /** 配额重置的时刻（epoch 毫秒）。 */
  readonly resetAtMs: number | null;
  /** 次级限流才有。 */
  readonly retryAfterMs: number | null;
  /** 哪个配额桶（`core` / `search` / …）。 */
  readonly resource: string | null;
}

const NO_RATE_INFO: RateLimitSnapshot = {
  remaining: null,
  limit: null,
  resetAtMs: null,
  retryAfterMs: null,
  resource: null,
};

/** 只把**真的存在且是数字**的头读成数字；其余一律 `null`。 */
function readRateLimit(res: Response): RateLimitSnapshot {
  const num = (name: string): number | null => {
    const raw = res.headers.get(name);
    if (raw == null) return null;
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  };
  const resetSec = num('x-ratelimit-reset');
  const retryAfterSec = num('retry-after');
  return {
    remaining: num('x-ratelimit-remaining'),
    limit: num('x-ratelimit-limit'),
    resetAtMs: resetSec == null ? null : resetSec * 1000,
    retryAfterMs: retryAfterSec == null ? null : retryAfterSec * 1000,
    resource: res.headers.get('x-ratelimit-resource'),
  };
}

/** 一次 HTTP 失败，**连它当时的配额快照一起**带出来。 */
class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly rate: RateLimitSnapshot,
  ) {
    super(`HTTP ${status}`);
    this.name = 'UpstreamHttpError';
  }
}

/**
 * 把一次 403/429 变成一条**用户能照着做**的结论 —— **机器可读的那一种**。
 *
 * ★★ 这条线要治的病：`x-ratelimit-remaining` 上游**每次响应都给**，而我们原来
 * **只在 403/429 时**把它变成一句话，正常响应里那个数字直接丢掉 ——
 * 于是我们永远只在撞墙之后才知道自己快撞墙了。而撞墙那一刻我们说的还是
 * 「rate limited by upstream (HTTP 403)」：**它不可执行**。
 * 「等 3 分钟再试」是可执行的。
 *
 * 🔴 **「配额还剩多少」与「这次查询成功没有」是两件事，这里不许把它们塌成一个。**
 * 具体到代码上有三条：
 *   1. `status` 和 `rate` 是**两个独立入参**，本函数**从不**用 `remaining` 去推断成功与否；
 *   2. 反过来也一样：`remaining === 0` **不会**让一次成功的请求变成失败 ——
 *      本函数只在失败路径上被调用，成功响应压根不经过这里
 *      （`remaining: 0` 的成功请求就是成功的，那个 0 说的是**下一次**）；
 *   3. **403 不等于限流。** 上游对私有/改名仓库、滥用保护也回 403。
 *      所以 `remaining > 0` 时这里**明说「不是配额问题」**，而不是像原来那样
 *      一律宣布 "rate limited" —— 那是在没有证据的地方给了一个具体的错误原因。
 *
 * ⚠️ **算不出恢复时间就不说时间**（本条要求 3）：`reset` 缺失、或已经是过去时，
 * 都只走 `quota_exhausted_no_reset`，绝不编一个「等 X 分钟」。
 * 编出来的那个数会被用户当真去等 —— 所以这一条现在**由类型守着**：
 * 只有 `quota_exhausted` 那一格才有 `resetInMs`，而它是 `number`，不是 `number | null`。
 *
 * ⚠️ **#106：这里不再产出一句话。** 上一版返回的是
 * 「上游限流（HTTP 403），约 3 分钟后可再试」这种整句中文，而 `apps/web` 把它插进
 * `components.upstream.failed`（一句英文）里 —— 英文界面上就是半句中文。
 * 讽刺的是那句话本身是 v0.7.2 刚做好的诚实文案：**内容是对的，位置是错的。**
 * 现在只交出 `kind` + 结构化数字，措辞与时长格式化都在 `apps/web` 的两份 locale。
 */
export function httpFailureReason(
  status: number,
  rate: RateLimitSnapshot,
  nowMs: number,
): UpstreamFailure {
  // 次级限流：上游直接告诉了我们等多久，照传。
  if (rate.retryAfterMs != null && rate.retryAfterMs > 0) {
    return { kind: 'rate_limited', status, retryAfterMs: rate.retryAfterMs };
  }

  if (rate.remaining === 0) {
    // 只有真的算得出来才带时间。
    if (rate.resetAtMs != null && rate.resetAtMs > nowMs) {
      return {
        kind: 'quota_exhausted',
        resetInMs: rate.resetAtMs - nowMs,
        resource: rate.resource,
        limit: rate.limit,
      };
    }
    return { kind: 'quota_exhausted_no_reset', resource: rate.resource, limit: rate.limit };
  }

  // ★ 有配额却还是 403/429 —— **这不是限流**，别替它编一个原因。
  if (rate.remaining != null) {
    return { kind: 'http_error_not_quota', status, remaining: rate.remaining };
  }

  return { kind: 'http_error_no_quota_info', status };
}

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
    /*
     * 403/429 把**当时的配额快照**一起带走 —— 措辞在 `httpFailureReason()` 里定。
     * 这里原来直接抛一句写死的 "rate limited by upstream (HTTP 403)"：
     * 它既**不可执行**（不知道等多久），又在 `remaining > 0` 的 403 上**说了假话**
     * （403 不等于限流）。
     */
    if (res.status === 403 || res.status === 429) {
      throw new UpstreamHttpError(res.status, readRateLimit(res));
    }
    // 其余非 2xx 不谈配额：那是在没有证据的地方加戏。
    if (!res.ok) throw new UpstreamHttpError(res.status, NO_RATE_INFO);
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
      return { kind: 'no-upstream', reason: 'static_source' };
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
            ? { kind: 'no_release_matches_tag_pattern', tagPattern: src.tagPattern }
            : { kind: 'repo_has_no_releases' },
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
          reason: src.tagPattern
            ? { kind: 'no_tag_matches_tag_pattern', tagPattern: src.tagPattern }
            : { kind: 'repo_has_no_tags' },
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
        : { kind: 'failed', checkedAt, reason: { kind: 'npm_response_has_no_version' } };
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
        : { kind: 'failed', checkedAt, reason: { kind: 'huggingface_response_has_no_sha' } };
    }

    return {
      kind: 'failed',
      checkedAt,
      reason: { kind: 'unsupported_upstream_kind', upstreamKind: src.kind },
    };
  } catch (e) {
    // Degrade quietly: a failed check must never look like "you are up to date", and must
    // never prevent installing the pinned version.
    return { kind: 'failed', checkedAt, reason: failureReason(e, timeoutMs) };
  }
}

/**
 * 一次异常变成 `UpstreamCheck.failed` 的 `reason` —— **全仓唯一的措辞点**。
 *
 * ⚠️ **超时那一条刻意什么都不猜。** 一次超时**同时**发生在配额见底的时刻，
 * 并不构成"因为配额见底所以超时"的证据 —— 那正是上一轮被实测证伪过的那种推断
 * （27/27 超时曾被我归因成"并发数太高"，复测里同样的 27 并发 2.4s 全过，
 * 真凶是网络瞬态）。**没有证据就不给原因。**
 */
function failureReason(e: unknown, timeoutMs: number): UpstreamFailure {
  if (e instanceof UpstreamHttpError) return httpFailureReason(e.status, e.rate, Date.now());
  if ((e as Error)?.name === 'AbortError') return { kind: 'timed_out', timeoutMs };
  /*
   * ⚠️ **这一行刻意不枚举**（#106）。落到这里的是 `fetch` / DNS / TLS 原样抛回来的
   * `message`（`fetch failed`、`getaddrinfo ENOTFOUND …`……）—— 一个**我们没有解读过、
   * 也没有边界**的集合。给它硬编一个枚举，是把「我不知道这是什么」塌成「我知道」。
   * 所以它如实进 `upstream_error_text`，界面上明说这一段是原文、不会被翻译。
   */
  return { kind: 'upstream_error_text', text: String((e as Error)?.message ?? e) };
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
 *
 * ⚠️ **理由只有配额这一条，别再往上加"更快"。**
 * 这段注释原来还写着「27 并发本身就是失败原因」，证据是 `GET :10000/api/components?check=1`
 * 实测 27/27 `timed out after 8000ms`。**那个因果推断后来被我自己的复测证伪了**：
 * 同样 27 个并发、同样 8s 超时、同样这台机器，直接复现一次是
 * **26/27 拿到 200、0 个超时、0 个 403/429、总耗时 2.4s**。
 * 也就是说那次全超时是**当时的网络瞬态**（同一刻单发一个请求就要 7.35s，本身已逼近 8s 超时），
 * 不是并发数。去重**不会**让慢网络变快，只会让配额少烧 —— 只认后者。
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
        reason: 'not_registered',
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
