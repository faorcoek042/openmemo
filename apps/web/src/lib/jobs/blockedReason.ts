/**
 * 「这条任务在等什么」—— **`blockedCode` → 那句话的 i18n key，全仓唯一一份。**
 *
 * ## 为什么它必须是公共的（Manager 2026-08-12 裁决）
 *
 * 这张表原来**只长在导图那一半**：`GenerateMindmapButton` 里一句
 * `t(\`mindmap.blocked.\${code}\`, { defaultValue: t('mindmap.blocked.UNKNOWN') })`。
 * 而 `blocked` 不是导图独有的状态 —— 转写同样会挂起（没装 ASR 模型），
 * 笔记页那条进度行只说得出「暂时无法继续」，**说不出在等什么，也给不出下一步**。
 *
 * 补法有两条，裁决取前者：
 *
 * | | 代价 |
 * |---|---|
 * | **提成公共表**（本文件） | 已知且有限：动一次 `GenerateMindmapButton`、动一条断言 |
 * | 在转写那边再建一张 | **「同一个概念两份」** —— 今天两张表说的话一致，下一个人只改一张 |
 *
 * 后者正是这一整周收敛扫描在治的病（两张 remediation 路由表对同一个 action
 * 给了两个落点；`NOTE_STATUSES` 与 CHECK 各写一遍…），而且它**一定会漂移**。
 *
 * ## 判据：认不出的 code 一律回落到 `UNKNOWN`，**绝不渲染成空白**
 *
 * daemon 随时可以新增一个 `blockedCode`（`queue.block()` 的第二个参数是自由字符串，
 * 契约里没有闭集），而前端**不该因此变哑**。一个"任务卡住了但页面什么都不说"
 * 与"任务卡住了"在用户那里是两件事：前者他会以为软件坏了。
 *
 * ⚠️ 回落必须落在**这一层**，不是各调用点各写一次 `?? 'UNKNOWN'` ——
 * 漏一处就是一块空白，而空白不会让任何测试变红。
 *
 * ## ⏳ 命名空间还没搬（这是已知的半成品，不是遗漏）
 *
 * 下面的 value 指向两个**已经存在的**词条位置：`mindmap.blocked.*`（导图那三条）
 * 与 `errors.MISSING_ASR_MODEL.detail`（转写那条，`ErrorBlock` 的文案表里早就有，
 * 而且措辞正好是一句可以直接当"在等什么"用的话）。
 *
 * 它们本该统一到一个 `jobBlocked.*` 命名空间下 —— 一个叫 `mindmap.blocked.*` 的键
 * 服务转写任务，本身就是个命名谎话。**没有一起做，是因为 locale 那两份文件本轮
 * 归另一路（`a8916f71` 正在改三处最后一米），窗口开了才轮到我动它。**
 *
 * ✅ 但那次搬迁**只需要改这个文件里的常量，消费方一行都不用动** ——
 * 这正是把它提成公共表的意义所在。搬迁时一并要做的两件事记在这里：
 *   ① `mindmap.blocked.*` / `errors.MISSING_ASR_MODEL.detail` → `jobBlocked.*`；
 *   ② `blockedReason.test.ts` 里那条"表里每个 key 在两份 locale 里都真的存在"
 *      会跟着一起变绿/变红，不需要新写守卫。
 *
 * ## 本文件不 import React / i18next 运行时
 *
 * 它只**说出 key**，查词条是渲染层的事。这样它能进 `tsconfig.test.json`
 * 那条 CommonJS 单测通道 —— 与 `noteJobs.ts` / `jobToastModel.ts` 同一条理由：
 * 「哪些事实到得了屏幕上」这类规则埋在组件里就只能靠起浏览器点一遍来验证。
 */

/**
 * daemon **真的会发**的 `blockedCode` → i18n key。
 *
 * ⚠️ 这三个是**核过的全集**（全仓 `queue.block(` 的调用点）：
 *   · `jobs/runners/transcribe.ts` → `MISSING_ASR_MODEL`
 *   · `jobs/runners/mindmap.ts`    → `NO_TRANSCRIPT` / `LLM_NOT_CONFIGURED`
 *
 * 它**不是**契约里那份 `PIPELINE_ERROR_CODES`。那个常量声称
 * "daemon already blocks jobs with these"，而实测两边只交叠 1 个：
 * 它列的 `MISSING_LLM` / `MISSING_BACKEND` / `RESOURCE_DISK_FULL` / `MISSING_API_KEY`
 * daemon **一个都没发过**，而 daemon 真发的两个它**没有**。已单独报出，本轮不动它。
 * 照着那份写这张表，会得到 4 条永远走不到的分支 + 2 条永远落 UNKNOWN 的真实状态。
 */
export const BLOCKED_REASON_KEYS: Readonly<Record<string, string>> = {
  /* 转写：没装语音识别模型。 */
  MISSING_ASR_MODEL: 'errors.MISSING_ASR_MODEL.detail',
  /* 导图：这条笔记还没有转写稿。 */
  NO_TRANSCRIPT: 'mindmap.blocked.NO_TRANSCRIPT',
  /* 导图：没有可用的语言模型。 */
  LLM_NOT_CONFIGURED: 'mindmap.blocked.LLM_NOT_CONFIGURED',
};

/**
 * 认不出的 code 落这里。
 *
 * 措辞是「任务被挂起了。去任务中心看看它在等什么。」—— 它**只说我们确实知道的**
 * （挂起了、去哪能看到更多），不猜原因。
 */
export const BLOCKED_REASON_FALLBACK_KEY = 'mindmap.blocked.UNKNOWN';

/**
 * `blockedCode` → 要渲染的那条 i18n key。**永远返回一个 key，不返回 null。**
 *
 * 返回 null 会让每个调用点自己决定"那就不显示了吧"，而那正是空白的来源。
 * `code` 为空（daemon 只说 blocked、没给码）同样落兜底：
 * 状态本身已经是事实，缺一个码不该让整块提示消失。
 */
export function blockedReasonKey(code: string | null | undefined): string {
  if (!code) return BLOCKED_REASON_FALLBACK_KEY;
  return BLOCKED_REASON_KEYS[code] ?? BLOCKED_REASON_FALLBACK_KEY;
}
