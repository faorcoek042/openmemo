/**
 * A-5：**磁盘余量不许拿隔壁卷的数冒充。**
 *
 * 病灶原样：`detectDisks()` 在 `statfs` 抛异常时把那一项**整条省略**（首次运行目录还没
 * 建、移动硬盘没插、网络盘没挂 —— 都是合法情况），而 `modelsRootFreeMB()` 当时写的是
 * `find(models_root) ?? hw.disks[0]` ⇒ 剩下的那项往往是 `runtimes_root`，**可能是另一个卷**。
 *
 * 于是同一个卷出现两个数，而其中一个根本不是它的：
 * fit 判定拿系统盘的 400 GB 说"可安装"，存储页同时显示"剩余 0 B"。
 *
 * ⚠️ 触发条件此前**没有实测记录**（按"仍装着子弹的陷阱"处理）。这一档把它变成
 * **可复现**的：见 `packages/runtime/src/detect/diskUnknown.test.ts` —— 那里用真的
 * `detectDisks()` 打一个不存在的 modelsRoot，证明"整条省略"在本平台真的会发生。
 * 这里接着证明：一旦发生，旧判据会给出一个**看起来很合理但属于别的卷**的数字。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeFit, modelsRootFreeMB } from './fitness.js';
import type { HardwareInfo } from './hardware.js';

/** 只有 runtimes_root 被测到的硬件读数 —— 正是 detectDisks 省略 models_root 之后的形状。 */
function hwWithOnlyRuntimesDisk(): HardwareInfo {
  return {
    schemaVersion: 1,
    detectedAt: '2026-08-11T00:00:00.000Z',
    os: { platform: 'linux', arch: 'x64', version: '6.1' },
    cpu: { brand: 'stub', physicalCores: 8, logicalCores: 16, features: [] },
    ram: { totalMB: 32_000, availableMB: 16_000 },
    gpus: [],
    selectedGpuIndex: null,
    unifiedMemory: false,
    // ★ models_root 缺席（statfs 失败被省略），只剩系统盘上的 runtimes_root：400 GB
    disks: [
      {
        mount: '/',
        path: '/opt/openmemo/runtimes',
        pathFor: 'runtimes_root',
        freeMB: 400_000,
        totalMB: 500_000,
      },
    ],
    backends: [],
    selectedBackend: 'cpu',
  } as unknown as HardwareInfo;
}

describe('A-5 磁盘余量：「没测到」不许被说成「隔壁那个就是它」', () => {
  it('★ models_root 缺席时必须返回 null，绝不借 disks[0] 的数字', () => {
    const free = modelsRootFreeMB(hwWithOnlyRuntimesDisk());
    assert.equal(
      free,
      null,
      '把 runtimes_root（可能是另一个卷）的 400 GB 当成模型卷的余量了 —— ' +
        '这正是「我没拿到」被说成「隔壁那个就是它」',
    );
  });

  it('★ 阴性对照：models_root 在场时照常返回它自己的数（别把上一条修成"永远 null"）', () => {
    const hw = hwWithOnlyRuntimesDisk();
    hw.disks = [
      ...hw.disks,
      {
        mount: '/mnt/models',
        path: '/mnt/models',
        pathFor: 'models_root',
        freeMB: 1_234,
        totalMB: 9_999,
      },
    ];
    assert.equal(modelsRootFreeMB(hw), 1_234, '有真读数时不许也说"不知道"');
  });

  /**
   * ★★ 这一条钉的是**后果**，不是那个 null。
   *
   * 旧行为下：借来的 400 GB > 需要的 3.3 GB ⇒ 判 `recommended` ⇒ 模型页写「可安装」，
   * 而那个卷可能根本没挂上。判据钉"tier 不许是一个断言磁盘够用的档"。
   */
  const bigModel = {
    totalSizeBytes: 3_000_000_000,
    requirements: {
      ramRequiredMB: 2_000,
      vramRequiredMB: 0,
      diskRequiredMB: 3_300,
      cpuFeatures: [],
      computedAtContext: null,
    },
    role: 'asr' as const,
    modelId: 'asr/whisper-large-v3',
  };

  it('★★ 没测到磁盘时，结论必须是"未知"这一档 —— 不许断言可安装，也不许断言装不下', () => {
    const fit = computeFit(bigModel, hwWithOnlyRuntimesDisk());
    assert.equal(
      fit.tier,
      'unknown_disk',
      `没测到磁盘却给出了 ${fit.tier} —— 那是在替一次没做过的检查背书`,
    );
    assert.equal(fit.reasonCode, 'disk_unknown');
    assert.equal(fit.detail.diskFreeMB, null, 'detail 里也不许出现借来的数字');
    assert.notEqual(fit.tier, 'blocked_disk', '"没测到"不是"不够" —— 别把不知道说成装不下');
  });

  it('★ 阴性对照：真的读到而且真的不够时，仍然要判 blocked_disk', () => {
    const hw = hwWithOnlyRuntimesDisk();
    hw.disks = [
      {
        mount: '/mnt/models',
        path: '/mnt/models',
        pathFor: 'models_root',
        freeMB: 100,
        totalMB: 9_999,
      },
    ];
    const fit = computeFit(bigModel, hw);
    assert.equal(fit.tier, 'blocked_disk', '真的装不下时不能退化成"未知"');
    assert.equal(fit.detail.diskFreeMB, 100);
  });
});
