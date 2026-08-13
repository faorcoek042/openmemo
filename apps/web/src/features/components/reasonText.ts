/**
 * 组件页上那几句「为什么」的**措辞总表**（#106）。
 *
 * ## 这个文件存在的理由
 *
 * daemon 以前把这些理由拼成**整句中文**发过来，组件卡把它插进
 * `components.installedNoVersion` / `components.note.*` 这些**英文**句子的
 * `{{reason}}` 里。于是英文界面上逐字是：
 *
 * ```
 * installed (安装记录里没有记版本号)
 * We did ask upstream and got no answer (上游配额已用尽（core 配额，每小时 60 次），约 42 分钟后恢复), …
 * ```
 *
 * 它符合「CJK 只出现在数据里」的表面判据 —— `en.json` 里一个汉字都没有 ——
 * **但对英文用户就是半句中文**。所以契约那一侧改成了机器可读的原因
 * （`InstalledVersionUnknownReason` / `NoUpstreamReason` / `UpstreamIndeterminate`
 * / `UpstreamFailure`），措辞全部搬到这里 + 两份 locale。做法照 `79cc117`
 * 对 `AdvisoryUndeterminedReason` 的那一次。
 *
 * ## ★★ 为什么是 `Record<全部 kind, string>` 而不是 `switch` 或 `?.`
 *
 * 下面四张表都是**总表**：契约里新增一种原因而没人给它写话，**构建当场就红**。
 * 换成 `switch` + `default` 或 `KEYS[k] ?? ''`，新原因会静默渲染成一段空白 ——
 * 那正是"说不知道的时候必须说清为什么"这条要求失效的方式。
 *
 * ## ⚠️ 参数是**结构化字段**，不是拼进 key 里的
 *
 * 「约 3 分钟后可再试」里的 3 由 `retryAfterMs` 插值而来（`approxEta`，
 * 两种语言各自的说法），不是一个叫 `retry_in_3_min` 的枚举成员。
 */

import type {
  InstalledVersionUnknownReason,
  NoUpstreamReason,
  UpstreamFailure,
  UpstreamIndeterminate,
} from '@openmemo/shared';

import { approxEta } from '../../lib/format/time';

/** 「说不出已装的是哪一版」的每一种原因该说哪句话。**总表**。 */
export const INSTALLED_VERSION_UNKNOWN_KEYS: Readonly<
  Record<InstalledVersionUnknownReason, string>
> = {
  no_version_recorded: 'components.reason.installedVersion.noVersionRecorded',
};

/** 「结构上没有上游可问」的每一种成因该说哪句话。**总表**。 */
export const NO_UPSTREAM_KEYS: Readonly<Record<NoUpstreamReason, string>> = {
  static_source: 'components.reason.noUpstream.staticSource',
  not_registered: 'components.reason.noUpstream.notRegistered',
};

/** 「排不出先后」的每一种成因该说哪句话。**总表**。 */
export const INDETERMINATE_KEYS: Readonly<Record<UpstreamIndeterminate['kind'], string>> = {
  version_schemes_differ: 'components.reason.indeterminate.versionSchemesDiffer',
  pin_outside_all_tag_families: 'components.reason.indeterminate.pinOutsideAllTagFamilies',
};

/**
 * 一次上游查询失败的每一种原因该说哪句话。**总表**，14 格一个都不许少。
 *
 * ⚠️ `upstream_error_text` 那一格说的是「这一段是上游原文，我们没翻译」——
 * 它的词条里**刻意不用 `**…**` 强调**：这一族短语是被插进另一条词条的
 * `{{reason}}` 里再交给 `<Emphasis>` 的，而 `components.test.tsx` 那道
 * `EMPHASIS_REGISTRY` 护栏按「词条 → 渲染点文件里出现该 key 字面量」登记，
 * 建模不了这种嵌套。括号里再套一层粗体本来也是噪音。
 * 它是唯一一格**故意不解释内容**的，因为我们确实不知道那串字符是什么意思。
 * 把它写成一句像模像样的解释，等于替一段没看懂的字符串背书。
 */
