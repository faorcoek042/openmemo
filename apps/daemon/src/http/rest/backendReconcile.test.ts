/**
 * T-165 ① —— **`/runtime` 对已经装好的 ffmpeg 显示「安装 119 MB」**（`gates-fix §5.2`）。
 *
 * ## 缺陷原状
 *
 * 全仓有两个互不相干的「已安装」：
 *   A = 盘上真的有文件（`resolveBackendTool()` 扫 `by-name/backend/**`）；
 *   B = 有一份 `manifests/backend/<id>.json`。
 * **B 的写入方全仓只有 `startPackInstall()` 那一句 `writeManifest`**，
 * 而安装器刻意是"blob 先落、manifest 最后写" —— 崩在中间、冷启动脚本、手工解包，
 * 都会留下"A 有 B 没有"。此时：
 *   · `/api/backends/catalog` 的 `installed` = false  → `/runtime` 上一个「安装 119 MB」按钮
 *   · `/api/components` 的 `installedVersion` = null
 *   · `DELETE /api/backends/:id` = 404
 *   · `recordSelfTest()` 找不到记录，自检结果落不了地
 * 而 `discoverTools()` / `/api/selfcheck` / 真正跑转写的那条路**同时**说它装着。
 *
 * ## 判据：装没装只准有一个回答的人
 *
 * 所以这一族**不**去断言"catalog 那一格变成 true"就收工 —— 那正是
 * `gates-fix §5.2` 的第 2 条修法（catalog 现算）能做到、而且只能做到的事。
 * 下面每一条都要求**同一台机器上另一个读取方也跟着变对**：
 * 能卸载（DELETE 不再 404）、`priority` 进得了记录（`resolveBackendTool` 的排序才活）。
 *
 * ## 还要求它**不许乱认**
 *
 * 补记录很容易滑成"照着目录抄一份"，那是**发明一条不成立的证据**。三条阴性对照：
 *   · 盘上的字节与目录声明的 sha256 不符 → 不认（那是另一个版本；
 *     `[实测 :10000]` 真的有这一格：盘上 ffmpeg 7.1.5，目录已升到 8.1.2）；
 *   · 别的平台的包 → 不认（三个 `ytdlp-*` 在目录里**归档文件名逐字相同**）；
 *   · 归档在、解包目录不在（装到一半）→ 不认。
 */

/*
 * ⚠️ PROTOCOL §9-bis：**在模块顶层**把模型根与扩展目录钉进 tmp，窗口为零。
 * `RestState.create()` 会 mkdir 模型根、读写 `active.json` / `prefs.json` ——
 * 不重定向就会去动这台机器上真实的数据目录（用户的 demo 就在那儿）。
 * node:test 一个测试文件一个子进程，进程退了环境变量就没了，**不需要清理代码**。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-reconcile-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';

import type { GetBackendCatalogResponse } from '@openmemo/shared';

import { SseHub } from '../sse.js';
import { currentPlatform, handleBackendRoutes } from './backends.js';
import { RestState } from './state.js';

/* ─────────────────────────── 夹具：一份合成目录 ─────────────────────────── */

const HERE = currentPlatform();
/** 另一个平台 —— 用来钉"别的平台的包不许被顺带认领"。 */
const ELSEWHERE = HERE.os === 'darwin' ? 'linux' : 'darwin';

const FLAT_BYTES = Buffer.from('#!/bin/sh\necho reconcile-flat\n');
const ARCHIVE_BYTES = Buffer.alloc(4096, 3);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// 镜像 host 有白名单（`MirrorSchema`），随便写个 example.invalid 会被 manifest 校验拒掉。
const MIRROR = [
  { provider: 'github', url: 'https://github.com/x/y/releases/download/v1/f', official: true },
];
const LICENSE = { id: 'MIT', gated: false, url: 'https://github.com/x/y/blob/main/LICENSE' };

