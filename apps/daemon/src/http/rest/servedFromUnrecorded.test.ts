/**
 * T-197 —— **`/runtime` 对正在被使用的 ffmpeg 说「安装 119 MB」。**
 *
 * ## 用户症状（`:10000` 实测）
 *
 * 同一时刻：`/api/selfcheck` 的 `tool.ffmpeg` 是绿的、流水线正拿它跑转码，
 * 而 `/runtime` 页对**这一份**显示「安装 119 MB」，点下去再下一遍。
 * 盘上是 **7.1.5**、目录已升到 **8.1.2** —— **归档文件名都不同**，
 * 对账按目录声明的名字去 stat，连痕迹都找不到，
 * 于是它既不在 `installed` 里、**也不在对账的 skipped 里**。
 *
 * ## 修法：新增一格，**不改 `installed` 的判据**
 *
 * `backendReconcile.ts:22-38` 已论证过：把 `installed` 改成「有 manifest **或**
 * 文件都在」会造出**第三个答案** —— `installed` 列不出、`DELETE` 404、
 * `installedVersion` 仍 null、`recordSelfTest()` 仍写不进。
 * 所以 `installed` 一个字没动，只把**另一件事**说出来。
 *
 * 证据来自**解析器**（`discoverTools()`，与流水线装配调的是同一个函数），
 * 而不是我们另写一套"扫盘找已安装"。
 *
 * ## 把名字遮住，这些断言什么时候会失败
 *
 * 任何人把这一格改成"没有证据时也发一个 false"（缺失 ≠ 否）、
 * 或者顺手把 `installed` 改成"或"、
 * 或者让一个**已被安装记录认领**的路径也算成"没人记录的副本"。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-served-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { GetBackendCatalogResponse, InstalledBackendPack } from '@openmemo/shared';

import { SseHub } from '../sse.js';
import { handleBackendRoutes } from './backends.js';
import { RestState } from './state.js';

const REPO_ROOT = resolve(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
);
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

function captureRes(): { res: ServerResponse; body: () => string } {
  const chunks: Buffer[] = [];
  const res = {
    writeHead(): ServerResponse {
      return res;
    },
    end(chunk?: Buffer | string): void {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    setHeader(): void {
      /* 不关心 */
    },
  } as unknown as ServerResponse;
  return { res, body: () => Buffer.concat(chunks).toString('utf8') };
}

async function seed(): Promise<RestState> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  // 包内那一档不参与本组用例：只验"盘上有、记录里没有"这一格
  delete process.env['OPENMEMO_BUNDLED_WHISPER_DIR'];
  return await RestState.create({ sse: new SseHub(), dataDir, manifestDir: MANIFEST_DIR });
}

