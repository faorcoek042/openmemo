/**
 * T-173：断路器的**出口**。
 *
 * ## 这份测试真正要钉的那一条
 *
 * 修之前，`blacklistedAt` 一旦置上就再也不会被失败清掉（`state.blacklistedAt ?? new Date()`），
 * 而唯一的解除条件是**探测成功** —— 成功的前提是被调用，被调用的前提是没被停用。
 * **那不是断路器，是死锁**：用户收不到任何报错，只会发现 GPU 加速"就是不工作"。
 *
 * 所以下面最重要的不是"冷却期算得对不对"，是那条**不变式**：
 *
 * > **只要 `blacklistedAt !== null`，就必然存在一个会到期的 `retryAt`。**
 *
 * 它被两种方式钉住：① 逐条断言；② 一个"永远失败的机器"跑 200 轮，
 * 每一轮都必须还能等到 `recover`。第 ② 条是**死锁回归测试** ——
 * 任何把"停用"重新做成永久的改动，都会在那里当场变红，而不是等用户发现 GPU 不工作。
 *
 * ## 另外两条是"别把旋钮拧错"
 *
 * `PROBE_TIMEOUT_MS`（多久算超时）与 `CIRCUIT_BREAKER_THRESHOLD`（几次算坏）
 * **这次一个字都不许改** —— 改的是"停用之后怎么出来"。这里直接断言它们的值，
 * 顺手拧一下就会红。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BREAKER_COOLDOWN_MAX_MS,
  BREAKER_COOLDOWN_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  PROBE_RECOVERY_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  breakerCooldownMs,
  breakerVerdict,
  emptyBreaker,
  recordProbeOutcome,
  type BreakerState,
} from './runProbe.js';
import type { ProbeResult } from '../types.js';

const FP = 'fingerprint-aaaa';

function timeout(): ProbeResult {
  return {
    ok: false,
    kind: 'timeout',
    message: `probe timed out after ${String(PROBE_TIMEOUT_MS)}ms (killed).`,
    stderr: '',
    durationMs: PROBE_TIMEOUT_MS,
  };
}

function success(): ProbeResult {
  return {
    ok: true,
    durationMs: 163,
    stderr: '',
    output: {
      schemaVersion: 1,
      ggmlVersion: '0.15.1',
      ggmlCommit: 'deadbeef',
      searchPath: '/tmp/backend',
      deviceCount: 0,
      devices: [],
    },
  };
}

const at = (ms: number): Date => new Date(ms);

/** 连着失败到跳闸为止，返回跳闸那一刻的 state。 */
function tripped(now = 0): BreakerState {
  let s = emptyBreaker();
  for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i += 1) {
    s = recordProbeOutcome(s, timeout(), FP, at(now));
  }
  return s;
}

describe('T-173 断路器：两个不许动的旋钮', () => {
  it('PROBE_TIMEOUT_MS 仍是 ADR-003 决策 3 的 10 秒', () => {
    assert.equal(PROBE_TIMEOUT_MS, 10_000);
  });

  it('CIRCUIT_BREAKER_THRESHOLD 仍是 2', () => {
    assert.equal(CIRCUIT_BREAKER_THRESHOLD, 2);
  });

  it('★ 恢复探测的预算必须**大于**交互路径那个，否则冷 Mac 永远自愈不了', () => {
    /*
     * 冷 Mac 上 Metal 首次初始化实测 12306 / 16092 / 17606 / 20959 ms（n=4，T-172），
     * 而被 kill 的探针什么都不留（shader 缓存全有全无）。
     * ⇒ 用 10 s 去做恢复探测 = 每一次都必然超时 = 从"永久拉黑"变成"永久重试"。
     * 断言的是**关系**，不是某个字面量：谁把它"顺手统一"掉，这里当场红。
     */
    assert.equal(PROBE_RECOVERY_TIMEOUT_MS > PROBE_TIMEOUT_MS, true);
    assert.equal(PROBE_RECOVERY_TIMEOUT_MS > 20_959, true);
  });

  it('★ 冷却基数不许小到"每次自检都重试一遍"', () => {
    // 诊断页自检查询的 staleTime 是 30 s；冷却期必须明显大于它，
    // 否则用户每刷一次页面就放一发探测 —— 那等于把断路器删掉。
    assert.equal(BREAKER_COOLDOWN_MS >= 60_000, true);
    assert.equal(BREAKER_COOLDOWN_MAX_MS > BREAKER_COOLDOWN_MS, true);
  });
});

