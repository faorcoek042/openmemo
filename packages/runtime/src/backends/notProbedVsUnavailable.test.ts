/**
 * T-168：**「没被探测」与「探测过、不可用」必须是两种状态。**
 *
 * ## 缺陷原状（`[本机实测]`，真装两个包、真跑探针）
 *
 * 目录里今天同时有 Linux 的 CPU 包与 Vulkan 包。用户在网页上**显式选了 `cpu`** 之后：
 *
 * ```
 * selectedBackend = "cpu"
 * backendDir      = <models>/by-name/backend/whispercpp-cpu-linux-x64
 * vulkan  installed=true available=false
 *         unavailableReason="installed but enumerated no devices (driver missing or too old)"
 * ```
 *
 * 那句话是**编的**。同一台机器上，把探针分别指向两个目录，它自己的 stderr 说得很清楚：
 *
 * ```
 * $ openmemo-probe <cpu 包目录>
 * load_backend: loaded CPU backend from …/libggml-cpu-zen4.so     ← 没有 Vulkan 这一行
 * $ openmemo-probe <vulkan 包目录>
 * ggml_vulkan: No devices found.
 * load_backend: loaded Vulkan backend from …/libggml-vulkan.so
 * ```
 *
 * CPU 包里**根本没有** `libggml-vulkan.so`（实测目录清单），所以 Vulkan 后端
 * 一次都没被加载过。而两种情形下报给用户的是**逐字相同**的一句话 ——
 * 一句在场景 A 里为假、在场景 B 里为真的话。
 *
 * ## 判据
 *
 * **不是「让它别报错」，是「报出来的话必须是真的」。**
 * 用户显式选 CPU 时，加速包没被使用是**正确行为**；错的是把它描述成驱动缺失。
 * 所以下面每一条正面用例都配一条阴性对照：**真的驱动问题必须照旧报得出来**，
 * 否则这次修改只是把一个假阳性换成了假阴性。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { Backend, HardwareInfo } from '@openmemo/shared';

import type { AdvisoryDetection, ProbeDevice, ProbeResult } from '../types.js';
import { ggmlRegNameFromFileName, probedBackendsInDir } from '../probe/probedBackends.js';
import { buildHardwareInfo } from './manager.js';

/* ------------------------------------------------------------------ 夹具 -- */

const OS = { platform: 'linux' as const, arch: 'x64' as const, version: '6.8.0' };
const CPU = {
  brand: 'AMD RYZEN AI MAX+ 395',
  physicalCores: 8,
  logicalCores: 16,
  features: ['avx2'],
};
const NO_ADVISORY: AdvisoryDetection = { gpus: [], source: 'none' } as unknown as AdvisoryDetection;

const cpuDevice: ProbeDevice = {
  index: 0,
  name: 'CPU',
  description: CPU.brand,
  backendReg: 'CPU',
  type: 'cpu',
  memFreeBytes: 8e9,
  memTotalBytes: 16e9,
  softwareRenderer: false,
};

function probeOk(devices: ProbeDevice[], searchPath: string): ProbeResult {
  return {
    ok: true,
    output: {
      schemaVersion: 1,
      ggmlVersion: '0.15.1',
      ggmlCommit: 'deadbeef',
      searchPath,
      deviceCount: devices.length,
      devices,
    },
    durationMs: 12,
  } as ProbeResult;
}

function build(input: {
  probe: ProbeResult;
  installed: Backend[];
  probedBackends: Backend[];
}): HardwareInfo {
  return buildHardwareInfo({
    os: OS,
    cpu: CPU,
    ram: { totalMB: 16000, availableMB: 8000 },
    unifiedMemory: false,
    disks: [],
    advisory: NO_ADVISORY,
    probe: input.probe,
    installedBackends: new Set<Backend>(input.installed),
    probedBackends: new Set<Backend>(input.probedBackends),
    bundledBackends: new Set<Backend>(),
  });
}

const reasonFor = (hw: HardwareInfo, id: Backend): string =>
  hw.backends.find((b) => b.id === id)?.unavailableReason ?? '';
const statusFor = (hw: HardwareInfo, id: Backend) => {
  const s = hw.backends.find((b) => b.id === id);
  assert.ok(s !== undefined, `${id} 必须出现在 backends 里`);
  return s;
};

/** 本仓根目录 —— 从 src 跑和从 dist 跑的层数不同，所以向上找而不是数 `..`。 */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'vendor', 'manifests', 'backends.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根（vendor/manifests/backends.json）');
}

/* ------------------------------------------------------------- 承重的三条 -- */

