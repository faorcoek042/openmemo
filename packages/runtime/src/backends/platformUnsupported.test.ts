/**
 * T-196 —— 「本平台不适用」是第三种话，不是「未安装」的同义词。
 *
 * ## 现场
 *
 * `[用户真机 v0.7.0 · win32/x64 10.0.26200]` 运行时页「为什么这些后端不可用（5 项）」逐字：
 *
 * ```
 * metal：backend package not installed
 * coreml：backend package not installed
 * ```
 *
 * 而 Metal / Core ML 是 **Apple 操作系统的一部分**，在 Windows 上永远装不上。
 * 说成"未安装"不是措辞不好听 —— 它是**一条可执行但必定白费的指令**：
 * 用户会去「运行时」页找那个包，找不到，然后以为是产品坏了或者自己漏了一步。
 *
 * 成因：`buildHardwareInfo()` 的理由链**整个函数里没有任何东西知道操作系统存在**
 * （`os` 在入参里，但只喂给 `preferenceOrder`）。于是三态被压成两态：
 * 「装不了」和「还没装」共用同一句话。
 *
 * ── 把名字遮住，这些断言什么时候会失败 ──────────────────────────────────────
 *  · 有人把平台判定挪到 `!probe.ok` 之后 → 探针一失败，确定的平台事实又降级成"没测出来"；
 *  · 有人把判据改成"目录里有没有这个后端的包" → **Mac 上的 CoreML 会被标成「其它平台」**；
 *  · 有人给 cuda/rocm 也加上平台不适用 → 一台没 N 卡的 Windows 机器会被告知"CUDA 装不了"，
 *    而那是假的（换张卡就能用）；
 *  · 有人把 `unavailableKind` 去掉，让界面回去正则匹配那句英文。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Backend, BackendStatus, HardwareInfo, OsPlatform } from '@openmemo/shared';

import type { AdvisoryDetection, ProbeResult } from '../types.js';
import { APPLE_ONLY_BACKENDS, isBackendPossibleOnPlatform } from './applicability.js';
import { buildHardwareInfo } from './manager.js';

const CPU = {
  brand: 'AMD Ryzen 7 7840HS w/ Radeon 780M Graphics',
  physicalCores: 8,
  logicalCores: 16,
  features: ['avx2'],
};
const NO_ADVISORY: AdvisoryDetection = { gpus: [], source: 'none' } as unknown as AdvisoryDetection;

/** 探针整个没跑成 —— 用来验"平台结论不依赖任何测量"。 */
const PROBE_FAILED: ProbeResult = {
  ok: false,
  kind: 'exec_error',
  message: 'probe executable not found',
  durationMs: 1,
  stderr: '',
} as ProbeResult;

/** 探针跑成了，但一个设备都没枚举到（真机 Windows 上没装任何加速包时的样子）。 */
const PROBE_OK_EMPTY: ProbeResult = {
  ok: true,
  output: {
    schemaVersion: 1,
    ggmlVersion: '0.15.1',
    ggmlCommit: 'deadbeef',
    searchPath: '/x/runtime',
    deviceCount: 0,
    devices: [],
  },
  durationMs: 12,
  stderr: '',
} as ProbeResult;

function build(platform: OsPlatform, probe: ProbeResult = PROBE_OK_EMPTY): HardwareInfo {
  return buildHardwareInfo({
    os: { platform, arch: platform === 'darwin' ? 'arm64' : 'x64', version: '10.0.26200' },
    cpu: CPU,
    ram: { totalMB: 32000, availableMB: 16000 },
    unifiedMemory: platform === 'darwin',
    disks: [],
    advisory: NO_ADVISORY,
    probe,
    installedBackends: new Set<Backend>(),
    probedBackends: new Set<Backend>(),
  });
}

function statusOf(hw: HardwareInfo, id: Backend): Extract<BackendStatus, { available: false }> {
  const s = hw.backends.find((b) => b.id === id);
  assert.ok(s !== undefined, `${id} 必须出现在 backends 里`);
  assert.equal(s.available, false, `这组用例假定 ${id} 不可用；它可用了说明夹具选错了`);
  return s as Extract<BackendStatus, { available: false }>;
}

