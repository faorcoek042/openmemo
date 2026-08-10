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

import type { Backend, BackendStatus, BackendUnavailableKind, OsPlatform } from '@openmemo/shared';

import { evaluateApplicability, isPackApplicable } from './applicability.js';

const LINUX = { os: 'linux' as OsPlatform, arch: 'x64' };

const pack = (backend: Backend) => ({
  id: `whispercpp-${backend}-linux-x64`,
  backend,
  os: 'linux' as OsPlatform,
  arch: 'x64',
});

/**
 * 覆盖项的形状 —— **本身也是判别联合**（T-194）。
 *
 * 夹具此前是 `Partial<BackendStatus>`，于是可以写出
 * `{ available: true, probed: false }` 这种生产者永远产不出来的对象，
 * 而被测函数照单全收。**一个能构造非法输入的夹具，验的是另一个产品。**
 */
type StatusOverride =
  | { available: true; probed: true; installed?: boolean; unavailableReason?: null }
  | {
      available: false;
      probed: boolean;
      installed?: boolean;
      unavailableReason: string;
      unavailableKind: BackendUnavailableKind;
    };

/** 一份真实形状的 BackendStatus 表：CPU 已装可用，其余都"没装所以枚举不到"。 */
function statuses(overrides: Partial<Record<Backend, StatusOverride>> = {}): BackendStatus[] {
  const all: Backend[] = ['cuda', 'vulkan', 'rocm', 'metal', 'coreml', 'cpu'];
  return all.map((id): BackendStatus => {
    const common = { id, installed: id === 'cpu', version: null, deviceIndex: null };
    const ov = overrides[id];
    if (ov !== undefined) {
      return ov.available
        ? { ...common, ...ov, available: true, probed: true }
        : { ...common, ...ov, available: false };
    }
    return id === 'cpu'
      ? { ...common, available: true, probed: true }
      : {
          ...common,
          available: false,
          // 没装的包，其 ggml 库不在被扫描的目录里 → 探针不可能加载过它（T-168）
          probed: false,
          unavailableReason: 'backend package not installed',
          unavailableKind: 'not_installed' as const,
        };
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
          unavailableKind: 'enumerated_none',
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
        unavailableKind: 'not_probed_this_run',
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
    /*
     * ★ T-191：这里**不再钉那句话的字面**（原来钉的是 `/请先安装 CPU 基础包/`）。
     *
     * 钉字面的代价刚刚兑现过：`[用户真机实测 2026-08-09]` 那句话的两个分句在他机器上
     * **都是假的**（他早就装了 CPU 包；而且当时"装完也不会自动重新探测"），
     * 而这条断言**全程是绿的** —— 它守住的是"这句话没被改动"，不是"这句话成立"。
     *
     * 改成钉**性质**：一条给用户看的不可用理由，必须
     *   ① 说清现在是什么状态（还没探测到，**不是**"你的硬件不支持"）；
     *   ② 指向一个**真存在、真能点**的控件（「本机组件」页上的安装 / 更新）。
     * 措辞可以改，这两条不能丢。
     */
    const reason = never.reason ?? '';
    assert.match(reason, /尚未探测到/, '要先说清"还没探测到"，而不是让人以为硬件不支持');
    assert.match(
      reason,
      /本机组件|运行时|CPU 基础包/,
      '不可用理由必须指向一个真能点的控件；只说"不可用"等于把成本转嫁给用户',
    );
    assert.ok(reason.length >= 20, `理由太短，装不下"是什么状态 + 该做什么"两件事：${reason}`);

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

  /*
   * ★ 这一组钉的是"判据不许读散文"。
   *
   * `isPackApplicable` 里那句 `probeNeverRan` 原本是
   * `(b.unavailableReason ?? '').includes('probe')`。它**不是死代码** ——
   * `manager.ts:217` 在探针整个没跑成时给六个后端全写 `probe did not complete: …`，
   * 所以它一直在生效。危险的地方在于它**随时会静默失效**：
   * `manager.ts` 今天会写 7 种 unavailableReason，只有 1 种含 `probe` 这个词，
   * T-168 新增的那段就不含。任一后端落到新文案上，`.every()` 立刻变 false，
   * 冷启动死锁原样回来，而且没有任何东西会响。
   *
   * 下面第二条就是那个反例：**结构完全相同，只换了文案**。
   * 它在改回字符串判据时必红 —— 这正是它存在的理由。
   */
  describe('★ probeNeverRan 的判据：结构字段，不是 unavailableReason 里的英文', () => {
    /** 探针整个没跑成时 `manager.ts` 产出的形状：六个后端全部 unavailable + unprobed。 */
    const probeFailed = (reason: string): BackendStatus[] =>
      (['cuda', 'vulkan', 'rocm', 'metal', 'coreml', 'cpu'] as Backend[]).map((id) => ({
        id,
        available: false,
        installed: false,
        probed: false,
        version: null,
        deviceIndex: null,
        unavailableReason: reason,
        unavailableKind: 'probe_failed' as const,
      }));

    const hardwareWith = (backends: BackendStatus[]) => ({
      schemaVersion: 1 as const,
      detectedAt: new Date().toISOString(),
      os: { platform: 'linux' as OsPlatform, arch: 'x64' as const, version: '6.8.0' },
      cpu: { brand: 'x', physicalCores: 4, logicalCores: 8, features: ['avx2'] },
      ram: { totalMB: 16000, availableMB: 8000 },
      unifiedMemory: false,
      gpus: [],
      backends,
      selectedBackend: 'cpu' as Backend,
      selectedGpuIndex: null,
      disks: [],
    });

    /** T-168 写进 `manager.ts:237-245` 的那段文案，一个 `probe` 字样都没有。 */
    const T168_REASON =
      'installed, but this detection run did not load it: only the backend directory ' +
      "currently in use is scanned, and this backend's library is not in it. " +
      'This is not a driver or hardware fault — nothing was measured about it.';

    /** 探针没跑成时，该给用户的那句**可执行**的话。 */
    const ACTIONABLE = /尚未探测到硬件能力/;

    it('前提检查：这段真实文案里确实没有 probe 这个词（前提没了的话下面全是空转）', () => {
      assert.equal(
        T168_REASON.includes('probe'),
        false,
        'manager.ts 的新文案现在含 probe 了 —— 请换一段真实的、不含该词的文案',
      );
    });

    /*
     * ★★ 这条是**唯一**能区分新旧判据的用例，写清楚免得下一个人白写一条。
     *
     * `[实测]` 我把新旧两版并排跑了同一组输入：**`applicable` 一次都没变过**，
     * 变的只有 `reason`。因为 `evaluateApplicability` 里那条环打破器
     * （`status.probed !== true` && advisory）在探针没跑成时**恒真**，
     * advisory 那条路照样放行 —— 所以拿 `applicable` 当断言的用例
     * **在新旧两版下都会绿**，它什么都没验到。（我第一版就是这么写的，反向验证时才发现。）
     */
    it('★ 文案换了 → 用户拿到的解释不许退化成探针内部的英文', () => {
      const hw = hardwareWith(probeFailed(T168_REASON));
      const r = isPackApplicable(pack('vulkan'), LINUX, hw);

      assert.match(
        r.reason ?? '',
        ACTIONABLE,
        '判据又在读散文了：换个文案就把"请先装 CPU 包，装完自动重探"退化成了探针的英文原话',
      );
    });

    it('探针失败的老文案下，行为必须与从前一字不差（不许借修复之名改掉别的）', () => {
      const hw = hardwareWith(probeFailed('probe did not complete: probe executable not found'));
      assert.match(isPackApplicable(pack('vulkan'), LINUX, hw).reason ?? '', ACTIONABLE);
      assert.equal(
        isPackApplicable(pack('vulkan'), LINUX, hw, ['vulkan']).applicable,
        true,
        '探针没跑成 + 有独立硬件证据 → 必须可装（T-044 那个冷启动死锁）',
      );
    });

    it('阴性对照：探针真的跑过且给了结论时，不许被当成"没跑过"放水', () => {
      // cpu 已装、已探测、可用；vulkan 已装、已探测、枚举不到设备 = 真结论。
      const backends = probeFailed(
        'installed but enumerated no devices (driver missing or too old)',
      );
      const withVerdict: BackendStatus[] = backends.map((b): BackendStatus => {
        /*
         * ⚠️ 翻成 available 必须**同时把不可用理由去掉** —— 类型逼出来的：
         * 一个"可用"的后端还挂着一句"为什么不可用"，是个自相矛盾的对象。
         * 旧写法 `{ ...b, available: true, … , unavailableReason: null }` 能过，
         * 是因为那时两个字段互不相干。
         */
        if (b.id === 'cpu') {
          const {
            unavailableReason: _drop,
            unavailableKind: _dropKind,
            ...rest
          } = b as Extract<BackendStatus, { available: false }>;
          return { ...rest, available: true, probed: true, installed: true };
        }
        if (b.id === 'vulkan' && !b.available) return { ...b, installed: true, probed: true };
        return b;
      });
      assert.equal(
        isPackApplicable(pack('vulkan'), LINUX, hardwareWith(withVerdict), ['vulkan']).applicable,
        false,
        '探针给过结论就得认 —— 否则这条修复只是把闸门焊死在 true 上',
      );
    });
  });
});