/** 在 `by-name/backend/<dir>/` 里放一个可执行文件 —— 没有任何安装记录认领它。 */
async function putUnrecordedTool(state: RestState, dir: string, name: string): Promise<string> {
  const d = join(state.store.root, 'by-name', 'backend', dir);
  await mkdir(d, { recursive: true });
  const p = join(d, name);
  await writeFile(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return p;
}

async function catalog(state: RestState): Promise<GetBackendCatalogResponse> {
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

const findPack = (c: GetBackendCatalogResponse, id: string) => c.packs.find((p) => p.id === id);

describe('正在被使用、却没有安装记录的那一份，目录要说出来（T-197）', () => {
  it('★ 盘上有一份没人记录的 ffmpeg 正被解析到 ⇒ 目录里这一格必须有证据', async () => {
    const state = await seed();
    const p = await putUnrecordedTool(state, 'ffmpeg-n7.1.5-12-old.tar.xz', 'ffmpeg');

    const c = await catalog(state);
    const media = c.packs.find((x) => x.id.startsWith('media-tools-') && x.os === process.platform);
    // 本机平台上那条 media-tools 必须在目录里，否则这条用例在空跑
    assert.ok(media, '目录里没有本机平台的 media-tools —— 用例前提不成立');

    assert.deepEqual(
      media.installedOnDiskButUnrecorded,
      { file: 'ffmpeg', path: p },
      `正在被使用的那份没被说出来 ⇒ 页面继续显示「安装 119 MB」，点下去再下一遍。` +
        `实得 ${JSON.stringify(media.installedOnDiskButUnrecorded)}`,
    );
  });

  it('★★ `installed` 的判据一个字没动 —— 它仍然只回答"有没有 manifest"', async () => {
    const state = await seed();
    await putUnrecordedTool(state, 'ffmpeg-n7.1.5-12-old.tar.xz', 'ffmpeg');

    const c = await catalog(state);
    const media = c.packs.find((x) => x.id.startsWith('media-tools-') && x.os === process.platform);
    assert.equal(
      media?.installed,
      false,
      '把 installed 改成"或"了 —— 那会造出第三个答案：installed 列不出、DELETE 404、' +
        'installedVersion 仍 null、recordSelfTest 仍写不进（backendReconcile.ts:22-38）',
    );
  });

  it('★ 没有任何证据时**什么都不说**（缺失 ≠ 否）', async () => {
    const state = await seed();
    const c = await catalog(state);
    for (const p of c.packs) {
      assert.equal(
        'installedOnDiskButUnrecorded' in p,
        false,
        `${p.id} 在没有证据时发了这一格 —— 客户端会把它读成"确认没有别处的副本"`,
      );
    }
  });

  it('★ 路径落在**已被安装记录认领**的范围内 ⇒ 不算"没人记录的副本"', async () => {
    const state = await seed();
    const dir = 'claimed-archive.tar.xz';
    const p = await putUnrecordedTool(state, dir, 'ffmpeg');
    // 给它补一条安装记录：`files[].relPath` 指向那个归档，认领的是它的解包目录
    const rec: InstalledBackendPack = {
      schemaVersion: 1,
      id: 'media-tools-claimed',
      engine: 'ffmpeg',
      engineVersion: 'x',
      backend: 'cpu',
      installedAt: new Date().toISOString(),
      verifiedAt: null,
      integrity: 'unverified',
      files: [
        {
          name: dir,
          sha256: '',
          sizeBytes: 1,
          root: 'models',
          relPath: join('by-name', 'backend', dir),
        } as unknown as InstalledBackendPack['files'][number],
      ],
      selfTest: null,
    };
    await state.store.writeManifest('backend', 'media-tools-claimed', rec);

    const c = await catalog(state);
    const media = c.packs.find((x) => x.id.startsWith('media-tools-') && x.os === process.platform);
    assert.equal(
      media?.installedOnDiskButUnrecorded ?? null,
      null,
      `那份 ffmpeg（${p}）已经被一条安装记录认领了，不该被说成"没人记录的副本"`,
    );
  });

  it('★ 已经有自己安装记录的包不算这一格（记录说话，轮不到它）', async () => {
    const state = await seed();
    await putUnrecordedTool(state, 'ffmpeg-n7.1.5-12-old.tar.xz', 'ffmpeg');
    const c0 = await catalog(state);
    const target = c0.packs.find(
      (x) => x.id.startsWith('media-tools-') && x.os === process.platform,
    );
    assert.ok(target);

    await state.store.writeManifest('backend', target.id, {
      schemaVersion: 1,
      id: target.id,
      engine: 'ffmpeg',
      engineVersion: 'x',
      backend: 'cpu',
      installedAt: new Date().toISOString(),
      verifiedAt: null,
      integrity: 'unverified',
      files: [],
      selfTest: null,
    } as InstalledBackendPack);

    const c = await catalog(state);
    const after = findPack(c, target.id);
    assert.equal(after?.installed, true);
    assert.equal(
      after?.installedOnDiskButUnrecorded ?? null,
      null,
      '已有记录的包还在报"别处有一份" —— 那一格只对没有记录的包有意义',
    );
  });
});
