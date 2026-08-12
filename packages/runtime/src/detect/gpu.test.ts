/**
 * 虚拟机里的显示适配器：**第三态**，不是"可能支持"，也不是"不支持"（#86）。
 *
 * ## 它对着的那件事（v0.7.1 已知边界第 7 条）
 *
 * `[CI 实测 2026-08-10, windows-2025, run 31389910051]` 那台 runner 的唯一显示适配器是
 * `Microsoft Hyper-V Video`（`PNPDeviceID` = `VMBUS\{DA0A7802-…}\{5620E0C7-…}`）。
 * 它匹配不上 `SOFTWARE_ADAPTER_NAMES`（正则里是 `microsoft basic`，不是 `hyper-v`），
 * 于是被当成一块普通显卡带上 `['vulkan']`，界面照着说
 * 「这块卡我们看见了……（可能支持 vulkan）」——**任何虚拟机里的客户机都会被这么告知。**
 *
 * ## 为什么修法是第三态，而不是"把它筛掉"
 *
 * 筛掉 = 把假阳性换成假阴性，而这里的假阴性更贵，两条理由都是量出来的：
 *
 * 1. **「看到虚拟适配器 ⇒ 没有 GPU 加速」被本仓自己的实测证伪**：两台 macOS runner 的
 *    GPU 都是 `Apple Paravirtual device`，而 Metal 在上面**真的能跑**（热跑 123 ms）。
 * 2. **probe 是唯一权威，而 probe 要先装包才能跑。** 判成"不支持"会让 Vulkan 包
 *    在 `evaluateApplicability` 里变成"不适用" —— 断掉用户唯一能拿到答案的路。
 *
 * ## 判据（三条，缺一条这个修复就是假的）
 *
 * ① 虚拟适配器 → `undetermined`，而且**理由是一句用户读得懂、能照着做的话**；
 * ② **真显卡不许被误伤** —— 尤其是用户那台的 Radeon 780M（核显）；
 * ③ **`undetermined` 仍然让 Vulkan 包可安装** —— 用产品自己的 `evaluateApplicability`
 *    真跑一遍，而不是断言"某个字段还在"。这一条是这次改动最容易被"顺手优化掉"的地方。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { advisoryGpuBackends, type AdvisoryGpuVerdict } from '@openmemo/shared';

import { evaluateApplicability } from '../backends/applicability.js';
import { classifyDisplayAdapter, virtualAdapterVerdict } from './gpu.js';

/** `[CI 实测 run 31389910051]` 那台 windows-2025 runner 的原始返回，逐字。 */
const HYPERV = {
  name: 'Microsoft Hyper-V Video',
  pnpDeviceId:
    'VMBUS\\{DA0A7802-B9DF-4B20-B0F1-4D0F0B0C0D0E}\\{5620E0C7-8062-4DCE-AEB7-520C7EF76171}',
};

/** `[用户真机 2026-08-10, win32/x64 10.0.26200]` AMD Ryzen 7 7840HS 的那块核显。 */
const RADEON_780M = {
  name: 'AMD Radeon(TM) 780M Graphics',
  pnpDeviceId: 'PCI\\VEN_1002&DEV_15BF&SUBSYS_12345678&REV_C1\\4&1A2B3C4D&0&0041',
};

