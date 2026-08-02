import { useQuery } from '@tanstack/react-query';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

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

export function useSearchQuery(q: string, mode: SearchMode) {
  return useQuery({
    queryKey: qk.search(q, mode),
    queryFn: () =>
      api<{ hits: SearchHit[] }>(
        'notes',
        `/search?q=${encodeURIComponent(q)}&mode=${mode}`,
      ),
    enabled: q.trim().length > 0,
    select: (d) => d.hits,
  });
}
