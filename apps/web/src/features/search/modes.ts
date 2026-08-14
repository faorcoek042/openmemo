/**
 * 「服务端到底提供哪几路检索」—— **纯决策部分**（T-164 ⑤）。
 *
 * ## 为什么把这几行单独拿出来
 *
 * 因为它们要守的性质是**规则**，而不是"有没有渲染出来"：
 * 缺陷版本恰恰是**恒渲染三个 tab**，所以任何形如「页面上有三个 tab」
 * 或「tablist 里有『语义』字样」的断言，在缺陷版本下**照样全绿**。
 * 只有把「哪几档可选」「实际发出去的是哪一档」做成可以单独喂输入的函数，
 * 断言才钉得到后果上。
 *
 * 与 `noteAssets.ts` 拆出来的理由一模一样。
 */

import type { SemanticUnavailableReason } from '@openmemo/shared';

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

/**
 * 「为什么没有语义检索」的每一种成因该说哪句话。**总表**（#112 第 11 处）。
 *
 * ## 为什么是 `Record<全部 kind, string>` 而不是 `switch` 或 `?? ''`
 *
 * 照 `features/components/reasonText.ts` 那四张表的姿势：契约里新增一格而没人给它
 * 写话，**构建当场就红**。换成 `KEYS[k] ?? ''`，新的一格会静默渲染成一段空白 ——
 * 而这一句的位置恰好在「{{modes}} search is unavailable: 」后面，
 * 空白会让它读成一句**没说完的话**。
 *
 * ⚠️ 它同时是**运行期认得哪几格的唯一来源**（见 `normalizeModes`）：
 * 加一格 ⇒ 编译逼着补词条 ⇒ 那一格自动被运行期收下。两件事不会各走各的。
 */
export const SEMANTIC_UNAVAILABLE_KEYS: Readonly<
  Record<SemanticUnavailableReason['kind'], string>
> = {
  no_embedding_stage: 'search.semanticUnavailable.noEmbeddingStage',
  vector_extension_not_loaded: 'search.semanticUnavailable.vectorExtensionNotLoaded',
};

/**
 * 服务端**真的**能提供哪几路检索（`apps/daemon/src/http/rest/search.ts` 的 `modeReport()`）。
 *
 * 这份信息一直都在响应里，只是前端 `select: (d) => d.hits` 把它整个丢掉了。
 * 于是用户切到「语义」，以为换了检索方式，拿到的还是同一份关键词结果
 * （`rest/search.ts` 从头到尾不读 `mode`），**界面一个字都不说**。
 */
export interface SearchModes {
  keyword: boolean;
  semantic: boolean;
  hybrid: boolean;
  /**
   * 为什么没有语义路 —— **机器可读的那一格**（#112 第 11 处）。
   *
   * ⚠️ 这里存的是**成因**，不是话。措辞由 `SEMANTIC_UNAVAILABLE_KEYS` + 两份 locale 出，
   * 因为这句会被插进 `search.modesUnavailable` 那句**英文**里 ——
   * 上一版服务端发的是中文散文，英文界面上逐字是
   * `Semantic search is unavailable: sqlite-vec 未加载`。
   *
   * `null` 仍然是一个**真实的状态**：服务端没说为什么（旧 daemon、字段缺失、脏值）。
   * 那时界面说的是 `search.modesUnavailableUnknown` ——「服务端未说明原因」，
   * 而不是替它编一个成因。
   */
  semanticReason: SemanticUnavailableReason | null;
  /**
   * 关键词那一路**实际用的分词器**（T-200 A-2）。
   *
   * `'trigram'` = libsimple 没加载上，FTS5 退回三元组切分 ——
   * 后果是**中文双字词可能搜不到**（「人工智能」这种）。
   *
   * ⚠️ 此前这份信息在响应里**根本没被读过**：`normalizeModes` 只认
   * keyword/semantic/hybrid/semanticReason，于是关键词 tab 正常亮着、
   * `semanticReason` 只解释向量路 —— **用户搜不到中文，却被告知检索一切正常**。
   * 而同一台机器上，就绪横幅与自检页（读的是 `/api/health` 的
   * `db.extensions.tokenizer`，**另一个端点**）**明说降级了**。同一个事实，两处分叉。
   */
  tokenizer: 'simple' | 'trigram';
}