describe('T-173 断路器：跳闸与冷却', () => {
  it('第 2 次失败才跳闸，第 1 次不跳', () => {
    const one = recordProbeOutcome(emptyBreaker(), timeout(), FP, at(0));
    assert.equal(one.blacklistedAt, null);
    assert.equal(one.retryAt, null);
    assert.equal(breakerVerdict(one, FP, at(0)), 'closed');

    const two = recordProbeOutcome(one, timeout(), FP, at(0));
    assert.equal(two.blacklistedAt === null, false);
    assert.equal(two.retryAt === null, false);
    assert.equal(breakerVerdict(two, FP, at(0)), 'open');
  });

  it('冷却期内是 open（一发都不探），到期变 recover', () => {
    const s = tripped(0);
    assert.equal(breakerVerdict(s, FP, at(BREAKER_COOLDOWN_MS - 1)), 'open');
    assert.equal(breakerVerdict(s, FP, at(BREAKER_COOLDOWN_MS)), 'recover');
    assert.equal(breakerVerdict(s, FP, at(BREAKER_COOLDOWN_MS + 99_999)), 'recover');
  });

  it('半开那一发成功 → 彻底复位（不是"再给一次机会"）', () => {
    const s = tripped(0);
    const healed = recordProbeOutcome(s, success(), FP, at(BREAKER_COOLDOWN_MS));
    assert.deepEqual(healed, { ...emptyBreaker(), driverFingerprint: FP });
    assert.equal(breakerVerdict(healed, FP, at(BREAKER_COOLDOWN_MS)), 'closed');
  });

  it('半开那一发失败 → 退避翻倍并重新计时，不是原地卡死', () => {
    let s = tripped(0);
    const firstDue = Date.parse(s.retryAt ?? '');
    assert.equal(firstDue - 0, BREAKER_COOLDOWN_MS);

    // 到点了，放一发，还是失败
    s = recordProbeOutcome(s, timeout(), FP, at(firstDue));
    const secondDue = Date.parse(s.retryAt ?? '');
    assert.equal(secondDue - firstDue, BREAKER_COOLDOWN_MS * 2);
    // 「从什么时候起坏的」不该被每次重试刷新
    assert.equal(s.blacklistedAt, new Date(0).toISOString());

    s = recordProbeOutcome(s, timeout(), FP, at(secondDue));
    assert.equal(Date.parse(s.retryAt ?? '') - secondDue, BREAKER_COOLDOWN_MS * 4);
  });

  it('退避封顶在 BREAKER_COOLDOWN_MAX_MS，且不会溢出成 NaN/Infinity', () => {
    assert.equal(breakerCooldownMs(CIRCUIT_BREAKER_THRESHOLD), BREAKER_COOLDOWN_MS);
    assert.equal(breakerCooldownMs(CIRCUIT_BREAKER_THRESHOLD + 1), BREAKER_COOLDOWN_MS * 2);
    assert.equal(breakerCooldownMs(9_999), BREAKER_COOLDOWN_MAX_MS);
    assert.equal(Number.isFinite(breakerCooldownMs(9_999)), true);
  });
});

describe('T-173 断路器：★ 死锁回归 —— 停用必须永远有出口', () => {
  it('不变式：blacklistedAt 置上 ⇒ retryAt 必然存在（连续 200 次失败逐条核）', () => {
    let s = emptyBreaker();
    let clock = 0;
    for (let i = 0; i < 200; i += 1) {
      s = recordProbeOutcome(s, timeout(), FP, at(clock));
      if (s.blacklistedAt !== null) {
        assert.equal(s.retryAt === null, false, `第 ${String(i)} 次失败后没有出口`);
        assert.equal(Number.isNaN(Date.parse(s.retryAt ?? '')), false);
      }
      clock += 1_000;
    }
  });

  it('★ 一台"永远失败"的机器，每一轮都还能等到 recover（200 轮）', () => {
    /*
     * 这就是修之前会红的那一条。旧实现里第 3 次失败之后 `isBlacklisted` 恒为 true，
     * 无论把时钟推到多远都不会再放行 —— 而这里要求：只要肯等，就一定等得到。
     */
    let s = tripped(0);
    let clock = 0;
    for (let round = 0; round < 200; round += 1) {
      const due = Date.parse(s.retryAt ?? '');
      assert.equal(Number.isNaN(due), false, `第 ${String(round)} 轮：没有到期时刻`);
      clock = due;
      assert.equal(
        breakerVerdict(s, FP, at(clock)),
        'recover',
        `第 ${String(round)} 轮：等到点了却仍然不放行 —— 这就是死锁`,
      );
      s = recordProbeOutcome(s, timeout(), FP, at(clock));
    }
    // 200 轮之后仍然有出口，而且冷却期已经收敛到上限（不会无限膨胀）
    assert.equal(Date.parse(s.retryAt ?? '') - clock, BREAKER_COOLDOWN_MAX_MS);
  });

  it('retryAt 读不出来时**放行**，不是永久停用', () => {
    // 方向选错就是原地回到死锁：一个坏掉的时间戳变成"再也不重试"。
    const broken: BreakerState = { ...tripped(0), retryAt: 'not-a-date' };
    assert.equal(breakerVerdict(broken, FP, at(0)), 'recover');
    const missing: BreakerState = { ...tripped(0), retryAt: null };
    assert.equal(breakerVerdict(missing, FP, at(0)), 'recover');
  });
});

describe('T-173 断路器：指纹变化是复位，不是"只给一次重试"', () => {
  it('指纹变了 → closed，且失败计数归零（不是攒着等下一次立刻按回去）', () => {
    const s = tripped(0);
    assert.equal(breakerVerdict(s, 'fingerprint-bbbb', at(0)), 'closed');

    // 放行的那一次**又**失败了：旧实现会 2+1=3 ≥ 阈值 → 立刻带着新指纹重新关上。
    const after = recordProbeOutcome(s, timeout(), 'fingerprint-bbbb', at(0));
    assert.equal(after.consecutiveFailures, 1);
    assert.equal(after.blacklistedAt, null);
    assert.equal(
      breakerVerdict(after, 'fingerprint-bbbb', at(0)),
      'closed',
      '装完包只给一次重试、那一次失败就永久关上 —— 正是 T-172 交回来的那条',
    );
  });

  it('指纹没变时不会被误判成"新证据"', () => {
    const s = tripped(0);
    assert.equal(breakerVerdict(s, FP, at(0)), 'open');
  });
});
