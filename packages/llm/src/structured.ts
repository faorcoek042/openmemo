/**
 * 结构化输出：解析 + 校验 + 重试。
 *
 * **为什么不能只依赖 `response_format`**（T-023 实测，llama-server b10223 + Qwen3-0.6B）：
 *
 * | 模式 | 实测结果 |
 * |---|---|
 * | `json_schema` | ✅ **真正的语法约束**，输出 `{"name":"Lucas","age":25}`，`JSON.parse` 直接通过 |
 * | `json_object` | ⚠️ HTTP 200 但**不强制**：实际输出 ```` ```json\n{"a": 1}\n``` ````，**带 markdown 围栏，parse 失败** |
 * | 不支持 | 只能靠 prompt 约束 |
 *
 * → 所以**任何情况下都必须做鲁棒提取**（剥围栏、找首个平衡的 JSON 对象），
 *   而不是天真地 `JSON.parse(text)`。
 */
import { LlmError } from './errors.js';
import type { ChatRequest, ChatResult, LlmProvider } from './types.js';

/**
 * 从模型输出里鲁棒地提取 JSON。
 *
 * 依次尝试：
 *   1. 直接 parse
 *   2. 剥 ```json … ``` / ``` … ``` 围栏
 *   3. 扫描出第一个**括号平衡**的 `{…}` 或 `[…]`（能正确跳过字符串里的括号与转义）
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试 */
  }

  // 剥 markdown 围栏 —— 实测 json_object 模式下最常见的失败形态
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 继续 */
    }
  }

  const balanced = findBalancedJson(trimmed);
  if (balanced !== undefined) {
    try {
      return JSON.parse(balanced);
    } catch {
      /* 继续 */
    }
  }

  throw new LlmError(
    'LLM_STRUCTURED_OUTPUT_FAILED',
    `cannot extract JSON from model output: ${trimmed.slice(0, 200)}`,
    'LLM 没有返回合法的 JSON',
    true,
  );
}

/**
 * 扫描第一个括号平衡的 JSON 值。
 * 必须正确处理字符串字面量与转义 —— 否则 `{"a":"}"}`  会被截断在错误位置。
 */
function findBalancedJson(s: string): string | undefined {
  for (let start = 0; start < s.length; start++) {
    const open = s[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        if (inString) escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

export interface StructuredOptions<T> {
  /** 校验 + 归一化。抛出的错误信息会被回灌给模型作为修复提示。 */
  readonly parse: (raw: unknown) => T;
  /** 最多重试几次（含首次）。默认 3。 */
  readonly maxAttempts?: number;
  /** 每次重试前的回调，便于上报进度/日志。 */
  readonly onRetry?: (attempt: number, error: Error) => void;
}

export interface StructuredResult<T> {
  readonly value: T;
  readonly attempts: number;
  readonly raw: string;
  readonly usage: ChatResult['usage'];
  readonly elapsedMs: number;
}

/**
 * 带校验与自修复重试的结构化调用。
 *
 * 失败时把**具体的校验错误**回灌给模型（而不是笼统地说"格式不对"）——
 * 这是让小模型也能产出合法结构的关键。
 */
export async function chatStructured<T>(
  provider: LlmProvider,
  req: ChatRequest,
  opts: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const messages = [...req.messages];
  let lastError: Error | undefined;
  let totalElapsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await provider.chat({ ...req, messages });
    totalElapsed += res.elapsedMs;

    try {
      const raw = extractJson(res.text);
      const value = opts.parse(raw);
      return {
        value,
        attempts: attempt,
        raw: res.text,
        usage: res.usage,
        elapsedMs: totalElapsed,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      opts.onRetry?.(attempt, lastError);
      if (attempt === maxAttempts) break;

      // 把模型的原输出和具体错误一起回灌 —— 让它知道错在哪，而不是重掷骰子
      messages.push({ role: 'assistant', content: res.text.slice(0, 2000) });
      messages.push({
        role: 'user',
        content:
          `上面的输出无法使用，错误是：${lastError.message}\n` +
          `请只输出**符合要求的纯 JSON**，不要加 markdown 代码围栏，不要任何解释文字。`,
      });
    }
  }

  throw new LlmError(
    'LLM_STRUCTURED_OUTPUT_FAILED',
    `structured output failed after ${maxAttempts} attempts: ${lastError?.message ?? 'unknown'}`,
    `LLM 连续 ${maxAttempts} 次未能产出合法结构（${lastError?.message ?? '未知原因'}）`,
    true,
    { action: 'retryWithLargerModel' },
  );
}