function pack(over: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    engine: 'yt-dlp',
    engineVersion: '2026.07.04',
    ggmlAbi: null,
    backend: 'cpu',
    tier: 'downloadable',
    os: HERE.os,
    arch: HERE.arch,
    displayName: 'X',
    displayNameZh: 'X',
    totalSizeBytes: FLAT_BYTES.length,
    requiresDriver: null,
    license: LICENSE,
    providesFiles: ['rc-flat'],
    priority: 42,
    availability: 'published',
    benchmark: null,
    catalogVersion: '2026.08.07',
    ...over,
  };
}

const FLAT_FILE = {
  role: 'binary',
  name: 'rc-flat',
  sizeBytes: FLAT_BYTES.length,
  sha256: sha(FLAT_BYTES),
  mirrors: MIRROR,
};
const ARCHIVE_FILE = {
  role: 'archive',
  name: 'rc-arch.tar.gz',
  sizeBytes: ARCHIVE_BYTES.length,
  sha256: sha(ARCHIVE_BYTES),
  unpack: 'tar.gz',
  mirrors: MIRROR,
};

const CATALOG = {
  schemaVersion: 1,
  catalogVersion: '2026.08.07',
  generatedAt: '2026-08-07T00:00:00.000Z',
  packs: [
    /** 单文件包（yt-dlp 那一形状）：安装器只硬链，不解包。 */
    pack({ id: 'rc-flat', files: [FLAT_FILE] }),
    /** 归档包（ffmpeg / whisper 那一形状）：硬链 + 解包目录。 */
    pack({
      id: 'rc-archive',
      engine: 'ffmpeg',
      files: [ARCHIVE_FILE],
      totalSizeBytes: ARCHIVE_BYTES.length,
      providesFiles: ['ffmpeg'],
      priority: 5,
    }),
    /**
     * ★ 与 `rc-flat` **归档文件名逐字相同**、只是平台不同 —— 目录里三个
     * `ytdlp-*` 就是这个形状（都叫 `yt-dlp`）。它绝不能被顺带认领。
     */
    pack({ id: 'rc-flat-elsewhere', os: ELSEWHERE, arch: 'arm64', files: [FLAT_FILE] }),
    /** ★ 盘上会放一份**内容不同**的同名文件 —— sha256 对不上，不许认。 */
    pack({
      id: 'rc-stale',
      files: [
        { ...FLAT_FILE, name: 'rc-stale-bin', sha256: sha(Buffer.from('the other version')) },
      ],
      providesFiles: ['rc-stale-bin'],
    }),
    /** ★ 归档在、解包目录不在 = 装到一半，不许认。 */
    pack({
      id: 'rc-halfway',
      engine: 'ffmpeg',
      files: [{ ...ARCHIVE_FILE, name: 'rc-half.tar.gz' }],
      totalSizeBytes: ARCHIVE_BYTES.length,
      providesFiles: ['ffmpeg'],
    }),
  ],
};

/** 安装器落下来的一天：`installedAt` 必须是它，不是"现在"。 */
const INSTALLED_AT = new Date('2026-07-01T08:09:10.000Z');

/** 最小 `ServerResponse` 桩：够 `sendJson` / `writeHead+end` 用。 */
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

/**
 * 造一台"装好了、但 manifest 没写成"的机器。
 *
 * **不写任何 manifest** —— 这就是缺陷状态本身。
 * 落点全部按安装器真正写的位置：`by-name/backend/<归档名>` 是 `linkByName()` 的硬链，
 * `by-name/backend/<unpackDirName(名)>` 是解包目录（temp-then-rename 之后才出现，
 * 所以"目录在"本身就是"解包跑完了"的诚实信号，安装器的注释是这么写的）。
 */
interface Seeded {
  readonly state: RestState;
  readonly dataDir: string;
  readonly manifestDir: string;
}