describe('#86 ① 虚拟机适配器落 undetermined', () => {
  it('★ Microsoft Hyper-V Video（VMBUS，无 VEN_）不是"一块可能支持 Vulkan 的卡"', () => {
    assert.equal(classifyDisplayAdapter(HYPERV), 'virtual');
  });

  it('VMBUS 这条判据不靠名字 —— 换个名字挂在同一条虚拟总线上，结论必须不变', () => {
    /*
     * 名字表是**软**判据（`VIRTUAL_ADAPTER_NAMES` 里除 Hyper-V 外没有一条实测过），
     * `VMBUS\` 才是硬的：挂在 Hyper-V 虚拟总线上的设备不是一块 PCI 显卡。
     * 只钉名字的话，微软哪天改一次显示名，这条守卫就静默失效。
     */
    assert.equal(
      classifyDisplayAdapter({
        name: '某个我们没见过的显示适配器',
        pnpDeviceId: HYPERV.pnpDeviceId,
      }),
      'virtual',
    );
  });

  it('Linux 那条路认 PCI 厂商号（virtio / QXL / VMware / VirtualBox …）', () => {
    /*
     * 这条缺陷**从来不是 Windows 专属**：Linux 分支连软件适配器过滤都没有，
     * `/sys/class/drm` 下每张 card 都直接拿 `['vulkan']`，而这些厂商号
     * 一个都不在 `PCI_VENDORS` 里 ⇒ 全落 `'other'` ⇒ 同一句"可能支持 Vulkan"。
     */
    for (const vendorId of ['0x1af4', '0x1b36', '0x15ad', '0x80ee', '0x1414', '0x1234']) {
      assert.equal(
        classifyDisplayAdapter({ name: `PCI ${vendorId}:0x1050`, pciVendorId: vendorId }),
        'virtual',
        `${vendorId} 没被认出来 —— Linux 虚拟机里会照旧被告知"可能支持 Vulkan"`,
      );
    }
  });

  it('软件光栅器仍然是 software（顺序不能反：它同时像"微软的"和"虚拟的"）', () => {
    // 宿主机没装显卡驱动时也会出现，它不是"虚拟机适配器"，而且永远不该是加速目标
    assert.equal(classifyDisplayAdapter({ name: 'Microsoft Basic Render Driver' }), 'software');
    assert.equal(classifyDisplayAdapter({ name: 'Microsoft Basic Display Adapter' }), 'software');
    assert.equal(classifyDisplayAdapter({ name: 'llvmpipe (LLVM 21.1.8, 256 bits)' }), 'software');
  });
});

describe('#86 ② 真显卡不许被误伤', () => {
  it('★ 用户那台的 Radeon 780M（核显）必须仍然是 real', () => {
    /*
     * 这是这次改动的头号回归风险，而且它有历史：把"虚拟适配器"筛得太狠会误杀核显，
     * 而那正是 T-195 那条用户报障（面板说"未检测到可用 GPU"，CPU 那栏印着 780M）。
     */
    assert.equal(classifyDisplayAdapter(RADEON_780M), 'real');
  });

  it('直通进虚拟机的 N 卡（PCI\\VEN_10DE）也是 real —— 判据是设备本身，不是"机器是不是虚拟机"', () => {
    assert.equal(
      classifyDisplayAdapter({
        name: 'NVIDIA GeForce RTX 4070',
        pnpDeviceId: 'PCI\\VEN_10DE&DEV_2786&SUBSYS_87654321&REV_A1\\4&2B3C4D5E&0&0008',
      }),
      'real',
    );
  });

  it('macOS 的 Apple Paravirtual device：**刻意**不判 virtual', () => {
    /*
     * ⚠️ 这条用例是这次判断的**反例锚点**，不是凑数的。
     * 两台 CI runner 的 GPU 就是它，而 Metal 在上面实测能跑（`warmup.ts` / ADR-003）。
     * 它一旦被判成 virtual，我们就会对一个**量过、确实能跑**的配置说"我们不知道"。
     * darwin 那条路的证据也本来就更硬：`spdisplays_mtlgpufamilysupport` 是能力，不是名字。
     */
    assert.equal(classifyDisplayAdapter({ name: 'Apple Paravirtual device' }), 'real');
  });
});

