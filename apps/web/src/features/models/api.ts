/**
 * 模型域的 Query / Mutation hooks（T-022 独占）。
 *
 * 全部 endpoint 与类型来自 `@openmemo/shared`（我在 T-013 里定义的 27 个 endpoint），
 * query key 一律取 `app/query.ts` 的 `qk` 工厂，不在本文件拼字符串数组。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActivateRequest,
  ActivateResponse,
  GcRequest,
  GcResponse,
  GetCatalogResponse,
  GetInstalledResponse,
  GetJobsResponse,
  GetSourcesResponse,
  GetStorageResponse,
  ModelRole,
  PullRequest,
  PullResponse,
} from '@openmemo/shared';

import { api } from '../../lib/api/client';
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

export function useModelsInstalledQuery() {
  return useQuery({
    queryKey: qk.models.installed,
    queryFn: () => api<GetInstalledResponse>('/models/installed'),
  });
}

export function useModelsStorageQuery() {
  return useQuery({
    queryKey: qk.models.storage,
    queryFn: () => api<GetStorageResponse>('/models/storage'),
  });
}

export function useModelsSourcesQuery() {
  return useQuery({
    queryKey: qk.models.sources,
    queryFn: () => api<GetSourcesResponse>('/models/sources'),
  });
}

/** 下载任务快照。★ 挂载时必须先拉这个再订阅 SSE，否则会漏掉订阅前发生的事件。 */
export function useJobsQuery() {
  return useQuery({
    queryKey: qk.jobs.all,
    queryFn: () => api<GetJobsResponse>('/jobs'),
  });
}

/**
 * 触发下载。
 *
 * 返回 202 + jobId，**不返回结果** —— 进度走全局单条 SSE（D-01 §3.2 规则 2）。
 * 因此 `onSuccess` 只把新 job 塞进缓存，不做乐观业务更新。
 * `idempotencyKey` 防用户狂点：服务端对同一 target 已有活跃 job 时会返回既有 job
 * （`deduplicated: true`），不会重复下载几 GB。
 */
export function useModelPullMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: PullRequest) =>
      api<PullResponse>('/models/pull', {
        method: 'POST',
        body: req,
        idempotencyKey: `pull:${req.id}`,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
    },
  });
}

export function useModelDeleteMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.models.installed });
      void qc.invalidateQueries({ queryKey: qk.models.storage });
      void qc.invalidateQueries({ queryKey: qk.models.catalog });
    },
  });
}

export function useModelActivateMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ActivateRequest) =>
      api<ActivateResponse>('/models/activate', { method: 'POST', body: req }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.models.installed });
    },
  });
}

export function useModelVerifyMutation() {
  return useMutation({
    mutationFn: (id: string) => api<PullResponse>('/models/verify', { method: 'POST', body: { id } }),
  });
}

export function useGcMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: GcRequest) => api<GcResponse>('/models/gc', { method: 'POST', body: req }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.models.storage });
    },
  });
}

export function useSourceProbeMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ jobId: string }>('/models/sources/probe', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.models.sources });
    },
  });
}

export function useJobCancelMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      api<void>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
    },
  });
}

export function useJobRetryMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      api<PullResponse>(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
    },
  });
}

/**
 * 跑基准 —— ADR-004 决策 3 的落地入口。
 *
 * 模型详情页的"准确率/速度"初始为空；用户点这个按钮，服务端用内嵌测试音频在**本机**实测，
 * 把真实 RTF 写回 `benchmark` 字段。**绝不填论文 WER 数字。**
 */
export function useModelBenchmarkMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<PullResponse>('/models/benchmark', { method: 'POST', body: { id } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.models.installed });
    },
  });
}
