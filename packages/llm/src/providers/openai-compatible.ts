/**
 * OpenAI 兼容 provider —— **一个实现覆盖绝大多数后端**。
 *
 * 覆盖：OpenAI、DeepSeek、Groq、xAI、Moonshot、SiliconCloud、OpenRouter、通义、智谱、
 * **Ollama**（`/v1`）、**LM Studio**（`/v1`）、**本机 `llama-server`**（`/v1`，用户自己装的 —— ADR-016 砍掉的是我们内置那档）。
 *
 * 设计要点：
 * - `apiKey` 可为空 —— 本地后端不该逼用户填假 key（memo.ac 的已知 bug，R-01 §C11 #12）。
 * - 流式与非流式共用一套错误映射。
 * - 结构化输出三级降级：`json_schema` → `json_object` → 纯 prompt 约束。
 */
import { LlmError, mapHttpError, mapNetworkError } from '../errors.js';
import type {
  ChatRequest,
  ChatResult,
  LlmProvider,
  ProviderCapabilities,
  ProviderConfig,
  TokenUsage,
} from '../types.js';

interface OaChoiceDelta {
  delta?: { content?: string | null };
  message?: { content?: string | null };
  finish_reason?: string | null;
}

interface OaResponse {
  choices?: OaChoiceDelta[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly kind = 'openai-compatible' as const;
  readonly id: string;
  readonly label: string;
  readonly isLocal: boolean;
  #caps: ProviderCapabilities | undefined;

  constructor(private readonly cfg: ProviderConfig) {
    this.id = cfg.id;
    this.label = cfg.label ?? cfg.id;
    this.isLocal = cfg.isLocal ?? isLoopback(cfg.baseUrl);
  }

  get baseUrl(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.cfg.headers ?? {}),
    };
    // 本地后端可以完全没有 key —— 不要伪造一个 "Bearer sk-no-key"
    if (this.cfg.apiKey) h['Authorization'] = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.#headers() });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      return (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    } catch {
      return [];
    }
  }

  /**
   * 能力探测。**实测而非假设** —— 不同后端对 `response_format` 的支持差别很大
   * （llama-server 支持 json_schema，多数国产网关只支持 json_object，有的两个都不支持）。
   */
  async capabilities(): Promise<ProviderCapabilities> {
    if (this.#caps) return this.#caps;

    let structuredOutput: ProviderCapabilities['structuredOutput'] = 'none';
    // 用一个极小的请求探测，成本可忽略
    for (const mode of ['json_schema', 'json_object'] as const) {
      const ok = await this.#probeStructured(mode);
      if (ok) {
        structuredOutput = mode;
        break;
      }
    }

    this.#caps = {
      streaming: true,
      structuredOutput,
      toolUse: false,
      contextWindow: this.cfg.contextWindow ?? 8192,
      vision: false,
    };
    return this.#caps;
  }

  async #probeStructured(mode: 'json_schema' | 'json_object'): Promise<boolean> {
    const responseFormat =
      mode === 'json_object'
        ? { type: 'json_object' }
        : {
            type: 'json_schema',
            json_schema: {
              name: 'probe',
              strict: true,
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
                additionalProperties: false,
              },
            },
          };
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [{ role: 'user', content: 'Reply {"ok":true}' }],
          max_tokens: 16,
          response_format: responseFormat,
          ...(this.cfg.extraBody ?? {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const caps = await this.capabilities();
    const started = Date.now();
    const model = req.model ?? this.cfg.model;
    const streaming = typeof req.onDelta === 'function';

    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(this.cfg.extraBody ?? {}),
    };

    // 结构化输出：按实测能力降级
    if (req.schema) {
      if (caps.structuredOutput === 'json_schema') {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: req.schema.name,
            strict: req.schema.strict ?? true,
            schema: req.schema.schema,
          },
        };
      } else if (caps.structuredOutput === 'json_object') {
        body['response_format'] = { type: 'json_object' };
      }
      // 'none' 时不设 response_format，靠 prompt 约束 + 解析重试（structured.ts）
    }

    const signal = combineSignals(req.signal, this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw mapNetworkError(err, this.id, this.baseUrl);
    }

    if (!res.ok) {
      throw mapHttpError(res.status, await safeText(res), this.id);
    }

    if (streaming) {
      return this.#consumeStream(res, req, model, started);
    }

    const json = (await res.json()) as OaResponse;
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text,
      model: json.model ?? model,
      elapsedMs: Date.now() - started,
      ...(json.choices?.[0]?.finish_reason
        ? { finishReason: json.choices[0].finish_reason as string }
        : {}),
      ...(json.usage ? { usage: toUsage(json.usage) } : {}),
    };
  }

  /** 解析 SSE 流。注意 chunk 边界可能把一行 `data:` 切成两半，必须缓冲。 */
  async #consumeStream(
    res: Response,
    req: ChatRequest,
    model: string,
    started: number,
  ): Promise<ChatResult> {
    if (!res.body) throw new LlmError('LLM_BAD_RESPONSE', 'no body', '流式响应为空', true);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分帧；最后一段可能不完整，留在 buffer 里
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let evt: OaResponse;
          try {
            evt = JSON.parse(payload) as OaResponse;
          } catch {
            continue; // 半截 JSON：跳过，下一轮补齐
          }
          const delta = evt.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            text += delta;
            req.onDelta?.(delta);
          }
          const fr = evt.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (evt.usage) usage = toUsage(evt.usage);
        }
      }
    } catch (err) {
      throw mapNetworkError(err, this.id, this.baseUrl);
    }

    return {
      text,
      model,
      elapsedMs: Date.now() - started,
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}

function toUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): TokenUsage {
  const p = u.prompt_tokens ?? 0;
  const c = u.completion_tokens ?? 0;
  return { promptTokens: p, completionTokens: c, totalTokens: u.total_tokens ?? p + c };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/** 合并用户的 AbortSignal 与超时信号。 */
function combineSignals(user: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!user) return timeout;
  // AbortSignal.any 在 Node 20+ 可用
  return AbortSignal.any([user, timeout]);
}
