import { useQuery } from '@tanstack/react-query';

import { validateSearchResponse, type SearchHit as SearchHitContract } from '@openmemo/shared';

import { normalizeModes, type SearchMode } from './modes';
import { api } from '../../lib/api/client';
import { qk } from '../../app/query';

export type { SearchMode, SearchModes } from './modes';

/**
 * 一条搜索命中 —— **就是 daemon 那一份**（`@openmemo/shared` 的 `SearchHit`），
 * 照 `lib/api/types.ts` 的 T-150 别名法。
 *
 * ─── ⚠️ 这里原来不是「弱化的手抄件」，是一份**已经在说假话**的声明 ────────────
 *
 * | 手抄件写的 | daemon 实际发的（`rest/search.ts` + `SearchHitSchema`） | 后果 |
 * |---|---|---|
 * | `kind: 'segment' \| 'note' \| 'mindmap_node'` | **`source: 'segment' \| 'note'`** | **字段名就不一样** —— 按类型读 `hit.kind` 恒得 `undefined` |
 * | （没有这三格） | `transcriptUid` / `seq` / `endMs` | daemon 一直在发，类型上却不存在 |
 * | `noteUid: string` | `noteUid: NoteUid` | 弱化（这是三条里最轻的一条） |
 *
 * 它没崩，是因为**全仓没有任何一处读 `hit.kind`** —— `SearchPage.tsx` 只读
 * `noteUid` / `noteTitle` / `startMs` / `snippet` 四个。**和 `<audio>` 从未进过 DOM
 * 是同一族缺陷**：字段声明了、永远拿不到值、而且没有人发现。
 * 正因如此，换成契约那份是**零调用点改动**。
 *
 * ⚠️ `mindmap_node` 那一档**没有顺手删** —— 它被捞进了契约的 `SEARCH_SOURCES`，
 * 并在那里注明「服务端今天不发」。理由（`mindmap_nodes_fts` 建好了、
 * `mindmap_nodes` 今天只写不读 ⇒ **建了一半没接线，不是不打算做**）写在那份声明上。
 */
export type SearchHit = SearchHitContract;

/**
 * 搜索结果 + **服务端如实报的档位可用性**。
 *
 * ⚠️ 这里原来是 `select: (d) => d.hits` —— 把响应里的 `modes` / `semanticReason`
 * **整个丢掉**（T-164 ⑤）。服务端一直在如实告知
 * `{semantic:false, hybrid:false, semanticReason:"…尚无 embedding 生成环节（链路未接通）"}`，
 * 而前端把它扔了，然后用一个写死的常量恒渲染三个 tab。
 * **裁决"v1 不做向量"没问题；问题是现状在骗人。**
 */
/**
 * ★ T-200 A-2：把 `validateSearchResponse()` **接上唯一一个真实调用点**。
 *
 * 那个校验器从落地起**全仓没有任何调用者** —— 它把键名声明对了（`tokenizer`），
 * 而 daemon 一直发的是 `chineseTokenizer`。**本该由它当场拦下的分叉，
 * 因为没人跑它，安静地活了下来。**
 * 一个从没被跑过的校验器比没有更糟：它让读代码的人以为这里有守卫。
 *
 * ⚠️ 只在 DEV 出声、**只 warn 不抛**：
 *   · 抛 = 一次字段漂移把整个搜索页打成白屏，比漏报更糟；
 *   · 生产沉默 = 老 daemon（字段还没跟上）不该把用户界面搞坏。
 * 判据是「**开发时当场知道**」，不是「运行时更严格」。
 */
function assertModesMatchContract(resp: unknown): void {
  if (!import.meta.env.DEV) return;
  const v = validateSearchResponse(resp);
  if (!v.ok) {
    console.warn(`[search] 响应与契约不符（SearchResponse）：${v.errors.slice(0, 5).join('; ')}`);
  }
}

export function useSearchQuery(q: string, mode: SearchMode) {
  return useQuery({
    queryKey: qk.search(q, mode),
    queryFn: () =>
      api<{ hits: SearchHit[]; modes?: unknown }>(
        'notes',
        `/search?q=${encodeURIComponent(q)}&mode=${mode}`,
      ),
    enabled: q.trim().length > 0,
    select: (d) => {
      assertModesMatchContract(d);
      return { hits: d.hits, modes: normalizeModes(d.modes) };
    },
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