export const UPSTREAM_FAILURE_KEYS: Readonly<Record<UpstreamFailure['kind'], string>> = {
  rate_limited: 'components.reason.failed.rateLimited',
  quota_exhausted: 'components.reason.failed.quotaExhausted',
  quota_exhausted_no_reset: 'components.reason.failed.quotaExhaustedNoReset',
  http_error_not_quota: 'components.reason.failed.httpErrorNotQuota',
  http_error_no_quota_info: 'components.reason.failed.httpErrorNoQuotaInfo',
  timed_out: 'components.reason.failed.timedOut',
  no_release_matches_tag_pattern: 'components.reason.failed.noReleaseMatchesTagPattern',
  repo_has_no_releases: 'components.reason.failed.repoHasNoReleases',
  no_tag_matches_tag_pattern: 'components.reason.failed.noTagMatchesTagPattern',
  repo_has_no_tags: 'components.reason.failed.repoHasNoTags',
  npm_response_has_no_version: 'components.reason.failed.npmResponseHasNoVersion',
  huggingface_response_has_no_sha: 'components.reason.failed.huggingfaceResponseHasNoSha',
  unsupported_upstream_kind: 'components.reason.failed.unsupportedUpstreamKind',
  upstream_error_text: 'components.reason.failed.upstreamErrorText',
};

/** `t()` 的最小形状 —— 这个模块不引 React，方便直接对它写用例。 */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * 「哪个配额桶、每小时多少次」那一段。**两格都可能没有**（上游不一定给这两个头），
 * 所以是四种情形各一句话，而不是往一句话里塞两个可能为空的洞 ——
 * 后者会渲染出 `quota is used up (bucket , /hour)` 这种。
 *
 * 返回值**自带前导空格与括号**：拼进主句时不需要调用方再判断有没有。
 */
function quotaScope(t: Translate, resource: string | null, limit: number | null): string {
  if (resource !== null && limit !== null)
    return t('components.reason.quotaScope.both', {
      resource,
      limit,
    });
  if (resource !== null) return t('components.reason.quotaScope.resource', { resource });
  if (limit !== null) return t('components.reason.quotaScope.limit', { limit });
  return '';
}

/**
 * 一条 `UpstreamFailure` → 用户读得懂的那句话（当前语言）。
 *
 * `locale` 只用来格式化时长（`approxEta` 对中英各有说法）；措辞一律走 `t()`。
 */
export function upstreamFailureText(t: Translate, locale: string, f: UpstreamFailure): string {
  const key = UPSTREAM_FAILURE_KEYS[f.kind];
  switch (f.kind) {
    case 'rate_limited':
      return t(key, { status: f.status, wait: approxEta(f.retryAfterMs / 1000, locale) ?? '' });
    case 'quota_exhausted':
      return t(key, {
        scope: quotaScope(t, f.resource, f.limit),
        wait: approxEta(f.resetInMs / 1000, locale) ?? '',
      });
    case 'quota_exhausted_no_reset':
      return t(key, { scope: quotaScope(t, f.resource, f.limit) });
    case 'http_error_not_quota':
      return t(key, { status: f.status, remaining: f.remaining });
    case 'http_error_no_quota_info':
      return t(key, { status: f.status });
    case 'timed_out':
      return t(key, { timeoutMs: f.timeoutMs });
    case 'no_release_matches_tag_pattern':
    case 'no_tag_matches_tag_pattern':
      return t(key, { tagPattern: f.tagPattern });
    case 'repo_has_no_releases':
    case 'repo_has_no_tags':
    case 'npm_response_has_no_version':
    case 'huggingface_response_has_no_sha':
      return t(key);
    case 'unsupported_upstream_kind':
      return t(key, { upstreamKind: f.upstreamKind });
    case 'upstream_error_text':
      return t(key, { text: f.text });
    default:
      return assertNeverUpstreamFailure(f);
  }
}

/**
 * 编译期穷尽性检查；**运行期不 throw**。
 *
 * 抄 `assertNeverInstalledArm` 那一条：少写一条腿时 `tsc` 当场红（那是我们要的），
 * 但真跑到这一行（产品与 daemon 版本错配）时，让整张组件页崩掉是更坏的结果。
 * 返回空串 ⇒ 外层那句英文照样成立，只是括号里没有细节 —— 而**上面那张总表
 * 保证了这一行在编译得过的代码里不可达**。
 */
function assertNeverUpstreamFailure(x: never): string {
  void x;
  return '';
}

/** 一条 `UpstreamIndeterminate` → 用户读得懂的那句话。 */
export function indeterminateText(t: Translate, r: UpstreamIndeterminate): string {
  switch (r.kind) {
    case 'version_schemes_differ':
      return t(INDETERMINATE_KEYS[r.kind], {
        upstreamScheme: r.upstreamScheme,
        pinnedVersion: r.pinnedVersion,
        pinnedScheme: r.pinnedScheme,
      });
    case 'pin_outside_all_tag_families':
      return t(INDETERMINATE_KEYS[r.kind], {
        families: r.newestPerFamily.join(' / '),
        pinnedVersion: r.pinnedVersion,
      });
    default:
      return assertNeverIndeterminate(r);
  }
}

function assertNeverIndeterminate(x: never): string {
  void x;
  return '';
}
