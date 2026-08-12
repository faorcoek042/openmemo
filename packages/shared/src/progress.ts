/**
 * 进度刻度 —— **一个数字，两种量纲，靠约定维持**，这次把它写进类型。
 *
 * ## 它修的那条 bug（#90 闸门在真浏览器里抓到的）
 *
 * 笔记列表行、笔记详情进度行、`/tasks` 进行中那行，**同时**显示「转写中 100%」、
 * 进度条满格（`aria-valuenow="100"`、`width:100%`）——而同一时刻
 * `GET /api/jobs` 的 `progress` 是 **0.728**。一条 40 分钟的音频，用户会盯着
 * 「100%」看好几分钟，然后以为卡死了。
 *
 * 成因是一条 SSE 字段上的量纲分叉，**两个生产者对同一个字段名给出两种刻度**：
 *
 * | 生产者                                            | 写进 `pct` 的是            | 量纲      |
 * |---------------------------------------------------|----------------------------|-----------|
 * | `apps/daemon/src/jobs/events.ts`（转写 / 导图）    | `Math.round(fraction*100)` | **0–100** |
 * | `apps/daemon/src/http/rest/state.ts`（下载）       | `completed / total`        | 0–1       |
 *
 * 而**契约、openapi、store、`ProgressMeter`、`formatPercent` 全部按 0–1 用**。
 * 于是 `formatPercent` 把 `90` 夹成 `1` → 恒 `100%`，`ProgressMeter` 把 `90*100`
 * 夹成 `100` → 恒满条。**任何 pct ≥ 1 的帧一到，显示就永久钉在 100%。**
 *
 * 最锋利的一处是 `apps/web/src/features/tasks/api.ts` 的
 * `progress: live?.progress ?? job.progress` —— 同一行、同一个 `??`、两个量纲：
 * **有 SSE 帧时是 90，没帧时是 0.9。** 掐断 `/api/events` 立刻显示 71%，
 * 实时通道一恢复就跳回 100%（审计用 playwright 实测过这条反证）。
 *
 * 而下载链路**侥幸是对的**（生产者和消费者都是 0–1）—— 这正是它能活这么久的原因：
 * **最常被人盯着看的那条进度条没坏。**
 *
 * ## 为什么不是"在那一行除以 100 就完了"
 *
 * 除以 100 修的是这一次。下一个人往 `pct: number | null` 里写什么，类型仍然一个字
 * 都拦不住 —— `number | null` 对 `0.9` 和 `90` 一视同仁。事实上 `events.ts` 那行
 * 头上的注释写的就是「契约用的是百分比（0..100）…… 又一处**只有类型检查才拦得住**
 * 的差异」：**它准确地诊断了病因，然后自己成了病例。**
 *
 * 所以这里按仓里已有的手法（`ToolchainVerdict` / `SpeedEvidence` / `InstalledVersion`
 * / `VersionOrder`）把那个无名裸数字升格：
 *
 * 1. **判别式联合**，`kind` 打头 —— 数字不再单独存在，它永远和它的量纲绑在一起。
 * 2. **只有一种量纲可表达**：`fraction`（0–1）。**没有 `percent` 这一格** ——
 *    百分比是**显示形态**，不是传输形态：它只在渲染层现算（`ProgressMeter` 把比例
 *    乘 100 画成宽度，`formatPercent` 交给 `Intl` 去本地化），**从不上线**。
 *    ⇒ 「两种量纲共用一个字段名」在类型上**写不出来**。
 * 3. **「报不出进度」是独立一格，且不携带那个数字**（不是 `value: null`，是**没有
 *    `value` 这一栏**）。这一条顺手把 `features/models/sse.ts` 用一段注释苦苦守护的
 *    语义搬进了类型：`pct: null` 的意思是「这一步没有刻度」，**不是 0%**。
 *    而 `features/tasks/sse.ts` 那侧写的正是 `e.pct ?? 0` —— 同一行上的第二个 bug。
 * 4. **唯一构造点** `progressFraction()`：越界不再被静默夹紧，而是**降级成
 *    `unreportable` 并出声**。
 *
 * ## 越界为什么是"降级 + 出声"，不是 throw、也不是夹紧
 *
 * - **夹紧**是原来的做法，它把一个 90 倍的偏差**藏起来**：`formatPercent` 静默把
 *   `90` 变成 `100%`，界面上看起来只是"跑得快"。**这就是本次 bug 逃过十几个 agent
 *   的原因。** 夹紧本身没错（防越界），错在夹紧之后**什么都不说**。
 * - **throw** 太贵：进度上报在 runner 的热路径上，为一个显示问题把用户正在跑的
 *   转写任务打死，比显示错误更糟。
 * - 所以退到**最保守的那一档**（与 `components.ts` 的 `unrecognizedInstalledArm`
 *   同一个取舍：编译期红、运行期退保守）：说「不知道」。界面对
 *   `unreportable` 的表达是**不确定表达**（脉动条 / `—`），
 *   而 `console.error` 里有完整的现场。**不确定的进度必须用不确定的表达渲染。**
 */

/** 判别式。`percent` **刻意不存在** —— 见文件头第 2 条。 */
export const PROGRESS_READING_KINDS = ['fraction', 'unreportable'] as const;

/**
 * 为什么报不出进度。**不是装饰**：每一格都对应一种真实处境，
 * 而把它们全折叠成 `null` 正是「安装中显示成停在 0% 的进度条」那一族的成因。
 */
