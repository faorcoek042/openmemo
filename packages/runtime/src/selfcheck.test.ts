/**
 * `runSelfCheck` —— T-119 同源化的回归测试。
 *
 * 这里守的不是"某条检查算得对不对"，而是**两个出口不会再分叉**：
 *   1. 探针给不出答案时，检查项**照常出现**（只是报 warn）。
 *      少一条就意味着 CLI 与端点的 id 集合可能不同 —— 那正是
 *      "网页绿 ≠ CLI 绿" 的直接成因，而两边都自称"自检"。
 *   2. `diffSelfCheckReports` 真的抓得到漂移。
 *      如果它恒返回空数组，那句"24 项逐 id 一致"就是句空话，
 *      而空话式的绿灯比没有绿灯更危险。
 *   3. 判据不许降级成"文件在不在"：分词器测的是**那四个词能不能命中**。
 *
 * Run: node --test packages/runtime/dist/selfcheck.test.js
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  diffSelfCheckReports,
  runSelfCheck,
  type SelfCheckProbes,
  type SelfCheckReport,
} from './selfcheck.js';

const BASE = {
  dataDir: '/nonexistent/data',
  storeRoot: '/nonexistent/data/models',
  extensionsDir: '/nonexistent/data/bin/ext',
};

/** 只实现"必答"的六个探针；四类新检查故意不给，用来验证它们仍然出现。 */
function minimalProbes(over: Partial<SelfCheckProbes> = {}): SelfCheckProbes {
  return {
    tools: () =>
      Promise.resolve({
        ffmpeg: null,
        ffprobe: null,
        whisperCli: null,
        whisperVad: null,
        vadModel: null,
        ytDlp: null,
      }),
    installed: () => Promise.resolve([]),
    chineseSearch: () => Promise.resolve(null),
    vecVersion: () => Promise.resolve(null),
    engines: () => Promise.resolve([]),
    selectFor: () => Promise.resolve(null),
    ...over,
  };
}

const idsOf = (r: SelfCheckReport): string[] => r.results.map((x) => x.id);
const byId = (r: SelfCheckReport, id: string) => r.results.find((x) => x.id === id);

describe('检查项集合稳定（两个出口不会分叉）', () => {
  it('四类新检查在探针缺席时仍然出现，只是报"未探测"', async () => {
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    for (const id of [
      'hw.os',
      'hw.cpu',
      'hw.memory',
      'hw.probe',
      'llm.tier1',
      'llm.tier2',
      'datadir.assetsContained',
      'datadir.assetsPresent',
      'proxy.config',
      'proxy.ffmpeg',
    ]) {
      assert.ok(idsOf(r).includes(id), `缺了 ${id} —— 两个出口的 id 集合就会不一致`);
    }
    // 硬件这三条 runtime 自己就能答，不需要注入
    assert.equal(byId(r, 'hw.os')?.status, 'ok');
    // 需要注入的那些如实说"没测"，而不是消失、也不是假装通过
    assert.equal(byId(r, 'hw.probe')?.status, 'warn');
    assert.match(byId(r, 'llm.tier1')?.detail ?? '', /未探测/);
    assert.equal(byId(r, 'datadir.assetsContained')?.status, 'warn');
  });

  it('探针全给和全不给，id 集合完全一样', async () => {
    const bare = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    const full = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        probePath: () => Promise.resolve(null),
        mediaAssets: () => Promise.resolve([]),
        localLlmServices: () => Promise.resolve([]),
        llmKeyConfig: () => Promise.resolve({ providerId: null, hasKey: false }),
        proxy: () =>
          Promise.resolve({ mode: 'system', activeUrl: null, ffmpegSupported: true, ffmpegReason: null }),
      }),
    });
    assert.deepEqual(idsOf(bare), idsOf(full));
  });

  it('proxyTest 关闭时不产生 proxy.connectivity —— 自检必须能离线跑完', async () => {
    let called = 0;
    const probes = minimalProbes({
      proxy: () =>
        Promise.resolve({ mode: 'system', activeUrl: null, ffmpegSupported: true, ffmpegReason: null }),
      proxyConnectivity: () => {
        called += 1;
        return Promise.resolve({ ok: true, probes: [] });
      },
    });
    const off = await runSelfCheck({ ...BASE, probes });
    assert.ok(!idsOf(off).includes('proxy.connectivity'));
    assert.equal(called, 0, '没要求就不许真发外网请求');

    const on = await runSelfCheck({ ...BASE, probes, proxyTest: true });
    assert.ok(idsOf(on).includes('proxy.connectivity'));
    assert.equal(called, 1);
  });
});

