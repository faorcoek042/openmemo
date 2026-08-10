/**
 * Anthropic provider。Messages API 与 OpenAI 格式不同，必须独立实现（D-01 §6.2）。
 *
 * 主要差异（决定了不能复用 OpenAI 实现）：
 * - 鉴权头是 `x-api-key` 而非 `Authorization: Bearer`，且需要 `anthropic-version`
 * - `system` 是**顶层参数**，不在 `messages` 数组里
 * - `max_tokens` 是**必填**
 * - 流式是具名事件（`content_block_delta` 等），不是 OpenAI 的 `choices[].delta`
 * - 结构化输出没有 `response_format`，靠 tool use 或 prompt 约束
 */
import { LlmError, mapHttpError, mapNetworkError } from '../errors.js';
import { fetchModelList, parseDataIdList } from '../list-models.js';
import type {
  ChatRequest,
  ChatResult,
  ListModelsResult,
  LlmProvider,
  ProviderCapabilities,
  ProviderConfig,
  TokenUsage,
} from '../types.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicProvider implements LlmProvider {
  readonly kind = 'anthropic' as const;
  readonly id: string;
  readonly label: string;
  readonly isLocal = false;

  constructor(private readonly cfg: ProviderConfig) {
    this.id = cfg.id;
    this.label = cfg.label ?? 'Anthropic';
  }

  get baseUrl(): string {
    return (this.cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  #headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(this.cfg.apiKey ? { 'x-api-key': this.cfg.apiKey } : {}),
      ...(this.cfg.headers ?? {}),
    };
  }

  /**
   * 列模型。**失败不再伪装成"没有模型"**（T-167）—— 见 `list-models.ts` 的文件头。
   * 401 要用户去改 Key，断网要他查网络，两件事不能给同一个答案。
   */
  listModels(): Promise<ListModelsResult> {
    return fetchModelList({
      url: `${this.baseUrl}/v1/models`,
      headers: this.#headers(),
      providerId: this.id,
      baseUrl: this.baseUrl,
      parse: parseDataIdList,
    });
  }

  capabilities(): Promise<ProviderCapabilities> {
    return Promise.resolve({
      streaming: true,
      // Messages API 没有 response_format；结构化输出走 prompt 约束 + 解析重试
      structuredOutput: 'none',
      toolUse: true,
      contextWindow: this.cfg.contextWindow ?? 200_000,
      vision: true,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const model = req.model ?? this.cfg.model;
    const streaming = typeof req.onDelta === 'function';

    // system 必须提到顶层 —— 这是与 OpenAI 格式最容易踩的差异
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      messages,
      // max_tokens 在 Anthropic 是必填，不能省
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(streaming ? { stream: true } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      throw mapNetworkError(err, this.id, this.baseUrl);
    }

    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''), this.id);

    if (streaming) return this.#consumeStream(res, req, model, started);

    const json = (await res.json()) as AnthropicResponse;
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      text,
      model: json.model ?? model,
      elapsedMs: Date.now() - started,
      ...(json.stop_reason ? { finishReason: json.stop_reason } : {}),
      ...(json.usage ? { usage: toUsage(json.usage) } : {}),
    };
  }

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

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        let evt: {
          type?: string;
          delta?: { text?: string; stop_reason?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        try {
          evt = JSON.parse(line.slice(5).trim()) as typeof evt;
        } catch {
          continue;
        }
        if (evt.type === 'content_block_delta' && typeof evt.delta?.text === 'string') {
          text += evt.delta.text;
          req.onDelta?.(evt.delta.text);
        }
        if (evt.type === 'message_delta') {
          if (evt.delta?.stop_reason) finishReason = evt.delta.stop_reason;
          if (evt.usage) usage = toUsage(evt.usage);
        }
      }
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

function toUsage(u: { input_tokens?: number; output_tokens?: number }): TokenUsage {
  const p = u.input_tokens ?? 0;
  const c = u.output_tokens ?? 0;
  return { promptTokens: p, completionTokens: c, totalTokens: p + c };
}
