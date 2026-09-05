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
 * 都可以依赖。
 *
 * ## ★ 订正：降到 `lib/` 是对的，**在这里又抄一份 `useQuery` 是错的**
 *
 * 这个文件此前自己写了一条 `useQuery`：`queryKey` 与 `useModelsCatalogQuery('all')`
 * **逐字相同**（`[...qk.models.catalog, 'all', '']`）、URL 也相同
 * （`/models/catalog?role=all`），只有 `staleTime` 一个写字面量 `60_000`、
 * 一个写 `STALE_TIME_OVERRIDES.catalog`（今天恰好也是 60_000）。
 *
 * 同一个 key 上挂着两份 `queryFn`，**react-query 只执行先挂载的那一个** ——
 * 于是"这次请求实际长什么样"取决于组件挂载顺序。今天两份等价所以没有症状，
 * 而没有症状正是这一族债最难被清掉的原因。
 * （有症状的那个版本是 `qk.models.installed` 的三份，见 `lib/api/models.ts` 文件头。）
 *
 * 现在**查询本体在 `lib/api/models.ts`（唯一一份）**，这里只负责"从目录里查名字"。
 * 上面那句"先例已经有一个：`AsrModelPicker` 自己持有一条 `qk.models.installed` 查询"
 * 也一并作废 —— 那正是被这次收敛清掉的东西，别再照着它抄。
 *
 * ⚠️ 这里**不带 `lang` 参数**，与 `ModelDetailPage.tsx:32` 一致 ——
 * 两份名字本来就都在响应里，语言是**读的时候**才决定的，
 * 不该再让它进 cache key、把同一份数据劈成两份。
 */

import { useModelsCatalogQuery } from '../api/models';
import type { CatalogLookup, LocalizableEntry } from '../format/jobName';

/**
 * 返回一个查表函数。
 *
 * ⚠️ **目录没加载好时返回的是"什么都查不到"的查表，而不是抛错或空名字** ——
 * 首帧必然处在这个状态，调用方（`jobDisplayName`）会因此走 daemon 兜底名。
 */
export function useModelCatalogNames(): CatalogLookup {
  const { data } = useModelsCatalogQuery('all');

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
