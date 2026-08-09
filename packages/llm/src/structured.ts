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

  /*
   * ⚠️ 截断专项检测 —— **必须在扫描内层对象之前**（T-023 实测踩到的坑）。
   *
   * 输出被 max_tokens 截断时形如：
   *   {"topics":[{"title":"X","seg":[0],"points":[{"text":"Y","seg":[0]}]}
   * 最外层的 `{` 永远不闭合。若先跑 findBalancedJson，它会**继续往后扫**，
   * 命中内层那个恰好闭合的 `{"text":"Y",...}` 并"成功"返回 ——
   * 调用方于是拿到一个合法但结构不对的对象，报出 "缺少 topics 数组"，
   * 把人往"模型不听话"的方向带，**而真正原因是 token 不够**。
   *
   * 这个顺序错误我自己先写反过一次，是测试逼出来的：
   * 顺序反了不会让任何用例变红，只会让错误信息误导人。
   */
  const first = trimmed[0];
  if ((first === '{' || first === '[') && !isBalanced(trimmed)) {
    throw new LlmError(
      'LLM_STRUCTURED_OUTPUT_FAILED',
      `model output looks truncated (unbalanced JSON, ${trimmed.length} chars). ` +
        `Raise maxTokens or reduce the requested output size. Tail: ${trimmed.slice(-120)}`,
      'LLM 输出被截断（JSON 未闭合）——通常是 max_tokens 不够，或要求它输出的内容太多。已自动重试；若反复出现，换一个上下文更大的模型',
      true,
      /*
       * ⚠️ 原本挂着 （原 action 名 “increaseMaxTokens” ），而 `maxTokens` 是本仓
       * **刻意不给控件**的字段之一：`LlmSettingsSection.tsx:491` 明写
       * 「目录声明了、但我们存不下也不会发出去…不给控件（一个改了不生效的输入框是假控件）」。
       * 也就是说这条引导**在结构上永远无处可点**，`RemediationButton` 对它返回 null。
       *
       * 按用户 2026-08-09 的裁决删掉行动号召，但**诊断信息不能一起删**（§13）：
       * 把"能做什么"并进文案本身（已自动重试 / 反复出现就换个更大的模型）——
       * 换模型是用户**真的做得到**的事，而它在 `/models?tab=llm` 上有控件。
       */
    );
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

/** 整串的括号是否闭合（同样要跳过字符串字面量与转义）。 */
function isBalanced(s: string): boolean {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
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
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if (open !== (ch === '}' ? '{' : '[')) return false;
    }
  }
  return stack.length === 0 && !inString;
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
