/**
 * 列模型：**「这家没有模型」与「我没问到」是两回事**（T-167）。
 *
 * ## 修之前
 *
 * 三个 provider 的 `listModels()` 各自写着同一个形状：
 *
 * ```ts
 * if (!res.ok) return [];   // 401 / 404 / 500 → "没有模型"
 * } catch { return []; }     // 断网 / DNS 失败 / 超时 → "没有模型"
 * ```
 *
 * 于是至少五种处境被压成同一个 `[]`。而它们的下一步**互相矛盾**：
 *
 * | 真实处境 | 用户该做的 |
 * |---|---|
 * | 200 + 空列表 | 这个账号确实没开通模型 —— 去服务商那边开通 |
 * | 401 / 403 | **改 Key** |
 * | 连不上 / DNS 失败 | 查网络，或地址填错了 |
 * | 超时 | 重试 |
 * | 响应形状不对 | 地址指到了不是 `/models` 的地方 |
 *
 * 全都渲染成「这个服务商没有模型」的话，用户会**去换服务商** ——
 * 这是这一族缺陷里唯一一条会让人做出**错误决定**的。
 *
 * ## 判据（沿用 T-166 立的那条）
 *
 * > **不是看 errno，是看「这个位置在当前语境下本来就该不该有东西」。**
 *
 * 对面**好好地**回了一个空列表 ⇒ 那就是真的零，合法（罕见但可能）。
 * 只要"好好地回答"这个前提没成立（HTTP 错、网络错、形状不对），就**不是零，是没问到**。
 *
 * ⚠️ **注意与 `apps/daemon/src/llm/enumerate.ts` 的差异，别去"统一"**：
 * 那边（用户点「刷新模型列表」的那条路）**把 0 个也判成失败**，理由写在它自己的注释里
 * —— 在那个语境下，空下拉会被用户读成"我的账号没有模型"，而真实原因多半是地址配错。
 * 那是一个**产品决策**（宁可多问一句），而这里是**库的原语**，职责是如实转述对面说了什么。
 * 两者都对，因为语境不同；谁去把它们抹平，谁就会毁掉其中一个。
 *
 * ## 关于"要不要给可点的按钮"
 *
 * `apps/web/src/lib/remediation/routes.ts` 记着 26 个调用点里 **23 个刻意不给按钮**，
 * 「给一个点了没用的按钮，比不给按钮更糟」。逐条判过：
 *
 * - **401/403 → 给**（`openSettings` → `/models?tab=llm`，Key 输入框就在那儿）。
 *   Key 错了是**用户能自己修好**的，而且落点明确。
 * - **连不上 → 给**（`checkLocalBackend` → 同一页，baseUrl 也在那儿配）。
 * - **超时 / 5xx / 429 → 不给**：下一步是"再试一次 / 等一会"，那是就地动作不是跳转，
 *   `retryable` 已经表达了。
 * - **形状不对 → 不给**：沿用既有 `LLM_BAD_RESPONSE` 的处理（它一直没有按钮）。
 *   话已经说清了"这不像 /models 端点"，而"该改成什么地址"我们并不知道，
 *   给一个跳转按钮等于假装我们知道。
 *
 * 这两条动作名都是**既有的**、且都已在 `REMEDIATION_ROUTES` 里认领过，
 * 所以不引入新的"发得出却没人接"的引导（那道守卫在 `routes.test.ts`，它扫 `packages/llm/src`）。
 */
import { LlmError, mapHttpError, mapNetworkError } from './errors.js';
import type { ListModelsResult } from './types.js';

/** 默认 10 秒。列模型是个交互动作，用户在等，不能像 chat 那样给 120 秒。 */
const DEFAULT_LIST_TIMEOUT_MS = 10_000;

export interface FetchModelListOptions {
  /** 完整的 `/models` 地址。 */
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly providerId: string;
  /** 只用于错误文案（"连不上 <baseUrl>"）。 */
  readonly baseUrl: string;
  /**
   * 把响应体解析成模型名数组。
   * **返回 `null` 表示"形状不对"** —— 那不是"零个模型"，是"这地方不是 /models"。
   */
  readonly parse: (body: unknown) => string[] | null;
  readonly timeoutMs?: number;
  /** 注入点：测试用它精确构造 401 / 断网 / 超时 / 形状不对，而不是起真服务器。 */
  readonly fetchImpl?: typeof fetch;
}

export async function fetchModelList(opts: FetchModelListOptions): Promise<ListModelsResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.url, {
      headers: opts.headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS),
    });
  } catch (err) {
    // 断网 / DNS / 拒绝连接 / 超时 / 取消 —— 各自映射到各自的码与下一步
    return { ok: false, error: mapNetworkError(err, opts.providerId, opts.baseUrl) };
  }

  if (!res.ok) {
    // 401→改 Key、429→等、5xx→重试，全都已经在 mapHttpError 里分好了
    return {
      ok: false,
      error: mapHttpError(res.status, await res.text().catch(() => ''), opts.providerId),
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: new LlmError(
        'LLM_BAD_RESPONSE',
        `models endpoint returned non-JSON from ${opts.providerId}`,
        `模型列表接口返回的不是 JSON —— 多半是地址（${opts.baseUrl}）指到了别的东西`,
        false,
        undefined,
        err,
      ),
    };
  }

  const models = opts.parse(body);
  if (models === null) {
    return {
      ok: false,
      error: new LlmError(
        'LLM_BAD_RESPONSE',
        `unexpected /models shape from ${opts.providerId}`,
        `模型列表的响应格式不对（${opts.baseUrl}）—— 这个地址多半不是模型列表接口`,
        false,
      ),
    };
  }

  /*
   * 走到这里：对面 200、JSON 合法、形状正确。**此时的空数组是真的零**，
   * 是一个合法答案，不是失败。这一行就是"合法的零"与"没问到"的分界线。
   */
  return { ok: true, models };
}

/** OpenAI 兼容与 Anthropic 共用的 `{ data: [{ id }] }` 形状。 */
export function parseDataIdList(body: unknown): string[] | null {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data
    .map((m) => (m as { id?: unknown }).id)
    .filter((x): x is string => typeof x === 'string');
}
