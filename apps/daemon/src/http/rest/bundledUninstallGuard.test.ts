/**
 * ★★ **产品不许删掉自己。**
 *
 * ## 用户症状（`[实测]` 隔离实例上端到端复现过，不是推演）
 *
 * `/runtime` 上「随包出厂」的那批组件（linux 包里是 `media-tools-*`，提供
 * `ffmpeg` / `ffprobe`）卸载按钮是**亮的**，前面只挡着一个泛泛的 `window.confirm`。
 * 点下去：
 *
 *     DELETE /api/backends/media-tools-linux-x64   →   HTTP 204
 *     包内 runtime/probe/ffmpeg、runtime/probe/ffprobe   →   **没了**
 *
 * 真机上这是 ~115 MB × 2 ≈ 230 MB，而且**不在数据目录里** —— 删的是
 * **已安装的应用自身**的文件。除了把整个产品重下一遍，拿不回来。
 *
 * ## 链条（每一环都已核实）
 *
 * 1. `backendReconcile.ts` 的 `reconcileBundledPacks()` 给包内那份补记录时，写的是
 *    **legacy 形状**：绝对 `path`、没有 `root`/`relPath`，并且标着 `source: 'bundled'`。
 * 2. `DELETE /api/backends/:id` **不看 `source`**，直接
 *    `dropInstalledFiles(id, ['backend'])` 然后 `removeManifest`。
 * 3. `resolveInstalledFile()` 的**越界检查只写在 `root + relPath` 那条分支**上；
 *    legacy 分支是 `if (rec.path) return rec.path;` —— 原样返回，不作任何检查。
 *    于是那个指向**模型根之外**的绝对路径畅通无阻地走到 `fs.rm`。
 *
 * ⚠️ 这个文件守的是 **②**，不是 ③。`resolveInstalledFile()` 那个洞影响**每一条**
 * legacy 记录（包括模型桶），收紧它要单独做影响面分析 —— 见 PR 正文的后续项。
 * 这里钉的是**故障关闭**那一半：记录自己已经带着 `source`，服务端就该据此拒绝。
 *
 * ## 判据：**断言字节还在，不是断言状态码变了**
 *
 * 只断言 HTTP 状态码的用例**抓不到这个 bug** —— 缺陷的伤害在文件系统上，不在信封里。
 * 所以每条用例都把盘上那两个文件读回来逐字节比对。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * ⚠️ PROTOCOL §9-bis：模块顶层重定向，窗口为零。
 * `RestState.create()` 会 mkdir 模型根、读写 active.json —— 不重定向就会去动
 * 这台机器上真实的数据目录。
 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-bundled-guard-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';

import { ArtifactStore } from '@openmemo/downloader';
import type { BackendPack, InstalledBackendPack } from '@openmemo/shared';

import { SseHub } from '../sse.js';
import { reconcileBackendManifests } from './backendReconcile.js';
import { currentPlatform, handleBackendRoutes } from './backends.js';
import { RestState } from './state.js';

/* ─────────────────────────── 夹具：一份合成目录 ─────────────────────────── */

/**
 * 用**本机**平台，两处（目录条目 / 对账的 platform）取同一个值。
 * 写死 linux/x64 会让这个文件在 mac runner 上静默变成一个什么都没测的绿灯。
 */
const HERE = currentPlatform();

/** 包内那两个二进制的替身 —— 内容不同，好在断言里分得开是哪一个被删了。 */
const FFMPEG_BYTES = Buffer.from('ELF-ish bytes standing in for the bundled ffmpeg\n');
const FFPROBE_BYTES = Buffer.from('ELF-ish bytes standing in for the bundled ffprobe\n');
/** 走正常下载装进 store 的那一份 —— 对照组，它**应该**删得掉。 */
const DOWNLOADED_BYTES = Buffer.alloc(2048, 7);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// 镜像 host 有白名单（`MirrorSchema`），example.invalid 会被清单校验拒掉。
const MIRROR = [
  { provider: 'github', url: 'https://github.com/x/y/releases/download/v1/f', official: true },
];
const LICENSE = { id: 'MIT', gated: false, url: 'https://github.com/x/y/blob/main/LICENSE' };

const BUNDLED_ID = 'media-tools-guard';
const DOWNLOADED_ID = 'ytdlp-guard';
/** 下载装的那份在 store 里的归档名。 */
const DOWNLOADED_FILE = 'ytdlp-guard-bin';

