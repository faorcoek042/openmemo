import { useQuery } from '@tanstack/react-query';

import { normalizeModes, type SearchMode } from './modes';
import { api } from '../../lib/api/client';
import { qk } from '../../app/query';

export type { SearchMode, SearchModes } from './modes';

export interface SearchHit {
  noteUid: string;
  noteTitle: string;
  /** 命中的转写段（有则可直达时间点），无则是笔记正文命中 */
  startMs: number | null;
  /** 已带 <mark> 高亮的片段（由服务端的 simple_highlight 产出） */
  snippet: string;
  score: number;
  kind: 'segment' | 'note' | 'mindmap_node';
}

/**
 * 搜索结果 + **服务端如实报的档位可用性**。
 *
 * ⚠️ 这里原来是 `select: (d) => d.hits` —— 把响应里的 `modes` / `semanticReason`
 * **整个丢掉**（T-164 ⑤）。服务端一直在如实告知
 * `{semantic:false, hybrid:false, semanticReason:"…尚无 embedding 生成环节（链路未接通）"}`，
 * 而前端把它扔了，然后用一个写死的常量恒渲染三个 tab。
 * **裁决"v1 不做向量"没问题；问题是现状在骗人。**
 */
export function useSearchQuery(q: string, mode: SearchMode) {
  return useQuery({
    queryKey: qk.search(q, mode),
    queryFn: () =>
      api<{ hits: SearchHit[]; modes?: unknown }>(
        'notes',
        `/search?q=${encodeURIComponent(q)}&mode=${mode}`,
      ),
    enabled: q.trim().length > 0,
    select: (d) => ({ hits: d.hits, modes: normalizeModes(d.modes) }),
  });
}

/**
 * 检索能力探测：**不带查询串也要问一次**。
 *
 * 为什么需要它：可选的档位得在用户**打字之前**就定下来，否则空查询时
 * 三个 tab 又会全部摆出来，等用户点完一个再让它消失 —— 比一直不显示更糟。
 * 服务端对空 `q` 会直接回 `{hits: [], modes: …}`（`toFtsQuery` 返回 undefined 的那一支），
 * 所以这是一次真实且极廉价的探测，不是为了测试造的旁路。
 */
export function useSearchModesQuery() {
  return useQuery({
    queryKey: qk.search('', 'modes-probe'),
    queryFn: () => api<{ modes?: unknown }>('notes', '/search?q='),
    select: (d) => normalizeModes(d.modes),
    staleTime: 5 * 60_000,
  });
}
