/**
 * T-153 —— `POST /api/llm/detect` 与 `POST /api/llm/models` **真的在路由表里**。
 *
 * ## 这条钉的是什么
 *
 * `frontend-truth` T-150 的 D-10 六项里，第 6 项（#3 探测式本地模型）**整条卡死**，
 * 理由一句话：`POST /api/llm/detect` 不存在（它 grep 过 daemon 的 46 条路由）。
 * 而 `detectLocalBackends()` 早就写好了，只是只在 `jobs/runners/mindmap.ts` 与
 * `rest/selfcheck.ts` **内部**被调用 —— 前端够不着。
 * 「后端做好了、前端够不着」正是 HANDOFF ⑤D 那一族（已经四次）。
 *
 * 所以第一条断言就是最笨的那条：**它不是 404**。
 * 一个"端点存在"的断言看起来不值得写，但它恰恰是这次卡住的全部内容。
 *
 * ## 判据取"后果"，不取"字段存在"
 *
 * - detect：`probed` 必须**逐条列出探过哪几个地址**。只回 `detected: []` 的话，
 *   界面只能说"没探到"，用户分不清"我的 Ollama 换过端口"和"我压根没装"。
 *   ⑤A-2 同族：**空集必须自带它的量程**。
 * - models：对 `official-doc` 的那 20 家**必须显式拒绝并说明原因**，
 *   而不是回一个空清单假装成功（那会变成"刷新完下拉空了"，用户以为自己账号没模型）。
 *
 * ## 网络纪律
 *
 * 本文件**不发任何外网请求**。detect 打的是三个本机回环端口（探不到就是探不到，
 * 那正是干净机器上的正常结果）；models 只测两条**不需要联网就能判定**的分支
 * （目录里没有这家 / 这家没有可枚举端点）。真正会出网的那条走注入 fetch 的单测，
 * 见本文件末尾的 `listProviderModels` 一组。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startDaemon } from '../../main.js';
import {
  __resetProviderCatalogCache,
  listProviderModels,
  modelsEndpointFor,
} from '../../llm/enumerate.js';
import { resolveManifestDir } from './manifests.js';

import type { LlmDetectResponse } from '@openmemo/shared';

let base = '';
let token = '';
let stop: (() => Promise<void>) | undefined;

before(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'om-llm-routes-'));
  /*
   * 19xxx 段（见 `testPorts.test.ts`）：避开用户真实实例的 17650。
   * ⚠️ 基数还必须与别的测试文件隔开 ≥30 —— node:test 一个文件一个子进程、并行跑。
   * 第一版取 19_880，与 `noteDetailContract.test.ts` 的 19860 只隔 20，
   * **那条护栏当场把我抓了**（它就是为这件事写的）。
   */
  const port = 19_800 + Math.floor(Math.random() * 10);
  const d = await startDaemon({ port, dataDir: dir, maxPort: port + 20 });
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

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: H(),
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