describe('判据没有被降级成"文件在不在"', () => {
  it('分词器测的是那四个词能不能命中，命中 0 就是 fail', async () => {
    const miss = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        // 扩展"加载成功"了，但一个词都切不出来 —— 正是 trigram 退化的样子
        chineseSearch: () => Promise.resolve({ 用户: 0, 推特: 0, 中国: 0, 服务: 0 }),
      }),
    });
    const c = byId(miss, 'ext.chineseSearch');
    assert.equal(c?.status, 'fail');
    assert.equal(c?.required, true);
    assert.match(c?.remediation ?? '', /trigram/);

    const hit = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        chineseSearch: () => Promise.resolve({ 用户: 1, 推特: 2, 中国: 1, 服务: 2 }),
      }),
    });
    assert.equal(byId(hit, 'ext.chineseSearch')?.status, 'ok');
  });

  it('by-name/asr 里只有 VAD 模型 ≠ ASR 就绪', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        installed: (kind) =>
          Promise.resolve(kind === 'asr' ? ['ggml-silero-v6.2.0.bin'] : []),
      }),
    });
    const m = byId(r, 'model.asr');
    assert.equal(m?.status, 'fail', '把 VAD 当 ASR 报绿就是假绿灯');
    assert.match(m?.detail ?? '', /非 ASR 角色/);
  });

  it('资产路径逃出 dataDir = fail（搬家后会取不到）', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        mediaAssets: () =>
          Promise.resolve([
            { role: 'original', relPath: 'a.wav' },
            { role: 'audio16k', relPath: '/somewhere/else/tmp/job-1/audio16k.wav' },
          ]),
      }),
    });
    const d = byId(r, 'datadir.assetsContained');
    assert.equal(d?.status, 'fail');
    assert.equal(d?.required, true);
    assert.match(d?.detail ?? '', /1\/2/);
  });
});

describe('工具来源要分开：装在 dataDir 里 vs 借系统 PATH 的', () => {
  it('从 storeRoot 里解析出来 = ok', async () => {
    const r = await runSelfCheck({
      ...BASE,
      storeRoot: '/usr',
      probes: minimalProbes({
        tools: () =>
          Promise.resolve({
            ffmpeg: '/usr/bin/env',
            ffprobe: null,
            whisperCli: null,
            whisperVad: null,
            vadModel: null,
            ytDlp: null,
          }),
      }),
    });
    assert.equal(byId(r, 'tool.ffmpeg')?.status, 'ok');
  });

  it('只在系统 PATH 上 = warn，且不再算必需项（能跑，但不可分发）', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        tools: () =>
          Promise.resolve({
            ffmpeg: '/usr/bin/env',
            ffprobe: null,
            whisperCli: null,
            whisperVad: null,
            vadModel: null,
            ytDlp: null,
          }),
      }),
    });
    const t = byId(r, 'tool.ffmpeg');
    assert.equal(t?.status, 'warn');
    assert.equal(t?.required, false);
    assert.match(t?.detail ?? '', /系统 PATH/);
  });
});

describe('diffSelfCheckReports 真的抓得到漂移', () => {
  const mk = (results: { id: string; status: 'ok' | 'warn' | 'fail'; required?: boolean }[]): SelfCheckReport => ({
    ok: true,
    ranAt: '',
    dataDir: '',
    storeRoot: '',
    extensionsDir: '',
    counts: { ok: 0, warn: 0, fail: 0 },
    results: results.map((r) => ({
      layer: 'x',
      id: r.id,
      label: r.id,
      labelZh: r.id,
      status: r.status,
      detail: '',
      required: r.required ?? false,
      remediation: null,
    })),
  });

  it('完全一致 → 空', () => {
    const a = mk([{ id: 'a', status: 'ok' }, { id: 'b', status: 'warn' }]);
    assert.deepEqual(diffSelfCheckReports(a, mk([{ id: 'a', status: 'ok' }, { id: 'b', status: 'warn' }])), []);
  });

  it('端点少一项（就是 T-119 之前的形状）→ 报 missing-there', () => {
    const cli = mk([{ id: 'hw.os', status: 'ok' }, { id: 'ext.chineseSearch', status: 'ok' }]);
    const api = mk([{ id: 'ext.chineseSearch', status: 'ok' }]);
    const d = diffSelfCheckReports(cli, api);
    assert.equal(d.length, 1);
    assert.equal(d[0]?.id, 'hw.os');
    assert.equal(d[0]?.kind, 'missing-there');
  });

  it('结论不同 → 报 status（网页绿而 CLI 红，正是要抓的那种）', () => {
    const d = diffSelfCheckReports(
      mk([{ id: 'ext.chineseSearch', status: 'fail' }]),
      mk([{ id: 'ext.chineseSearch', status: 'ok' }]),
    );
    assert.deepEqual(d, [{ id: 'ext.chineseSearch', kind: 'status', here: 'fail', there: 'ok' }]);
  });

  it('必需性不同 → 也要报：那是纯逻辑，不该受环境影响', () => {
    const d = diffSelfCheckReports(
      mk([{ id: 'model.asr', status: 'ok', required: true }]),
      mk([{ id: 'model.asr', status: 'ok', required: false }]),
    );
    assert.equal(d.length, 1);
    assert.equal(d[0]?.kind, 'required');
  });

  it('detail 不参与比较 —— 路径/设备数天生不同，拿它做判据只会误报', () => {
    const a = mk([{ id: 'tool.ffmpeg', status: 'ok' }]);
    const b = mk([{ id: 'tool.ffmpeg', status: 'ok' }]);
    b.results[0]!.detail = '/完全不同的/路径/ffmpeg';
    assert.deepEqual(diffSelfCheckReports(a, b), []);
  });
});
