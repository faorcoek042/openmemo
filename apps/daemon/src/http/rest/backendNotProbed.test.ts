/**
 * T-168 daemon 侧：**「这次没探它」不许被当成「本机不支持它」。**
 *
 * `packages/runtime` 那边负责让 `unavailableReason` 说真话
 * （见 `backends/notProbedVsUnavailable.test.ts`）。但同一个 `available === false`
 * 还驱动着 daemon 的两个出口，它们各自把"没有结论"翻译成了一个结论：
 *
 * | 出口 | 缺陷原状 | 用户看到 |
 * |---|---|---|
 * | `GET /api/backends/catalog` 的 `inapplicableKind` | 落到 `'unsupported'` | 卡片上「本机不支持」 |
 * | `POST /api/backends/select` | 409 CONFLICT | **选了 CPU 之后再也选不回 Vulkan** |
 *
 * 第二条是闭环，这是它最坏的地方：
 *
 * ```
 * 用户选 cpu → findInBackendPacks 把 cpu 包排最前 → backendDir 指向 cpu 包目录
 *   → 探测报 vulkan.available=false → 想选回 vulkan → 409「驱动缺失或过旧」
 *   → 而拦住他的这个 false，正是他自己上一次选择造成的
 * ```
 *
 * 唯一的出路是卸掉 CPU 包或手改 `prefs.json`。
 *
 * ## 判据
 *
 * 每条正面用例都配阴性对照：**真的探过、真的没设备**时，两个出口必须照旧拒绝并说明白。
 * 少了阴性对照，"把闸门焊死在放行上"也能全绿 —— 那是本次改动最危险的失败方式。
 */

/*
 * ⚠️ PROTOCOL §9-bis：**模块顶层**把模型根钉进 tmp，窗口为零、无清理代码。
 * `RestState.create()` 会 mkdir 模型根并读写 `active.json` / `prefs.json`，
 * 不重定向就会去动这台机器上真实的数据目录（用户的 demo 就在那儿）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-notprobed-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import type { Backend, BackendStatus, GetBackendCatalogResponse } from '@openmemo/shared';

import { SseHub } from '../sse.js';
import { currentPlatform, handleBackendRoutes } from './backends.js';
import { RestState } from './state.js';

const PLATFORM = currentPlatform();

/** 一个 L2 加速包（vulkan 在每个平台上都是 L2，metal 只在 darwin 上不是）。 */
const CATALOG = {
  schemaVersion: 1,
  catalogVersion: '2026.08.07',
  generatedAt: '2026-08-07T00:00:00.000Z',
  packs: [
    {
      schemaVersion: 1,
      id: 'np-vulkan',
      engine: 'whisper.cpp',
      engineVersion: 'v1.9.1',
      ggmlAbi: '0.15.1',
      backend: 'vulkan',
      tier: 'downloadable',
      os: PLATFORM.os,
      arch: PLATFORM.arch,
      displayName: 'np vulkan',
      displayNameZh: 'np vulkan',
      files: [
        {
          role: 'archive',
          name: 'np-vulkan.tar.gz',
          sizeBytes: 4,
          sha256: 'a'.repeat(64),
          unpack: 'tar.gz',
          mirrors: [{ provider: 'github', url: 'https://github.com/x/y/z.tar.gz', official: true }],
        },
      ],
      totalSizeBytes: 4,
      requiresDriver: null,
      license: { id: 'MIT', gated: false, url: 'https://example.invalid/l' },
      providesFiles: ['libggml-vulkan.so'],
      priority: 80,
      benchmark: null,
      catalogVersion: '2026.08.07',
    },
  ],
};

function captureRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number): ServerResponse {
      status = s;
      return res;
    },
    end(chunk?: Buffer | string): void {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    setHeader(): void {
      /* 不关心 */
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => Buffer.concat(chunks).toString('utf8') };
}

function jsonReq(body: unknown): IncomingMessage {
  // Buffer 而不是 string：`readJsonBody` 用 `Buffer.concat`，喂字符串会 ERR_INVALID_ARG_TYPE。
  return Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as unknown as IncomingMessage;
}

/**
 * 这些用例喂的 vulkan 状态**永远是"不可用"那一档**（它们要验的正是
 * "不可用的两种成因不许混为一谈"）。所以类型就写成那条分支，而不是
 * `Partial<BackendStatus>` —— 后者能构造出生产者永远产不出来的组合
 * （T-194 之前 `{available:true, probed:false}` 就是这么进来的）。
 */
type UnavailableVulkan = {
  available: false;
  probed: boolean;
  installed: boolean;
  unavailableReason: string;
};

/** 一份 vulkan 处于指定状态的硬件快照。其余后端保持"没装"。 */
function hardwareWith(vulkan: UnavailableVulkan) {
  const ids: Backend[] = ['cuda', 'vulkan', 'rocm', 'metal', 'coreml', 'cpu'];
  return {
    schemaVersion: 1 as const,
    detectedAt: new Date().toISOString(),
    os: { platform: PLATFORM.os, arch: PLATFORM.arch, version: '0' },
    cpu: { brand: 'x', physicalCores: 4, logicalCores: 8, features: ['avx2'] },
    ram: { totalMB: 16000, availableMB: 8000 },
    unifiedMemory: false,
    gpus: [],
    backends: ids.map((id): BackendStatus => {
      const common = { id, version: null, deviceIndex: null };
      if (id === 'vulkan') return { ...common, ...vulkan };
      return id === 'cpu'
        ? { ...common, available: true, probed: true, installed: true }
        : {
            ...common,
            available: false,
            installed: false,
            probed: false,
            unavailableReason: 'backend package not installed',
          };
    }),
    selectedBackend: 'cpu' as Backend,
    selectedGpuIndex: null,
    disks: [],
  };
}

