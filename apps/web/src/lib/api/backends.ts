/**
 * 后端包目录 —— **唯一的一份定义**。
 *
 * 与 `lib/api/models.ts` 同一条理由：消费方跨层。`lib/catalog/useJobCatalogNames.ts`
 * （给 `components/common/JobToaster.tsx` 用）与 `features/runtime` 都要读
 * `/backends/catalog`，而分层护栏禁止 `lib/` 依赖 `features/`。
 *
 * 收敛前这两处各写了一份 `useQuery`：`queryKey` 同是 `qk.backends.catalog`、
 * `queryFn` 逐字相同、只有 `staleTime` 一个写字面量 `60_000`、一个写
 * `STALE_TIME_OVERRIDES.catalog`（今天恰好也是 60_000）。
 *
 * **"今天恰好相等"正是这一族债的标准形态** —— 它此刻没有任何症状，
 * 所以没人会去动它；等到有人调整 `STALE_TIME_OVERRIDES.catalog` 的那天，
 * 两份实现开始分叉，而分叉的表现是"同一份目录在两个页面上新鲜度不一样"，
 * 没有任何一处会报错。`qk.models.installed` 那三份（见 `lib/api/models.ts`）
 * 就是同一个坑发展到有症状的样子。
 */

import { useQuery } from '@tanstack/react-query';
import type { GetBackendCatalogResponse } from '@openmemo/shared';

import { api } from './client';
import { qk, STALE_TIME_OVERRIDES } from '../../app/query';

export function useBackendsCatalogQuery() {
  return useQuery({
    queryKey: qk.backends.catalog,
    queryFn: () => api<GetBackendCatalogResponse>('backends', '/backends/catalog'),
    staleTime: STALE_TIME_OVERRIDES.catalog,
  });
}
