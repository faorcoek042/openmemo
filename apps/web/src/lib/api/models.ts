/**
 * 模型域的**读**查询 —— 每个端点**唯一的一份定义**。
 *
 * ## ★ 为什么它在 `lib/` 而不在 `features/models/`
 *
 * 与 `lib/api/jobs.ts` / `lib/api/hardware.ts` 完全同一条理由（那两份的文件头写了全）：
 * 消费方跨了层。`components/common/AsrModelPicker.tsx` 要读 `/models/installed`，
 * 而 `eslint.config.js` 的分层护栏禁止 `components/` 与 `lib/` 依赖 `features/`。
 * 正解是**把查询降到 `lib/`**，由 `features/models/api.ts` 再导出 —— 不是各写一份。
 *
 * ## 各写一份的具体代价（这次修的就是它）
 *
 * `qk.models.installed` 这一个 key 上曾经挂着**三个 `useQuery`，两种 `queryFn`**：
 *
 * | 位置 | queryFn | 落到哪个 surface |
 * | --- | --- | --- |
 * | `features/models/api.ts` | `api('/models/installed')`（裸形式） | `'generic'` |
 * | `AsrModelPicker.tsx` ×2 | `api('models', '/models/installed')` | `'models'` |
 *
 * react-query 按 key 去重，**只有第一个挂载的观察者的 `queryFn` 会真的执行**。
 * 于是"这次请求把哪个面标成 live/mock"取决于**组件挂载顺序** ——
 * 同一个页面，先开模型页还是先开录音页，顶栏「已接通 N / 模拟 M」就不一样，
 * 而 `<MockNotice surface="models">` 该不该出现也跟着飘。
 * 这类 bug 没有报错、复现要靠特定的点击顺序，是最贵的那一类。
 *
 * ⚠️ 由 `lib/api/queryAndSurface.test.ts` 钉住：一个 `queryKey` 只许有一份 `queryFn`。
 */

import { useQuery } from '@tanstack/react-query';
import type {
  GetCatalogResponse,
  GetInstalledResponse,
  GetStorageResponse,
  ModelRole,
} from '@openmemo/shared';

import { api } from './client';
import { qk, STALE_TIME_OVERRIDES } from '../../app/query';

/**
 * @param lang 用户打算转写的语言。服务端据此把"实测在该语言下不可用"的模型
 *             标为 `notRecommendedForLanguage`（ADR-011 决策 1）。
 */
export function useModelsCatalogQuery(role: ModelRole | 'all' = 'all', lang?: string) {
  return useQuery({
    queryKey: [...qk.models.catalog, role, lang ?? ''],
    queryFn: () =>
      api<GetCatalogResponse>(
        `/models/catalog?role=${role}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`,
      ),
    // 目录带 ETag 缓存，放宽 staleTime（app/query.ts 的约定）
    staleTime: STALE_TIME_OVERRIDES.catalog,
  });
}

/**
 * 已安装的模型 + 各 role 当前激活的那一个。
 *
 * @param enabled 关掉时不发请求（折叠面板里的调用方，见 `useActiveAsrModel`）。
 *
 * ⚠️ **不设 `staleTime`**，用 `app/query.ts` 的全局默认 0：
 * 「本地 daemon，请求几乎零成本 —— 宁可多拉一次也不显示旧数据」。
 * 收敛前 `useActiveAsrModel` 私自设了 30s，而同 key 的另外两个观察者是 0 ——
 * 同一份缓存上两种新鲜度口径，"挂载时会不会重拉"同样取决于谁先挂载。
 */
export function useModelsInstalledQuery(enabled = true) {
  return useQuery({
    queryKey: qk.models.installed,
    enabled,
    queryFn: () => api<GetInstalledResponse>('models', '/models/installed'),
  });
}

/**
 * 模型占了多少盘、数据目录在哪一块盘上。
 *
 * ★ 这一条**不在原始缺陷清单里，是新加的守卫扫出来的第二例**：
 * `features/models/api.ts` 写的是裸 `api('/models/storage')`（⇒ `'generic'`），
 * `features/settings/DataLocationSection.tsx` 写的是 `api('models', …)` + `staleTime: 30_000`，
 * 两者共用 `qk.models.storage`。与 `qk.models.installed` **逐字同型**：
 * 谁先挂载谁的 `queryFn` 生效 ⇒ 哪个面被标记、多久算过期，都取决于用户先开哪一页。
 *
 * `staleTime` 统一回全局默认 0（理由同上面 `useModelsInstalledQuery`）。
 */
export function useModelsStorageQuery() {
  return useQuery({
    queryKey: qk.models.storage,
    queryFn: () => api<GetStorageResponse>('models', '/models/storage'),
  });
}
