/**
 * LLM 错误分类与到 `ApiErrorBody.remediation` 的映射（D-01 §7.1 / ADR-007 决策 2）。
 *
 * **为什么 remediation 不是锦上添花**：章程要求 2.1「用户不碰命令行」直接依赖它。
 * 错误若只能给一段文字，用户还是得去查文档；有了机器可读的动作，UI 才能渲染成一个按钮。
 */

export type LlmErrorCode =
  | 'LLM_NOT_CONFIGURED'
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_CONTEXT_EXCEEDED'
  | 'LLM_TIMEOUT'
  | 'LLM_CONNECTION_FAILED'
  | 'LLM_SERVER_ERROR'
  | 'LLM_BAD_RESPONSE'
  | 'LLM_STRUCTURED_OUTPUT_FAILED'
  | 'LLM_ABORTED';

export interface Remediation {
  readonly action: string;
  readonly params?: Record<string, unknown>;
}

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly messageZh: string,
    readonly retryable: boolean,
    readonly remediation?: Remediation,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  /** 转成 `packages/shared` 的 `ApiErrorBody` 形状。 */
  toApiError(): {
    error: {
      code: string;
      message: string;
      messageZh: string;
      retryable: boolean;
      remediation?: Remediation;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        messageZh: this.messageZh,
        retryable: this.retryable,
        ...(this.remediation ? { remediation: this.remediation } : {}),
      },
    };
  }
}

/** 把 HTTP 状态码 + 响应体映射成带 remediation 的错误。 */
export function mapHttpError(status: number, body: string, providerId: string): LlmError {
  const snippet = body.slice(0, 400);

  if (status === 401 || status === 403) {
    return new LlmError(
      'LLM_AUTH_FAILED',
      `auth failed (${status}) from ${providerId}: ${snippet}`,
      'API Key 无效或已过期',
      false,
      { action: 'openSettings', params: { section: 'llm', providerId } },
    );
  }
  if (status === 429) {
    return new LlmError(
      'LLM_RATE_LIMITED',
      `rate limited by ${providerId}: ${snippet}`,
      '调用频率超限，稍后会自动重试',
      true,
      { action: 'wait' },
    );
  }
  // 云厂商普遍用 400 + "context length" 报上下文超限
  if (
    status === 400 &&
    /context.{0,20}(length|window)|too many tokens|maximum context/i.test(body)
  ) {
    return new LlmError(
      'LLM_CONTEXT_EXCEEDED',
      `context exceeded on ${providerId}: ${snippet}`,
      '转写稿超出模型上下文窗口，将自动分段处理',
      false,
      { action: 'reduceChunkSize' },
    );
  }
  if (status >= 500) {
    return new LlmError(
      'LLM_SERVER_ERROR',
      `upstream ${status} from ${providerId}: ${snippet}`,
      'LLM 服务暂时不可用',
      true,
    );
  }
  return new LlmError(
    'LLM_BAD_RESPONSE',
    `unexpected ${status} from ${providerId}: ${snippet}`,
    `LLM 返回了意外的响应（HTTP ${status}）`,
    false,
  );
}

/** 网络层错误（连不上、超时、被取消）。 */
export function mapNetworkError(err: unknown, providerId: string, baseUrl: string): LlmError {
  const e = err as { name?: string; code?: string; message?: string };

  if (e?.name === 'AbortError') {
    // 区分"用户取消"与"超时" —— 前者不该重试也不该报错给用户
    return new LlmError('LLM_ABORTED', 'request aborted', '请求已取消', false);
  }
  if (e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' || e?.code === 'EHOSTUNREACH') {
    return new LlmError(
      'LLM_CONNECTION_FAILED',
      `cannot reach ${baseUrl}: ${e.code}`,
      `连不上 LLM 服务（${baseUrl}）`,
      true,
      { action: 'checkLocalBackend', params: { providerId, baseUrl } },
    );
  }
  return new LlmError(
    'LLM_CONNECTION_FAILED',
    `network error to ${baseUrl}: ${e?.message ?? String(err)}`,
    '网络错误，无法访问 LLM 服务',
    true,
    { action: 'checkLocalBackend', params: { providerId, baseUrl } },
    err,
  );
}

export function notConfiguredError(): LlmError {
  return new LlmError(
    'LLM_NOT_CONFIGURED',
    'no LLM provider configured',
    '尚未配置 LLM。可以填一个 API Key，或安装本地模型。',
    false,
    { action: 'openSettings', params: { section: 'llm' } },
  );
}
