/**
 * Gemini provider 的**协议形状**测试。
 *
 * ⚠️ 验证等级说明（重要）：
 * 这里跑的是**本地 mock**，不是真的 Google 端点 —— 我没有 Gemini API Key。
 * 所以本文件能证明的是"我们发出去的请求符合 Gemini 文档描述的形状、响应能被正确解析"，
 * **不能证明真实 API 会接受它**。`AnthropicProvider` 至今也是同样状态（一次没真跑过）。
 * 拿到 Key 之前，不要在任何地方写"Gemini 已验证可用"。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, it } from 'node:test';

import { GeminiProvider, toGeminiContents } from './gemini.js';

interface Captured {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let captured: Captured | undefined;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    captured = {
      path: req.url ?? '',
      headers: req.headers,
      body: chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {},
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 16 },
      }),
    );
  });
});
const ready = new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});
after(() => server.close());

const providerFor = async (): Promise<GeminiProvider> =>
  new GeminiProvider({
    id: 'gemini',
    apiKey: 'test-key',
    model: 'gemini-2.0-flash',
    baseUrl: `http://127.0.0.1:${await ready}`,
  });

describe('toGeminiContents —— 消息形状转换（纯函数）', () => {
  it('system 抽到顶层 systemInstruction，不留在 contents 里', () => {
    const r = toGeminiContents([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]);
    assert.equal(r.contents.length, 1);
    assert.equal(r.systemInstruction?.parts[0]?.text, '你是助手');
  });

  it('**assistant 必须变成 model**（Gemini 不认识 assistant）', () => {
    const r = toGeminiContents([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    assert.deepEqual(
      r.contents.map((c) => c.role),
      ['user', 'model'],
    );
  });

  it('多条 system 合并成一条', () => {
    const r = toGeminiContents([
      { role: 'system', content: '一' },
      { role: 'system', content: '二' },
      { role: 'user', content: 'x' },
    ]);
    assert.match(r.systemInstruction?.parts[0]?.text ?? '', /一[\s\S]*二/);
  });
});

describe('GeminiProvider.chat —— 请求形状（打本地 mock，非真实 Google）', () => {
  it('路径带模型名与 :generateContent 动作', async () => {
    const p = await providerFor();
    await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(captured?.path, '/v1beta/models/gemini-2.0-flash:generateContent');
  });

  it('★ 密钥走 x-goog-api-key 头，**不出现在 URL 里**（URL 会进日志）', async () => {
    const p = await providerFor();
    await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(captured?.headers['x-goog-api-key'], 'test-key');
    assert.ok(!captured?.path.includes('test-key'), 'API key 泄漏进了 URL');
  });

  it('★ schema 里的 additionalProperties 必须被剥掉（否则 Gemini 整个请求 400）', async () => {
    const p = await providerFor();
    await p.chat({
      messages: [{ role: 'user', content: 'hi' }],
      schema: {
        name: 'outline',
        schema: {
          type: 'object',
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
          properties: { a: { type: 'string', additionalProperties: false } },
        },
      },
    });
    const gen = captured?.body['generationConfig'] as Record<string, unknown>;
    const sent = JSON.stringify(gen['responseSchema']);
    assert.ok(!sent.includes('additionalProperties'), '嵌套层的 additionalProperties 没剥干净');
    assert.ok(!sent.includes('$schema'));
    assert.equal(gen['responseMimeType'], 'application/json');
  });

  it('usageMetadata 正确映射到 TokenUsage', async () => {
    const p = await providerFor();
    const r = await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.text, '你好');
    assert.equal(r.usage?.promptTokens, 11);
    assert.equal(r.usage?.completionTokens, 5);
    assert.equal(r.usage?.totalTokens, 16);
    assert.equal(r.finishReason, 'STOP');
  });

  it('没配模型时报 LLM_NOT_CONFIGURED，而不是发一个残缺请求出去', async () => {
    // ProviderConfig 要求 model 字段存在，所以"没配"的真实形态是**空串**
    const p = new GeminiProvider({
      id: 'g',
      apiKey: 'k',
      model: '',
      baseUrl: `http://127.0.0.1:${await ready}`,
    });
    await assert.rejects(
      () => p.chat({ messages: [{ role: 'user', content: 'x' }] }),
      /LLM_NOT_CONFIGURED|no model configured/,
    );
  });
});