describe('T-168 ★ 未被探测 ≠ 不可用', () => {
  it('★ 显式选 CPU 时，已装的 Vulkan 包不许被说成驱动有问题', () => {
    // 探针只扫了 CPU 包目录：枚举到 CPU，Vulkan 的库压根不在这个目录里。
    const hw = build({
      probe: probeOk([cpuDevice], '/models/by-name/backend/whispercpp-cpu-linux-x64'),
      installed: ['cpu', 'vulkan'],
      probedBackends: ['cpu'],
    });

    const vulkan = statusFor(hw, 'vulkan');
    assert.equal(vulkan.installed, true);
    assert.equal(vulkan.available, false, '没被加载就是没枚举到 —— available 照旧是 false');
    assert.equal(vulkan.probed, false, '★ 这一格就是缺陷原状里缺的那个事实');

    // 判据本身：那句具体的、错的诊断不许出现。
    assert.equal(
      /driver missing or too old/.test(vulkan.unavailableReason ?? ''),
      false,
      '★ 探针根本没加载它，任何关于驱动的结论都是编的 —— 用户会去修一个没坏的驱动',
    );
    assert.equal(
      /\bdriver\b|\bhardware\b|too old|unsupported/i.test(
        (vulkan.unavailableReason ?? '').replace(/not a driver or hardware fault/i, ''),
      ),
      false,
      '★ 连暗示都不许：没测过就不能对驱动/硬件发表任何意见',
    );
    // 而且必须**说出**真实成因，否则用户只是换一句看不懂的话
    assert.match(vulkan.unavailableReason ?? '', /did not load it/);
    assert.match(
      vulkan.unavailableReason ?? '',
      /whispercpp-cpu-linux-x64/,
      '要点名这次扫的是哪个目录 —— 否则用户无从判断该怎么办',
    );
  });

  it('★ 阴性对照：探针**真的**加载过它却没枚举到设备 → 驱动那句必须照旧报得出来', () => {
    /*
     * 这条是上一条的边界。库就在被扫的目录里（Vulkan 包被选中），ggml 加载了它，
     * `ggml_vulkan: No devices found.` —— 这才是关于驱动/硬件的**真结论**。
     * 少了这条，本次修改就是把假阳性换成了假阴性：所有真的驱动问题一起哑掉。
     */
    const hw = build({
      probe: probeOk([cpuDevice], '/models/by-name/backend/whispercpp-vulkan-linux-x64'),
      installed: ['cpu', 'vulkan'],
      probedBackends: ['cpu', 'vulkan'],
    });

    const vulkan = statusFor(hw, 'vulkan');
    assert.equal(vulkan.probed, true);
    assert.equal(vulkan.available, false);
    assert.match(
      vulkan.unavailableReason ?? '',
      /driver missing or too old/,
      '★ 探针有过机会还是没枚举到 —— 这时候说驱动，是有依据的',
    );
  });

  it('★ 两种情形给出的话必须**不同** —— 否则这个字段仍然承载不了两种状态', () => {
    const notLoaded = reasonFor(
      build({
        probe: probeOk([cpuDevice], '/packs/cpu'),
        installed: ['cpu', 'vulkan'],
        probedBackends: ['cpu'],
      }),
      'vulkan',
    );
    const reallyUnavailable = reasonFor(
      build({
        probe: probeOk([cpuDevice], '/packs/vulkan'),
        installed: ['cpu', 'vulkan'],
        probedBackends: ['cpu', 'vulkan'],
      }),
      'vulkan',
    );

    assert.notEqual(
      notLoaded,
      reallyUnavailable,
      '★ 缺陷原状下这两句逐字相同 —— 一句在其中一种情形里必然是假的',
    );
    assert.ok(notLoaded.length > 0 && reallyUnavailable.length > 0);
  });
});

describe('T-168 不许因此放水', () => {
  it('包没装时，仍然是"没装"，不是"没探测"', () => {
    const hw = build({
      probe: probeOk([cpuDevice], '/packs/cpu'),
      installed: ['cpu'],
      probedBackends: ['cpu'],
    });
    assert.match(reasonFor(hw, 'vulkan'), /backend package not installed/);
  });

  it('探针整个没跑成时，那句"probe did not complete"优先级最高（否则解环逻辑会误判）', () => {
    const failed: ProbeResult = {
      ok: false,
      kind: 'missing_probe',
      message: 'probe executable not found',
      durationMs: 0,
      stderr: '',
    } as ProbeResult;
    const hw = build({ probe: failed, installed: ['cpu', 'vulkan'], probedBackends: [] });
    assert.match(reasonFor(hw, 'vulkan'), /probe did not complete/);
    assert.equal(statusFor(hw, 'vulkan').probed, false);
  });

  it('★ available 为真时 probed 必须也为真（枚举到设备本身就是加载过的证据）', () => {
    // 刻意**不**把 cpu 放进 probedBackends：枚举结果必须能压过目录清单。
    const hw = build({
      probe: probeOk([cpuDevice], '/packs/cpu'),
      installed: ['cpu'],
      probedBackends: [],
    });
    const cpu = statusFor(hw, 'cpu');
    assert.equal(cpu.available, true);
    assert.equal(cpu.probed, true, '★ 不变式：available ⟹ probed，否则这两格会互相打架');
    for (const b of hw.backends) {
      if (b.available) assert.equal(b.probed, true, `${b.id}: available 却 probed=false`);
    }
  });
});

