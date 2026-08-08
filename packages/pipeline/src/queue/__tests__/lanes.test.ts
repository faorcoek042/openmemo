/**
 * Lane semaphores. D-01 §4.2.
 *
 * The load-bearing assertion is GPU mutual exclusion: whisper-large and an 8B LLM on one
 * card at the same time is an OOM, and an OOM mid-transcription costs the user
 * everything since the last chunk.
 *
 * Run: node --test packages/pipeline/dist/queue/__tests__/lanes.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LaneManager, PRIORITY, PriorityTracker, defaultCapacities } from '../lanes.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('defaultCapacities', () => {
  it('never oversells the GPU regardless of core count', () => {
    for (const cores of [1, 4, 8, 32, 128]) {
      const caps = defaultCapacities(cores);
      assert.equal(caps['gpu.asr'], 1, 'VRAM cannot be oversold');
      assert.equal(caps['gpu.llm'], 1, 'VRAM cannot be oversold');
    }
  });

  it('scales cpu.media with the machine but clamps it to 1..4', () => {
    assert.equal(defaultCapacities(1)['cpu.media'], 1);
    assert.equal(defaultCapacities(8)['cpu.media'], 2);
    assert.equal(defaultCapacities(128)['cpu.media'], 4);
  });
});

describe('LaneManager', () => {
  it('limits concurrency per lane', async () => {
    const lanes = new LaneManager({ ...defaultCapacities(8), 'net.download': 2 });
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        lanes.withLane('net.download', async () => {
          running += 1;
          peak = Math.max(peak, running);
          await delay(20);
          running -= 1;
        }),
      ),
    );
    assert.equal(peak, 2, 'net.download capacity is 2');
  });

  it('runs different lanes in parallel — they are not one global limit', async () => {
    const lanes = new LaneManager(defaultCapacities(8));
    const started: string[] = [];

    await Promise.all([
      lanes.withLane('net.download', async () => {
        started.push('net');
        await delay(30);
      }),
      lanes.withLane('io.local', async () => {
        started.push('io');
        await delay(30);
      }),
    ]);
    assert.deepEqual(started.sort(), ['io', 'net'], 'both should start immediately');
  });

  it('NEVER runs gpu.asr and gpu.llm concurrently', async () => {
    const lanes = new LaneManager(defaultCapacities(8));
    let gpuRunning = 0;
    let violations = 0;

    const gpuTask = (lane: 'gpu.asr' | 'gpu.llm') =>
      lanes.withLane(lane, async () => {
        gpuRunning += 1;
        if (gpuRunning > 1) violations += 1;
        await delay(25);
        gpuRunning -= 1;
      });

    await Promise.all([
      gpuTask('gpu.asr'),
      gpuTask('gpu.llm'),
      gpuTask('gpu.asr'),
      gpuTask('gpu.llm'),
    ]);

    assert.equal(violations, 0, 'ASR and LLM must never share the GPU — this is an OOM');
  });

  it('releases permits when the body throws', async () => {
    const lanes = new LaneManager({ ...defaultCapacities(8), 'gpu.asr': 1 });
    await assert.rejects(() =>
      lanes.withLane('gpu.asr', () => Promise.reject(new Error('inference failed'))),
    );
    // A leaked permit would deadlock every later job; this must resolve.
    await lanes.withLane('gpu.asr', async () => undefined);
    const stats = lanes.stats().find((s) => s.lane === 'gpu.asr')!;
    assert.equal(stats.inUse, 0, 'permit must be returned after a failure');
  });

  it('does not leak the gpu.exclusive permit when the inner acquire is aborted', async () => {
    const lanes = new LaneManager({ ...defaultCapacities(8), 'gpu.asr': 1 });
    const ac = new AbortController();

    // Occupy the lane.
    const holder = lanes.withLane('gpu.asr', async () => {
      await delay(50);
    });
    // Second caller queues, then gets cancelled.
    const cancelled = lanes.withLane('gpu.asr', async () => undefined, ac.signal);
    await delay(5);
    ac.abort();
    await assert.rejects(() => cancelled);
    await holder;

    // If gpu.exclusive had leaked, this would hang rather than resolve.
    await lanes.withLane('gpu.llm', async () => undefined);
  });

  it('grows capacity at runtime and releases waiters (hardware.changed)', async () => {
    const lanes = new LaneManager({ ...defaultCapacities(8), 'io.local': 1 });
    let concurrent = 0;
    let peak = 0;

    const task = () =>
      lanes.withLane('io.local', async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await delay(40);
        concurrent -= 1;
      });

    const all = [task(), task(), task()];
    await delay(5);
    lanes.setCapacity('io.local', 3);
    await Promise.all(all);
    assert.ok(peak > 1, 'raising capacity must let queued work start');
  });

  it('reports stats for the UI', async () => {
    const lanes = new LaneManager(defaultCapacities(8));
    const stats = lanes.stats();
    assert.equal(stats.length, 6);
    assert.equal(stats.find((s) => s.lane === 'gpu.asr')!.capacity, 1);
  });
});

describe('PriorityTracker — cooperative preemption (D-01 §4.3)', () => {
  it('yields to strictly higher priority only', () => {
    const t = new PriorityTracker();
    t.enqueue('interactive-job', PRIORITY.INTERACTIVE);
    assert.equal(t.shouldYield(PRIORITY.BATCH), true, 'batch should yield to interactive');
    assert.equal(t.shouldYield(PRIORITY.INTERACTIVE), false, 'equal priority must not thrash');
  });

  it('stops yielding once the urgent job is dequeued', () => {
    const t = new PriorityTracker();
    t.enqueue('a', PRIORITY.INTERACTIVE);
    assert.equal(t.shouldYield(PRIORITY.NORMAL), true);
    t.dequeue('a');
    assert.equal(t.shouldYield(PRIORITY.NORMAL), false);
  });

  it('reports the highest waiting priority', () => {
    const t = new PriorityTracker();
    t.enqueue('a', PRIORITY.BATCH);
    t.enqueue('b', PRIORITY.INTERACTIVE);
    assert.equal(t.highestWaiting(), PRIORITY.INTERACTIVE);
  });
});
