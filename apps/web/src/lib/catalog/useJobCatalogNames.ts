/**
 * 两份目录的「slug → 两份显示名」查表，合起来给 {@link jobDisplayName} 用。
 *
 * ## ⚠️ 两份目录是**两个东西**，不许合成一份
 *
 * | job 类型 | 查哪份 | 端点 | 里面装的是 |
 * | --- | --- | --- | --- |
 * | `download.model` | `qk.models.catalog` | `/models/catalog` | 模型（按 group/variant 两层） |
 * | `download.backend` | `qk.backends.catalog` | `/backends/catalog` | 后端包（平铺一层 `packs[]`） |
 *
 * 形状不同、失效时机不同、连"一条记录长什么样"都不同。把它们并成一张表
 * 只会让下一个人以为世界上只有一份目录 —— 那正是本仓反复吃过亏的
 * 「同一份映射分裂/合并成不对的份数」那一族。
 *
 * ## 为什么住在 `lib/`
 *
 * 消费方之一是 `components/app-shell/JobToaster.tsx`，而 eslint（D-05 §3.5,
 * `eslint.config.js:82-99`）禁止 `lib/` 与 `components/` 依赖 `features/`，
 * 所以不能去 import `features/runtime/api` 里那份实现。
 * 与 `useModelCatalogNames` 同样的解法：把"读目录"降到 `lib/`，
 * query key 仍用 `app/query` 里那个**同一个** `qk.backends.catalog`，
 * 于是与 `features/runtime` 共享缓存与失效，不会多打一份数据。
 *
 * ★ 订正：降到 `lib/` 是对的，**在这里再抄一条 `useQuery` 是错的**。
 * 现在 `useBackendsCatalogQuery` 的实现就住在 `lib/api/backends.ts`（唯一一份），
 * `features/runtime/api.ts` 再导出它，本文件直接用它 —— 三方同一份定义。
 * 原来的两份只在 `staleTime` 的写法上不同、今天恰好等值，理由见那个文件的头部。
 */

import { useBackendsCatalogQuery } from '../api/backends';
import type { CatalogLookup, CatalogLookups, LocalizableEntry } from '../format/jobName';
import { useModelCatalogNames } from './useModelCatalogNames';

/**
 * 后端包目录的查表。
 *
 * ⚠️ 这一份**同时覆盖三个安装入口** —— `[数出来的]` `startPackInstall()` 的产品调用方
 * 一共 3 个：`backends.ts:464`（运行时页）、`models.ts:335`（`/api/models/pull`
 * 传 `kind: 'backend-pack'`）、**`components.ts:158`（组件页装 sqlite-ext / media-tool）**。
 * 三个都走同一个 `enqueue`，写的都是 `targetId: pack.id`；
 * 而组件页那条是先 `state.findCatalogPack(id)`（`state.ts:812-814`，读的正是
 * `backendCatalog.packs`）把组件 id 映射回后端包，**所以它的 `targetId`
 * 一定在这份目录里** —— 这一份查表把三个入口一起覆盖掉。
 */
function useBackendCatalogNames(): CatalogLookup {
  const { data } = useBackendsCatalogQuery();

  return (targetId: string): LocalizableEntry | null =>
    data?.packs?.find((p) => p.id === targetId) ?? null;
}

/**
 * 渲染点调这一个 hook 就够了：两份目录都在里面，按 job 类型分派。
 *
 * ⚠️ 两个 `useQuery` 都是**无条件调用**的（Rules of Hooks）。
 * 它们各自带 ETag 与 60s staleTime，且 key 与两个 feature 共用，
 * 所以"多挂一个渲染点"不等于"多打一次网络"。
 */
export function useJobCatalogNames(): CatalogLookups {
  const model = useModelCatalogNames();
  const backend = useBackendCatalogNames();
  return { 'download.model': model, 'download.backend': backend };
}