async function seed(vulkan: UnavailableVulkan): Promise<RestState> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  const manifestDir = mkdtempSync(join(TEST_ROOT, 'manifests-'));
  await writeFile(join(manifestDir, 'backends.json'), JSON.stringify(CATALOG), 'utf8');

  const state = await RestState.create({ sse: new SseHub(), dataDir, manifestDir });
  state.hardware = hardwareWith(vulkan);
  /*
   * advisory 固定为空，让这些用例**与跑它的机器无关**。
   * 不钉住的话，一台真有 A 卡的机器会让解环通道生效，
   * `inapplicableKind` 变成 `'applicable'`，用例结论随机器漂移。
   */
  state.advisoryBackends = [];
  return state;
}

async function selectBackend(state: RestState, backend: Backend) {
  const cap = captureRes();
  const handled = await handleBackendRoutes(
    state,
    jsonReq({ backend }),
    cap.res,
    '/api/backends/select',
    'POST',
  );
  assert.equal(handled, true);
  return cap;
}

async function packOf(state: RestState) {
  const cap = captureRes();
  await handleBackendRoutes(state, {} as IncomingMessage, cap.res, '/api/backends/catalog', 'GET');
  const body = JSON.parse(cap.body()) as GetBackendCatalogResponse;
  const pack = body.packs.find((p) => p.id === 'np-vulkan');
  assert.ok(pack !== undefined, 'np-vulkan 必须在目录里 —— 找不到会让下面的断言恒真');
  return pack;
}

/** 装了、但这次探测没加载它（缺陷现场：用户显式选了 cpu）。 */
const NOT_PROBED: UnavailableVulkan = {
  installed: true,
  probed: false,
  available: false,
  unavailableReason:
    'installed, but this detection run did not load it: only the backend directory currently in use is scanned (…), and this backend’s library is not in it.',
};

/** 装了、探针**真的**加载过、确实没枚举到设备（真结论）。 */
const REALLY_UNAVAILABLE: UnavailableVulkan = {
  installed: true,
  probed: true,
  available: false,
  unavailableReason: 'installed but enumerated no devices (driver missing or too old)',
};

describe('T-168 ★ POST /api/backends/select 不许把用户锁死在 CPU 上', () => {
  it('★ 装了但这次没探它 → 必须放行（选中它本来就是拿到结论的唯一办法）', async () => {
    const state = await seed(NOT_PROBED);
    const cap = await selectBackend(state, 'vulkan');

    assert.equal(
      cap.status(),
      200,
      '★ 缺陷原状是 409 —— 用户选了 CPU 之后就再也选不回 Vulkan，' +
        '而拦住他的那个 available=false 正是他自己上一次选择造成的',
    );
    assert.equal(state.prefs.selectedBackend, 'vulkan', '放行了就必须真的落盘，否则是假的 200');
    assert.equal(state.hardware.selectedBackend, 'vulkan');
  });

  it('★ 阴性对照：探过、确实没设备 → 照旧 409，且理由照旧说得出口', async () => {
    const state = await seed(REALLY_UNAVAILABLE);
    const cap = await selectBackend(state, 'vulkan');

    assert.equal(cap.status(), 409, '有真结论时不许放水 —— 否则这次改动只是把闸门焊死在放行上');
    assert.match(cap.body(), /driver missing or too old/);
    assert.equal(state.prefs.selectedBackend, null, '拒绝了就不许留下痕迹');
  });

  it('★ 阴性对照：包根本没装 → 照旧 409（理由为真且可操作：去装）', async () => {
    const state = await seed({
      installed: false,
      probed: false,
      available: false,
      unavailableReason: 'backend package not installed',
    });
    const cap = await selectBackend(state, 'vulkan');
    assert.equal(cap.status(), 409);
    assert.match(cap.body(), /not installed|未枚举到设备|not available/);
  });

  it('cpu 永远选得动（L1 地板，ADR-014 决策 1）', async () => {
    const state = await seed(NOT_PROBED);
    assert.equal((await selectBackend(state, 'cpu')).status(), 200);
  });
});

describe('T-168 ★ inapplicableKind：没测过 = undetermined，不是 unsupported', () => {
  it('★ 装了但这次没探它 → undetermined', async () => {
    const pack = await packOf(await seed(NOT_PROBED));
    assert.equal(
      pack.inapplicableKind,
      'undetermined',
      '★ 缺陷原状是 unsupported —— 一个完好的包被标成「本机不支持」',
    );
  });

  it('★ 阴性对照：探过、确实没设备 → unsupported（这才是真的不支持）', async () => {
    const pack = await packOf(await seed(REALLY_UNAVAILABLE));
    assert.equal(pack.inapplicableKind, 'unsupported');
  });

  it('★ 判据不依赖文案：把 unavailableReason 抹成空串，结论也不许变', async () => {
    /*
     * 这一条钉的是"结构判据排在字符串嗅探前面"。
     * 原实现只有一条正则（`/probe did not complete|probe skipped/i`），
     * 改一个词它就静默失效 —— T-144「产出方与使用方用了两个名字」的同一族。
     */
    const pack = await packOf(await seed({ ...NOT_PROBED, unavailableReason: '' }));
    assert.equal(pack.inapplicableKind, 'undetermined');
  });
});