describe('T-196 策略：只有 Apple 平台专属的那两个后端会被判"平台不适用"', () => {
  it('★ metal / coreml：只在 darwin 上可能', () => {
    for (const b of ['metal', 'coreml'] as Backend[]) {
      assert.equal(isBackendPossibleOnPlatform(b, 'darwin'), true, `${b} 在 macOS 上必须是可能的`);
      assert.equal(isBackendPossibleOnPlatform(b, 'win32'), false);
      assert.equal(isBackendPossibleOnPlatform(b, 'linux'), false);
    }
  });

  it('★ cuda / rocm / vulkan / cpu：任何平台都不判"不适用"（换张卡就能用，不是平台事实）', () => {
    for (const b of ['cuda', 'rocm', 'vulkan', 'cpu'] as Backend[]) {
      for (const os of ['darwin', 'win32', 'linux'] as OsPlatform[]) {
        assert.equal(
          isBackendPossibleOnPlatform(b, os),
          true,
          `${b}@${os} 被判成平台不适用 —— 那会把"这台机器没有这块卡"说成"这个系统装不了"`,
        );
      }
    }
  });

  it('名单就是那两个，不多不少（多一个就会误伤一整类硬件）', () => {
    assert.deepEqual([...APPLE_ONLY_BACKENDS].sort(), ['coreml', 'metal']);
  });
});

describe('T-196 ★ 现场复现：Windows 上 metal/coreml 不再说「未安装」', () => {
  it('★ metal / coreml → platform_unsupported，且那句话里不许出现 "not installed"', () => {
    const hw = build('win32');
    for (const id of ['metal', 'coreml'] as Backend[]) {
      const s = statusOf(hw, id);
      assert.equal(
        s.unavailableKind,
        'platform_unsupported',
        `${id} 在 Windows 上仍被判成 ${s.unavailableKind}`,
      );
      assert.equal(
        /not installed/i.test(s.unavailableReason),
        false,
        `★ ${id} 仍在叫用户去装一个不存在的东西：${s.unavailableReason}`,
      );
      assert.match(s.unavailableReason, /win32/, '理由里该说清是哪个平台');
    }
  });

  it('★ cuda / rocm 在 Windows 上一个字都没变（本轮明确不收它们）', () => {
    const hw = build('win32');
    for (const id of ['cuda', 'rocm'] as Backend[]) {
      const s = statusOf(hw, id);
      assert.equal(
        s.unavailableKind,
        'not_installed',
        `${id} 被顺手改了 —— CUDA 在 Windows 上平台层面是适用的，只是这台机器没那块卡`,
      );
      assert.equal(s.unavailableReason, 'backend package not installed');
    }
  });

  /**
   * ★★ 这一条守的是 Manager 明确点名的那个陷阱。
   *
   * "没有包 ⇒ 平台不适用" 这个反推法看着更数据驱动，但 **coreml 连 darwin 上都是 0 个包**
   * —— 反推法会在**一台 Mac 上**把 CoreML 标成「其它平台」，那是假的。
   * **没有包 ≠ 平台上不可能。** 前者是发布进度，后者是操作系统事实。
   */
  it('★★ 反例：Mac 上的 coreml 不许被判"平台不适用"（哪怕它一个包都没有）', () => {
    const hw = build('darwin');
    for (const id of ['metal', 'coreml'] as Backend[]) {
      const s = statusOf(hw, id);
      assert.notEqual(
        s.unavailableKind,
        'platform_unsupported',
        `★ ${id} 在 macOS 上被判成平台不适用 —— 判据八成被改成了"目录里有没有包"`,
      );
    }
  });

  /**
   * ★ 平台结论**不依赖任何测量**：探针没跑成也照样成立。
   *
   * 排在 `!probe.ok` 之后的话，一台探针起不来的 Windows 机器会先命中
   * "probe did not complete"，把一个确定的事实降级成一句"没测出来"。
   */
  it('★ 探针整个没跑成时，平台结论依然是平台结论（不降级成"没测出来"）', () => {
    const hw = build('win32', PROBE_FAILED);
    assert.equal(statusOf(hw, 'metal').unavailableKind, 'platform_unsupported');
    // 对照组：同一次探测里，cuda 该说的是"探针没跑成"，证明这条链没被整体短路
    assert.equal(statusOf(hw, 'cuda').unavailableKind, 'probe_failed');
  });

  it('每一条不可用都必须带上机器可判的成因（界面才不用去猜那句英文）', () => {
    for (const os of ['win32', 'darwin', 'linux'] as OsPlatform[]) {
      for (const b of build(os).backends) {
        if (b.available) continue;
        assert.ok(
          typeof b.unavailableKind === 'string' && b.unavailableKind.length > 0,
          `${os}/${b.id} 少了 unavailableKind`,
        );
      }
    }
  });
});