/**
 * 线上那一格 → 认得的成因，认不出一律 `null`（#112 第 11 处）。
 *
 * ⚠️ **必须在运行期收一道**：它是从网线上来的。类型上写着判别式联合，
 * 不代表它到手时就是；旧 daemon 发的是**一句中文散文**，
 * 而更旧的什么都不发。两种都必须落到"服务端没说为什么"那一档。
 *
 * 认不出的 `kind` 也归 `null`，**不猜一格**：这里的判据仍是那句
 * **「哪个默认值会让界面说一句不成立的话」** ——
 * 猜一格会让界面言之凿凿地说出一个我们并不知道的成因
 * （比如把新出的第三格说成「扩展没加载」，把用户支去装一个装了也没用的东西）；
 * 而 `null` 说的是「服务端没说」—— 这句在任何情况下都成立。
 *
 * 认哪几格由 {@link SEMANTIC_UNAVAILABLE_KEYS} 这张**总表**说了算，
 * 不在这里另抄一份常量：抄一份就会有一天两边不一样。
 */
function semanticReasonOf(raw: unknown): SemanticUnavailableReason | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const kind: unknown = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return null;
  // `hasOwnProperty.call` 而不是 `in`：`'toString' in KEYS` 是真的。
  if (!Object.prototype.hasOwnProperty.call(SEMANTIC_UNAVAILABLE_KEYS, kind)) return null;
  // 只留 `kind`：线上多带的字段一律不进前端状态。
  return { kind: kind as SemanticUnavailableReason['kind'] };
}

/** 展示顺序。**不是"有哪几档"** —— 那个只有服务端知道。 */
export const MODE_ORDER: SearchMode[] = ['hybrid', 'keyword', 'semantic'];

/**
 * 把服务端的 `modes` 收成前端要用的形状。
 *
 * ⚠️ **响应里没有 `modes` 时按"只有关键词"处理**，而不是按"三档全有"。
 *
 * 这与 `noteAssets.isUsableAsset`「字段缺失 ≠ 不可用」那条规矩**方向相反，是刻意的**：
 * 那里宽松的默认让一个**真实存在**的能力不被藏起来；这里宽松的默认会把一个
 * **不存在**的能力摆出来给人点 —— 恰好就是这次要修的那个谎。
 * 判据不是"缺省该宽还是该严"，是**"哪个默认值会让界面说一句不成立的话"**。
 *
 * `keyword` 例外地默认为 true：FTS5 那条路是无条件实现的（`rest/search.ts` 只有它），
 * 把它也默认成 false 会让搜索页在一次网络抖动后变成一片空白。
 */
export function normalizeModes(raw: unknown): SearchModes {
  const m = (raw ?? {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  return {
    keyword: bool(m['keyword'], true),
    semantic: bool(m['semantic'], false),
    hybrid: bool(m['hybrid'], false),
    semanticReason: semanticReasonOf(m['semanticReason']),
    /*
     * ⚠️ 缺省取 `'simple'`（**不降级**），方向与 `semantic` 那几个相反 —— 刻意的：
     * 这里"宽松"的后果是**少说一句降级**，而"严格"（默认 trigram）的后果是
     * **对一台好机器凭空说它搜不到中文**。判据仍是那句：
     * **哪个默认值会让界面说一句不成立的话。**
     */
    tokenizer: m['tokenizer'] === 'trigram' ? 'trigram' : 'simple',
  };
}

/** 服务端说可用的那几档，按展示顺序排。 */
export function availableModes(modes: SearchModes | undefined): SearchMode[] {
  if (!modes) return ['keyword'];
  return MODE_ORDER.filter((m) => modes[m]);
}

/**
 * 真正要发给服务端的那一档。
 *
 * URL 里写着一个服务端提供不了的档（收藏夹、旧链接、手改地址栏）时**落回第一个可用档**，
 * 而不是把它原样发出去 —— 原样发的后果就是这次要修的那个谎：
 * 请求里写着 `mode=semantic`、服务端根本不读它、回来的是关键词结果，
 * 而界面还高亮着「语义」那个 tab。
 */
export function effectiveMode(
  requested: string | null,
  modes: SearchModes | undefined,
): SearchMode {
  const avail = availableModes(modes);
  if (requested && (avail as string[]).includes(requested)) return requested as SearchMode;
  return avail[0] ?? 'keyword';
}

/** 展示顺序里**缺**的那几档（要如实说出来的那些）。 */
export function missingModes(modes: SearchModes | undefined): SearchMode[] {
  const avail = availableModes(modes);
  return MODE_ORDER.filter((m) => !avail.includes(m));
}
