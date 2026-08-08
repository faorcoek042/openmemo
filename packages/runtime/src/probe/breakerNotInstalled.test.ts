/**
 * 断路器：**「还没装」不是「装了但坏了」。**
 *
 * ## 守的是什么（全新安装上的一次假警报）
 *
 * `[实测 2026-08-08]` 全新数据目录、一个后端包都没装：
 *
 *   daemon 启动探一发（探针不存在）+ 用户在运行时页点一下「重新检测」再探一发
 *   = 2 次 = 正好到 `CIRCUIT_BREAKER_THRESHOLD` ⇒
 *
 *     verdict=open  blacklistedBackends=[cuda,vulkan,rocm,metal,coreml]
 *     lastError=probe executable not found: <data>/bin/runtime/openmemo-probe
 *
 * 于是用户**第一次打开诊断页**看到的是「加速后端断路器」告警 + 5 个后端全被停用，
 * 而他什么都还没做错 —— 探针本来就随后端包出厂，冷启动时必然不存在。
 *
 * `missing_probe` / `missing_backend_dir` 这两种失败，`runProbe` 只做一次
 * `existsSync`（微秒级、不 spawn、不碰驱动），也就是说**什么都没测**。
 * 判据与 T-168 是同一条：**没有证据要被报成没有证据，不能被报成故障。**
 *
 * ## 刻意没动的三个常量
 *
 * `PROBE_TIMEOUT_MS` / `CIRCUIT_BREAKER_THRESHOLD` / `BREAKER_COOLDOWN_MS`
 * **一个字未改**（有测试直接断言它们的值）。这次改的不是"多久算超时""几次算坏"，
 * 是**"什么算一次失败"**。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProbeResult } from '../types.js';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  breakerVerdict,
  emptyBreaker,
  recordProbeOutcome,
} from './runProbe.js';

const FP = 'fingerprint-1';

function failure(kind: ProbeResult extends { ok: false } ? never : string): ProbeResult {
  return {
    ok: false,
    kind: kind as never,
    message: `probe failed: ${kind}`,
    durationMs: 1,
    stderr: '',
  };
}

const ok: ProbeResult = {
  ok: true,
  output: { ggmlVersion: '0.15.1', devices: [], backends: [], searchPath: '' } as never,
  durationMs: 5,
  stderr: '',
};

describe('断路器：探针还没装 ≠ 探针坏了', () => {
  it('★★ 连着 N 次 missing_probe 也不许跳闸（全新安装的必然形态）', () => {
    let s = emptyBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD + 3; i++) {
      s = recordProbeOutcome(s, failure('missing_probe'), FP);
    }
    assert.equal(s.consecutiveFailures, 0, '什么都没测到，不该记成失败');
    assert.equal(s.blacklistedAt, null);
    assert.equal(breakerVerdict(s, FP), 'closed', '用户第一次打开诊断页不该看到"加速后端已停用"');
  });

  it('★ missing_backend_dir 同理（后端目录还不存在也是"还没装"）', () => {
    let s = emptyBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD + 1; i++) {
      s = recordProbeOutcome(s, failure('missing_backend_dir'), FP);
    }
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(breakerVerdict(s, FP), 'closed');
  });

  it('★ 但"为什么没探到"仍然要可见 —— lastError 照记', () => {
    const s = recordProbeOutcome(emptyBreaker(), failure('missing_probe'), FP);
    assert.equal(typeof s.lastError, 'string');
    assert.equal((s.lastError ?? '').includes('missing_probe'), true);
  });

  it('★★ 真故障照旧跳闸 —— 这条修复不许把断路器整个关掉', () => {
    let s = emptyBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      s = recordProbeOutcome(s, failure('timeout'), FP);
    }
    assert.equal(s.consecutiveFailures, CIRCUIT_BREAKER_THRESHOLD);
    assert.notEqual(s.blacklistedAt, null, '超时是真的测过了并且挂了，必须跳闸');
    assert.equal(breakerVerdict(s, FP), 'open');
  });

  it('★ crash / bad_output / exec_error 都算真失败', () => {
    for (const kind of ['crash', 'bad_output', 'exec_error']) {
      let s = emptyBreaker();
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++)
        s = recordProbeOutcome(s, failure(kind), FP);
      assert.equal(s.consecutiveFailures, CIRCUIT_BREAKER_THRESHOLD, `${kind} 应当计数`);
    }
  });

  it('★ 「装了但坏了」之后又被卸掉：已有的失败计数不许被 missing_probe 抹掉', () => {
    let s = recordProbeOutcome(emptyBreaker(), failure('timeout'), FP);
    assert.equal(s.consecutiveFailures, 1);
    s = recordProbeOutcome(s, failure('missing_probe'), FP);
    assert.equal(s.consecutiveFailures, 1, '不计数，但也不清零 —— 那是另一种编造');
  });

  it('★ 探测成功仍然彻底复位', () => {
    let s = recordProbeOutcome(emptyBreaker(), failure('timeout'), FP);
    s = recordProbeOutcome(s, failure('timeout'), FP);
    assert.notEqual(s.blacklistedAt, null);
    s = recordProbeOutcome(s, ok, FP);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.blacklistedAt, null);
  });
});
