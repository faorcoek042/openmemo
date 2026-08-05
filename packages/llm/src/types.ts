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

/**
 * 用途标识 —— **每个用途可以配一套独立的 provider + 模型**。
 *
 * 分档依据是 `memo-compare` 对 memo.ac 的取证：那边是
 * **chat / 摘要+导图 / 翻译 各配一套**，而不是全局一个模型。
 * 这个分法有实际理由：翻译要的是便宜快速的小模型，导图要的是能稳定吐结构化 JSON 的，
 * 对话要的是上下文长的 —— 强行共用一个，用户只能按最贵的那个需求配，然后为翻译多花十倍钱。
 *
 * `summarize` **同时覆盖摘要与思维导图**（与 memo.ac 一致）：两者都是"读全文吐结构"，
 * 对模型能力的要求是同一类，拆开只会让设置页多一栏没人知道怎么填的东西。
 */
export const LLM_PURPOSES = ['chat', 'summarize', 'translate'] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

/** 设置页每一栏的形状。任一为空 = 该用途回退到默认配置。 */
export interface PurposeBinding {
  readonly providerId?: string;
  readonly model?: string;
}

/** `llm.purposes` 设置键的形状。缺项一律回退到 `llm.defaultProviderId/ModelId`。 */
export type PurposeBindings = Partial<Record<LlmPurpose, PurposeBinding>>;

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
  /** 列出可用模型。失败返回空数组而不是抛 —— 这只是个便利功能。 */
  listModels(): Promise<string[]>;
}

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
