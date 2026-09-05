/**
 * 代理面板上那两处**名字与细节**的措辞总表（#112 第 16、17 处）。
 *
 * ## 这个文件存在的理由
 *
 * 代理设置整屏是英文词条，而其中两处的字**是从 daemon 直接搬上来的中文**：
 *
 * ```
 * · 连不上代理 http://127.0.0.1:7890/ —— 未向 YouTube 发出请求      ← probes[].detail
 * hf-mirror 镜像    不可达                                          ← 源表格的名字
 * ⚠️ 2 download source(s) are unreachable: hf-mirror 镜像、Hugging Face   ← 同一个名字，第二处
 * ```
 *
 * 与 `features/components/reasonText.ts` 是同一条路子：契约那一侧换成机器可读
 * （`ProxyProbeDetail`），措辞全部搬到这里 + 两份 locale。
 *
 * ## ★★ 为什么两张表都是 `Record<全部 kind, string>`
 *
 * **总表**：契约里新增一格而没人给它写话，**构建当场就红**。
 * 换成 `KEYS[k] ?? ''` 或 `switch` 带个万能 `default`，新的一格会静默渲染成一段空白 ——
 * 而这两处的空白各自都会说出一句不成立的话：探针那一行会只剩一个孤零零的 `·`，
 * 源表格那一格会变成一行没有名字的延迟数字。
 *
 * ## ⚠️ 名字那张表为什么按 `provider` 而不是新造一个枚举
 *
 * `provider` 一直就是机器可读的那根轴（`fastest` 比的就是它），只是从来没人拿它当
 * 措辞轴用，界面渲染的是 `label` —— 而目录里那两条 label 逐字含中文。
 * 这里不需要再造一个平行的枚举：`DOWNLOAD_SOURCE_PROVIDERS` 已经是那张名单，
 * 且 `DOWNLOAD_SOURCE_TARGETS` 已经被钉在它上面（加内置源 ⇒ 加联合成员 ⇒ 下面这张表红）。
 *
 * ⚠️ 但**调用方可以传自定义源**（`measureDownloadSources(cfg, {sources})`），
 * 那时 `provider` 认不出来 —— 这时**如实说这是按配置原样显示的名字**，
 * 而不是假装它也是一个我们认得的源。见 {@link sourceDisplayName}。
 */

import {
  isDownloadSourceProvider,
  type DownloadSourceProvider,
  type ProxyProbeDetail,
} from '@openmemo/shared';

import { isKnownKind, unreachable, type Translate } from '../../lib/wording';

/** 一条探针细节的每一种成因该说哪句话。**总表**，四格一个都不许少。 */
export const PROXY_PROBE_DETAIL_KEYS: Readonly<Record<ProxyProbeDetail['kind'], string>> = {
  proxy_unreachable_not_sent: 'settings.proxy.probeDetail.proxyUnreachableNotSent',
  proxy_rejected_credentials: 'settings.proxy.probeDetail.proxyRejectedCredentials',
  proxy_refused_tunnel: 'settings.proxy.probeDetail.proxyRefusedTunnel',
  /**
   * ⚠️ 这一格的词条**刻意只标出处、不解释内容**（「探针原文：…」）。
   * 落进来的是 fetch / DNS / TLS 原样抛回来的串 —— 一个我们没解读过也没有边界的集合。
   * 把它写成一句像模像样的解释，等于替一段没看懂的字符串背书
   *（同 `components.reason.failed.upstreamErrorText` 的待遇）。
   */
  probe_error_text: 'settings.proxy.probeDetail.probeErrorText',
};

/** 内置下载源在界面上叫什么。**总表**，四格一个都不许少。 */
export const SOURCE_NAME_KEYS: Readonly<Record<DownloadSourceProvider, string>> = {
  hf: 'settings.proxy.sourceName.hf',
  'hf-mirror': 'settings.proxy.sourceName.hf-mirror',
  modelscope: 'settings.proxy.sourceName.modelscope',
  github: 'settings.proxy.sourceName.github',
};

/**
 * 一条 `ProxyProbeDetail` → 用户读得懂的那句话（当前语言）。
 *
 * `switch` 而不是直接 `t(KEYS[d.kind], d)`：每一格的插值参数不一样，
 * 而**把整个对象当参数摊给 i18next** 会让「这一格该有哪几个洞」变成运气
 *（少一个字段时渲染出 `{{target}}` 那种原样占位符，而不是编译错误）。
 */