export const PROGRESS_UNREPORTABLE_REASONS = [
  /** 这一步没有分母：解压写盘、校验、"正在选择下载源"。**绝不编一个百分比。** */
  'no_denominator',
  /** 阶段公告帧：只换 step，不带刻度（`state.ts` 的 `job.step` 桥接就发这个）。 */
  'step_announcement',
  /** 上游给了一个不是有限数的值（NaN / Infinity）。 */
  'not_a_number',
  /**
   * 上游给了一个不在 0–1 里的数 —— **几乎总是量纲错**（把 0–100 当 0–1 传）。
   * 这一格存在的全部意义是：让那个错**在界面上和日志里都留下痕迹**，
   * 而不是被夹成 100% 藏起来。
   */
  'out_of_range',
] as const;
export type ProgressUnreportableReason = (typeof PROGRESS_UNREPORTABLE_REASONS)[number];

/** 有刻度：`value` 恒在 0–1。**唯一合法量纲。** */
export interface FractionReading {
  readonly kind: 'fraction';
  /**
   * 0..1。只可能由 {@link progressFraction} 产出 —— 手拼一个
   * `{ kind: 'fraction', value: 90 }` 在类型上写得出来，但全仓没有第二个构造点，
   * `check:orphans` 与本文件的注释共同承担这条纪律。
   */
  readonly value: number;
}

/**
 * 没刻度。**注意它没有 `value` 这一栏** —— 这是刻意的（`SpeedEvidence` 的
 * `UnmeasuredSpeed` 同一手法）：`value: null` 会让 `?? 0` 写得出来，
 * 而 `?? 0` 就是「不知道」被渲染成「0%」的那一行。
 */
export interface UnreportableReading {
  readonly kind: 'unreportable';
  readonly reason: ProgressUnreportableReason;
}

export type ProgressReading = FractionReading | UnreportableReading;

/** 越界容差。浮点累加出来的 `1.0000000000000002` 不该被当成量纲错。 */
const EPSILON = 1e-9;

/**
 * 量纲事故的**唯一出声点**。
 *
 * 走 `console.error` 而不是抛：见文件头「越界为什么是降级 + 出声」。
 * daemon 与 web 共用这一份 —— 两边各写一份的话，只会有一边被人看见。
 */
export function reportProgressDimensionViolation(where: string, value: number): void {
  console.error(
    `[progress] ${where}: 收到 ${value}，它不在 0–1 里。` +
      `进度的传输量纲只有 fraction（0–1）一种；看起来像是把百分比（0–100）当小数传了。` +
      `这一帧按「报不出进度」处理 —— 界面会显示不确定表达，而不是一个假的 100%。`,
  );
}

/**
 * 唯一构造点。**把一个裸数字变成一条有量纲的读数。**
 *
 * @param value 0..1 的比例。越界 / 非有限数 → 降级成 `unreportable` 并出声。
 * @param where 出事时打进日志的现场（调用点的名字）。
 */
export function progressFraction(value: number, where: string): ProgressReading {
  if (!Number.isFinite(value)) return { kind: 'unreportable', reason: 'not_a_number' };
  if (value < -EPSILON || value > 1 + EPSILON) {
    reportProgressDimensionViolation(where, value);
    return { kind: 'unreportable', reason: 'out_of_range' };
  }
  return { kind: 'fraction', value: Math.min(1, Math.max(0, value)) };
}

/**
 * 有分母才给刻度。`total <= 0` → `no_denominator`，**不是 0%**。
 *
 * 这个比值全仓此前算了 4 遍（`state.ts` / `tasks/api.ts` / `JobToaster` /
 * `DownloadRow`），每一遍都自带一次写反的机会。
 */
export function progressOf(completed: number, total: number, where: string): ProgressReading {
  if (!Number.isFinite(total) || total <= 0) {
    return { kind: 'unreportable', reason: 'no_denominator' };
  }
  return progressFraction(completed / total, where);
}

/** 「这一步没有刻度」的单例，省得调用点各拼各的字面量（`NOT_INSTALLED` 同一手法）。 */
export const PROGRESS_UNREPORTABLE: Readonly<
  Record<ProgressUnreportableReason, UnreportableReading>
> = Object.freeze({
  no_denominator: Object.freeze({ kind: 'unreportable', reason: 'no_denominator' }),
  step_announcement: Object.freeze({ kind: 'unreportable', reason: 'step_announcement' }),
  not_a_number: Object.freeze({ kind: 'unreportable', reason: 'not_a_number' }),
  out_of_range: Object.freeze({ kind: 'unreportable', reason: 'out_of_range' }),
});

/**
 * **唯一读取点。** 返回 0–1，或者 `null`＝「这一步报不出进度」。
 *
 * 命名收敛（`toolchainMissing` 同一手法）：它叫 `fractionOf` 而不是 `valueOf` ——
 * 调用点写出来的是 `fractionOf(e.progress)`，**读起来就带着量纲**，
 * 于是 `fractionOf(...) * 100` 这种写法自己会显得可疑。
 *
 * `null` 一律要用**不确定表达**渲染，`?? 0` 是错的（那是把"不知道"写成"0%"）。
 */
export function fractionOf(reading: ProgressReading | null | undefined): number | null {
  if (!reading) return null;
  return reading.kind === 'fraction' ? reading.value : null;
}
