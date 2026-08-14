/**
 * ★★ **「卸载成了，但有 N 个文件没删掉」—— 这句话的服务端那一半。**
 *
 * ## 为什么这个文件在今天之前不存在，而它必须存在
 *
 * `795f091`（#107 ②）让两个卸载端点在**有拒绝时**回 `200 + filesNotRemoved`，
 * 干净的那条路仍然是 `204`。可是**这条 200 从来没有被任何一条用例走过**：
 * `installRecordBounds.test.ts` 钉的是 `dropInstalledFiles()` 的**返回值**
 * （函数层），`bundledUninstallGuard.test.ts` 钉的是 409 那一档。
 * 也就是说，**把这段 200 整个删掉、退回一个沉默的 204，本仓一条都不会红** ——
 * 而那正是 #109 抱怨的那个状态：一个字段只到 API，界面上一个字都没有。
 *
 * ## 🔴 三条一起才算数，缺任何一条这个文件就变成摆设
 *
 *   ① **有拒绝 ⇒ 200，且 `filesNotRemoved` 非空**；
 *   ② **记录真的没了** —— 界面上那句话向用户承诺的正是这一半
 *      （"你的卸载生效了，不用再点一次"）。如果记录还在，那句话就是假的，
 *      而且用户再点一次会拿到 404 与 200 之外的第三种答案；
 *   ③ **干净的那条路仍然是 204** —— 没有它，"把所有卸载都改成回 200"
 *      也能让 ① 绿，于是 ① 什么都没证明。两条路分得开，界面才说得出两句不同的话。
 *
 * ## 判据落在**响应 + 盘上的字节**，不落在 `dropInstalledFiles()` 的返回值上
 *
 * 返回值那一层已经有 `installRecordBounds.test.ts` 守着了。这里问的是另一个问题：
 * **那份账有没有走到 HTTP 上**。所以每条都从路由入口进（`createModelRoutes().handle`
 * —— `server.ts` 用的就是它），并且顺手核一遍"被拒绝的那些字节确实还在盘上"：
 * 一条只看信封的用例，在"回了 200 但文件照删不误"时是绿的，而那是最坏的一种。
 *
 * ⚠️ 与 `installRecordBounds.test.ts:187` 同一条约定：`reason` 是解析层的**英文原话**，
 *   钉它就是钉真契约（`RefusedFileReport.reason` 刻意没有收成枚举）。这里同样按原话断言。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/*
 * ⚠️ PROTOCOL §9-bis：模块顶层重定向，窗口为零。
 * `RestState.create()` 会 mkdir 模型根、读写 active.json —— 不重定向就会去动
 * 这台机器上真实的数据目录。
 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-uninstall-refusal-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';

import { ArtifactStore } from '@openmemo/downloader';
import type {
  InstalledBackendPack,
  InstalledModel,
  UninstallWithRefusalsResponse,
} from '@openmemo/shared';

import { SseHub } from '../sse.js';
import { createModelRoutes, type ModelRoutes } from './models.js';

/** 应用本体里那个文件的替身 —— 内容独一无二，好让"它变了"与"它没了"分得开。 */
const APP_OWNED = Buffer.from('bytes that belong to the installed application, not to the user\n');
/** 库内正常装着的那份 —— 对照组，它**应该**真的被删掉。 */
const STORE_OWNED = Buffer.from('bytes that live inside the artifact store\n');

/**
 * 最小 `ServerResponse` 桩。
 *
 * ⚠️ `end` 必须收 **Buffer**（`sendJson` 写的是 Buffer）：只收 string 的话
 * 状态码断言照样过、而 body 恒为空 —— 那是一条"看起来在测内容、其实只测了状态码"
 * 的用例（`bundledUninstallGuard.test.ts` 里同一条注释，同一个坑）。
 */
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

interface Seeded {
  readonly routes: ModelRoutes;
  readonly store: ArtifactStore;
  readonly modelsRoot: string;
  readonly dataDir: string;
}

/**
 * 造一台干净的机器：空目录 + 一个空的 `ArtifactStore`。
 *
 * ★ 走 `createModelRoutes()`（`server.ts` 的接线点）而不是直接调 `handleBackendRoutes` /
 * 私有的 `handleModelRoutes`：这个文件问的就是"那份账有没有走到 HTTP 上"，
 * 绕过路由层去问就是在问别的问题。`RestState` 由它自己懒加载 ——
 * 所以安装记录必须在**第一个请求之前**写好（下面每条用例都是这么做的）。
 */