/** 目录里 media-tools 的真实形状（字段照抄 v0.7.x 的 `vendor/manifests/backends.json`）。 */
const CATALOG = {
  schemaVersion: 1,
  catalogVersion: '2026.08.12',
  generatedAt: '2026-08-12T00:00:00.000Z',
  packs: [
    {
      schemaVersion: 1,
      id: BUNDLED_ID,
      engine: 'ffmpeg',
      engineVersion: 'n8.1.2-34-g9b6c8969e0',
      ggmlAbi: null,
      backend: 'cpu',
      tier: 'downloadable',
      os: HERE.os,
      arch: HERE.arch,
      displayName: 'ffmpeg / ffprobe',
      displayNameZh: 'ffmpeg / ffprobe',
      files: [
        {
          role: 'archive',
          name: 'ffmpeg-n8.1.2.tar.gz',
          sizeBytes: 111_679_252,
          sha256: 'a'.repeat(64),
          unpack: 'tar.gz',
          mirrors: MIRROR,
        },
      ],
      totalSizeBytes: 111_679_252,
      requiresDriver: null,
      license: LICENSE,
      providesFiles: ['ffmpeg', 'ffprobe'],
      priority: 10,
      availability: 'published',
      benchmark: null,
      catalogVersion: '2026.08.12',
    },
    {
      schemaVersion: 1,
      id: DOWNLOADED_ID,
      engine: 'yt-dlp',
      engineVersion: '2026.07.04',
      ggmlAbi: null,
      backend: 'cpu',
      tier: 'downloadable',
      os: HERE.os,
      arch: HERE.arch,
      displayName: 'yt-dlp',
      displayNameZh: 'yt-dlp',
      files: [
        {
          role: 'binary',
          name: DOWNLOADED_FILE,
          sizeBytes: DOWNLOADED_BYTES.length,
          sha256: sha(DOWNLOADED_BYTES),
          mirrors: MIRROR,
        },
      ],
      totalSizeBytes: DOWNLOADED_BYTES.length,
      requiresDriver: null,
      license: LICENSE,
      providesFiles: [DOWNLOADED_FILE],
      priority: 42,
      availability: 'published',
      benchmark: null,
      catalogVersion: '2026.08.12',
    },
  ],
};

/** 最小 `ServerResponse` 桩：够 `sendJson` / `writeHead+end` 用。 */
function captureRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number): ServerResponse {
      status = s;
      return res;
    },
    // ⚠️ `sendJson` 写的是 **Buffer** 不是 string —— 只收 string 的话状态码断言会过、
    // 而 body 恒为空，那是一条"看起来在测内容、其实只测了状态码"的用例。
    end(chunk?: Buffer | string): void {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    setHeader(): void {
      /* 不关心 */
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => Buffer.concat(chunks).toString('utf8') };
}

interface Seeded {
  readonly state: RestState;
  /** 「已安装的应用」里那个 `runtime/probe/` —— **刻意落在模型根之外**。 */
  readonly probeDir: string;
  /** 下载装的那一份在盘上的落点。 */
  readonly downloadedPath: string;
}

/**
 * 造一台**装好了的真机**：
 *
 *   · 一个「应用包内」的 `runtime/probe/{ffmpeg,ffprobe}`（在模型根**之外**，
 *     这正是真实几何：那些字节属于已安装的应用，不属于用户的数据目录）；
 *   · 那条 bundled 安装记录**由产品自己的启动对账写出**（`reconcileBackendManifests`），
 *     不是手写的夹具 —— 记录的形状（`source: 'bundled'` + 绝对 `path`、无 `root`/`relPath`）
 *     因此永远跟着生产代码走，而不是跟着我对它的记忆走；
 *   · 外加一个**正常下载装的**包作对照组。
 *
 * ⚠️ 记录写在 `RestState.create()` **之前**：启动对账见到已有记录就跳过，
 * 硬件指纹也在那一刻被钉住 —— 否则第一个请求会因为指纹变化重探一次硬件。
 */
async function seed(): Promise<Seeded> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  const modelsRoot = join(dataDir, 'models');
  process.env['OPENMEMO_MODELS'] = modelsRoot;

  const manifestDir = mkdtempSync(join(TEST_ROOT, 'manifests-'));
  await writeFile(join(manifestDir, 'backends.json'), JSON.stringify(CATALOG), 'utf8');

  // ── 应用包内那份（模型根之外）──────────────────────────────────────────────
  const probeDir = join(dataDir, 'app', 'runtime', 'probe');
  await mkdir(probeDir, { recursive: true });
  await writeFile(join(probeDir, 'ffmpeg'), FFMPEG_BYTES);
  await writeFile(join(probeDir, 'ffprobe'), FFPROBE_BYTES);
  // 与启动脚本设的是同一个变量 —— `bundledRuntimeDir()` 优先读它
  process.env['OPENMEMO_BUNDLED_WHISPER_DIR'] = probeDir;

  const store = new ArtifactStore(modelsRoot);
  await store.init();

  // ── 产品自己的启动对账：这一步写出那条 `source: 'bundled'` 的记录 ──────────
  const report = await reconcileBackendManifests({
    store,
    packs: CATALOG.packs as unknown as readonly BackendPack[],
    platform: HERE,
  });
  assert.deepEqual(
    report.reconciled.map((r) => r.packId),
    [BUNDLED_ID],
    `启动对账没补出 bundled 记录 —— 这个用例的前提就不成立了：${JSON.stringify(report)}`,
  );

  // ── 对照组：一个正常下载装进 store 的包 ────────────────────────────────────
  await writeFile(store.blobPath(sha(DOWNLOADED_BYTES)), DOWNLOADED_BYTES);
  await store.linkByName('backend', sha(DOWNLOADED_BYTES), DOWNLOADED_FILE);
  const downloadedPath = join(modelsRoot, 'by-name', 'backend', DOWNLOADED_FILE);
  await store.writeManifest('backend', DOWNLOADED_ID, {
    schemaVersion: 1,
    id: DOWNLOADED_ID,
    engine: 'yt-dlp',
    engineVersion: '2026.07.04',
    backend: 'cpu',
    installedAt: '2026-07-01T08:09:10.000Z',
    verifiedAt: '2026-07-01T08:09:10.000Z',
    integrity: 'ok',
    source: 'downloaded',
    files: [
      {
        role: 'binary',
        name: DOWNLOADED_FILE,
        sha256: sha(DOWNLOADED_BYTES),
        sizeBytes: DOWNLOADED_BYTES.length,
        root: 'models',
        relPath: join('by-name', 'backend', DOWNLOADED_FILE),
      },
    ],
    selfTest: null,
  } as unknown as InstalledBackendPack);

  const state = await RestState.create({ sse: new SseHub(), dataDir, manifestDir });
  return { state, probeDir, downloadedPath };
}

