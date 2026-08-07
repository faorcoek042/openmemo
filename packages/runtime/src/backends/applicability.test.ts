/**
 * T-160 ②：**L2 门禁是自指的 —— ADR-014 把死锁挪了一格，没解开。**
 *
 * ## 那个环
 *
 * ```
 * cuda 包没装 → 没有 libggml-cuda.so → probe 枚举不到 CUDA 设备
 *            → backends.cuda.available === false → cuda 包被判"不适用"→ 装不了
 * ```
 *
 * `unavailableReason` 自己把话说出来了：`"backend package not installed"`。
 * T-044 那次的环是"没 probe"，ADR-014 让 CPU 包无条件可装，把 probe 带进来了；
 * **但那不解这个环** —— 装了 probe，probe 依然只枚举得到"库已经在盘上"的后端。
 * `[本机实测]` live 实例：CPU 包已装、probe 也装上之后，每一个加速包仍然 409。
 *
 * ## 出路不是"放开闸门"
 *
 * 无条件放行会把 678 MB 的 CUDA 包推给一台没有 N 卡的机器。
 * 真正的出路是：**已经存在、但一直被丢掉的第二路证据** —— advisory 探测
 * （nvidia-smi / sysfs DRM / system_profiler / DXGI）。它**不依赖任何包**，
 * 这正是它能解环的原因：A 不再需要 B。
 *
 * ## 这些用例钉的是什么
 *
 * 每一条都成对写：**解环**的那半，和**不许因此放水**的那半。
 * 只写前一半的话，"把 applicable 恒改成 true" 也能全绿 —— 那是这次改动最危险的失败方式。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Backend, BackendStatus, OsPlatform } from '@openmemo/shared';

import { evaluateApplicability, isPackApplicable } from './applicability.js';

const LINUX = { os: 'linux' as OsPlatform, arch: 'x64' };

const pack = (backend: Backend) => ({
  id: `whispercpp-${backend}-linux-x64`,
  backend,
  os: 'linux' as OsPlatform,
  arch: 'x64',
});

/** 一份真实形状的 BackendStatus 表：CPU 已装可用，其余都"没装所以枚举不到"。 */
function statuses(overrides: Partial<Record<Backend, Partial<BackendStatus>>> = {}): BackendStatus[] {
  const all: Backend[] = ['cuda', 'vulkan', 'rocm', 'metal', 'coreml', 'cpu'];
  return all.map((id) => {
    const base: BackendStatus = {
      id,
      available: id === 'cpu',
      installed: id === 'cpu',
      // 没装的包，其 ggml 库不在被扫描的目录里 → 探针不可能加载过它（T-168）
      probed: id === 'cpu',
      version: null,
      deviceIndex: null,
      unavailableReason: id === 'cpu' ? null : 'backend package not installed',
    };
    return { ...base, ...(overrides[id] ?? {}) };
  });
}

