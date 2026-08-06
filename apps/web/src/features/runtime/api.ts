/**
 * 运行时域的 Query / Mutation hooks（T-022 独占）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Backend,
  GetBackendCatalogResponse,
  GetInstalledBackendsResponse,
  PullResponse,
} from '@openmemo/shared';

import { api } from '../../lib/api/client';
import { qk, STALE_TIME_OVERRIDES } from '../../app/query';

/**
 * 硬件探测结果。
 *
 * ★ T-153 **实现已提升到 `lib/api/hardware.ts`**，这里只是再导出。
 * 原因：`features/models` 也要用它（`ModelCard` 判断该不该给 CoreML encoder 的选项），
 * 而分层护栏禁止 `features/A` import `features/B`（D-05 §3.5）。
 * **再导出而不是复制**：两处共用同一个 `queryKey`，硬件不会被多探一次
 * （R-02 实测 `system_profiler` 可达数秒级，探测要起独立子进程真正枚举设备）。
 */
export { useHardwareQuery } from '../../lib/api/hardware';

export function useBackendsCatalogQuery() {
  return useQuery({
    queryKey: qk.backends.catalog,
    queryFn: () => api<GetBackendCatalogResponse>('/backends/catalog'),
    staleTime: STALE_TIME_OVERRIDES.catalog,
  });
}

export function useBackendsInstalledQuery() {
  return useQuery({
    queryKey: qk.backends.installed,
    queryFn: () => api<GetInstalledBackendsResponse>('/backends/installed'),
  });
}

/** 安装后端包 → 202 + jobId，进度走同一条全局 SSE（与模型下载共用下载器）。 */
export function useBackendInstallMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<PullResponse>('/backends/install', {
        method: 'POST',
        body: { id },
        idempotencyKey: `backend:${id}`,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
    },
  });
}

export function useBackendRemoveMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/backends/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.backends.installed });
      void qc.invalidateQueries({ queryKey: qk.backends.catalog });
    },
  });
}

/** 切换当前生效的加速后端。 */
export function useBackendSelectMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (backend: Backend) =>
      api<{ selectedBackend: Backend }>('/backends/select', {
        method: 'POST',
        body: { backend },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.backends.installed });
      void qc.invalidateQueries({ queryKey: qk.runtime.hardware });
      // 硬件/后端一变，**所有 fit 判定都失效** —— 必须重拉模型目录，
      // 不能只刷新硬件面板（shared/events.ts 的 hardware.changed 注释明确要求）。
      void qc.invalidateQueries({ queryKey: qk.models.catalog });
    },
  });
}

/**
 * 触发后端自检。
 *
 * ADR-003 决策 3：自检必须跑**真实推理**（内嵌测试音频），不是"文件存在"检查 ——
 * R-02 在本机实测到 `libvulkan.so.1` 存在但根本没有 GPU。loader ≠ ICD ≠ 硬件。
 */
export function useBackendSelfTestMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<PullResponse>('/backends/selftest', { method: 'POST', body: { id } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.backends.installed });
    },
  });
}
