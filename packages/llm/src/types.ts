/**
 * LLM 适配层接口（D-01 §6.2）。
 *
 * **关键简化：只需要两个实现。**
 * | 实现 | 覆盖 |
 * |---|---|
 * | `OpenAiCompatibleProvider`（可配 baseUrl/apiKey/model） | OpenAI、DeepSeek、Groq、Moonshot、通义、智谱、**Ollama**、**LM Studio**、**内置 llama-server** |
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

export interface ChatRequest {
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

export interface LlmProvider {
  readonly id: string;
  readonly kind: 'openai-compatible' | 'anthropic';
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
