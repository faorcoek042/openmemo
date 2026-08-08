/**
 * Google Gemini provider（原生 `generativelanguage.googleapis.com`，不走 OpenAI 兼容层）。
 *
 * `memo-compare` 取证后**推翻了自己先前的结论**：memo.ac 里 Claude / Gemini / Mistral / Ollama
 * 是**四家原生客户端**（`ChatGoogleGenerativeAI` 出现 4 处、`generativelanguage` 5 处），
 * 不是统一走 OpenAI 兼容。Google 确实也提供 OpenAI 兼容端点，但它是**子集**：
 * 下面这几处差异用兼容层表达不了或会静默降级。
 *
 * 与 OpenAI / Anthropic 的实质差异（这些决定了必须独立实现）：
 * - 鉴权走 **`x-goog-api-key` 头**（也支持 `?key=`，但那会把密钥写进 URL 和日志，不用）
 * - 路径里带模型名与动作：`/v1beta/models/<model>:generateContent`
 * - 消息体是 `contents[{ role, parts[{text}] }]`，**role 只有 `user` / `model`**
 *   —— 没有 `assistant` 这个词，也**没有 system role**：system 走顶层 `systemInstruction`
 * - 结构化输出是 `generationConfig.responseMimeType` + `responseSchema`，
 *   而且 schema 用的是 **OpenAPI 子集**，不吃 JSON Schema 的 `additionalProperties`
 * - 用量字段是 `usageMetadata.{promptTokenCount,candidatesTokenCount,totalTokenCount}`
 */
import { LlmError, mapHttpError, mapNetworkError } from '../errors.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  LlmProvider,
  ProviderCapabilities,
  ProviderConfig,
  TokenUsage,
} from '../types.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

interface GeminiPart {
  text?: string;
}
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

/**
 * JSON Schema → Gemini 的 OpenAPI 子集。
 *
 * 必须剥掉 `additionalProperties` / `$schema` 这类字段：Gemini 会因为不认识的键
 * **整个请求 400**，而错误信息只说 "Invalid JSON payload"，非常难查。
 * 剥掉是安全的 —— 它们只是约束的收紧，去掉不会让输出变成别的形状。
 */
function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set(['additionalProperties', '$schema', 'definitions', '$defs', 'title']);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (drop.has(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(schema) as Record<string, unknown>;
}

/** OpenAI 风格的 messages → Gemini 的 contents + systemInstruction。 */
export function toGeminiContents(messages: readonly ChatMessage[]): {
  contents: Array<{ role: string; parts: GeminiPart[] }>;
  systemInstruction?: { parts: GeminiPart[] };
} {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages.filter((m) => m.role !== 'system');
  return {
    contents: rest.map((m) => ({
      // Gemini 只认 user / model —— 把 assistant 原样传过去会被拒
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    ...(sys.length > 0 ? { systemInstruction: { parts: [{ text: sys.join('\n\n') }] } } : {}),
  };
}

export class GeminiProvider implements LlmProvider {
  readonly kind = 'gemini' as const;
  readonly id: string;
  readonly label: string;
  readonly isLocal = false;

  constructor(private readonly cfg: ProviderConfig) {
    this.id = cfg.id;
    this.label = cfg.label ?? 'Google Gemini';
  }

  get baseUrl(): string {
    return (this.cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  }

  #headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // 走头而不是 ?key= —— query 里的密钥会进日志、进 Referer、进错误上报
      ...(this.cfg.apiKey ? { 'x-goog-api-key': this.cfg.apiKey } : {}),
      ...(this.cfg.headers ?? {}),
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/${API_VERSION}/models`, {
        headers: this.#headers(),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      return (body.models ?? [])
        .map((m) => m.name?.replace(/^models\//, ''))
        .filter((x): x is string => typeof x === 'string');
    } catch {
      return []; // 列模型只是便利功能，失败不该冒泡成错误
    }
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return Promise.resolve({
      streaming: true,
      /** Gemini 原生支持 schema 约束（`responseSchema`），等价于 json_schema 档。 */
      structuredOutput: 'json_schema' as const,
      toolUse: true,
      /*
       * 1M 是 gemini-1.5/2.x pro 系列的上下文窗口。**这是个静态估计值** ——
       * Gemini 的 models 接口会返回 `inputTokenLimit`，但那要多打一次网络请求，
       * 而调用方只用它做粗略预算。若日后要精确，应改为读 listModels 的真实值，
       * 不要在这里越写越大。
       */
      contextWindow: 1_000_000,
      vision: true,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const model = req.model ?? this.cfg.model;
    if (!model) {
      throw new LlmError(
        'LLM_NOT_CONFIGURED',
        'no model configured for Gemini',
        '未配置 Gemini 模型',
        false,
      );
    }

    const { contents, systemInstruction } = toGeminiContents(req.messages);
    const generationConfig: Record<string, unknown> = {};
    if (req.maxTokens !== undefined) generationConfig['maxOutputTokens'] = req.maxTokens;
    if (req.temperature !== undefined) generationConfig['temperature'] = req.temperature;
    if (req.schema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = toGeminiSchema(req.schema.schema);
    }

    const url = `${this.baseUrl}/${API_VERSION}/models/${encodeURIComponent(model)}:generateContent`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
        }),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      throw mapNetworkError(err, this.id, this.baseUrl);
    }

    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''), this.id);

    const body = (await res.json()) as GeminiResponse;
    if (body.error) {
      throw new LlmError(
        'LLM_BAD_RESPONSE',
        body.error.message ?? 'Gemini returned an error',
        `Gemini 返回错误：${body.error.message ?? '未知'}`,
        true,
      );
    }

    const cand = body.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const u = body.usageMetadata;
    const usage: TokenUsage | undefined = u
      ? {
          promptTokens: u.promptTokenCount ?? 0,
          completionTokens: u.candidatesTokenCount ?? 0,
          totalTokens:
            u.totalTokenCount ?? (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0),
        }
      : undefined;

    return {
      text,
      model,
      elapsedMs: Date.now() - started,
      ...(usage ? { usage } : {}),
      ...(cand?.finishReason ? { finishReason: cand.finishReason } : {}),
    };
  }
}