describe('L2 适用性：解开"要先装才能被发现"的环', () => {
  it('复现死锁本身：没有独立证据时，"没装"仍然挡住安装（旧行为，必须保留）', () => {
    const r = evaluateApplicability({ pack: pack('cuda'), platform: LINUX, backends: statuses() });
    assert.equal(r.applicable, false);
    assert.equal(r.tier, 'l2');
    // 这句正是环本身：它说的是"因为没装，所以不给装"
    assert.match(r.reason ?? '', /not installed/);
  });

  it('advisory 探到 N 卡 → CUDA 包变成可装（环被解开）', () => {
    const r = evaluateApplicability({
      pack: pack('cuda'),
      platform: LINUX,
      backends: statuses(),
      advisoryCandidates: ['cuda', 'vulkan'], // nvidia-smi 报到一块 N 卡时的真实取值
    });
    assert.equal(r.applicable, true);
    assert.equal(r.tier, 'l2', 'CUDA 仍然是 L2 —— 解环不等于把它降级成无条件可装');
  });

  it('**不许放水**：advisory 没有这块硬件时照旧不可装', () => {
    const r = evaluateApplicability({
      pack: pack('cuda'),
      platform: LINUX,
      backends: statuses(),
      // 一台只有 A 卡 / 核显的机器：sysfs 只给出 vulkan
      advisoryCandidates: ['vulkan'],
    });
    assert.equal(r.applicable, false, '没有 N 卡还推 678 MB 的 CUDA 包，比装不上更糟');
    assert.equal(
      evaluateApplicability({
        pack: pack('vulkan'),
        platform: LINUX,
        backends: statuses(),
        advisoryCandidates: ['vulkan'],
      }).applicable,
      true,
      '同一台机器上 vulkan 应当可装 —— 否则这条只是把闸门焊死了',
    );
  });

  it('**不许放水**：包已经装了、**而且探针真的探过**之后，probe 的裁决重新说了算', () => {
    /*
     * 这一条是解环规则的边界。装上、**并且探针加载过它的库**之后，probe 已经有机会枚举了：
     * 它仍然说"没有可用设备"，那就是真结论（驱动太老 / 只有软件渲染器 / 卡被占用），
     * 此时再拿 advisory 去覆盖它，就是用弱证据推翻强证据。
     *
     * ★ T-168：`probed: true` 是这条用例的**承重墙**，不是补齐类型的样板。
     * 少了它，这条断言变成"装了就不许再解环"，而那正是被证伪的那句话 ——
     * 见下面那条 T-168 用例。两条必须一起读。
     */
    const r = evaluateApplicability({
      pack: pack('cuda'),
      platform: LINUX,
      backends: statuses({
        cuda: {
          installed: true,
          probed: true,
          available: false,
          unavailableReason: 'installed but enumerated no devices (driver missing or too old)',
        },
      }),
      advisoryCandidates: ['cuda', 'vulkan'],
    });
    assert.equal(r.applicable, false);
    assert.match(r.reason ?? '', /enumerated no devices/);
  });

  it('★ T-168：装了、但**这次探测根本没加载它** → 那不是裁决，不许当裁决用', () => {
    /*
     * `backendDir` 是单值的：一次探测只扫一个包的目录。用户显式选了 cpu 时，
     * 已装的 vulkan 包**永远**轮不到被加载 —— 再探一百次也一样。
     *
     * 缺陷原状：`installed === true` 就关掉解环通道，于是一个完好的包被判"不适用"，
     * 理由是那句从来没测过的「driver missing or too old」。
     */
    const backends = statuses({
      vulkan: {
        installed: true,
        probed: false,
        available: false,
        unavailableReason: 'installed, but this detection run did not load it: …',
      },
    });

    const r = evaluateApplicability({
      pack: pack('vulkan'),
      platform: LINUX,
      backends,
      advisoryCandidates: ['vulkan'],
    });
    assert.equal(
      r.applicable,
      true,
      '没有裁决就不能当成否定裁决 —— 这与"包没装"是同一种无知，必须同样解环',
    );

    // 阴性对照：没有独立硬件证据时，它仍然不可装。否则这条只是把闸门焊死在 true 上。
    assert.equal(
      evaluateApplicability({ pack: pack('vulkan'), platform: LINUX, backends }).applicable,
      false,
      'advisory 没看到对应硬件时不许放行 —— 解环不等于无条件放水',
    );
  });

  it('probe 从未跑过（全新机器）：有独立证据就不必先装 CPU 包', () => {
    const never = evaluateApplicability({
      pack: pack('vulkan'),
      platform: LINUX,
      backends: null,
    });
    assert.equal(never.applicable, false);
    assert.match(never.reason ?? '', /请先安装 CPU 基础包/);

    const withEvidence = evaluateApplicability({
      pack: pack('vulkan'),
      platform: LINUX,
      backends: null,
      advisoryCandidates: ['vulkan'],
    });
    assert.equal(withEvidence.applicable, true);
  });

  it('平台不符时，任何证据都不管用', () => {
    const r = evaluateApplicability({
      pack: { id: 'x', backend: 'cuda', os: 'win32', arch: 'x64' },
      platform: LINUX,
      backends: statuses(),
      advisoryCandidates: ['cuda'],
    });
    assert.equal(r.applicable, false);
    assert.match(r.reason ?? '', /与本机不符/);
  });

  it('L1（CPU）不受影响 —— 它是地板，永远可装', () => {
    assert.equal(
      evaluateApplicability({ pack: pack('cpu'), platform: LINUX, backends: null }).applicable,
      true,
    );
    assert.equal(
      evaluateApplicability({ pack: pack('cpu'), platform: LINUX, backends: null }).tier,
      'l1',
    );
  });

  it('isPackApplicable 会把 advisory 传下去（少传一个参数 = 死锁原样还在）', () => {
    const hardware = {
      schemaVersion: 1 as const,
      detectedAt: new Date().toISOString(),
      os: { platform: 'linux' as OsPlatform, arch: 'x64' as const, version: '6.8.0' },
      cpu: { brand: 'x', physicalCores: 4, logicalCores: 8, features: ['avx2'] },
      ram: { totalMB: 16000, availableMB: 8000 },
      unifiedMemory: false,
      gpus: [],
      backends: statuses(),
      selectedBackend: 'cpu' as Backend,
      selectedGpuIndex: null,
      disks: [],
    };

    assert.equal(
      isPackApplicable(pack('cuda'), LINUX, hardware).applicable,
      false,
      '不传 advisory 时行为必须与从前一字不差',
    );
    assert.equal(isPackApplicable(pack('cuda'), LINUX, hardware, ['cuda']).applicable, true);
  });
});
