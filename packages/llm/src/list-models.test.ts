/**
 * `listModels()` —— **「这家没有模型」与「我没问到」必须分得开**（T-167）。
 *
 * ## 缺陷长什么样
 *
 * 三个 provider 的 `listModels()` 都是这个形状：
 *
 * ```ts
 * async listModels(): Promise<string[]> {
 *   try {
 *     const res = await fetch(...);
 *     if (!res.ok) return [];          // ← 401 / 404 / 500 全变成"没有模型"
 *     ...
 *   } catch {
 *     return [];                        // ← 断网 / DNS 失败 / 超时 全变成"没有模型"
 *   }
 * }
 * ```
 *
 * 于是**四五种完全不同的处境返回同一个 `[]`**，而它们的下一步互相矛盾：
 * Key 错了要**改 Key**，连不上要**查网络/地址**，超时要**重试**，
 * 而真的空列表意味着**这个账号确实没开通模型**。
 * 把它们压成一个空数组，调用方只能说出一句话，而那句话对其中至少三种情况是错的。
 *
 * 这是同族里唯一一条会让用户**做出错误决定**的：他会去换服务商。
 *
 * ## 判据（沿用 T-166 立的那条）
 *
 * > **不是看 errno，是看「这个位置在当前语境下本来就该不该有东西」。**
 *
 * - 对面 200 且真的回了空列表 ⇒ **合法的零**（罕见但可能：新账号没开通任何模型）
 * - 401 / 连不上 / 超时 / 响应形状不对 ⇒ **故障**，且各自的下一步完全不同
 *
 * ## 这些腿钉的不是"返回了错误"
 *
 * 而是**能不能区分为什么空**。只断言 `ok === false` 会被一个笼统的
 * 「加载失败」满足 —— 那只是把一个错的答案换成一个没用的答案。
 * 所以每条都断言到 `code` 与「下一步」（remediation 给不给、给到哪）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchModelList } from './list-models.js';

/** 造一个只回一次的假 fetch。 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(impl(String(url), init))) as unknown as typeof fetch;
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** OpenAI / Anthropic 的 `/models` 形状。 */
const parseOa = (b: unknown): string[] | null => {
  const data = (b as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data.map((m) => (m as { id?: unknown }).id).filter((x): x is string => typeof x === 'string');
};

const base = {
  url: 'https://api.example.com/v1/models',
  providerId: 'example',
  baseUrl: 'https://api.example.com',
  headers: {},
  parse: parseOa,
};

describe('★ T-167 listModels：为什么空，必须说得出来', () => {
  it('★ 真的空列表（200 + data: []）= **合法的零**，不是故障', async () => {
    const r = await fetchModelList({ ...base, fetchImpl: stubFetch(() => jsonRes({ data: [] })) });
    assert.equal(r.ok, true, '对面好好地回了一个空列表，这不是失败');
    assert.deepEqual(r.ok ? r.models : null, []);
  });

  it('正常列表照常返回', async () => {
    const r = await fetchModelList({
      ...base,
      fetchImpl: stubFetch(() => jsonRes({ data: [{ id: 'm-1' }, { id: 'm-2' }, { nope: 1 }] })),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok ? r.models : null, ['m-1', 'm-2']);
  });

  /*
   * ↓ 下面每一条都必须与"真的空列表"**返回值不同**，而且彼此之间也不同 ——
   *   这正是 `return []` 抹掉的信息。
   */

  it('★★ 401 = Key 的问题：既不能说"没有模型"，还要指到能改 Key 的地方', async () => {
    const r = await fetchModelList({
      ...base,
      fetchImpl: stubFetch(() => jsonRes({ error: 'invalid x-api-key' }, 401)),
    });
    assert.equal(r.ok, false, '401 被当成"这家没有模型" —— 用户会去换服务商');
    if (r.ok) return;
    assert.equal(r.error.code, 'LLM_AUTH_FAILED');
    assert.match(r.error.messageZh, /Key/, '要直说是 Key 的问题');
    // 下一步必须是"去改 Key"，而不是一句笼统的加载失败
    assert.equal(r.error.remediation?.action, 'openSettings');
    assert.equal(r.error.retryable, false, 'Key 错了重试多少次都一样');
  });

  it('★ 403 同样归到 Key/权限，不是"没有模型"', async () => {
    const r = await fetchModelList({
      ...base,
      fetchImpl: stubFetch(() => jsonRes({}, 403)),
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? null : r.error.code, 'LLM_AUTH_FAILED');
  });

  it('★★ 连不上（DNS/拒绝连接）= 查网络或地址，且与 401 必须是两回事', async () => {
    const r = await fetchModelList({
      ...base,
      fetchImpl: stubFetch(() => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
          code: 'ENOTFOUND',
        });
      }),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, 'LLM_CONNECTION_FAILED');
    assert.notEqual(r.error.code, 'LLM_AUTH_FAILED', '连不上不该被说成 Key 有问题');
    assert.match(r.error.messageZh, /连不上|网络/);
    assert.equal(r.error.retryable, true, '网络问题值得重试');
  });

  it('★★ 超时 = 重试，且不许和"连不上"混成一个码', async () => {
    const r = await fetchModelList({
      ...base,
      fetchImpl: stubFetch(() => {
        // AbortSignal.timeout() 抛的就是 name='TimeoutError' 的 DOMException
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      }),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, 'LLM_TIMEOUT', '超时有自己的码，下一步是重试');
    assert.equal(r.error.retryable, true);
  });

  it('★ 用户主动取消 ≠ 超时（前者不该当成错误报给用户）', async () => {
    const r = await fetchModelList({
      ...base,
      fetchImpl: stubFetch(() => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }),
    });
    assert.equal(r.ok ? null : r.error.code, 'LLM_ABORTED');
  });

  it('★ 500 = 对面挂了，可重试，也不是"没有模型"', async () => {
    const r = await fetchModelList({ ...base, fetchImpl: stubFetch(() => jsonRes({}, 503)) });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, 'LLM_SERVER_ERROR');
    assert.equal(r.error.retryable, true);
  });

  it('★★ 响应形状不对（地址指错了）= 故障，不是"零个模型"', async () => {
    // 常见现场：baseUrl 少了 /v1，或指到了一个网页
    const r = await fetchModelList({
      ...base,
      fetchImpl: stubFetch(() => jsonRes({ object: 'list', items: [] })),
    });
    assert.equal(r.ok, false, '没有 data 数组说明这压根不是 /models 端点');
    if (r.ok) return;
    assert.equal(r.error.code, 'LLM_BAD_RESPONSE');
    assert.match(r.error.messageZh, /形状|格式|地址/);
  });

  it('★ 返回的根本不是 JSON（网关的 HTML 错误页）= 故障', async () => {
    const r = await fetchModelList({
      ...base,
      fetchImpl: stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 200 })),
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? null : r.error.code, 'LLM_BAD_RESPONSE');
  });

  /**
   * ⚠️ **这条钉的是"能不能区分"本身**，而不是任何单条的取值。
   *
   * 缺陷的本质是**信息被压平**：五种处境映射到同一个 `[]`。
   * 所以这里把五种处境跑一遍，要求它们的「结论 + 下一步」两两不同。
   * 只要有人再把某两种合并回同一个答案，这条就会红 ——
   * 而逐条断言 code 的那些腿未必抓得到"合并"。
   */
  it('★★★ 五种处境的「结论 + 下一步」必须两两可辨（不许再被压成同一个答案）', async () => {
    const cases: Array<[string, typeof fetch]> = [
      ['真的空', stubFetch(() => jsonRes({ data: [] }))],
      ['401', stubFetch(() => jsonRes({}, 401))],
      [
        '连不上',
        stubFetch(() => {
          throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        }),
      ],
      [
        '超时',
        stubFetch(() => {
          throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        }),
      ],
      ['形状不对', stubFetch(() => jsonRes({ items: [] }))],
    ];

    const seen = new Map<string, string>();
    for (const [name, fetchImpl] of cases) {
      const r = await fetchModelList({ ...base, fetchImpl });
      // 「用户看到什么 + 该点什么」的指纹
      const fingerprint = r.ok
        ? `ok:${r.models.length}`
        : `${r.error.code}|${r.error.remediation?.action ?? '无按钮'}|${String(r.error.retryable)}`;
      const clash = [...seen.entries()].find(([, f]) => f === fingerprint);
      assert.equal(
        clash,
        undefined,
        `「${name}」与「${clash?.[0] ?? ''}」给出了同一个答案（${fingerprint}）—— ` +
          `这正是 return [] 的病：不同的处境要有不同的下一步`,
      );
      seen.set(name, fingerprint);
    }
    assert.equal(seen.size, 5);
  });

  /**
   * ⚠️ **前提锚点**：假 fetch 真的被用上了。
   *
   * 没有这一条，上面所有用例都可能是在"根本没发请求"的情况下通过的 ——
   * 而那种通过什么也不证明（T-166 那轮我已经吃过一次假红，这次先把假绿堵掉）。
   */
  it('★ 前提成立：注入的 fetch 真的被调用了，且打在正确的 URL 上', async () => {
    const calls: string[] = [];
    const r = await fetchModelList({
      ...base,
      fetchImpl: stubFetch((url) => {
        calls.push(url);
        return jsonRes({ data: [{ id: 'x' }] });
      }),
    });
    assert.deepEqual(calls, ['https://api.example.com/v1/models'], '请求没发出去或发错了地方');
    assert.equal(r.ok, true);
  });
});