async function seed(tag: string): Promise<Seeded> {
  const dataDir = mkdtempSync(join(TEST_ROOT, `${tag}-`));
  const modelsRoot = join(dataDir, 'models');
  process.env['OPENMEMO_MODELS'] = modelsRoot;

  const manifestDir = mkdtempSync(join(TEST_ROOT, `${tag}-manifests-`));
  await writeFile(
    join(manifestDir, 'backends.json'),
    JSON.stringify({
      schemaVersion: 1,
      catalogVersion: '2026.08.14',
      generatedAt: '2026-08-14T00:00:00.000Z',
      packs: [],
    }),
    'utf8',
  );

  const store = new ArtifactStore(modelsRoot);
  await store.init();

  const routes = createModelRoutes({ sse: new SseHub(), dataDir, manifestDir });
  return { routes, store, modelsRoot, dataDir };
}

async function del(
  routes: ModelRoutes,
  apiPath: string,
): Promise<{ status: number; body: string }> {
  const cap = captureRes();
  const handled = await routes.handle(
    {} as IncomingMessage,
    cap.res,
    new URL(`http://127.0.0.1${apiPath}`),
    'DELETE',
  );
  assert.equal(handled, true, '路由根本没接住这个请求，后面的断言无意义');
  return { status: cap.status(), body: cap.body() };
}

/** 一条**遗留形状**的后端安装记录：只有绝对 `path`，没有 `root`/`relPath`。 */
function legacyBackendRecord(id: string, files: { name: string; path: string }[]): unknown {
  return {
    schemaVersion: 1,
    id,
    engine: 'ffmpeg',
    engineVersion: 'n8.1.2',
    backend: 'cpu',
    installedAt: '2026-07-01T00:00:00.000Z',
    verifiedAt: '2026-07-01T00:00:00.000Z',
    integrity: 'ok',
    /*
     * ⚠️ **不是 `bundled`。** 那一档在路由入口就被 409 挡掉了
     * （`bundledUninstallGuard.test.ts` 守的就是它），走不到本文件要测的那个 200。
     * 这里要的是"记录自称是正常下载装的，而它指向的路径其实在库外"——
     * 也就是那条守卫**够不着**的那一半。
     */
    source: 'downloaded',
    files: files.map((f) => ({
      role: 'binary',
      sha256: '',
      sizeBytes: 1,
      name: f.name,
      path: f.path,
    })),
    selfTest: null,
  };
}

/** 一条**可移植形状**的记录：root + relPath，路径就在库内。 */
function portableBackendRecord(id: string, name: string): unknown {
  return {
    schemaVersion: 1,
    id,
    engine: 'yt-dlp',
    engineVersion: '2026.07.04',
    backend: 'cpu',
    installedAt: '2026-07-01T00:00:00.000Z',
    verifiedAt: '2026-07-01T00:00:00.000Z',
    integrity: 'ok',
    source: 'downloaded',
    files: [
      {
        role: 'binary',
        name,
        sha256: '',
        sizeBytes: STORE_OWNED.length,
        root: 'models',
        relPath: `by-name/backend/${name}`,
      },
    ],
    selfTest: null,
  };
}

/* ══════════════ ① 有拒绝 ⇒ 200 + filesNotRemoved，而且记录真的没了 ══════════════ */

