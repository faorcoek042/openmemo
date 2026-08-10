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
      /*
       * ⚠️ 这里原本挂着 （原 action 名 “reduceChunkSize” ），而**界面上没有任何地方能改分段大小**
       * （全 web 搜不到 chunkSize 控件）。于是 `RemediationButton` 在
       * `!onAct && target === null` 时返回 null —— **产品叫用户"去调小分段"，
       * 却一个按钮都不渲染**。
       *
       * 用户 2026-08-09 裁决：**能解决就补按钮，解决不了就删掉引导**。
       * 这一条解决不了（没有那个控件），所以**去掉行动号召，保留诊断文案** ——
       * 而且这句话本身已经说了产品会自己处理（「将自动分段处理」），
       * 用户本来就不需要做任何事。留着一个点不出来的动作，只会让他以为自己漏了一步。
       */
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
  /*
   * ★ 超时必须有**自己**的码（T-167）。
   *
   * `AbortSignal.timeout()` 抛的是 `name === 'TimeoutError'` 的 DOMException，
   * 而不是 `AbortError`。此前这里没有这一支，于是超时掉进最下面那个
   * `LLM_CONNECTION_FAILED`，和"连不上"说同一句话 —— 可这两件事的下一步不一样：
   * 连不上多半是**地址或网络配错了**（要去改），超时多半是**这一次慢了**（重试就行）。
   *
   * 刻意**不给**可点的下一步：唯一有意义的动作是"再试一次"，那是就地动作，
   * 不是跳转；`remediation/routes.ts` 记着 26 个调用点里 23 个刻意不给按钮，
   * 理由是「给一个点了没用的按钮，比不给按钮更糟」。`retryable: true` 已经把
   * "可以重试"这件事说清楚了。
   */
  if (e?.name === 'TimeoutError') {
    return new LlmError(
      'LLM_TIMEOUT',
      `timeout talking to ${baseUrl}`,
      `连接 LLM 服务超时（${baseUrl}），可以重试`,
      true,
    );
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
