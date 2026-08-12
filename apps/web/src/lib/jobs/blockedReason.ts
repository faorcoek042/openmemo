/**
 * 「这条任务在等什么」—— **`blockedCode` → 那句话的 i18n key，全仓唯一一份。**
 *
 * ## 为什么它必须是公共的（Manager 2026-08-12 裁决）
 *
 * 这张表原来**只长在导图那一半**：`GenerateMindmapButton` 里一句
 * `t(\`mindmap.blocked.\${code}\`, { defaultValue: … })`（那个命名空间已经搬走）。
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
 * ## ✅ 命名空间搬完了（`jobBlocked.*`）
 *
 * 上一轮这些 value 还散在两处**已经存在的**词条位置：`mindmap.blocked.*`（导图三条）
 * 与 `errors.MISSING_ASR_MODEL.detail`（转写那条）。两处都是历史落点：
 *   · 一个叫 `mindmap.blocked.*` 的键服务**转写**任务，本身就是命名谎话；
 *   · `errors.*` 那条是 `ErrorBlock` 的**报错**文案，语义合、**口吻不对** ——
 *     「在等你装模型」是个可修复的等待态（装好会自己接着跑），
 *     不该穿着"出错了"的衣服。
 *
 * 现在四条都在 `jobBlocked.*` 下，转写那条是**新写的**、按等待态的口吻写。
 * ⚠️ `errors.MISSING_ASR_MODEL.*` **一个字没动**：它另有消费方（`ErrorBlock` 的
 * 文案表按 `code` 查 `title`/`detail`/`action` 三件套），改它会在另一条路上出事。
 * **新写一条比改现有那条安全** —— 那条词条有两个消费方，别改一处忘一处。
 *
 * 这次搬迁应验了提表时写下的那句：**只改了这个文件里的常量，两个消费方一行都没动。**
 *
 * ## 本文件不 import React / i18next 运行时
 *
 * 它只**说出 key**，查词条是渲染层的事。这样它能进 `tsconfig.test.json`
 * 那条 CommonJS 单测通道 —— 与 `noteJobs.ts` / `jobToastModel.ts` 同一条理由：
 * 「哪些事实到得了屏幕上」这类规则埋在组件里就只能靠起浏览器点一遍来验证。
 */

/**
 * daemon **真的会发**的 `blockedCode`。
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
export const KNOWN_BLOCKED_CODES = [
  'MISSING_ASR_MODEL',
  'NO_TRANSCRIPT',
  'LLM_NOT_CONFIGURED',
] as const;
export type KnownBlockedCode = (typeof KNOWN_BLOCKED_CODES)[number];

/**
 * `blockedCode` → i18n key。
 *
 * ★ 类型是**全量 `Record<KnownBlockedCode, string>`，不是 `Record<string, string>`**。
 * 差别不是风格：往上面那个数组里加一个码而**没人给它写话**，
 * 这一行**构建当场就红**（缺属性）。写成宽 Record 的话，新码会安静地落进兜底 ——
 * 一句"任务被挂起了，去任务中心看看"，而任务中心也只会重复同一句。
 * 那种失败没有任何东西会报，只有用户觉得这软件说不清话。
 *
 * ⚠️ 反过来**不能**把 `blockedReasonKey()` 的入参也收成 `KnownBlockedCode`：
 * `queue.block()` 的第二个参数是自由字符串，daemon 随时能发一个我们没见过的码。
 * **闭集用于"我们答应过要写话的那些"，开集用于"运行时真会收到的那些"** ——
 * 两者是不同的集合，混成一个会让其中一半说谎。
 */
export const BLOCKED_REASON_KEYS: Readonly<Record<KnownBlockedCode, string>> = {
  /* 转写：没装语音识别模型。 */
  MISSING_ASR_MODEL: 'jobBlocked.MISSING_ASR_MODEL',
  /* 导图：这条笔记还没有转写稿。 */
  NO_TRANSCRIPT: 'jobBlocked.NO_TRANSCRIPT',
  /* 导图：没有可用的语言模型。 */
  LLM_NOT_CONFIGURED: 'jobBlocked.LLM_NOT_CONFIGURED',
};

/**
 * 认不出的 code 落这里。
 *
 * 措辞是「任务被挂起了。去任务中心看看它在等什么。」—— 它**只说我们确实知道的**
 * （挂起了、去哪能看到更多），不猜原因。
 */
export const BLOCKED_REASON_FALLBACK_KEY = 'jobBlocked.UNKNOWN';

/**
 * `blockedCode` → 要渲染的那条 i18n key。**永远返回一个 key，不返回 null。**
 *
 * 返回 null 会让每个调用点自己决定"那就不显示了吧"，而那正是空白的来源。
 * `code` 为空（daemon 只说 blocked、没给码）同样落兜底：
 * 状态本身已经是事实，缺一个码不该让整块提示消失。
 */
export function blockedReasonKey(code: string | null | undefined): string {
  if (!code) return BLOCKED_REASON_FALLBACK_KEY;
  // 入参刻意是 `string`（见上）：这里查的是一张闭集表，查不到就是查不到。
  return (
    (BLOCKED_REASON_KEYS as Readonly<Record<string, string>>)[code] ?? BLOCKED_REASON_FALLBACK_KEY
  );
}