describe('#109 DELETE /api/backends/:id —— 有文件没删掉时必须说得出话', () => {
  it('★★ 200 + 非空 filesNotRemoved；记录没了；被拒的那些字节还在盘上', async () => {
    const { routes, store, dataDir } = await seed('backend-refuse');

    // 应用自己的安装目录（**不在**数据目录里，正是随包出厂那份所在的位置）
    const appDir = join(TEST_ROOT, 'backend-refuse-app', 'runtime', 'probe');
    await mkdir(appDir, { recursive: true });
    const victim = join(appDir, 'ffmpeg');
    await writeFile(victim, APP_OWNED);
    assert.equal(
      victim.startsWith(dataDir + sep),
      false,
      '夹具搭错了：这个路径落在数据目录里，那就根本不会被拒绝，这条用例测的是别的东西',
    );

    const id = 'media-tools-refuse';
    await store.writeManifest(
      'backend',
      id,
      legacyBackendRecord(id, [{ name: 'ffmpeg', path: victim }]) as InstalledBackendPack,
    );

    const r = await del(routes, `/api/backends/${id}`);

    /*
     * ① 状态码：**204 是错的答案**，它等于"全删干净了"，而实际上没有。
     *   先把这条单独断出来，红出来的那一行才直接说得清坏在哪一档。
     */
    assert.notEqual(
      r.status,
      204,
      '有文件被拒绝删除，却回了一个沉默的 204 —— 界面因此没有任何东西可显示，' +
        '用户看到卡片消失、磁盘没变小，而产品从头到尾没说过一个字（#109）',
    );
    assert.equal(r.status, 200, `期望 200（“卸载成了，但有残留”那一档）：${r.body}`);

    const body = JSON.parse(r.body) as UninstallWithRefusalsResponse & { packId?: string };
    assert.equal(body.packId, id, `响应里没说这是哪个包：${r.body}`);
    assert.equal(
      typeof body.freedBytes,
      'number',
      `freedBytes 缺了或不是数字 —— 契约里它是必填：${r.body}`,
    );
    assert.equal(
      body.filesNotRemoved.length,
      1,
      `200 却没有逐条说清哪些文件没删掉 —— 那与 204 对用户是同一件事：${r.body}`,
    );
    assert.equal(body.filesNotRemoved[0]?.name, 'ffmpeg');
    /*
     * ② **理由里必须带得出那个绝对路径。**
     *   界面上那句话的第三件事是"那几个文件在哪儿"，而整条链上只有这串原话答得出来。
     *   （`reason` 是解析层英文原话、刻意不翻译 —— 同 installRecordBounds.test.ts:187。）
     */
    assert.ok(
      body.filesNotRemoved[0]?.reason.includes(victim),
      `理由里没说是哪个路径 —— 用户拿着这句话找不到那几个文件：` +
        `${body.filesNotRemoved[0]?.reason ?? '(空)'}`,
    );

    /*
     * ③ ★★ **记录真的没了。** 这是界面那句话向用户承诺的另一半
     *   （"卸载已经生效，不用再点一次"）。记录若还在，那句话就是假的。
     */
    assert.equal(
      await store.readManifest('backend', id),
      null,
      '回了 200 说"记录已清"，而安装记录还在 —— 界面照着这句话告诉用户不用再点，' +
        '而那个包在列表里根本没消失',
    );

    /*
     * ④ 而被拒绝的那些字节**一个都不许少** —— 否则这条 200 是在替一次真实的删除
     *   道歉，那比沉默更坏。
     */
    assert.deepEqual(
      await readFile(victim).catch(() => null),
      APP_OWNED,
      '说了"我们没删它"，其实删了 —— 那是**已安装应用本体**的字节',
    );
  });

  it('★★ 反面：全删干净时仍然是 204（两条路分不开，上一条就什么都没证明）', async () => {
    const { routes, store, modelsRoot } = await seed('backend-clean');

    const id = 'ytdlp-clean';
    const name = 'ytdlp-clean-bin';
    await mkdir(join(modelsRoot, 'by-name', 'backend'), { recursive: true });
    const target = join(modelsRoot, 'by-name', 'backend', name);
    await writeFile(target, STORE_OWNED);
    await store.writeManifest(
      'backend',
      id,
      portableBackendRecord(id, name) as InstalledBackendPack,
    );

    const r = await del(routes, `/api/backends/${id}`);

    assert.equal(
      r.status,
      204,
      `一条完全正常的卸载被改成了 200 —— 那等于对每一次卸载都说一句"有文件被留下"：${r.body}`,
    );
    assert.equal(r.body, '', `204 不该带 body：${r.body}`);
    await assert.rejects(
      () => readFile(target),
      '回了 204（“全删干净了”），文件却还在盘上 —— 那正是 T-192 修过的那种假回收',
    );
    assert.equal(await store.readManifest('backend', id), null, '记录还在 —— 卸载没走完');
  });
});

/* ══════════════ ② 模型那一侧：同一个契约、同一条规则 ══════════════ */

