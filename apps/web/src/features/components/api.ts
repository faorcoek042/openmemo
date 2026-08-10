/**
 * 组件域的 Query / Mutation hooks（T-068，model-mgmt 独占）。
 *
 * 端点契约见 `packages/shared/src/components.ts`；数据层实现见
 * `packages/downloader/src/components.ts`（`listComponents`）。
 *
 * ⚠️ **这里原来还有一个 `useRollbackComponentMutation`，T-157 ② 删掉了**，
 * 而它对面的 `POST /api/components/:id/rollback` 与整条回滚管道现在也删干净了 ——
 * 那条路从来没有通过一次。决定与理由（含将来真要做得先补哪一环）：
 * `docs/adr/ADR-017-component-rollback-removed.md`。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CheckUpdatesRequest,
  GetComponentsResponse,
  UpdateComponentRequest,
} from '@openmemo/shared';

import { api } from '../../lib/api/client';
import { qk, STALE_TIME_OVERRIDES } from '../../app/query';

/**
 * 组件清单。
 *
 * `check=false` 时**完全不查上游** —— 纯本地数据，断网也能看清单、看来源、装组件。
 * 版本检测是锦上添花，绝不能成为前置条件。
 */
export function useComponentsQuery(check = false) {
  return useQuery({
    queryKey: [...qk.components.all, check],
    queryFn: () => api<GetComponentsResponse>(`/components${check ? '?check=true' : ''}`),
    staleTime: check ? 60_000 : STALE_TIME_OVERRIDES.catalog,
  });
}

/** 主动查一次上游。查不到只是"未知"，不当错误抛给用户。 */
export function useCheckUpdatesMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CheckUpdatesRequest = {}) =>
      api<GetComponentsResponse>('/components/check', { method: 'POST', body: req }),
    onSuccess: (data) => {
      // 直接写回缓存：响应已是完整清单，再拉一次纯属浪费
      qc.setQueryData([...qk.components.all, true], data);
      qc.setQueryData([...qk.components.all, false], data);
    },
  });
}

/**
 * 组件动作的真实路径 —— **id 在路径里，不在 body 里**。
 *
 * daemon 的路由是 `POST /api/components/:id/update`
 * （`http/rest/components.ts` 的 `/^\/api\/components\/([^/]+)\/update$/`）。
 * 这里原来发的是 `POST /api/components/update` + `{ id }` ——
 * **少一段路径，正则不匹配，handler 返回 false，主路由 404**（T-132 查出）。
 * 又一次「测我发了什么，没测对面会读什么」：清单能拉出来、卡片渲染正常、
 * 只有真按下按钮才会失败，而没人按过。
 *
 * 拼进路径的 id 必须 encode：目录里已经有 `asr/whisper-large-v3-turbo-q5_0`
 * 这种带斜杠的 id，不 encode 会被切成两段而永远 404。
 * （daemon 侧对应地做 `decodePathSegment`。）
 */
function componentActionPath(id: string, action: 'update'): string {
  return `/components/${encodeURIComponent(id)}/${action}`;
}

/**
 * 安装或更新单个组件。
 *
 * 走**同一个下载器**（校验/续传/去重/重试/回滚全复用），不是另写一条更新路径 ——
 * 另写一条就意味着那条路径会漏掉这些保证。
 * 「安装」与「更新」是**同一个端点**：daemon 侧两者都等于"装清单里钉死的那个版本"，
 * 分成两条路只会多出一条没人测的分支。
 */
export function useUpdateComponentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateComponentRequest) =>
      api<{ ok: true; id: string; toVersion: string; jobId: string; deduplicated: boolean }>(
        componentActionPath(req.id, 'update'),
        {
          method: 'POST',
          body: req,
          idempotencyKey: `component-update:${req.id}:${req.toVersion ?? 'latest'}`,
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
      void qc.invalidateQueries({ queryKey: qk.components.all });
    },
  });
}
