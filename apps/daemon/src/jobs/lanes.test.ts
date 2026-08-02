/**
 * lane 信号量测试（D-01 §4.2）。
 * 重点验证 `gpu.asr` 与 `gpu.llm` 的**互斥**——显存不可超卖，这条错了会 OOM。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LanePool, defaultCapacities } from './lanes.js';

describe('lane 信号量', () => {
  it('默认容量符合 D-01 §4.2', () => {
    const c = defaultCapacities(16);
    assert.equal(c['gpu.asr'], 1, '显存不可超卖');
    assert.equal(c['gpu.llm'], 1);
    assert.equal(c['net.download'], 2);
    assert.equal(c['cpu.media'], 4, 'clamp(16/4,1,4)=4');
    assert.equal(c['io.local'], 4);
  });

  it('cpu.media 随核数 clamp 到 [1,4]', () => {
    assert.equal(defaultCapacities(2)['cpu.media'], 1);
    assert.equal(defaultCapacities(64)['cpu.media'], 4);
  });

  it('容量用尽后 acquire 挂起，release 后放行', async () => {
    const pool = new LanePool();
    const r1 = await pool.acquire('gpu.asr');
    assert.equal(pool.inUseOf('gpu.asr'), 1);
    assert.equal(pool.tryAcquire('gpu.asr'), undefined, '容量为 1，第二个应拿不到');

    let acquired = false;
    const pending = pool.acquire('gpu.asr').then((rel) => {
      acquired = true;
      return rel;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(acquired, false, 'release 之前不应放行');

    r1();
    const r2 = await pending;
    assert.equal(acquired, true);
    r2();
    assert.equal(pool.inUseOf('gpu.asr'), 0);
  });

  it('**gpu.asr 与 gpu.llm 互斥**（同卡跑 whisper large + 8B LLM 会 OOM）', async () => {
    const pool = new LanePool();
    const relAsr = await pool.acquire('gpu.asr');
    assert.equal(
      pool.tryAcquire('gpu.llm'),
      undefined,
      'gpu.asr 占用时 gpu.llm 必须拿不到（共享 gpu.exclusive）',
    );
    relAsr();
    const relLlm = pool.tryAcquire('gpu.llm');
    assert.ok(relLlm, '释放后 gpu.llm 应可获取');
    relLlm?.();
  });

  it('非 GPU lane 之间互不影响', async () => {
    const pool = new LanePool();
    const rel = await pool.acquire('gpu.asr');
    assert.ok(pool.tryAcquire('net.download'), 'GPU 占用不该挡住下载');
    assert.ok(pool.tryAcquire('io.local'));
    rel();
  });

  it('release 幂等：重复调用不会把计数弄负', async () => {
    const pool = new LanePool();
    const rel = await pool.acquire('io.local');
    rel();
    rel();
    rel();
    assert.equal(pool.inUseOf('io.local'), 0);
  });

  it('reconfigure 扩容后唤醒等待者（hardware.changed 场景）', async () => {
    const pool = new LanePool({ ...defaultCapacities(8), 'net.download': 1 });
    const r1 = await pool.acquire('net.download');
    let got = false;
    const pending = pool.acquire('net.download').then((r) => {
      got = true;
      return r;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(got, false);

    pool.reconfigure({ 'net.download': 2 });
    const r2 = await pending;
    assert.equal(got, true, '扩容应立刻唤醒等待者');
    r1();
    r2();
  });
});
