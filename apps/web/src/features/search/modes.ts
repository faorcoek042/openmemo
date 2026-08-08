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

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

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
  /** 为什么没有语义路（服务端给的原话，不由前端编）。 */
  semanticReason: string | null;
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
    semanticReason: typeof m['semanticReason'] === 'string' ? m['semanticReason'] : null,
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