async function seed(): Promise<Seeded> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');

  const manifestDir = mkdtempSync(join(TEST_ROOT, 'manifests-'));
  await writeFile(join(manifestDir, 'backends.json'), JSON.stringify(CATALOG), 'utf8');

  const byName = join(dataDir, 'models', 'by-name', 'backend');
  await mkdir(byName, { recursive: true });

  await writeFile(join(byName, 'rc-flat'), FLAT_BYTES);
  await writeFile(join(byName, 'rc-arch.tar.gz'), ARCHIVE_BYTES);
  await mkdir(join(byName, 'rc-arch'), { recursive: true });
  await writeFile(join(byName, 'rc-arch', 'ffmpeg'), 'x');
  // 内容与目录声明的 sha256 不符 —— 盘上是另一个版本
  await writeFile(join(byName, 'rc-stale-bin'), FLAT_BYTES);
  // 归档在，解包目录**不建** —— 装到一半
  await writeFile(join(byName, 'rc-half.tar.gz'), ARCHIVE_BYTES);

  for (const f of ['rc-flat', 'rc-arch.tar.gz', 'rc-stale-bin', 'rc-half.tar.gz']) {
    await utimes(join(byName, f), INSTALLED_AT, INSTALLED_AT);
  }

  const state = await RestState.create({ sse: new SseHub(), dataDir, manifestDir });
  return { state, dataDir, manifestDir };
}

async function catalogOf(state: RestState): Promise<GetBackendCatalogResponse> {
  const cap = captureRes();
  const handled = await handleBackendRoutes(
    state,
    {} as IncomingMessage,
    cap.res,
    '/api/backends/catalog',
    'GET',
  );
  assert.equal(handled, true);
  return JSON.parse(cap.body()) as GetBackendCatalogResponse;
}

