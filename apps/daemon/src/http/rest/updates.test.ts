/**
 * `GET /api/updates/check` —— D-20 §17 落地的唯一生产调用方（`updates.ts`）。
 *
 * 这里不重复 `packages/downloader/src/catalogUpdate.test.ts` 已经钉死的三条前提内部
 * 逻辑（签名/回退/钉死项），只钉 HTTP 这一层特有的两件事：
 *   1. `local.loadError`（清单目录本身读不了）与"查更新失败"是两种结果，不许混成一种
 *      —— 这正是 T-153 三态设计在这个新端点上的落地方式。
 *   2. 未设远端环境变量时诚实回 `not-configured`，且是 200 而不是错误状态码
 *      （"没配"不是"坏了"）。
 * 外加一条方法白名单（非 GET → 405）。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createUpdateRoutes } from './updates.js';

function captureRes(): { res: ServerResponse; status: () => number; body: () => unknown } {
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
  return {
    res,
    status: () => status,
    body: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
  };
}

/** 一个存在、可读、但没有任何清单文件的目录 —— `loadModelCatalog` 视为「真零」，非 loadError。 */
async function emptyManifestDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'om-updates-empty-'));
}

/** 一个根本不存在的目录 —— `loadModelCatalog` 走进 T-153 的 loadError 分支。 */
async function missingManifestDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'om-updates-gone-'));
  return join(d, 'no-such-manifests');
}

describe('createUpdateRoutes — GET /api/updates/check', () => {
  it('非 GET 一律 405，不触碰任何目录/网络', async () => {
    const routes = createUpdateRoutes({ manifestDir: await emptyManifestDir() });
    const cap = captureRes();
    const handled = await routes.handle(
      {} as IncomingMessage,
      cap.res,
      new URL('http://localhost/api/updates/check'),
      'POST',
    );
    assert.equal(handled, true);
    assert.equal(cap.status(), 405);
  });

  it('不认识的路径不接手（交回给下一个 router）', async () => {
    const routes = createUpdateRoutes({ manifestDir: await emptyManifestDir() });
    const cap = captureRes();
    const handled = await routes.handle(
      {} as IncomingMessage,
      cap.res,
      new URL('http://localhost/api/something-else'),
      'GET',
    );
    assert.equal(handled, false);
  });

  it('★ 清单目录本身读不了（T-153 loadError）：source=not-configured，且如实说明是目录读不了，不是"查更新失败"', async () => {
    const routes = createUpdateRoutes({ manifestDir: await missingManifestDir() });
    const cap = captureRes();
    const handled = await routes.handle(
      {} as IncomingMessage,
      cap.res,
      new URL('http://localhost/api/updates/check'),
      'GET',
    );
    assert.equal(handled, true);
    assert.equal(cap.status(), 200, '目录读不了不是 HTTP 层面的错误 —— 端点仍然如实回一份 JSON');
    const body = cap.body() as { source: string; detail: string; newOrChanged: unknown[] };
    assert.equal(body.source, 'not-configured');
    assert.match(body.detail, /本地目录都没读到/);
    assert.deepEqual(body.newOrChanged, []);
  });

  it('目录能读到（真零也算能读到）+ 未配置远端环境变量：source=not-configured，200，不发起任何网络请求', async () => {
    let fetchCalled = false;
    const routes = createUpdateRoutes({
      manifestDir: await emptyManifestDir(),
      env: {}, // 显式模拟"两个 OPENMEMO_CATALOG_UPDATE_* 都没设"
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('unexpected', { status: 200 });
      }) as typeof fetch,
    });
    const cap = captureRes();
    const handled = await routes.handle(
      {} as IncomingMessage,
      cap.res,
      new URL('http://localhost/api/updates/check'),
      'GET',
    );
    assert.equal(handled, true);
    assert.equal(cap.status(), 200);
    const body = cap.body() as { source: string; newOrChanged: unknown[] };
    assert.equal(body.source, 'not-configured');
    assert.deepEqual(body.newOrChanged, []);
    assert.equal(fetchCalled, false, '未配置地址时不该发起任何网络请求');
  });

  it('真实清单目录（vendor/manifests）也能正常喂给 checkForUpdates，不因为条目形状（files[] 而非顶层 sha256）而炸掉', async () => {
    // 不传 manifestDir：走 resolveManifestDir() 默认值，验证真实生产路径也能编译期/运行期都过。
    const routes = createUpdateRoutes({ env: {} });
    const cap = captureRes();
    const handled = await routes.handle(
      {} as IncomingMessage,
      cap.res,
      new URL('http://localhost/api/updates/check'),
      'GET',
    );
    assert.equal(handled, true);
    assert.equal(cap.status(), 200);
    const body = cap.body() as { source: string };
    assert.equal(body.source, 'not-configured');
  });
});
