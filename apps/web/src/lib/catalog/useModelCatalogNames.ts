/**
 * 「模型 slug → 两份显示名」的查表，给 {@link jobDisplayName} 用。
 *
 * ## 为什么这个 hook 住在 `lib/` 而不是 `features/models/`
 *
 * 消费方之一是 `components/common/JobToaster.tsx`。eslint（D-05 §3.5,
 * `eslint.config.js:82-99`）禁止 `lib/` 与 `components/` 依赖 `features/`，
 * 所以它**不能**去 import `features/models/api` 里那个 `useModelsCatalogQuery`。
 * 上一个人正是卡在这里没动手。
 *
 * 解法不是开豁免，而是**把"读目录"这件事降到 `lib/`** ——
 * 它只依赖 `app/query` 的 key 与 `lib/api/client`，两者 `components/` 与 `features/`
 * 都可以依赖。**先例已经有一个**：`components/common/AsrModelPicker.tsx:81-91`
 * 就是这样自己持有一条 `qk.models.installed` 查询的。
 *
 * ⚠️ **query key 与 `features/models` 用的是同一个 `qk.models.catalog` 前缀**，
 * 所以两边共享 react-query 的缓存与失效（`features/models/sse.ts`、
 * `features/runtime/sse.ts` 里的 invalidate 会同时刷到这里）。
 * 这里**不带 `lang` 参数**，与 `ModelDetailPage.tsx:32` 一致 ——
 * 两份名字本来就都在响应里，语言是**读的时候**才决定的（这正是本轮修的那件事），
 * 不该再让它进 cache key、把同一份数据劈成两份。
 */

import { useQuery } from '@tanstack/react-query';
import type { GetCatalogResponse } from '@openmemo/shared';

import { qk } from '../../app/query';
import { api } from '../api/client';
import type { CatalogLookup, LocalizableEntry } from '../format/jobName';

/**
 * 返回一个查表函数。
 *
 * ⚠️ **目录没加载好时返回的是"什么都查不到"的查表，而不是抛错或空名字** ——
 * 首帧必然处在这个状态，调用方（`jobDisplayName`）会因此走 daemon 兜底名。
 */
export function useModelCatalogNames(): CatalogLookup {
  const { data } = useQuery({
    queryKey: [...qk.models.catalog, 'all', ''] as const,
    queryFn: () => api<GetCatalogResponse>('/models/catalog?role=all'),
    // 目录带 ETag 缓存（app/query.ts 的约定），这里只是读名字，放宽一点没关系
    staleTime: 60_000,
  });

  return (targetId: string): LocalizableEntry | null => {
    const groups = data?.groups;
    if (!groups) return null;
    for (const g of groups) {
      /*
       * 先找 variant：job 的 `targetId` 是**变体**的 id
       * （daemon `models.ts:415` `targetId: model.id`，而 `model` 来自
       * `groups[].variants[]`）。组 id 只是兜底，免得目录形状变了就整条失灵。
       */
      const v = g.variants?.find((x) => x.id === targetId);
      if (v) return v;
      if (g.groupId === targetId) return g;
    }
    return null;
  };
}
