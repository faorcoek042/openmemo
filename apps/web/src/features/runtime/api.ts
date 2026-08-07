/**
 * 运行时域的 Query / Mutation hooks（T-022 独占）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Backend,
  GetBackendCatalogResponse,
  GetBreakerResponse,
  GetHardwareResponse,
  GetInstalledBackendsResponse,
  PullResponse,
} from '@openmemo/shared';
import { breakerTripped } from '@openmemo/shared';

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

/**
 * 断路器的**实时**状态（T-174）。
 *
 * ## 为什么不直接用 `useHardwareQuery()` 里的 `runtime.breaker`
 *
 * 那个字段确实也在（T-174 已把它接回契约），但 `/api/runtime/hardware` 在 daemon 侧
 * **带进程内缓存** —— 探测要 spawn 子进程，不可能每个请求跑一遍。于是它的
 * `retryAt` / `recovering` 是**拍快照那一刻**的值。拿它做倒计时会一路数到负数，
 * 然后永远停在"冷却已到期"上，而后台那一发恢复探测跑完了界面也不会知道。
 * **一个一直在说谎的倒计时比不显示更糟。**
 *
 * `/api/runtime/breaker` 每次都读 daemon 进程内的实时 state，且按 T-173 的设计
 * **不跑探测、不起恢复、不改任何状态**（它以前会 `await detect(false)`，那时"看一眼
 * 就会改变被观测对象"）。正因为它是纯的，才可以放心轮询。
 *
 * ## 轮询节奏
 *
 * **只在跳闸时轮询**（10 s）。没跳闸时 `refetchInterval: false` —— 绝大多数机器上
 * 断路器一辈子不会跳，不该为一个恒定为 closed 的东西每 10 秒打一次 daemon。
 */
export function useBreakerQuery() {
  return useQuery({
    queryKey: qk.runtime.breaker,
    queryFn: () => api<GetBreakerResponse>('/runtime/breaker'),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d === undefined) return false;
      return breakerTripped(d.verdict, d.blacklistedBackends) ? 10_000 : false;
    },
  });
}

/**
 * 「立刻重试」—— 用户显式要求断路器重新自证（T-174）。
 *
 * `GET /api/runtime/hardware?reset=1` 此前**零调用方**：接口写好了、按钮从来没有过，
 * 而自检里那句 remediation 让用户自己去敲 URL。这里就是那个按钮。
 *
 * ## ★ 这一发是**同步**的，别把它当成那个 90 秒的后台恢复
 *
 * 两条路径容易混：
 *   - **冷却到期的自动重试**：daemon 在后台放一发，预算 `PROBE_RECOVERY_TIMEOUT_MS`（90 s），
 *     当次请求立刻返回、`recovering: true`。界面上是"正在重试"。
 *   - **本 mutation**：`resetBreaker()` 清掉裁决 ⇒ 裁决变回 `closed` ⇒
 *     `detect(true)` **就地跑一发探测**，用的是交互预算 `PROBE_TIMEOUT_MS`（10 s）。
 *     也就是说**这个请求本身会挂最长约 10 秒**，回来时带的是全新的探测结果。
 *
 * 所以按钮按下去之后必须有可见反馈：那十秒里界面什么都不变的话，用户会连点，
 * 而连点正是 daemon 侧单飞机制要防的东西。反馈在 `BreakerNotice` 里（按钮禁用 + 计秒）。
 *
 * `onSuccess` 直接把响应写回硬件缓存：这一发返回的就是**完整的**
 * `GetHardwareResponse`（含新的 `runtime`），再发一次请求去拿同样的东西是浪费，
 * 而且会让卡片有一瞬间显示旧值。
 */
export function useBreakerResetMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<GetHardwareResponse>('/runtime/hardware?reset=1'),
    onSuccess: (data) => {
      qc.setQueryData(qk.runtime.hardware, data);
      // 断路器那份是独立端点，必须重新拉 —— 上面那行只更新了硬件那份
      void qc.invalidateQueries({ queryKey: qk.runtime.breaker });
      // 后端可用性变了 ⇒ 所有 fit 判定失效（与 useBackendSelectMutation 同一条理由）
      void qc.invalidateQueries({ queryKey: qk.models.catalog });
    },
  });
}

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