export function proxyProbeDetailText(t: Translate, d: ProxyProbeDetail): string {
  const key = PROXY_PROBE_DETAIL_KEYS[d.kind];
  switch (d.kind) {
    case 'proxy_unreachable_not_sent':
      return t(key, { proxyUrl: d.proxyUrl, target: d.target });
    case 'proxy_rejected_credentials':
      return t(key, { proxyUrl: d.proxyUrl });
    case 'proxy_refused_tunnel':
      return t(key, { proxyUrl: d.proxyUrl, target: d.target });
    case 'probe_error_text':
      return t(key, { text: d.text });
    /*
     * 兜底取空串：那一行只是少了后半句细节，探针状态芯片与目标仍然在。
     * 让整个代理面板崩掉是更坏的结果。
     *
     * ★ 这一行**运行期也不可达**，而这不是总表给的保证 —— 是
     * {@link normalizeProbeDetail} 给的：进得了本函数的每一个值都先过它，
     * 认不出的一律变成 `null`、根本到不了这里。总表守编译期、`normalize*` 守网线，
     * **两道一起才够**（`lib/wording.ts` 抬头那一节；同族里有两个模块只有第一道）。
     */
    default:
      return unreachable(d, '');
  }
}

/**
 * 线上那一格 → 认得的细节，认不出一律 `null`（那一行就不渲染细节）。
 *
 * ⚠️ **必须在运行期收一道**：它是从网线上来的。类型上写着判别式联合，
 * 不代表它到手时就是 —— 旧 daemon 发的是**一句中文散文**（一个 `string`），
 * 而字段本身一直是可选的。收不住的后果不是少一句话，是
 * `· [object Object]` 或者把一段中文散文原样贴回英文面板 —— 两者都比不说更糟。
 *
 * 认哪几格由 {@link PROXY_PROBE_DETAIL_KEYS} 这张**总表**说了算，不另抄一份常量。
 * 每一格还要求它自己的字段真的是字符串：缺了 `target` 的那一格渲染出来是
 * `… no request was sent to  at all`，一句读不通的话。
 */
export function normalizeProbeDetail(raw: unknown): ProxyProbeDetail | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  // `isKnownKind` 判的是总表**自有**的键（不是 `in`：`'toString' in KEYS` 是真的），
  // 判完顺带把 `kind` 收窄成总表的那几格，不用再写一次 `as`。
  if (!isKnownKind(PROXY_PROBE_DETAIL_KEYS, o['kind'])) return null;
  const str = (f: string): string | null => (typeof o[f] === 'string' ? (o[f] as string) : null);

  const k = o['kind'];
  switch (k) {
    case 'proxy_unreachable_not_sent':
    case 'proxy_refused_tunnel': {
      const proxyUrl = str('proxyUrl');
      const target = str('target');
      if (proxyUrl === null || target === null) return null;
      return { kind: k, proxyUrl, target };
    }
    case 'proxy_rejected_credentials': {
      const proxyUrl = str('proxyUrl');
      if (proxyUrl === null) return null;
      return { kind: k, proxyUrl };
    }
    case 'probe_error_text': {
      const text = str('text');
      if (text === null) return null;
      return { kind: k, text };
    }
    /*
     * ⚠️ 这一处兜底是 `null` 而不是 `''`，**刻意与上面那个不同**：
     * 这里产出的是**数据**（一条 `ProxyProbeDetail`），不是一句话。
     * 造一个半空的对象出去，等于让下游渲染一句缺洞的话（`… no request was sent to  at all`）；
     * `null` 说的是「这一行没有细节可显示」，那句在任何情况下都成立。
     */
    default:
      return unreachable(k, null);
  }
}

/**
 * 一个下载源在界面上的名字。
 *
 * 认得的 provider → 走词条（英文界面上是英文，中文界面上是中文）。
 * **认不出** → `settings.proxy.sourceNameVerbatim`，它自己就把「这是按配置原样显示的
 * 名字」说了出来。判据是那条老规矩：**不许把一段来源不明的字原样贴上去装作是文案**
 *（源表格里那两条内置 label 逐字是 `hf-mirror 镜像` / `ModelScope 魔搭`，
 * 而自定义源的 label 是用户自己写的，什么语言都可能）。
 */
export function sourceDisplayName(t: Translate, provider: string, label: string): string {
  if (isDownloadSourceProvider(provider)) return t(SOURCE_NAME_KEYS[provider]);
  return t('settings.proxy.sourceNameVerbatim', { label });
}