describe('POST /api/llm/detect —— 档 2 的入口终于存在了', () => {
  it('★ 它不是 404（T-150 卡死的全部内容就是这一条）', async () => {
    const r = await post('/api/llm/detect', {});
    assert.notEqual(
      r.status,
      404,
      'POST /api/llm/detect 又不见了 —— 没有它，D-10 #3 的「探测本机」只能是个假按钮',
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  it('★ 必须回「探过哪几个」，不能只回「探到了哪几个」', async () => {
    const r = await post('/api/llm/detect', {});
    const body = r.json as unknown as LlmDetectResponse;

    /*
     * 这条守卫挡的是"候选表被清空 ⇒ 下面几条恒真"，
     * **它不碰 `detected`** —— `detected` 恰恰是允许为空的那个量
     * （干净机器上就是空的），把非空守卫加在它上面就会在正常情况下炸掉。
     * `pack-publish` 因为这个错犯过两次，这里明写一遍。
     */
    assert.equal(body.probed.length >= 3, true, `只探了 ${String(body.probed.length)} 个候选`);

    const ids = body.probed.map((c) => c.id).sort();
    assert.deepEqual(ids, ['llama-server', 'lmstudio', 'ollama']);
    for (const c of body.probed) {
      assert.equal(/^https?:\/\/127\.0\.0\.1:\d+/.test(c.baseUrl), true, `${c.id}: ${c.baseUrl}`);
      assert.equal(c.label.length > 0, true, `${c.id} 没有可显示的名字`);
    }
  });

  it('★ 超时值随响应回去 —— 界面据此说「各 N 秒超时」，不许把秒数抄进文案', async () => {
    const body = (await post('/api/llm/detect', {})).json as unknown as LlmDetectResponse;
    assert.equal(typeof body.timeoutMs, 'number');
    assert.equal(body.timeoutMs > 0 && body.timeoutMs <= 5000, true, String(body.timeoutMs));
  });

  it('★ 探到的每一条都必须带着"至少一个模型" —— 端口开着不算数', async () => {
    const body = (await post('/api/llm/detect', {})).json as unknown as LlmDetectResponse;
    /*
     * 干净机器上 `detected` 是空的，这条自然成立。**它钉的是不变量而不是今天的取值** ——
     * 判据本身在 `packages/llm/src/detect.ts`（"data 里至少有一个模型"），
     * 这里保证路由层没有在往外发的时候把它放宽。
     * `detected ⊆ probed` 那一半也一起断，免得将来有人往里塞一条没探过的。
     */
    const probedIds = new Set(body.probed.map((c) => c.id));
    for (const d of body.detected) {
      assert.equal(d.models.length > 0, true, `${d.id} 被报成可用，却一个模型都没有`);
      assert.equal(probedIds.has(d.id), true, `${d.id} 不在候选表里`);
    }
  });

  it('GET 不行 —— 它会真去敲三个端口，不该被预取/缓存/重放', async () => {
    const r = await fetch(`${base}/api/llm/detect`, { headers: H() });
    assert.equal(r.status, 405);
  });
});

describe('POST /api/llm/models —— 「刷新模型列表」的另一半', () => {
  it('★ 它不是 404（没有它，#26 那个按钮做出来也按不动）', async () => {
    const r = await post('/api/llm/models', { providerId: 'deepseek' });
    assert.notEqual(r.status, 404, 'POST /api/llm/models 不存在');
  });

  it('★ 人工转录清单的那 20 家：必须明确拒绝并说明原因，不许回空清单假装成功', async () => {
    const r = await post('/api/llm/models', { providerId: 'deepseek' });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    const err = (r.json as { error?: { code?: string; messageZh?: string } }).error;
    assert.equal(err?.code, 'PROVIDER_NOT_ENUMERABLE');
    /*
     * 钉"说了什么"而不是"有没有文案"：这一档的全部价值是让用户知道
     * **不用再点了**（这家的清单本来就是人工从文档转录的），
     * 而不是让他以为网络出了问题去反复重试。
     */
    assert.equal(
      (err?.messageZh ?? '').includes('自定义'),
      true,
      `拒绝文案没给出下一步：${err?.messageZh ?? ''}`,
    );
  });

  it('目录里没有这家 → 404，并指向「自定义…」', async () => {
    const r = await post('/api/llm/models', { providerId: 'my-private-gateway' });
    assert.equal(r.status, 404);
    assert.equal(
      (r.json as { error?: { code?: string } }).error?.code,
      'PROVIDER_UNKNOWN',
      JSON.stringify(r.json),
    );
  });

  it('缺 providerId → 400，而不是拿一个空字符串去打网络', async () => {
    const r = await post('/api/llm/models', {});
    assert.equal(r.status, 400);
    assert.equal((r.json as { error?: { code?: string } }).error?.code, 'BAD_REQUEST');
  });
});

describe('listProviderModels —— 出网那条走注入 fetch，本机不联网', () => {
  const manifestDir = resolveManifestDir();
  /** 只用到 `settings` 表的读；这里给一个不含该表的假句柄，让它走 catch → undefined。 */
  const db = {
    prepare: () => ({
      get: () => {
        throw new Error('no settings table in this stub');
      },
    }),
  } as never;

  it('前提自检：目录真的读得到，且里面真有 4 家可枚举（读不到会让下面几条恒真）', async () => {
    __resetProviderCatalogCache();
    const { loadProviderCatalog } = await import('../../llm/enumerate.js');
    const cat = await loadProviderCatalog(manifestDir);
    assert.notEqual(cat, null, `读不到 llm-providers.json（manifestDir=${manifestDir}）`);
    const enumerable = (cat?.providers ?? []).filter(
      (p) => p.modelListSource.type !== 'official-doc',
    );
    assert.deepEqual(
      enumerable.map((p) => p.id).sort(),
      ['lmstudio', 'ollama', 'openrouter', 'siliconcloud'],
    );
  });

  it('★ Ollama 的地址要补 `/v1` —— 目录给的是原生 API 的根，不是 OpenAI 兼容面', async () => {
    const { loadProviderCatalog } = await import('../../llm/enumerate.js');
    const cat = await loadProviderCatalog(manifestDir);
    const ollama = cat?.providers.find((p) => p.id === 'ollama');
    assert.notEqual(ollama, undefined);
    assert.equal(modelsEndpointFor(ollama!), 'http://127.0.0.1:11434/v1/models');
    // 用户已经把 `/v1` 写进设置里时不许再补一次
    assert.equal(
      modelsEndpointFor(ollama!, 'http://127.0.0.1:11434/v1'),
      'http://127.0.0.1:11434/v1/models',
    );
  });

  it('★ 枚举到 0 个算失败 —— 空下拉会被读成"我的账号没有模型"', async () => {
    const out = await listProviderModels(db, '/tmp/om-llm-enum-nonexistent', manifestDir, 'openrouter', {
      fetchImpl: (() =>
        Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))) as never,
    });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure.kind, 'request-failed');
  });

  it('正常响应：去重 + 排序', async () => {
    const out = await listProviderModels(db, '/tmp/om-llm-enum-nonexistent', manifestDir, 'openrouter', {
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }] }),
            { status: 200 },
          ),
        )) as never,
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.ok === true ? out.value.models : [], ['a-model', 'z-model']);
  });

  it('★ 上游 4xx/5xx 原样带回状态，不许当成"没有模型"', async () => {
    const out = await listProviderModels(db, '/tmp/om-llm-enum-nonexistent', manifestDir, 'siliconcloud', {
      fetchImpl: (() => Promise.resolve(new Response('nope', { status: 401 }))) as never,
    });
    assert.equal(out.ok, false);
    assert.equal(
      out.ok === false && out.failure.kind === 'request-failed' ? out.failure.detail : '',
      'HTTP 401',
    );
  });

  it('★ 不是 OpenAI 兼容形状（没有 data 数组）→ 说清楚，别静默变成 0 个', async () => {
    const out = await listProviderModels(db, '/tmp/om-llm-enum-nonexistent', manifestDir, 'openrouter', {
      fetchImpl: (() =>
        Promise.resolve(new Response(JSON.stringify({ models: ['x'] }), { status: 200 }))) as never,
    });
    assert.equal(out.ok, false);
    assert.equal(
      out.ok === false && out.failure.kind === 'request-failed'
        ? out.failure.detail.includes('data')
        : false,
      true,
    );
  });
});
