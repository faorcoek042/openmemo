/**
 * LLM 适配层接口（D-01 §6.2）。
 *
 * **关键简化：只需要两个实现。**
 * | 实现 | 覆盖 |
 * |---|---|
 * | `OpenAiCompatibleProvider`（可配 baseUrl/apiKey/model） | OpenAI、DeepSeek、Groq、Moonshot、通义、智谱、**Ollama**、**LM Studio**、**本机 llama-server**（用户自己装的，ADR-016 砍的是"我们内置"那档）|
 * | `AnthropicProvider` | Claude（Messages API 格式不同，必须独立实现） |
 *
 * 我们的规则（直接对冲 R-01 §C11 #12：memo.ac 只有 OpenAI 能配 baseURL）：
 * **`baseUrl` 对所有 provider 都可配；`apiKey` 对本地后端可为空。**
 */

import type { LlmPurpose } from '@openmemo/shared';

import type { LlmError } from './errors.js';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface JsonSchemaSpec {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly strict?: boolean;
}

/*
 * ★ 用途分档 —— **权威定义在 `@openmemo/shared`**，这里只是再导出（调用方一个字不用改）。
 *
 * ## 为什么方向是 llm → shared，而不是反过来
 *
 * 这四个东西原来在这里与 `packages/shared/src/llm.ts` **逐字相同各写一份**，
 * 而 shared 那份的文件头写着它为什么非在 shared 不可：`@openmemo/llm` 的 `.` 导出指向
 * `dist/index.js`，会连带把 provider 与 `secrets.ts` 一起拉进来，而 `secrets.ts` 里的
 * `chmodSync` 被打进浏览器 bundle **正是那次「开发服务器下笔记详情页整页崩溃」**。
 * 前端够不着这里，所以权威只能落在 shared；而本包**早就声明了 `@openmemo/shared` 依赖**
 * （源码里却一次 import 都没有），没有任何"引不到"的借口。
 *
 * shared 那份当时留了一句待办，写的正是这一步，并附了一句
 * 「在那之前**取值必须与该文件逐字一致** —— 已核对（2026-08，三值相同）」——
 * **「靠人逐字核对」正是本轮要拆掉的那个东西**：核对过一次不等于下一次还会有人核对。
 *
 * 分档依据（memo-compare 取证：chat / 摘要+导图 / 翻译 各配一套）、
 * `summarize` 为什么同时覆盖摘要与导图、`PurposeBinding` 为什么必须**逐字段**回退，
 * 都写在 `packages/shared/src/llm.ts` 的那几份声明上。
 */
export {
  LLM_PURPOSES,
  type LlmPurpose,
  type PurposeBinding,
  type PurposeBindings,
} from '@openmemo/shared';

