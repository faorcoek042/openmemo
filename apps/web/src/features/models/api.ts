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
  GetSourcesResponse,
  GetStorageResponse,
  ModelRole,
  PullRequest,
  PullResponse,
  SelectSourceRequest,
  UninstallWithRefusalsResponse,
} from '@openmemo/shared';

import { api } from '../../lib/api/client';
import { qk, STALE_TIME_OVERRIDES } from '../../app/query';
import { notifyJobAttached } from '../../lib/jobs/attachedNotice';

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
/*
 * ★ T-195：实现搬到 `lib/api/jobs.ts`（唯一一份）。
 * 这里只再导出，调用点一个字不用改 —— 此前它与 `features/tasks/api.ts` 是同一件事的两份。
 */
export { useJobsQuery } from '../../lib/api/jobs';

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
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
      /*
       * ★ 服务端把这次请求**去重**到了一个已经在跑的 job 上（`toPullResponse` 的
       * `deduplicated`）。此时它**不会**发 `job.created`
       * （`downloader/queue.ts:111` 命中就 return，走不到 `:154` 的 emit），
       * 于是 Toast 层收不到任何东西 —— 用户点了「下载」，界面一个字都没有。
       * `[真机 2026-08-10]` 报成了"打开量化选择器就没有 Toast"，
       * 而实测三组对照证明弹出层无关：变量是"这个模型此刻正在下载"。
       *
       * 服务端拒绝重复建 job 是对的，不该改服务端；缺的是前端把**已经拿到的事实**用起来。
       */
      if (data.deduplicated) {
        notifyJobAttached({ jobId: data.jobId, targetId: data.targetId });
      }
    },
  });
}

/**
 * 卸载一个模型。
 *
 * ## 返回值有两档，**`void` 说不出第二档**（#109）
 *
 * · `undefined` —— 服务端回了 **204**：记录没了、文件也全删干净了，没什么可说的；
 * · 一个对象   —— 服务端回了 **200**：记录**照样没了**，但盘上留下了东西。
 *                 留下的原因有两格，**它们是两件事**（#113）：
 *                   · `filesNotRemoved`     我们**不肯**删（记录指向数据目录之外）；
 *                   · `filesFailedToRemove` 我们**试了、没删动**（`fs.rm` 抛了）。
 *                 ⚠️ 两格各自都可能是空数组 —— 只有**两格都空**才会走 204。
 *
 * `795f091` 把这个 200 写出来之后，这里仍然是 `api<void>` —— body 被整个丢掉，
 * 界面上一个字都没有。**一个只到 API 的字段就是「有人写没人读」。**
 * 两条路的区分由 `lib/api/client.ts` 替我们做完了（204 → `undefined`），
 * 所以调用方只需要问"拿到的是不是 undefined"。
 */
export function useModelDeleteMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<UninstallWithRefusalsResponse | undefined>(`/models/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
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
    mutationFn: (id: string) =>
      api<PullResponse>('/models/verify', { method: 'POST', body: { id } }),
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

/**
 * 立即测速。
 *
 * ⚠️ 响应体**就是一份新的 `GetSourcesResponse`**（`rest/models.ts` 的
 * `/api/models/sources/probe` 分支：`await state.probeMirrors(...)` 之后
 * `sendJson(res, 200, state.buildSources())`）。这里原来标的是 `{jobId}` ——
 * 一个 daemon 从来不发的形状。它能错这么久是因为**这个 hook 零调用方**：
 * 没人走的路上的坑不会有人掉进去（T-155 在 `useMoveNoteMutation` 上记过同一件事）。
 */
export function useSourceProbeMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<GetSourcesResponse>('/models/sources/probe', { method: 'POST' }),
    /*
     * 响应**就是**测完之后的完整快照，直接落缓存。
     *
     * ⚠️ 这里刻意**不再 `invalidateQueries`**：`setQueryData` 之后紧跟一次失效，
     * 等于用一次新的 GET 把刚拿到的结果盖掉 —— 中间那一帧用户能看见测速结果闪一下再消失。
     * （这是自己写的用例当场抓出来的：桩的 GET 返回"还没测过"，
     *   于是点完测速表格立刻空掉。真 daemon 上因为 `lastProbes` 有状态而看不出来，
     *   属于"只在 mock/测试里显形、但确实存在"的那一类。）
     * daemon 侧的 `sources.probed` SSE 仍会独立失效一次，快照不会长期陈旧。
     */
    onSuccess: (data) => {
      qc.setQueryData(qk.models.sources, data);
    },
  });
}

/**
 * 钉一个下载源（或改回 `auto`）。
 *
 * ★ T-157 ④：daemon 的三个端点全是真的，而前端**一个 select 的 hook 都没有** ——
 * 于是「所有下载源均失败」的时候用户没有任何自救入口。
 *
 * ⚠️ **它是"优先"，不是"只用"。** `orderSourcesForDownload` 把钉住的源排到最前，
 * 其余的仍然留在后面当回退（`probe.ts` 的注释写明了理由：探测是 5 秒快照，
 * 探测失败的源在真实传输里未必不通，全部丢掉会让用户一个源都不剩）。
 * 界面上必须照这个说，不能让用户以为自己关掉了别的源。
 *
 * ⚠️ **不提供 `custom`，而且现在 daemon 也不再收它了。**
 * 契约里曾有一个 `baseUrl`，daemon 会把它存进 prefs，而**全仓没有任何下载路径读过它**。
 * T-171（A-6）把那个字段连同"自定义源"这半个功能一起拆掉了：
 * `POST /api/models/sources/select` 收到 `provider:"custom"` 直接 400。
 * 所以这里不做输入框，不是"暂时没做"，是**后端明确拒绝**。
 */
export function useSelectSourceMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: SelectSourceRequest) =>
      api<GetSourcesResponse>('/models/sources/select', { method: 'POST', body: req }),
    onSuccess: (data) => {
      qc.setQueryData(qk.models.sources, data);
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