describe('#86 ③ undetermined 仍然让 Vulkan 包可安装（这条被优化掉，修复就变成了假阴性）', () => {
  /** 虚拟机那台机器上，advisory 唯一那块适配器给出的结论。 */
  const vmVerdict: AdvisoryGpuVerdict = {
    kind: 'undetermined',
    reason: '「Microsoft Hyper-V Video」是虚拟机提供的显示适配器 —— …装上 vulkan 后端包探一次…',
    probeWith: ['vulkan'],
  };

  it('★ 候选后端并集里必须仍有 vulkan', () => {
    assert.deepEqual(
      advisoryGpuBackends(vmVerdict),
      ['vulkan'],
      'undetermined 被当成"没有候选后端" —— 环打破器会失去它唯一的输入',
    );
  });

  it('★ 用产品自己的 evaluateApplicability 真跑：探针没跑过时，Vulkan 包仍然「可安装」', () => {
    const pack = {
      id: 'whispercpp-vulkan-win-x64',
      backend: 'vulkan',
      os: 'win32',
      arch: 'x64',
    } as const;
    const platform = { os: 'win32', arch: 'x64' } as const;

    const withAdvisory = evaluateApplicability({
      pack,
      platform,
      backends: null, // 探针从没成功跑过 —— 全新安装的常态
      advisoryCandidates: advisoryGpuBackends(vmVerdict),
    });
    assert.equal(
      withAdvisory.applicable,
      true,
      '虚拟机里 Vulkan 包变成了"不适用" —— 而 probe 要先装包才能跑，' +
        '这等于同时断掉用户唯一能拿到答案的路（比多说一句"可能支持"更坏）',
    );

    /*
     * 前提自检：这条断言不是恒真的。把 advisory 摘掉（也就是"判成不支持"那种修法），
     * 同一个包当场变成不适用 —— 上面那条绿灯确实是 advisory 挣来的。
     */
    const withoutAdvisory = evaluateApplicability({ pack, platform, backends: null });
    assert.equal(withoutAdvisory.applicable, false);
  });
});

describe('#86 ④ 那句理由是要给用户看的', () => {
  it('★ 说得出"是什么"和"下一步做什么"，且不含"可能支持 / 不支持"这种已经下了结论的话', () => {
    /*
     * ⚠️ 判据不是"reason 非空"（那和"文本存在"是同一族）。
     * 判据是这句话**回答了用户真正问的那个问题**：
     * 「这台机器上到底能不能用 GPU 加速」—— 我们回答了没有。
     * 所以它必须说出①看到的是什么 ②为什么下不了结论 ③照着做什么能拿到结论。
     *
     * 断的是**产品自己那个函数**的返回值（`virtualAdapterVerdict`），不是复刻一份 ——
     * 复刻一份就只证明了"我抄的那句话符合我抄的那句话"。
     */
    assert.equal(
      classifyDisplayAdapter(HYPERV),
      'virtual',
      '前提自检：这块适配器根本没走到 undetermined 那一支',
    );
    const v = virtualAdapterVerdict(HYPERV.name, ['vulkan']);
    assert.equal(v.kind, 'undetermined');
    if (v.kind !== 'undetermined') return;

    assert.ok(v.reason.includes('Microsoft Hyper-V Video'), `没说出看到的是哪一块 → ${v.reason}`);
    assert.ok(v.reason.includes('虚拟机'), `没说出它是什么 → ${v.reason}`);
    assert.ok(/判断不出来|判断不了/.test(v.reason), `没说出"我们下不了结论" → ${v.reason}`);
    assert.ok(v.reason.includes('vulkan'), `没说出装哪个包能问出答案 → ${v.reason}`);
    assert.ok(
      !v.reason.includes('可能支持'),
      `又说回"可能支持"了 —— 那正是这次要修掉的那句 → ${v.reason}`,
    );
    assert.ok(
      !/不支持|没有显卡/.test(v.reason),
      `把"判断不了"说成了"不支持" —— 假阳性换成假阴性 → ${v.reason}`,
    );
    assert.deepEqual(v.probeWith, ['vulkan'], '说了"装个包探一次"，却没说是哪个包');
  });
});
