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
 * ## 轮询节奏（三档）
 *
 * | 状态 | 间隔 | 为什么 |
 * |---|---|---|
 * | 没跳闸 | **不轮询** | 绝大多数机器上断路器一辈子不跳，不该为一个恒为 closed 的东西每 10 s 打一次 daemon |
 * | 跳闸、没在重试 | 10 s | 只需要察觉"冷却到期了/自动恢复了"，不需要更密 |
 * | **正在重试** | **2 s** | 那一发最长 90 s，界面要显示"已等多久"并在它结束时立刻反应；这一档才是用户盯着看的 |
 */
export function useBreakerQuery() {
  return useQuery({
    queryKey: qk.runtime.breaker,
    queryFn: () => api<GetBreakerResponse>('/runtime/breaker'),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d === undefined) return false;
      if (d.recovering) return 2_000;
      return breakerTripped(d.verdict, d.blacklistedBackends) ? 10_000 : false;
    },
  });
}

/**
 * 「立刻重试」—— 用户显式要求断路器重新自证（T-174；语义在 T-175 改过）。
 *
 * `GET /api/runtime/hardware?reset=1` 此前**零调用方**：接口写好了、按钮从来没有过，
 * 而自检里那句 remediation 让用户自己去敲 URL。这里就是那个按钮。
 *
 * ## ★ T-175：这一发**不再是同步的**
 *
 * 改之前：daemon 清掉裁决 ⇒ 裁决变 `closed` ⇒ **就地跑一发探测，交互预算 10 s**。
 * 而冷 Mac 上 Metal 首次初始化要 12–21 s（T-172 实测）⇒
 * **用户手点的那一发几乎必然超时，反而是后台自动那发（90 s）能成** ——
 * 按钮点了跟没点一样，只是多记一次失败。
 *
 * 现在手点与冷却到期**走同一条路**：daemon 起（或**加入**）一发后台恢复探测，
 * 预算 `PROBE_RECOVERY_TIMEOUT_MS`（90 s），单飞，**本请求立刻返回**。
 *
 * ## 于是"可见反馈"的来源也变了 —— 这一条是关键
 *
 * 请求本身现在很快，`isPending` 只有一瞬 —— **拿它当进度条就什么都看不见了**。
 * 真正的进度来自 daemon：`recovering` + `recoveryStartedAt`（见 `useBreakerQuery`）。
 * 这样有三个好处，缺一不可：
 *   1. **切走再回来进度还在** —— 它记在服务端，不是组件里的一个 `useState`；
 *   2. **自动恢复与手点长得一样** —— 用户不需要知道这一发是谁起的；
 *   3. **单飞与手点自然共存** —— 已经在跑时按钮本来就是禁用的，
 *      真撞上并发也只是"加入等待"，daemon 不会起第二发。
 *
 * 不再 `setQueryData(hardware)`：响应里的 `runtime` 是 daemon 侧**缓存**的那份探测，
 * 恢复那一发还没跑完，写回去等于把一份马上就要过期的快照钉在缓存上。
 */
export function useBreakerResetMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<GetHardwareResponse>('/runtime/hardware?reset=1'),
    onSuccess: () => {
      // 立刻去拿 `recovering: true` —— 那才是界面要显示的东西
      void qc.invalidateQueries({ queryKey: qk.runtime.breaker });
    },
  });
}

/**
 * 恢复成功之后，把硬件**重新探测**一遍。
 *
 * ## 为什么非得带 `?refresh=1`
 *
 * daemon 侧 `GET /api/runtime/hardware` 有进程内缓存（探测要 spawn，不能每请求跑一遍），
 * 而恢复探测跑完只改断路器 state，**不会动那份缓存**。于是断路器恢复之后：
 * 提示块消失了（它读的是实时端点），而上面那排后端芯片**还是灰的** ——
 * 用户刚被告知"好了"，看到的却是"还是不可用"。
 *
 * 所以在 open → closed 那一刻**恰好**重探一次。这也是代价最低的时刻：
 * 恢复那一发刚把 shader 缓存捂热（T-172 实测 17606ms → 163ms），这一次会很快。
 */
export function useHardwareRefresh() {
  const qc = useQueryClient();
  return async (): Promise<void> => {
    const fresh = await api<GetHardwareResponse>('/runtime/hardware?refresh=1');
    qc.setQueryData(qk.runtime.hardware, fresh);
    // 后端可用性变了 ⇒ 所有 fit 判定失效（与 useBackendSelectMutation 同一条理由）
    void qc.invalidateQueries({ queryKey: qk.models.catalog });
  };
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