describe('#109 DELETE /api/models/:id —— 同一个形状，两个端点不许各说各的', () => {
  /** 一条**遗留形状**的模型安装记录。 */
  function legacyModelRecord(id: string, name: string, path: string): unknown {
    return {
      schemaVersion: 1,
      id,
      role: 'asr',
      arch: 'whisper',
      format: 'ggml',
      quantization: 'q5_1',
      installedAt: '2026-07-01T00:00:00.000Z',
      verifiedAt: '2026-07-01T00:00:00.000Z',
      integrity: 'ok',
      sizeBytes: 1,
      files: [{ role: 'weights', name, sha256: '', sizeBytes: 1, path }],
    };
  }

  it('★★ 有拒绝 ⇒ 200 + filesNotRemoved，记录没了，字节还在', async () => {
    const { routes, store, dataDir } = await seed('model-refuse');

    const outsideDir = join(TEST_ROOT, 'model-refuse-elsewhere');
    await mkdir(outsideDir, { recursive: true });
    const victim = join(outsideDir, 'ggml-tiny.bin');
    await writeFile(victim, APP_OWNED);
    assert.equal(victim.startsWith(dataDir + sep), false, '夹具搭错了：这个路径落在数据目录里');

    // 斜杠是模型 id 的真实形状（`asr/…`），顺带把 URL 编解码那一段也走到
    const id = 'asr/legacy-outside';
    await store.writeManifest(
      'asr',
      id,
      legacyModelRecord(id, 'ggml-tiny.bin', victim) as unknown as InstalledModel,
    );

    const r = await del(routes, `/api/models/${encodeURIComponent(id)}`);

    assert.notEqual(
      r.status,
      204,
      '模型那一侧退回了沉默的 204 —— 两个端点对同一件事给了两种答案（#109 的另一半）',
    );
    assert.equal(r.status, 200, `期望 200：${r.body}`);

    const body = JSON.parse(r.body) as UninstallWithRefusalsResponse & { modelId?: string };
    assert.equal(body.modelId, id, `响应里没说这是哪个模型：${r.body}`);
    assert.equal(typeof body.freedBytes, 'number', `freedBytes 缺了或不是数字：${r.body}`);
    assert.equal(body.filesNotRemoved.length, 1, `200 却没有逐条说清哪些文件没删掉：${r.body}`);
    assert.equal(body.filesNotRemoved[0]?.name, 'ggml-tiny.bin');
    assert.ok(
      body.filesNotRemoved[0]?.reason.includes(victim),
      `理由里没带上那个绝对路径：${body.filesNotRemoved[0]?.reason ?? '(空)'}`,
    );

    assert.equal(
      await store.readManifest('asr', id),
      null,
      '回了 200 说"记录已清"，而安装记录还在 —— 界面那句话就成了假话',
    );
    assert.deepEqual(
      await readFile(victim).catch(() => null),
      APP_OWNED,
      '说了"我们没删它"，其实删了',
    );
  });

  it('★★ 反面：全删干净时仍然是 204', async () => {
    const { routes, store, modelsRoot } = await seed('model-clean');

    const id = 'asr/clean-inside';
    const name = 'ggml-clean.bin';
    await mkdir(join(modelsRoot, 'by-name', 'asr'), { recursive: true });
    const target = join(modelsRoot, 'by-name', 'asr', name);
    await writeFile(target, STORE_OWNED);
    await store.writeManifest('asr', id, {
      schemaVersion: 1,
      id,
      role: 'asr',
      arch: 'whisper',
      format: 'ggml',
      quantization: 'q5_1',
      installedAt: '2026-07-01T00:00:00.000Z',
      verifiedAt: '2026-07-01T00:00:00.000Z',
      integrity: 'ok',
      sizeBytes: STORE_OWNED.length,
      files: [
        {
          role: 'weights',
          name,
          sha256: '',
          sizeBytes: STORE_OWNED.length,
          root: 'models',
          relPath: `by-name/asr/${name}`,
        },
      ],
    } as unknown as InstalledModel);

    const r = await del(routes, `/api/models/${encodeURIComponent(id)}`);

    assert.equal(r.status, 204, `一条完全正常的模型卸载被改成了 200：${r.body}`);
    assert.equal(r.body, '', `204 不该带 body：${r.body}`);
    await assert.rejects(() => readFile(target), '回了 204，文件却还在盘上');
    assert.equal(await store.readManifest('asr', id), null, '记录还在 —— 卸载没走完');
  });
});
