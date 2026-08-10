/**
 * #87 / 轴1③ —— **系统里已经有一份 ffmpeg，目录却请你再下一遍 145 MB。**
 *
 * ## 用户症状（跨页矛盾，两句都来自产品自己）
 *
 * v0.7.0 的发布说明**明确让 macOS 用户自己去装 ffmpeg**。他照做之后：
 *
 * | 页面 | 读的是 | 说的话 |
 * |---|---|---|
 * | 首页 `ReadinessBanner` | A 侧 `pipeline.missing`（解析器） | 不报警 —— 因为流水线**真的在用** `/usr/bin/ffmpeg` |
 * | `/runtime`、`/components` | B 侧安装记录（manifest） | 「可安装 · 145 MB」 |
 *
 * 病的形状：**我们把「世界变了」窄化成了「我们自己改变了世界」。**
 * 解析器有三档 `pack | bundle | path`，`path` 那一档是活的；而安装记录里没有那一档
 * （**也不该有** —— 系统 ffmpeg 不是我们的包，我们没装、也无权删）。
 *
 * ## 修法：**加信息**，两侧一个都不合并
 *
 * `backendReconcile.ts:22-38` 已逐条论证过：把 `installed` 改成「有 manifest **或**
 * 文件都在」会造出**第三个答案**（`/backends/installed` 列不出、`DELETE` 404、
 * `installedVersion` 仍 null、`recordSelfTest()` 写不进）。那段论证仍然成立。
 * 所以 `installed` 一个字没动，只在装按钮旁边多说一句实话。
 *
 * ## ── 把名字遮住，这些断言什么时候会失败 ──────────────────────────────────
 *
 *  · 有人把 `installed` 改成"或"（那条论证被推翻）；
 *  · 有人把这一格和 `installedOnDiskButUnrecorded` 并成一个 ——
 *    那是"**我们自己 store 里**有一份没登记的"，这是"**那根本不是我们的东西**"；
 *  · 有人把**包内自带**那一档也算成"系统的"（自带那份是我们的，由 bundled 那条路认领）；
 *  · 有人在没有证据时也发一个值 —— 「我问不出来」会被读成「系统里没有」。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-syspath-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { GetBackendCatalogResponse } from '@openmemo/shared';

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

/** 放一个真的可执行文件（解析器按可执行位判定，不是按文件名）。 */
async function putExecutable(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return p;
}

/**
 * 造一台机器。
 *
 * ★ `PATH` **每条用例自己给全**，不继承宿主 —— 否则这台开发机上真有一个
 * `/usr/bin/ffmpeg`，"没有证据"那条用例就永远跑不出"没有证据"，
 * 而它会**看起来是通过的**（断言的是缺失，宿主有东西时才会红）。
 */
async function seed(opts: { pathDirs?: string[]; bundledDir?: string } = {}): Promise<RestState> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  process.env['PATH'] = (opts.pathDirs ?? []).join(delimiter);
  if (opts.bundledDir === undefined) delete process.env['OPENMEMO_BUNDLED_WHISPER_DIR'];
  else process.env['OPENMEMO_BUNDLED_WHISPER_DIR'] = opts.bundledDir;
  return await RestState.create({ sse: new SseHub(), dataDir, manifestDir: MANIFEST_DIR });
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

const mediaPack = (c: GetBackendCatalogResponse) => {
  const p = c.packs.find((x) => x.id.startsWith('media-tools-') && x.os === process.platform);
  assert.ok(p, '目录里没有本机平台的 media-tools —— 用例前提不成立，下面全是空跑');
  return p;
};

describe('#87 系统里已经有一份 ⇒ 目录要说出来（但不许说成"已安装"）', () => {
  it('★ 用户自己 brew install 的那份被解析到 ⇒ 这一格必须有证据（就是那条路径）', async () => {
    const bin = join(TEST_ROOT, 'hostbin-1');
    const ffmpeg = await putExecutable(bin, 'ffmpeg');
    const state = await seed({ pathDirs: [bin] });

    const media = mediaPack(await catalog(state));
    assert.deepEqual(
      media.servedFromSystemPath,
      { file: 'ffmpeg', path: ffmpeg },
      '系统里那份没被说出来 ⇒ 页面继续请用户把已经有的东西再下一遍 145 MB。' +
        `实得 ${JSON.stringify(media.servedFromSystemPath)}`,
    );
  });

  it('★★ `installed` 的判据一个字没动 —— 它仍然只回答"有没有 manifest"', async () => {
    const bin = join(TEST_ROOT, 'hostbin-2');
    await putExecutable(bin, 'ffmpeg');
    const state = await seed({ pathDirs: [bin] });

    assert.equal(
      mediaPack(await catalog(state)).installed,
      false,
      '把 installed 改成"或"了 —— 那会造出第三个答案：/backends/installed 列不出、' +
        'DELETE 404、installedVersion 仍 null、recordSelfTest 仍写不进（backendReconcile.ts:22-38）',
    );
  });

  it('★ 没有任何证据时**什么都不说**（缺失 ≠ 否）', async () => {
    const state = await seed({ pathDirs: [] });
    for (const p of (await catalog(state)).packs) {
      assert.equal(
        'servedFromSystemPath' in p,
        false,
        `${p.id} 在没有证据时发了这一格 —— 客户端会把"我问不出来"读成"系统里没有"`,
      );
    }
  });

  /**
   * ★★ 两侧不许并成一格。
   *
   * store 里那份是「**我们自己的**，只是没登记」（`installedOnDiskButUnrecorded`），
   * 系统那份是「**根本不是我们的**」。并了就等于又一次"把借来的说成自家的"，
   * 而本仓专门修过那一族。
   */
  it('★★ 反例：落在我们自己 store 里的那份，不许被说成"系统里已经有"', async () => {
    const state = await seed({ pathDirs: [] });
    const dir = join(state.store.root, 'by-name', 'backend', 'ffmpeg-n7.1.5-old.tar.xz');
    const inStore = await putExecutable(dir, 'ffmpeg');

    const media = mediaPack(await catalog(state));
    assert.equal(
      media.servedFromSystemPath ?? null,
      null,
      `store 里那份被说成了"系统的"（${JSON.stringify(media.servedFromSystemPath)}）—— ` +
        '两种状态被并成一格了',
    );
    // 前提自检：它确实被解析到了，只是应该落在**另一格**里 —— 否则上面那条是空跑
    assert.deepEqual(
      media.installedOnDiskButUnrecorded,
      { file: 'ffmpeg', path: inStore },
      '它连另一格也没进 ⇒ 上面那条"不许说成系统的"是在一个没被解析到的东西上空跑',
    );
  });

  it('★ 反例：**包内自带**那份也不许被说成"系统里已经有"（那是我们的东西）', async () => {
    const bundled = join(TEST_ROOT, 'bundle-1', 'runtime', 'probe');
    await putExecutable(bundled, 'ffmpeg');
    const state = await seed({ pathDirs: [], bundledDir: bundled });

    const media = mediaPack(await catalog(state));
    assert.equal(
      media.servedFromSystemPath ?? null,
      null,
      '包内自带那份被说成了"系统的" —— 自带是我们出厂带的，由 bundled 那条路认领',
    );
  });
});
