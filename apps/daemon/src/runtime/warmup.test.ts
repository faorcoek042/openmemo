/**
 * T-172：装包末尾捂热 Metal 着色器缓存。
 *
 * ## 这份测试真正要钉的那一条
 *
 * **捂热失败绝不能让装包失败。** 它比"捂热成功"重要得多：
 * 捂热是优化，不是安装的前提。而 `DownloadQueue.run()` 是
 * `await entry.task(ctx)` 外面套 try/catch（`packages/downloader/src/queue.ts:201`）——
 * **任务里任何一处抛出，整个 job 就是 failed**。用户看到的是"安装失败"，
 * 而实际上包已经完整落盘了。
 *
 * 所以下面用**六组敌对输入**逼 `warmProbeCache()` 抛异常：注入的探针同步 throw、
 * 返回 rejected promise、返回超时结果、真实探针 + 一个立刻退出 1 的假二进制、
 * 调用方回调自己抛。一组都不许抛出来。
 *
 * 第二条：**非 macOS 一次探针都不许多跑**（Linux/Windows 冷跑 13ms/39ms，没有问题要解决）。
 * 判据不是"返回值对"，是"**注入的探针的调用计数是 0**" —— 返回值对而照样 spawn 了，
 * 就等于在每台 Linux 机器的每次装包上白付一次子进程。
 *
 * 第三条：**`PROBE_TIMEOUT_MS` 一个字都没改**。捂热用自己的预算，作为**入参**传给
 * 产品自己的 `runProbe()`。这里断言的是探针**实际收到**的 `timeoutMs`，
 * 不是某个常量的名字 —— 常量改名/挪走时这条测试仍然说得出真话。
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PROBE_TIMEOUT_MS, type ProbeResult, type RunProbeOptions } from '@openmemo/runtime';

import { warmProbeCache } from './warmup.js';

/*
 * PROTOCOL §9-bis：指针文件重定向写在**模块顶层**，窗口为零。
 * （本模块其实一个字节都不写机器级状态 —— resolveRuntimeLayout 只 stat/readdir ——
 * 但这条规矩不因"我这次不需要"而豁免：判据是"被 kill -9 在最坏那一行会留下什么"。）
 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'om-warmup-'));
process.env['OPENMEMO_POINTER_FILE'] = join(SANDBOX, 'datadir.json');
// 这两个会绕过路径解析，必须确保它们不存在，否则下面造的布局全部失效
delete process.env['OPENMEMO_PROBE'];
delete process.env['OPENMEMO_BACKEND_DIR'];
delete process.env['OPENMEMO_MODELS'];

let seq = 0;

/** 造一份真实布局。`probe`/`metal` 控制这台"机器"上到底有什么。 */
function makeLayout(opts: { probe?: string; metal?: boolean } = {}): {
  dataDir: string;
  modelsDir: string;
  probePath: string;
} {
  seq += 1;
  const dataDir = join(SANDBOX, `case-${String(seq)}`);
  const runtimeDir = join(dataDir, 'bin', 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const modelsDir = join(dataDir, 'models');
  mkdirSync(modelsDir, { recursive: true });

  const probePath = join(runtimeDir, 'openmemo-probe');
  if (opts.probe !== undefined) {
    writeFileSync(probePath, opts.probe);
    chmodSync(probePath, 0o755);
  }
  if (opts.metal === true) {
    // ggmlRegNameFromFileName('libggml-metal.dylib') -> 'metal'
    writeFileSync(join(runtimeDir, 'libggml-metal.dylib'), 'not a real dylib');
  }
  return { dataDir, modelsDir, probePath };
}

/** 一个"成功"的探针返回值。 */
function okResult(): ProbeResult {
  return {
    ok: true,
    durationMs: 16_011,
    stderr: '',
    output: {
      schemaVersion: 1,
      ggmlVersion: '0.15.1',
      ggmlCommit: 'test',
      searchPath: '/dev/null',
      deviceCount: 1,
      devices: [
        {
          index: 0,
          name: 'Apple M-test',
          description: 'test Metal device',
          backendReg: 'Metal',
          type: 'gpu',
          memFreeBytes: 1,
          memTotalBytes: 2,
          softwareRenderer: false,
        },
      ],
    },
  };
}

describe('T-172 捂热：只在 macOS 上做，且只在真有 Metal 库时做', () => {
  it('★ 非 macOS：直接跳过，且**一次探针都不许 spawn**', async () => {
    const { dataDir, modelsDir } = makeLayout({ probe: '#!/bin/sh\nexit 0\n', metal: true });
    let calls = 0;

    const r = await warmProbeCache({
      dataDir,
      modelsDir,
      platform: 'linux',
      probe: async (): Promise<ProbeResult> => {
        calls += 1;
        return okResult();
      },
    });

    // 这一条才是要害：Linux 冷跑 13ms，没有问题要解决，不该平白多跑一次子进程
    assert.equal(calls, 0);
    assert.equal(r.attempted, false);
    assert.equal(r.skipped, 'not-darwin');
    assert.equal(r.ok, false);
  });

  it('win32 同样跳过', async () => {
    const { dataDir, modelsDir } = makeLayout({ probe: '#!/bin/sh\nexit 0\n', metal: true });
    let calls = 0;
    const r = await warmProbeCache({
      dataDir,
      modelsDir,
      platform: 'win32',
      probe: async (): Promise<ProbeResult> => {
        calls += 1;
        return okResult();
      },
    });
    assert.equal(calls, 0);
    assert.equal(r.skipped, 'not-darwin');
  });

  it('macOS 但没有 probe 二进制：跳过，不 spawn', async () => {
    const { dataDir, modelsDir } = makeLayout({ metal: true });
    let calls = 0;
    const r = await warmProbeCache({
      dataDir,
      modelsDir,
      platform: 'darwin',
      probe: async (): Promise<ProbeResult> => {
        calls += 1;
        return okResult();
      },
    });
    assert.equal(calls, 0);
    assert.equal(r.skipped, 'no-probe-binary');
  });

  it('★ macOS 且有 probe，但目录里没有 Metal 的 ggml 库：跳过', async () => {
    // 判据刻意是**目录里有没有 libggml-metal**，不是 `pack.backend === 'metal'`：
    // 清单里今天没有任何一个包声明 backend:'metal'（macOS 的包声明的是 cpu，
    // 却装着 libggml-metal），照那个字段判会永远跳过且零报错。
    const { dataDir, modelsDir } = makeLayout({ probe: '#!/bin/sh\nexit 0\n', metal: false });
    let calls = 0;
    const r = await warmProbeCache({
      dataDir,
      modelsDir,
      platform: 'darwin',
      probe: async (): Promise<ProbeResult> => {
        calls += 1;
        return okResult();
      },
    });
    assert.equal(calls, 0);
    assert.equal(r.skipped, 'no-metal-library');
  });

  it('★ macOS + probe + libggml-metal：真的跑，且 onBeforeProbe 在开跑前被调用一次', async () => {
    const { dataDir, modelsDir } = makeLayout({ probe: '#!/bin/sh\nexit 0\n', metal: true });
    const order: string[] = [];

    const r = await warmProbeCache({
      dataDir,
      modelsDir,
      platform: 'darwin',
      onBeforeProbe: () => order.push('before'),
      probe: async (): Promise<ProbeResult> => {
        order.push('probe');
        return okResult();
      },
    });

    assert.equal(r.attempted, true);
    assert.equal(r.ok, true);
    assert.equal(r.skipped, null);
    // 文案必须在探针开跑**之前**切换，否则那十几秒里进度条上什么都没有
    assert.deepEqual(order, ['before', 'probe']);
  });
});

describe('T-172 捂热：PROBE_TIMEOUT_MS 一个字都没动', () => {
  it('★ 捂热用自己的预算，作为入参传给产品自己的 runProbe（且明显大于 10s 阈值）', async () => {
    const { dataDir, modelsDir } = makeLayout({ probe: '#!/bin/sh\nexit 0\n', metal: true });
    let seen: RunProbeOptions | null = null;

    await warmProbeCache({
      dataDir,
      modelsDir,
      platform: 'darwin',
      probe: async (options): Promise<ProbeResult> => {
        seen = options;
        return okResult();
      },
    });

    assert.notEqual(seen, null);
    const got = seen as unknown as RunProbeOptions;
    // 断言探针**实际收到**的值，不是某个常量的名字
    assert.equal(typeof got.timeoutMs, 'number');
    assert.notEqual(got.timeoutMs, PROBE_TIMEOUT_MS);
    assert.equal((got.timeoutMs ?? 0) > PROBE_TIMEOUT_MS, true);
    // 实测冷启动 16–21s（n=2，虚拟化 runner），真机 UNKNOWN → 预算必须容得下最大观测样本
    assert.equal((got.timeoutMs ?? 0) >= 21_000, true);
    // 但仍然是**有界**的：驱动真挂死时这一步要收场，不能把装包任务永远吊住
    assert.equal(Number.isFinite(got.timeoutMs), true);
  });

  it('ADR-003 的 10 秒常量本身没被改', () => {
    assert.equal(PROBE_TIMEOUT_MS, 10_000);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ★★ 本文件最重要的一组：捂热失败绝不能变成装包失败
 * ══════════════════════════════════════════════════════════════════════════════ */
describe('★★ T-172 捂热：六组敌对输入，一组都不许抛', () => {
  const hostile: { name: string; opts: () => Record<string, unknown> }[] = [
    {
      name: '① 注入的探针**同步** throw（.catch() 接不住的那种）',
      opts: () => ({
        probe: (): Promise<ProbeResult> => {
          throw new Error('boom: 同步抛');
        },
      }),
    },
    {
      name: '② 注入的探针返回 rejected promise',
      opts: () => ({
        probe: (): Promise<ProbeResult> => Promise.reject(new Error('boom: 异步拒绝')),
      }),
    },
    {
      name: '③ 探针如实报超时（冷 Mac 上 90s 预算也不够的极端情形）',
      opts: () => ({
        probe: async (): Promise<ProbeResult> => ({
          ok: false,
          kind: 'timeout',
          message: 'probe timed out after 90000ms (killed).',
          durationMs: 90_000,
          stderr: '',
        }),
      }),
    },
    {
      name: '④ 探针如实报崩溃（SIGABRT —— 驱动/后端目录坏掉的那一类）',
      opts: () => ({
        probe: async (): Promise<ProbeResult> => ({
          ok: false,
          kind: 'crash',
          message: 'probe crashed (SIGABRT).',
          durationMs: 12,
          stderr: 'ggml_abort',
        }),
      }),
    },
    {
      name: '⑤ 调用方的 onBeforeProbe 回调自己抛',
      opts: () => ({
        onBeforeProbe: () => {
          throw new Error('boom: 进度条回调炸了');
        },
        probe: async (): Promise<ProbeResult> => okResult(),
      }),
    },
    {
      name: '⑥ 调用方的 log 回调自己抛',
      opts: () => ({
        log: () => {
          throw new Error('boom: 日志回调炸了');
        },
        probe: async (): Promise<ProbeResult> => okResult(),
      }),
    },
  ];

  for (const { name, opts } of hostile) {
    it(`${name} —— 不抛，返回结果`, async () => {
      const { dataDir, modelsDir } = makeLayout({ probe: '#!/bin/sh\nexit 0\n', metal: true });

      // 断言的是"它 resolve 了"，不是"它抛了某个错" —— 抛出来就是装包被判失败
      const r = await warmProbeCache({
        dataDir,
        modelsDir,
        platform: 'darwin',
        ...opts(),
      });

      assert.equal(typeof r.durationMs, 'number');
      assert.equal(typeof r.detail, 'string');
      assert.equal(r.detail.length > 0, true);
    });
  }

  it('★ 真实 runProbe（不注入）+ 一个立刻退出 1 的假探针：照样不抛', async () => {
    // 这一条走的是**没有替身**的那条路：真的 spawn、真的失败。
    const { dataDir, modelsDir } = makeLayout({
      probe: '#!/bin/sh\necho "not json" >&2\nexit 1\n',
      metal: true,
    });

    const r = await warmProbeCache({ dataDir, modelsDir, platform: 'darwin' });

    assert.equal(r.attempted, true);
    assert.equal(r.ok, false);
    assert.equal(r.skipped, null);
  });

  it('★ 探针二进制存在但不可执行（EACCES）：照样不抛', async () => {
    const { dataDir, modelsDir, probePath } = makeLayout({
      probe: '#!/bin/sh\nexit 0\n',
      metal: true,
    });
    chmodSync(probePath, 0o600);

    const r = await warmProbeCache({ dataDir, modelsDir, platform: 'darwin' });

    assert.equal(r.ok, false);
  });
});