describe('T-165 ① 启动对账：盘上装好了、manifest 没写成', () => {
  it('★ 单文件包与归档包都被认回来 —— `/runtime` 不再让用户把已装的东西重下一遍', async () => {
    const { state } = await seed();
    const byId = new Map((await catalogOf(state)).packs.map((p) => [p.id, p]));

    assert.equal(
      byId.get('rc-flat')?.installed,
      true,
      '盘上那份单文件包（yt-dlp 形状）仍被说成未安装 —— 这就是那个「安装 119 MB」按钮',
    );
    assert.equal(byId.get('rc-archive')?.installed, true, '归档包（ffmpeg 形状）仍被说成未安装');
  });

  it('★ 判据不是"catalog 那一格变绿"：同一台机器上必须**卸得掉**', async () => {
    /*
     * 这一条是"启动对账"与"catalog 现算"的分水岭。
     * 现算只能让 `/api/backends/catalog` 那一格好看，而 `DELETE /api/backends/:id`
     * 读的是 manifest —— 用户看到「已安装」，点卸载，被告知**未安装该后端包**。
     * 那不是修好，那是把两个答案变成三个。
     */
    const { state } = await seed();
    const cap = captureRes();
    await handleBackendRoutes(
      state,
      {} as IncomingMessage,
      cap.res,
      '/api/backends/rc-flat',
      'DELETE',
    );
    assert.equal(
      cap.status(),
      204,
      `卸载返回 ${String(cap.status())} —— 界面说已安装、卸载说没装，就是第三个答案：${cap.body()}`,
    );
  });

  it('★ 记录里必须带 priority —— 少了它，用户选的加速后端仍然排不上（T-162 空转）', async () => {
    const { state } = await seed();
    const rec = (await state.listInstalledBackends()).find((p) => p.id === 'rc-flat');
    assert.ok(rec, '没写出安装记录');
    assert.equal(
      rec!.priority,
      42,
      'priority 没抄进记录 —— `resolveBackendTool()` 的排序只能从安装记录里读到它，' +
        '缺了就落到"无安装清单"那一档，排在所有包最后',
    );
    assert.equal(
      rec!.backend,
      'cpu',
      'backend 没抄进记录 —— 用户的 selectedBackend 就对不上任何包',
    );
    assert.equal(rec!.selfTest, null, '从来没跑过自检，不许写成跑过');
  });

  it('★ 补出来的记录不许撒谎：sha256 是现算的，installedAt 是文件的、不是"现在"', async () => {
    const { state } = await seed();
    const rec = (await state.listInstalledBackends()).find((p) => p.id === 'rc-flat');
    assert.ok(rec);
    assert.equal(rec!.files[0]?.sha256, sha(FLAT_BYTES), '摘要必须是从盘上的字节算出来的');
    assert.equal(rec!.integrity, 'ok', '刚刚逐字节校验过，这一条是真的');
    assert.equal(
      rec!.installedAt,
      INSTALLED_AT.toISOString(),
      `installedAt 应当是那条链的 mtime（它不是现在装的），实际 ${String(rec!.installedAt)}`,
    );
    assert.ok(
      Date.now() - Date.parse(rec!.verifiedAt ?? '') < 60_000,
      'verifiedAt 才是"现在" —— 校验确实是刚做的',
    );
  });

  it('★ 阴性对照一：盘上的字节与目录声明的对不上 → 不认（那是另一个版本）', async () => {
    /*
     * `[实测 :10000]` 真的有这一格：盘上是 `ffmpeg-n7.1.5-…`，目录已经升到 8.1.2。
     * 把它记成"已安装 media-tools-linux-x64"，是把"版本不对"伪装成"一切正常"。
     */
    const { state } = await seed();
    const byId = new Map((await catalogOf(state)).packs.map((p) => [p.id, p]));
    assert.equal(
      byId.get('rc-stale')?.installed,
      false,
      '同名但内容不同的文件被认成了"已安装" —— 那是发明一条不成立的证据',
    );
  });

  it('★ 阴性对照二：别的平台的包不许被顺带认领（三个 ytdlp 包归档名逐字相同）', async () => {
    const { state } = await seed();
    const byId = new Map((await catalogOf(state)).packs.map((p) => [p.id, p]));
    assert.equal(
      byId.get('rc-flat-elsewhere')?.installed,
      false,
      `盘上只有一份 rc-flat，却把 ${ELSEWHERE} 那个包也宣布成已安装了`,
    );
  });

  it('★ 阴性对照三：归档在、解包目录不在（装到一半）→ 不认', async () => {
    const { state } = await seed();
    const byId = new Map((await catalogOf(state)).packs.map((p) => [p.id, p]));
    assert.equal(
      byId.get('rc-halfway')?.installed,
      false,
      '解包还没跑完就被记成已安装 —— 用户会拿到一个"装着但用不了"的包',
    );
  });

  it('前提自检：真安装写下的记录不许被对账覆盖（它只补，不改）', async () => {
    const { state, dataDir, manifestDir } = await seed();
    const before = (await state.listInstalledBackends()).find((p) => p.id === 'rc-flat');
    assert.ok(before);
    // 模拟一次真安装留下的记录：selfTest 已经有结果了
    await state.store.writeManifest('backend', 'rc-flat', {
      ...before!,
      selfTest: { passed: true, ranAt: 'x', devicesFound: 1, rtf: 0.1, errorMessage: null },
    });
    // 再跑一次对账（等价于重启一次）
    const again = await RestState.create({ sse: new SseHub(), dataDir, manifestDir });
    const after = (await again.listInstalledBackends()).find((p) => p.id === 'rc-flat');
    assert.equal(
      after?.selfTest?.passed,
      true,
      '对账把一份已有的记录覆盖掉了 —— 它只该补缺失的那些',
    );
  });

  it('前提自检：夹具真的没有预置任何 manifest（否则上面每一条都恒真）', async () => {
    const dataDir = mkdtempSync(join(TEST_ROOT, 'probe-'));
    await mkdir(join(dataDir, 'models', 'manifests', 'backend'), { recursive: true });
    await assert.rejects(
      () => stat(join(dataDir, 'models', 'manifests', 'backend', 'rc-flat.json')),
      '夹具里居然预置了安装记录 —— 那就不是在测对账了',
    );
  });
});
