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

/* ────────────────── T-153：`POST /api/llm/detect` 与 `POST /api/llm/models` ────────────────── */

/**
 * 探测本机 LLM 服务（ADR-003 档 2）的一个候选。
 *
 * ★ **判据是"真发请求确认"，不是"端口开着"。** 端口开着可能是别的服务、
 * 可能是个僵尸进程、可能是代理 —— `packages/llm/src/detect.ts` 的文件头记着这条教训，
 * `jobs/runners/mindmap.ts:9` 的注释也写着同一句。所以每个候选都要：
 * `GET {baseUrl}/models` 返回 2xx → 是合法 JSON 且有 `data` 数组 → **`data` 里至少有一个模型**。
 * 装了 Ollama 但一个模型都没下 ⇒ 对用户来说等于不可用，**不给假阳性**。
 */
export interface DetectedLocalLlm {
  /** 候选 id（`ollama` / `lmstudio` / `llama-server`）。 */
  id: string;
  label: string;
  /** 已经是我们的适配器直接能用的那个地址（含 `/v1`）。 */
  baseUrl: string;
  /** 真的从它那里列出来的模型。**至少一个**，否则这条根本不会出现。 */
  models: string[];
  /** 探测耗时，UI 据此把快的排前面。 */
  latencyMs: number;
}

/**
 * `POST /api/llm/detect` 的响应。
 *
 * ⚠️ **`probed` 必须一起回，不能只回 `detected`。**
 * 只回一个空数组的话，界面只能说"没探到"，而用户最需要知道的是
 * **"我们去敲了哪几个门"** —— 他才判断得出"我的 Ollama 改过端口"还是"我压根没装"。
 * 这与 `⑤A-2`「空集不等于一切正常」是同一条：**空结果必须自带它的量程**。
 */
export interface LlmDetectResponse {
  /** 逐个探过的候选（无论探没探到）。 */
  probed: { id: string; label: string; baseUrl: string }[];
  /** 真的确认可用的。`probed` 的子集。 */
  detected: DetectedLocalLlm[];
  /** 单个候选的超时（毫秒）。写进响应是为了让界面能如实说"各 N 秒超时"。 */
  timeoutMs: number;
  probedAt: string;
}

/**
 * `POST /api/llm/models` 的响应 —— **枚举某家真正现在有哪些模型**。
 *
 * 只有 `canRefreshModelList(spec) === true` 的 4 家（openrouter / siliconcloud /
 * ollama / lmstudio）能调；其余 20 家是 `official-doc`（人工从文档转录），
 * **没有端点可调**，服务端会 400 并说明原因，而不是回一个空清单假装成功。
 */
export interface LlmModelsResponse {
  providerId: string;
  /** 实际请求的地址（已脱敏：绝不含 Key）。让用户看得出刷新用的是哪个地址。 */
  endpoint: string;
  /** 枚举到的模型 id，已去重并排序。 */
  models: string[];
  fetchedAt: string;
}