export interface ChatRequest {
  /**
   * 这次调用属于哪个用途。**不传等于 `chat`**（保持既有调用方行为不变）。
   * provider 本身不消费它 —— 它是**给上层选 provider 用的**，
   * 放在请求里是为了让调用链上任何一层都能看出"这是在为哪个功能花钱"。
   */
  readonly purpose?: LlmPurpose;
  readonly messages: readonly ChatMessage[];
  /** 有 schema 则要求结构化输出。provider 不支持时降级为 prompt 约束 + 解析重试。 */
  readonly schema?: JsonSchemaSpec;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /** 流式增量回调。F4 要渐进式生成导图，这是"边生成边看"的入口。 */
  readonly onDelta?: (text: string) => void;
  /** 覆盖 provider 默认模型。 */
  readonly model?: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChatResult {
  readonly text: string;
  readonly usage?: TokenUsage;
  readonly model: string;
  readonly finishReason?: string;
  /** 实测耗时，用于 UI 展示与基准（ADR-004 决策 3：跑真实数字不编造）。 */
  readonly elapsedMs: number;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  /**
   * `json_schema` > `json_object` > `none`。决定结构化输出走哪条路。
   *
   * ⚠️ D-01 §6.2 里写的是 `json_mode`，但 OpenAI API 的**实际字段值**是
   * `response_format: {type: "json_object"}`。这里用真实值以免实现时又转换一次。
   *
   * ⚠️ 实测（llama-server b10223 + Qwen3-0.6B）：**`json_object` 不是强约束** ——
   * 会返回带 markdown 围栏的文本。只有 `json_schema` 是真正的语法约束。
   * 因此**无论哪一档都必须走 `extractJson()` 做鲁棒解析**。
   */
  readonly structuredOutput: 'json_schema' | 'json_object' | 'none';
  readonly toolUse: boolean;
  readonly contextWindow: number;
  readonly vision: boolean;
}

/*
 * ⚠️ 关于 `embed()` —— **已裁决 v1 不做**（T-033，Manager 裁决）。
 *
 * D-01 §6.2 的原始接口里有 `embed(req): Promise<Float32Array[]>`，用于 D-02 §4.3 的向量检索。
 * 我在 T-023 没有实现它，T-028 自查时把这条报了出来 —— 它正是向量检索断链的直接成因。
 *
 * 裁决理由（可逆）：补齐向量检索需要三件事，都不小：
 *   1. 再下一个 embedding 模型（bge-small-zh ~100MB / multilingual-e5-small ~470MB）
 *   2. 新的推理运行时 —— **whisper.cpp 与 llama.cpp 都不做 embedding**
 *      （llama-server 有 /v1/embeddings，但未验证；或需引入 onnxruntime）
 *   3. 语义窗口切块 + 换模型/换稿后的重建队列（D-02 §4.3/§4.5）
 * 而章程 F5 只要求"搜索"，FTS5 + libsimple 中文分词已端到端满足。
 *
 * **为什么这条决策可逆**：D-02 §4.5 把索引设计成**可重建缓存**，
 * `embed_chunks.text` 保留原文 —— 将来补 embedding 时**不需要迁移任何数据**，
 * 重跑一遍生成即可。
 *
 * 这里刻意**不留空实现**：留一个静默返回空数组的 `embed()` 会让人以为它坏了，
 * 而不是"没做"。要做的时候在这里加回接口方法即可。
 */
export interface LlmProvider {
  readonly id: string;
  readonly kind: 'openai-compatible' | 'anthropic' | 'gemini';
  /** 展示给用户的名字（"本地 llama-server" / "OpenAI"）。 */
  readonly label: string;
  /** 是否是本地后端 —— 决定 UI 要不要显示"数据将发送到 <provider>"的隐私提示。 */
  readonly isLocal: boolean;

  capabilities(): Promise<ProviderCapabilities>;
  chat(req: ChatRequest): Promise<ChatResult>;
  /**
   * 列出可用模型。
   *
   * ⚠️ **不返回 `string[]`**（T-167）。它曾经是 `Promise<string[]>` 且"失败返回空数组"，
   * 于是 401 / 断网 / 超时 / 响应形状不对**全部**变成"这家没有模型" ——
   * 而这四种情况的下一步互相矛盾（改 Key vs 查网络 vs 重试 vs 改地址）。
   * 调用方拿到 `[]` 只能说一句话，那句话对其中至少三种是错的，
   * 用户会据此**去换服务商**。
   *
   * 旧签名在结构上没有能力区分"真的零"和"没问到"，于是调用方也不可能小心
   * （与 `listManifestFiles`、`findStaleLinks` 同一条判词）。
   */
  listModels(): Promise<ListModelsResult>;
}

/**
 * `listModels()` 的结果。
 *
 * `{ ok: true, models: [] }` 是**合法的零** —— 对面好好地回答了"我这儿没有模型"。
 * 它与 `{ ok: false, error }` 是两件事，且**在类型上就分得开**。
 */
export type ListModelsResult =
  | { readonly ok: true; readonly models: string[] }
  | { readonly ok: false; readonly error: LlmError };

export interface ProviderConfig {
  readonly id: string;
  readonly label?: string;
  readonly baseUrl: string;
  /** 本地后端可为空。**绝不要求用户为本地服务填一个假 key**（memo.ac 的 bug）。 */
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly isLocal?: boolean;
  readonly contextWindow?: number;
  readonly timeoutMs?: number;
  /** 额外请求头（某些网关需要）。 */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * 额外的请求体字段，原样合并进 payload。
   *
   * 实测用途：Qwen3 系列默认是 **thinking 模型**，会先输出 `reasoning_content`
   * 把 token 预算烧光，导致小 `max_tokens` 下 `content` 为空。
   * 需要传 `{ chat_template_kwargs: { enable_thinking: false } }` 关掉。
   * 这类后端特有开关不适合进通用接口，用这个逃生舱口。
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}
