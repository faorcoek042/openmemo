/**
 * 「你刚点的这个下载，其实已经在跑了」——**客户端本地**的一条通知通道。
 *
 * ## 为什么需要它（真机缺陷，2026-08-10）
 *
 * 用户报「一旦打开量化选择器，那次下载就完全没有任务 Toast」。
 * `[实测 jsdom 三组对照]` 弹出层**不是**原因：不碰 / 开过并点选 / 开着不点，
 * 三组的 toast 逐字相同 —— `JobToaster` 的订阅 effect deps 是 `[apply, t]`，
 * 子组件重渲染既不重挂它、也不清空它。
 *
 * 真正的触发条件是**对一个"当前还在下载中"的模型再点一次下载**：
 *
 * ```
 * packages/downloader/src/queue.ts:101  findActiveByTarget(targetId)  // 只找非终态的同 target
 *                              :111-112 命中 → return { job: existing, deduplicated: true }
 *                              :154     this.emit('job.created', job)  ← 上面已经 return，走不到
 * ⇒ daemon 不广播 SSE `job.created` ⇒ Toast 层收不到 ⇒ 界面一个字都没有
 * ```
 *
 * **服务端拒绝重复建 job 是对的，不该改服务端。** 缺的是：`deduplicated: true`
 * **已经在 HTTP 响应里**（`toPullResponse`），而前端 `onSuccess` 只 `invalidateQueries`
 * —— **事实算好发出了，在离终点一行的地方被丢掉**。这一轮反复出现的正是这个形状。
 *
 * ## 为什么不走 `lib/events/bus`
 *
 * `bus.on` 的类型由 `EventMap` 约束，而 `EventMap` 是从 `@openmemo/shared` 的
 * `AnySseEvent` 推出来的 —— **加一个只存在于客户端的事件就得改跨进程契约**，
 * 而这件事根本不跨进程：它发生在"我刚发完请求"和"我自己的 toast 层"之间。
 * 所以用一个十几行的本地 emitter，不去污染 SSE 契约。
 *
 * ## 与「刷新后 Toast 不回来」的关系
 *
 * 同一个根：**Toast 层只由 `job.created` 喂养，而已经发生过的事实不会重放。**
 * 两者的**期望不同**，所以修法也不同：
 *   · 刷新 —— 用户做了导航动作，丢掉瞬时通知是正常的；缺的是**环境信号**（已加侧栏徽标）；
 *   · 重复下载 —— 用户**刚刚点了一下**，期待的是**即时反馈**，这里必须当场说话。
 */

export interface AttachedJobNotice {
  jobId: string;
  /** 模型/包 id。toast 用它当名字：**真实但技术性**，好过编一个好看的假名字。 */
  targetId: string;
}

type Listener = (n: AttachedJobNotice) => void;

const listeners = new Set<Listener>();

/** 订阅。返回退订函数（与 `bus.on` 同形，调用方习惯一致）。 */
export function onJobAttached(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 通知：这次请求被服务端去重了，它挂到了一个**已经在跑**的 job 上。
 *
 * 一个订阅者抛错不许拖垮其余订阅者 —— 与 `lib/events/bus` 同一条理由。
 */
export function notifyJobAttached(n: AttachedJobNotice): void {
  for (const fn of [...listeners]) {
    try {
      fn(n);
    } catch {
      /* 忽略：一个坏的订阅者不该让别人收不到 */
    }
  }
}
