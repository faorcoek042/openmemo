/**
 * **写进去 = 读回来** 的通用回归断言。
 *
 * 这个形状今天已经是第四次了：`textRaw`、`words`、`installPath`、`settings` ——
 * 全都是「写得进 / 声明了，但读不回 / 不执行」，而且**全都不会让任何测试变红**，
 * 只会让功能安静地不工作。所以这里不是只测 `settings` 这一个 bug，
 * 而是把「PATCH 什么，GET 就必须原样读到什么」这条性质本身钉成断言。
 *
 * 覆盖两种请求形状是刻意的：`GET` 回的是信封 `{settings:{…}}`，
 * 把它原样 `PATCH` 回去是最自然的用法，**必须能往返**，
 * 否则就会造出一个字面叫 `settings` 的键（正是这次的 bug）。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startDaemon } from '../../main.js';

let base = '';
let token = '';
let stop: (() => Promise<void>) | undefined;

before(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'om-settings-rt-'));
  const port = 17_600 + Math.floor(Math.random() * 300);
  const d = await startDaemon({ port, dataDir: dir, maxPort: port + 40 });
  base = `http://127.0.0.1:${d.port}`;
  token = d.token;
  stop = d.stop;
});
after(async () => {
  await stop?.();
});

const H = (): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function patch(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: H(), body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function getSettings(): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}/api/settings`, { headers: H() });
  const body = (await r.json()) as { settings: Record<string, unknown> };
  return body.settings;
}

describe('PATCH /api/settings —— 写什么读回来必须是什么', () => {
  it('扁平形状：键名逐字相同，值原样', async () => {
    const res = await patch({ 'llm.defaultProviderId': 'deepseek', 'llm.defaultModelId': 'deepseek-chat' });
    assert.equal(res.status, 200);
    const got = await getSettings();
    assert.equal(got['llm.defaultProviderId'], 'deepseek');
    assert.equal(got['llm.defaultModelId'], 'deepseek-chat');
  });

  it('★ 信封形状（把 GET 的结果原样 PATCH 回去）必须往返，且**不产生嵌套**', async () => {
    const res = await patch({ settings: { 'llm.baseUrl.deepseek': 'https://api.deepseek.com' } });
    assert.equal(res.status, 200);
    const got = await getSettings();
    assert.equal(got['llm.baseUrl.deepseek'], 'https://api.deepseek.com');
    // 这一条才是真正的回归点：曾经这里会多出一个字面叫 settings 的键
    assert.ok(!('settings' in got), '产生了嵌套的 settings 键');
  });

  it('★ 双层信封必须**明确报错**，而不是静默存成坏数据', async () => {
    const res = await patch({ settings: { settings: { 'a.b': 1 } } });
    assert.equal(res.status, 400);
    assert.equal((res.json['error'] as { code: string }).code, 'BAD_SETTING_KEY');
  });

  it('GET 的输出可以直接喂回 PATCH（往返幂等）', async () => {
    const before = await getSettings();
    const res = await patch({ settings: before });
    assert.equal(res.status, 200);
    const after = await getSettings();
    assert.deepEqual(after, before);
  });

  it('null 是合法值（清空），不能被当成 undefined 拒掉', async () => {
    await patch({ 'llm.defaultModelId': null });
    const got = await getSettings();
    assert.ok('llm.defaultModelId' in got);
    assert.equal(got['llm.defaultModelId'], null);
  });
});

describe('PUT /api/secrets/:key —— 密钥写入链路', () => {
  it('写入后 GET 能看到该键（值永远只回掩码）', async () => {
    const r = await fetch(`${base}/api/secrets/llm.deepseek.apiKey`, {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ value: 'sk-abcdef123456' }),
    });
    assert.equal(r.status, 200);
    const list = (await (await fetch(`${base}/api/secrets`, { headers: H() })).json()) as {
      secrets: Array<{ key: string; masked: string }>;
    };
    const hit = list.secrets.find((s) => s.key === 'llm.deepseek.apiKey');
    assert.ok(hit, '写进去的密钥读不回来');
    // 明文绝不能出现在响应里
    assert.ok(!hit.masked.includes('abcdef'), '掩码泄漏了明文');
  });
});

/**
 * CSRF 同源兜底（ADR 裁决）的**边界**测试。
 *
 * 兜底本身能过很容易测；真正要钉住的是**它不该救哪些情况** ——
 * 否则日后有人"顺手放宽一点"，兜底就悄悄变成了"CSRF 形同虚设"。
 */
describe('CSRF 同源兜底 —— 放行一种，拒绝四种', () => {
  let cookie = '';
  let csrf = '';
  const origin = (): string => base;
  const host = (): string => base.replace('http://', '');

  before(async () => {
    const r = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    csrf = ((await r.json()) as { csrf: string }).csrf;
  });

  const write = async (h: Record<string, string>): Promise<number> => {
    const r = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json', ...h },
      body: JSON.stringify({ 'ui.probe': Date.now() }),
    });
    return r.status;
  };

  it('无 CSRF 头 + 严格同源 + Sec-Fetch-Site:same-origin → 放行', async () => {
    assert.equal(await write({ Origin: origin(), 'Sec-Fetch-Site': 'same-origin' }), 200);
  });

  it('★ 带了**错的** CSRF 头 → 仍然拒绝（兜底不救它）', async () => {
    assert.equal(
      await write({ Origin: origin(), 'Sec-Fetch-Site': 'same-origin', 'x-openmemo-csrf': 'WRONG' }),
      403,
    );
  });

  it('★ Sec-Fetch-Site: cross-site → 拒绝', async () => {
    assert.equal(await write({ Origin: origin(), 'Sec-Fetch-Site': 'cross-site' }), 403);
  });

  it('★ Origin 与 Host 不同源 → 拒绝', async () => {
    assert.equal(await write({ Origin: 'http://evil.example' }), 403);
  });

  it('★ 完全没有 Origin（无从证明同源）→ 拒绝', async () => {
    assert.equal(await write({}), 403);
  });

  it('带正确 CSRF 头 → 放行（正常路径不受影响）', async () => {
    assert.equal(await write({ 'x-openmemo-csrf': csrf, Origin: origin() }), 200);
    assert.ok(host().length > 0);
  });
});
