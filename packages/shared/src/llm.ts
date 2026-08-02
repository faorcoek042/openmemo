/**
 * LLM 用途分档（per-purpose model selection）—— **浏览器侧可用的那一份**。
 *
 * ## 为什么不直接 import `@openmemo/llm`
 *
 * 权威定义在 `packages/llm/src/types.ts`，那个文件本身是纯的（零 import）。
 * 但 `@openmemo/llm` 的 `.` 导出指向 `dist/index.js`，会连带把 provider 与
 * `secrets.ts` 一起拉进来 —— 而 `secrets.ts` 里的 `chmodSync` 被打进浏览器 bundle
 * 正是刚发生过的那次「开发服务器下笔记详情页整页崩溃」。
 * 包没有 `./types` 子路径导出，所以前端**没有安全的方式**引到那个联合。
 *
 * `shared` 的约定是"**不得出现 `node:` 导入，因为它会被打进浏览器**"，
 * 放在这里是唯一既能被前端引用、又不会把 Node 代码带进 bundle 的位置。
 *
 * ⚠️ 待办（`oss-scout` 域）：`packages/llm/src/types.ts` 的 `LLM_PURPOSES` 应改为
 * `export { LLM_PURPOSES, type LlmPurpose } from '@openmemo/shared'`，
 * 否则仍是两份真相。在那之前**取值必须与该文件逐字一致** —— 已核对（2026-08，三值相同）。
 */

/**
 * 分档依据是 `memo-compare` 对 memo.ac 的取证：**chat / 摘要+导图 / 翻译 各配一套**。
 *
 * `summarize` **同时覆盖摘要与思维导图**：两者都是"读全文吐结构"，对模型能力的要求同类，
 * 拆开只会让设置页多一栏没人知道怎么填的东西。
 */
export const LLM_PURPOSES = ['chat', 'summarize', 'translate'] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

/**
 * 单个用途的绑定。**两个字段都可缺**，缺的那个**逐字段**回退到
 * `llm.defaultProviderId` / `llm.defaultModelId`。
 *
 * ⚠️ 逐字段而非整体回退，这个区别会直接影响 UI 怎么画：
 * 用户最常见的填法是**只换 model、不换 provider**（同一家换个便宜型号）。
 * 整体回退会让这种填法**静默失效** —— 填了、存了、看起来生效了，实际被整块丢弃。
 * 所以设置页必须能逐字段表达"这一项继承全局 / 这一项已覆盖"。
 */
export interface PurposeBinding {
  readonly providerId?: string;
  readonly model?: string;
}

/** `llm.purposes` 设置键的形状。 */
export type PurposeBindings = Partial<Record<LlmPurpose, PurposeBinding>>;

/** daemon 侧 `resolveConfiguredProvider` 真正读取的设置键 —— 前端必须写这几个，别的它不看。 */
export const LLM_SETTING_KEYS = {
  defaultProviderId: 'llm.defaultProviderId',
  defaultModelId: 'llm.defaultModelId',
  purposes: 'llm.purposes',
  /** 每个 provider 一条：`llm.baseUrl.<providerId>`。 */
  baseUrlPrefix: 'llm.baseUrl.',
} as const;

/**
 * 解析某用途最终生效的 provider/model —— 与 daemon 的 `bindingFor()` **同款逻辑**。
 *
 * 前端复刻它不是为了替后端决策，而是为了**如实显示"实际会用哪个"**：
 * 只显示用户填了什么，用户就看不出"我只填了 model，provider 继承的是哪个"，
 * 也看不出"我填的这些其实凑不出一个可用配置"。
 */
export function resolvePurpose(
  bindings: PurposeBindings | undefined,
  purpose: LlmPurpose,
  defaults: { providerId?: string | null; model?: string | null },
): {
  providerId: string | null;
  model: string | null;
  /** 逐字段：true = 用的是全局默认值（未覆盖）。 */
  inherited: { providerId: boolean; model: boolean };
} {
  const b = bindings?.[purpose] ?? {};
  const ownProvider = b.providerId?.trim() ? b.providerId.trim() : null;
  const ownModel = b.model?.trim() ? b.model.trim() : null;
  const defProvider = defaults.providerId?.trim() ? defaults.providerId.trim() : null;
  const defModel = defaults.model?.trim() ? defaults.model.trim() : null;

  return {
    providerId: ownProvider ?? defProvider,
    model: ownModel ?? defModel,
    inherited: { providerId: ownProvider === null, model: ownModel === null },
  };
}