async function del(state: RestState, id: string): Promise<{ status: number; body: string }> {
  const cap = captureRes();
  const handled = await handleBackendRoutes(
    state,
    {} as IncomingMessage,
    cap.res,
    `/api/backends/${id}`,
    'DELETE',
  );
  assert.equal(handled, true, '路由根本没接住这个请求，后面的断言无意义');
  return { status: cap.status(), body: cap.body() };
}

describe('随应用出厂的组件不许被产品自己删掉', () => {
  it('★★ DELETE 一个 bundled 包：必须被拒，且**盘上的字节一个都不许少**', async () => {
    const { state, probeDir } = await seed();

    const r = await del(state, BUNDLED_ID);

    /*
     * ① 服务端故障关闭。204 = 它刚刚删了已安装应用自己的一部分。
     */
    assert.notEqual(
      r.status,
      204,
      '服务端接受了这次卸载 —— 真机上那是 ~230 MB 属于**应用本体**的字节，' +
        '除了重下整个产品拿不回来',
    );
    assert.equal(r.status, 409, `期望 409（这不是"没装"，是"不该由这里删"）：${r.body}`);

    /*
     * ② ★ **判据在文件系统上**，不在信封里。
     *    只断言状态码的用例抓不到这个 bug —— 它的伤害是磁盘上的字节没了。
     */
    assert.deepEqual(
      await readFile(join(probeDir, 'ffmpeg')),
      FFMPEG_BYTES,
      '包内的 ffmpeg 被删了/被改了 —— 请求被拒绝**却仍然动了盘**，那比直接 204 更糟',
    );
    assert.deepEqual(
      await readFile(join(probeDir, 'ffprobe')),
      FFPROBE_BYTES,
      '包内的 ffprobe 被删了/被改了',
    );

    /*
     * ③ 拒绝要**说得出理由**：用户点的是一颗亮着的按钮，只回一个 409 数字
     *    等于让他去猜是不是自己机器坏了（与 T-196 那条 409 同一条判据）。
     */
    const err = (JSON.parse(r.body) as { error?: Record<string, unknown> }).error;
    assert.ok(err, `409 却没有错误信封：${r.body}`);
    assert.equal(err['code'], 'BUNDLED_NOT_REMOVABLE');
    assert.ok(
      String(err['message']).length > 0 && String(err['messageZh']).length > 0,
      '中英两句必须都在（本仓的错误信封约定），否则一半用户读到的是空字符串',
    );

    /*
     * ④ 记录也必须还在。删了记录却留着文件 = 又一个"第三个答案"：
     *    界面说没装、盘上有、解析器照样在用它。
     */
    const rec = await state.store.readManifest<InstalledBackendPack>('backend', BUNDLED_ID);
    assert.ok(rec, '拒绝了这次卸载，却把安装记录删掉了 —— 界面会开始说"未安装"，而文件还在');
    assert.equal(rec.source, 'bundled');
  });

  it('★ 闸门不许误伤：正常下载装的包照旧卸得掉，文件照旧真的没了', async () => {
    const { state, downloadedPath } = await seed();

    const r = await del(state, DOWNLOADED_ID);

    assert.equal(
      r.status,
      204,
      `把 downloaded 的包也挡住了 —— 那不是安全，是"用户拿不回自己的磁盘"：${r.body}`,
    );
    await assert.rejects(
      () => readFile(downloadedPath),
      '卸载回了 204，文件却还在盘上（那正是 T-192 修过的那种假回收）',
    );
    assert.equal(
      await state.store.readManifest('backend', DOWNLOADED_ID),
      null,
      '记录还在 —— 卸载没走完',
    );
  });
});
