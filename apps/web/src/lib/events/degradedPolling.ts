/**
 * `degraded` 的**真实兜底**：SSE 彻底断了之后，改用定时全量重拉。
 *
 * ## 为什么这个文件必须存在（#101）
 *
 * `source.ts` 的 `MAX_RECONNECT_BEFORE_DEGRADE` 注释一直写着
 * 「连续这么多次重连失败后**降级为轮询（约 15s）**」，而**那条轮询从来没有被实现过**。
 * 顺着它查下来只找到三样东西：一个 `'degraded'` 枚举值、一条黄色横幅、
 * 一张 tone 表 —— **没有任何一处在拉数据**。
 *
 * 后果不是"注释写错了"，是：
 *
 * > **SSE 断到降级之后，用户界面就永久停在最后一帧上，而且没人再去问服务端要新的。**
 *
 * 更糟的是那条注释会让下一个人**不去查这里**（"哦，有兜底的"）。
 * 一句描述了不存在事实的注释，比没有注释贵得多。
 *
 * ## 为什么是"真的实现"而不是"把那句话删掉"
 *
 * 因为**降级不等于服务端不可达**。`source.ts` 文件头自己就记着一种真实形态：
 * HTTP/1.1 只有 6 条连接预算，多标签页各开一条 SSE 就能把它吃光 ——
 * 那时候 **SSE 死了，REST 是好的**。企业代理缓冲 `text/event-stream`
 * （不转发就不冲刷）是同一类：长连接不通，普通请求照常。
 * 这两种情形下轮询**真的能把数据拿回来**，删掉那句话就等于把能救的场景一起放弃。
 *
 * 另一头（daemon 真的死了）轮询也不做坏事：请求会失败，横幅照旧挂着，
 * `onopen` 一旦恢复就会发 `sync.required` 并把状态切回 `open`，轮询自动停。
 *
 * ## 判据：**它必须真的产生网络请求**
 *
 * 这是本轮的核心教训。上一版的"兜底"由一个枚举值 + 一条横幅组成 ——
 * 从截图上看它**和真的有兜底一模一样**。所以回归腿钉的不是
 * "state 变成了 degraded"，也不是"横幅出现了"，而是
 * **活跃 query 的 queryFn 真的被再调用了一次**（见 `silentFailures.test.tsx`）。
 *
 * ## 为什么直接 `invalidateQueries()` 全量失效
 *
 * 与 `sync.required` 用的是同一条既有通道（`system.sse.ts`）：
 * 我们**不知道**断线期间漏了什么，所以唯一安全的做法是整篇重拉。
 * 这里刻意不发明第二套"只刷新某几个 key"的规则 ——
 * 那需要一份和服务端事件表同步的名单，而那种名单必然漂移。
 *
 * ⚠️ `invalidateQueries()` 只会**真的重取活跃 query**（TanStack 的语义），
 * 所以代价是"当前这一屏"，不是整个缓存。
 *
 * ## 多标签：**每个标签各轮各的**，不做协调（这是判断过的，不是默认）
 *
 * 前提事实：主标签广播连接态之后（`source.ts` 的 `applyLeaderState`），
 * 跟随者也会看到 `degraded`，于是**每个标签都会启动自己的这一份**。
 * 三条理由说明这是对的，而不是漏掉了一个协调层：
 *
 * 1. **只有本标签能刷新本标签的缓存。** 每个标签有自己的 `QueryClient`；
 *    主标签轮询一百次也不会让第二个标签的界面动一下。
 *    "只让主标签轮询"在结构上就修不了这个 bug。
 * 2. **协调版会把可见标签的刷新频率押在一个隐藏标签上。** 主标签是"谁先拿到 Web Lock"，
 *    完全可能是个后台标签，而浏览器会把后台标签的定时器节流到 ≥60s。
 *    改成"主标签定时广播、各标签跟着刷"，用户正在看的那个标签就会被拖成 60 秒一刷。
 *    各轮各的，**可见的那个永远是 15 秒**（不可见的被节流，反正没人在看）。
 * 3. **请求量不值得为它加一层协议。** 代价是 N 个标签 × 各自活跃 query，打的是 localhost，
 *    且只在降级期间：一个笔记详情页约 4 个活跃 query，3 个标签 ≈ 12 个请求 / 15s ≈ 0.8 req/s。
 *    ⚠️ 而且当初让多标签变贵的那件事（ADR-007：HTTP/1.1 六条连接预算被 SSE 吃光）
 *    **不会在这里重演** —— 那说的是**长连接**；轮询请求跑完就把槽位还回去了。
 *
 * 补充一条实测背景：`app/query.ts:84` 关掉了 `refetchOnWindowFocus`，
 * 理由写的是"我们有 SSE"。**那个理由恰好在降级时不成立** ——
 * 所以后台标签切回前台时不会自己补拉，不能靠聚焦兜底。这也是各标签自己轮询的理由之一。
 */

import type { QueryClient } from '@tanstack/react-query';

import { useConnectionStore, type ConnectionState } from '../stores/connection.store';

/**
 * 轮询间隔。
 *
 * 15 秒不是随手写的：它是 `source.ts` 那条注释**当初对读者许下的承诺**
 * （「降级为轮询（约 15s）」）。既然要把话变成真的，就按它原来说的那个数来，
 * 而不是另挑一个 —— 否则那句注释仍然是错的，只是错得没那么离谱。
 */
export const DEGRADED_POLL_INTERVAL_MS = 15_000;

/** 立刻做一次全量重拉。横幅上的「立即刷新」和进入降级的第一拍都走它。 */
export function resyncNow(qc: QueryClient): void {
  void qc.invalidateQueries();
}

export interface DegradedPollingDeps {
  /** 覆盖轮询间隔。**只给测试用** —— 真实间隔是产品承诺的一部分。 */
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * 订阅连接态：进入 `degraded` 就开始轮询，离开就停。返回注销函数。
 *
 * 幂等性由 `handle` 自己保证 —— 状态里连着来两次 `degraded`（比如
 * `x.daemon.shutdown` 紧跟着一次 SSE onerror）不会开出第二个定时器。
 */
export function startDegradedPolling(qc: QueryClient, deps: DegradedPollingDeps = {}): () => void {
  const intervalMs = deps.intervalMs ?? DEGRADED_POLL_INTERVAL_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let handle: unknown = null;

  const stopPolling = (): void => {
    if (handle === null) return;
    clearTimer(handle);
    handle = null;
  };

  const startPolling = (): void => {
    if (handle !== null) return;
    /*
     * ★ 第一拍立刻打，不等满一个间隔。
     * 用户是在"界面已经不动了一会儿"之后才看到降级横幅的 ——
     * 让他再干等 15 秒才看到第一次刷新，那 15 秒里横幅说的话对他就是假的。
     */
    resyncNow(qc);
    handle = setTimer(() => resyncNow(qc), intervalMs);
  };

  const apply = (state: ConnectionState): void => {
    if (state === 'degraded') startPolling();
    else stopPolling();
  };

  apply(useConnectionStore.getState().state);
  const unsubscribe = useConnectionStore.subscribe((s, prev) => {
    if (s.state !== prev.state) apply(s.state);
  });

  return () => {
    unsubscribe();
    stopPolling();
  };
}