describe('T-168 目录扫描：判据来自**真实出厂的包**，不是我自己写的正则', () => {
  it('★ 目录里那两个 Linux 包的 providesFiles，必须映射出正确的后端集合', async () => {
    /*
     * 判据独立于被测者（照 probeShipping.test.ts 那条）：文件名清单取自
     * `vendor/manifests/backends.json` 里**真实出厂**的 `providesFiles`，
     * 不是我按实现反推的样例。上游改文件名时这条会红，而不是继续报绿。
     */
    const catalog = JSON.parse(
      await readFile(path.join(repoRoot(), 'vendor', 'manifests', 'backends.json'), 'utf8'),
    ) as { packs: { id: string; providesFiles?: string[] }[] };

    const mapped = (id: string): Set<string> => {
      const pack = catalog.packs.find((p) => p.id === id);
      assert.ok(pack !== undefined, `目录里必须有 ${id}`);
      const files = pack.providesFiles ?? [];
      assert.ok(files.length > 0, `${id} 的 providesFiles 是空的 —— 这条用例会变成恒真`);
      const out = new Set<string>();
      for (const f of files) {
        const reg = ggmlRegNameFromFileName(f);
        if (reg !== null) out.add(reg);
      }
      return out;
    };

    const cpuPack = mapped('whispercpp-cpu-linux-x64');
    assert.equal(cpuPack.has('cpu'), true, 'CPU 包必须认得出 libggml-cpu-*.so');
    assert.equal(
      cpuPack.has('vulkan'),
      false,
      '★ 这就是缺陷的物理成因：CPU 包里没有 libggml-vulkan.so，探针不可能加载 Vulkan',
    );

    const vulkanPack = mapped('whispercpp-vulkan-linux-x64');
    assert.equal(vulkanPack.has('vulkan'), true);
    assert.equal(
      vulkanPack.has('cpu'),
      true,
      'Vulkan 包**同时**带着完整的 CPU 库 —— 这正是「不必对每个包各探一次」的依据',
    );
  });

  it('文件名 → ggml 注册名：覆盖三个平台真实出现过的形状', () => {
    const cases: [string, string | null][] = [
      ['libggml-cpu-zen4.so', 'cpu'],
      ['libggml-cpu.so', 'cpu'],
      ['libggml-vulkan.so', 'vulkan'],
      ['ggml-cuda.dll', 'cuda'], // Windows：没有 lib 前缀
      ['libggml-metal.dylib', 'metal'],
      ['libggml-metal.0.15.1.dylib', 'metal'], // macOS：版本号在扩展名之前
      ['libggml-base.so.0.15.1', 'base'], // 是 ggml 库，但不是用户可选的后端
      ['libggml.so.0.15.1', null], // 核心库
      ['libwhisper.so.1.9.1', null],
      ['libparakeet.so.1.9.1', null],
      ['whisper-cli', null], // 可执行文件，没有扩展名
      ['openmemo-probe', null],
      ['README.md', null],
    ];
    for (const [name, want] of cases) {
      assert.equal(ggmlRegNameFromFileName(name), want, `${name} 应映射成 ${String(want)}`);
    }
  });

  it('★ 真的读一次磁盘：读不出来的目录必须返回空集，不许当成"都能用"', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'om-probed-'));
    await writeFile(path.join(dir, 'libggml-cpu-haswell.so'), '');
    await writeFile(path.join(dir, 'libggml-base.so.0.15.1'), '');
    await writeFile(path.join(dir, 'whisper-cli'), '');

    const found = await probedBackendsInDir(dir);
    assert.equal(found.has('cpu'), true);
    assert.equal(found.has('vulkan'), false);
    assert.equal(found.size, 1, `只该认出 cpu，实得 ${[...found].join(',')}`);

    const missing = await probedBackendsInDir(path.join(dir, 'does-not-exist'));
    assert.equal(missing.size, 0, '★ 目录读不到时返回空集 —— 「不知道」不许被写成「知道」');
  });
});
