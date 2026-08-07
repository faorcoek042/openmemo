/**
 * gates-fix §5.3 / T-164 —— **自检跑完了，结果却到不了界面**。
 *
 * ## 缺陷原状
 *
 * T-160 已经把自检修到**跑得起来**（用户点「自测」实测拿到 `passed:true, 18.6x`）。
 * 但 `POST /api/backends/selftest` 的结果**没有任何人写回 `InstalledBackendPack.selfTest`**：
 * 全仓写这个字段的只有 `backends.ts` 里那一句 `selfTest: null`。
 *
 * 于是 `/api/backends/installed` 里每个包的 `selfTest` 恒为 null，
 * `BackendPackCard` 的三条分支 —— 通过徽章、失败徽章、`anyFailed` 横幅 ——
 * **永远不会亮**。用户点完自测看到一次性的返回，刷新一下就什么都没有了；
 * 而 D-05 明说 `passed:false` 必须留下一条**持续**的警告。
 *
 * ## 判据：钉「记到谁头上」，不只钉「有没有写」
 *
 * 只断言"写进去了"是不够的 —— 把结果无脑写到请求里那个 id 上同样能让断言变绿，
 * 而那会**发明一条不成立的证据**：用户在 CUDA 包的卡片上点自测，
 * 实际跑的是 CPU 后端，记录却写成"CUDA 包自检通过"。比 `selfTest: null` 坏得多。
 * 所以这里有一半的用例是在验**它什么时候必须拒绝写**。
 */

/*
 * ⚠️ PROTOCOL §9-bis：模块顶层就把模型根钉进 tmp，窗口为零。
 * 这个文件只碰自己 mkdtemp 出来的目录，但同一条纪律要一视同仁 ——
 * 判据是"被 kill 在最坏的那一行会留下什么"，不是"我这次小心了"。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-selftest-rec-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { ArtifactStore } from '@openmemo/downloader';
import type { InstalledBackendPack } from '@openmemo/shared';

import { createRuntimeRoutes, recordSelfTest, type SelfTestOutcomeLike } from './hardware.js';

const PASSED: SelfTestOutcomeLike = {
  passed: true,
  ranAt: '2026-08-07T03:21:00.000Z',
  devicesFound: 0,
  rtf: 0.0538,
  backendUsed: 'cpu',
  errorMessage: null,
};

/** 与 `backends.ts` 的 `toInstalledRecord()` 同形（含那句恒 null 的 selfTest）。 */
function packRecord(id: string, backend: string): InstalledBackendPack {
  return {
    schemaVersion: 1,
    id,
    engine: 'whisper.cpp',
    engineVersion: '1.9.1',
    backend,
    installedAt: '2026-08-06T10:00:00.000Z',
    verifiedAt: '2026-08-06T10:00:00.000Z',
    integrity: 'ok',
    files: [{ name: 'x.tar.gz', sha256: 'a'.repeat(64), sizeBytes: 1, path: '/x' }],
    selfTest: null,
  } as unknown as InstalledBackendPack;
}

async function storeWith(packs: InstalledBackendPack[]): Promise<ArtifactStore> {
  const root = mkdtempSync(join(TEST_ROOT, 'store-'));
  const store = new ArtifactStore(root);
  await store.init();
  for (const p of packs) await store.writeManifest('backend', p.id, p);
  return store;
}

async function readBack(store: ArtifactStore, id: string): Promise<InstalledBackendPack | null> {
  return store.readManifest<InstalledBackendPack>('backend', id);
}

/** `readJsonBody()` 只用 `for await (const chunk of req)` —— 一个异步可迭代就够。 */
function bodyReq(json: string): IncomingMessage {
  return Readable.from([Buffer.from(json, 'utf8')]) as unknown as IncomingMessage;
}

describe('后端自检结果必须落回安装记录（gates-fix §5.3）', () => {
  it('★ 跑通之后 selfTest 不再是 null —— 三条 UI 分支这才有可能亮', async () => {
    const store = await storeWith([packRecord('whispercpp-cpu-linux-x64', 'cpu')]);

    // 前提：写之前它确实是 null（否则这条用例可能一直在看一个本来就非 null 的字段）
    assert.equal((await readBack(store, 'whispercpp-cpu-linux-x64'))?.selfTest, null);

    const r = await recordSelfTest(store.root, 'whispercpp-cpu-linux-x64', PASSED);
    assert.equal(r.ok, true, `没写成：${String(r.reason)}`);
    assert.equal(r.packId, 'whispercpp-cpu-linux-x64');

    const after = await readBack(store, 'whispercpp-cpu-linux-x64');
    assert.equal(
      after?.selfTest?.passed,
      true,
      'selfTest 还是 null —— 用户点完自测，刷新一下界面又什么都没有了',
    );
    // 数字要**原样**落下去：卡片上显示的 rtf / devicesFound 就来自这里
    assert.equal(after?.selfTest?.rtf, 0.0538);
    assert.equal(after?.selfTest?.devicesFound, 0);
    assert.equal(after?.selfTest?.ranAt, PASSED.ranAt);
    // 其余字段一个都不许被这次写入弄丢
    assert.equal(after?.engineVersion, '1.9.1');
    assert.equal(after?.files.length, 1);
  });

  it('★ 失败也要落库 —— D-05 要求 passed:false 留下一条持续的警告', async () => {
    const store = await storeWith([packRecord('whispercpp-cpu-linux-x64', 'cpu')]);
    const r = await recordSelfTest(store.root, 'whispercpp-cpu-linux-x64', {
      ...PASSED,
      passed: false,
      rtf: null,
      errorMessage: 'whisper-cli exited with 134',
    });
    assert.equal(r.ok, true);
    const after = await readBack(store, 'whispercpp-cpu-linux-x64');
    assert.equal(after?.selfTest?.passed, false);
    assert.equal(after?.selfTest?.errorMessage, 'whisper-cli exited with 134');
  });

  it('★ 跑的是 CPU 后端，就不许记到 CUDA 包头上（这是发明证据，不是少个功能）', async () => {
    const store = await storeWith([
      packRecord('whispercpp-cpu-linux-x64', 'cpu'),
      packRecord('whispercpp-cuda-linux-x64', 'cuda'),
    ]);
    const r = await recordSelfTest(store.root, 'whispercpp-cuda-linux-x64', PASSED);
    assert.equal(r.ok, false, '把一次 CPU 自检记成了 CUDA 包通过');
    assert.equal(
      (r.reason ?? '').includes('cuda'),
      true,
      `拒绝的理由要说清楚，实得：${String(r.reason)}`,
    );
    assert.equal(
      (await readBack(store, 'whispercpp-cuda-linux-x64'))?.selfTest,
      null,
      'CUDA 包的记录被改了',
    );
    // 也不许"退而求其次"偷偷写到 CPU 包上 —— 用户没有点它
    assert.equal((await readBack(store, 'whispercpp-cpu-linux-x64'))?.selfTest, null);
  });

  it('没带 id 时按 backendUsed 认领，且只在唯一时才写', async () => {
    const one = await storeWith([packRecord('whispercpp-cpu-linux-x64', 'cpu')]);
    const r1 = await recordSelfTest(one.root, null, PASSED);
    assert.equal(r1.ok, true);
    assert.equal(r1.packId, 'whispercpp-cpu-linux-x64');

    const two = await storeWith([
      packRecord('whispercpp-cpu-linux-x64', 'cpu'),
      packRecord('llamacpp-cpu-linux-x64', 'cpu'),
    ]);
    const r2 = await recordSelfTest(two.root, null, PASSED);
    assert.equal(r2.ok, false, '两个 cpu 包都在，却挑了一个写进去');
    assert.equal((await readBack(two, 'whispercpp-cpu-linux-x64'))?.selfTest, null);
    assert.equal((await readBack(two, 'llamacpp-cpu-linux-x64'))?.selfTest, null);
  });

  /* ======================================================================== *
   * 接线：`POST /api/backends/selftest` 真的会调它
   * ======================================================================== */

  it('★★ 走真路由 POST /api/backends/selftest：结果必须落到磁盘上的安装记录里', async () => {
    /*
     * 上面那几条只证明 `recordSelfTest()` 自己是对的 —— 而这个仓库反复吃亏的形状
     * 恰恰是「函数写好了、没有人调它」（笔记删不掉 / 中文错误不显示 / 回滚永不可用）。
     * 所以这一条打在**路由**上：请求进去、manifest 文件出来。
     * 唯一被顶替的是自检执行器本身（本机没有 whisper-cli，且用户禁止跑真转写）。
     */
    const store = await storeWith([packRecord('whispercpp-cpu-linux-x64', 'cpu')]);
    const routes = createRuntimeRoutes({
      paths: { dataDir: join(store.root, '..'), modelsDir: store.root },
      runSelfTest: () =>
        Promise.resolve({
          status: 'ran' as const,
          outcome: {
            passed: true,
            ranAt: PASSED.ranAt,
            devicesFound: 0,
            rtf: 0.0538,
            speedup: 18.6,
            backendUsed: 'cpu',
            transcriptSimilarity: 0.98,
            errorMessage: null,
          },
          summary: '真实推理 18.6x',
          audioSeconds: 11,
          timeoutMs: 120000,
          resolved: { whisperCli: '/x/whisper-cli', model: '/x/m.bin', audio: '/x/jfk.wav' },
        } as never),
    });

    let status = 0;
    let payload = '';
    const res = {
      writeHead(s: number) {
        status = s;
        return res;
      },
      end(chunk?: Buffer | string) {
        if (chunk) payload += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      },
      setHeader() {
        /* 不关心 */
      },
    } as unknown as ServerResponse;

    // 真请求体：前端发的就是 `{id}`
    const req = bodyReq(JSON.stringify({ id: 'whispercpp-cpu-linux-x64' }));
    const handled = await routes.handle(
      req,
      res,
      new URL('http://127.0.0.1/api/backends/selftest'),
      'POST',
    );
    assert.equal(handled, true, '路由没认领 /api/backends/selftest');
    assert.equal(status, 200, `自检没跑成：${String(status)} ${payload}`);

    const body = JSON.parse(payload) as { recorded?: boolean; recordedTo?: string | null };
    assert.equal(body.recorded, true, `响应说没记下来：${payload}`);
    assert.equal(body.recordedTo, 'whispercpp-cpu-linux-x64');

    // ★ 真正的判据：**磁盘上那份 manifest** 变了
    const after = await readBack(store, 'whispercpp-cpu-linux-x64');
    assert.equal(
      after?.selfTest?.passed,
      true,
      '路由跑完了，manifest 里的 selfTest 还是 null —— 三条 UI 分支仍然不会亮',
    );
    assert.equal(after?.selfTest?.rtf, 0.0538);
  });

  it('backendUsed 缺失 / id 指向没装的包 —— 一律不写，并说明原因', async () => {
    const store = await storeWith([packRecord('whispercpp-cpu-linux-x64', 'cpu')]);

    const noBackend = await recordSelfTest(store.root, 'whispercpp-cpu-linux-x64', {
      ...PASSED,
      backendUsed: null,
    });
    assert.equal(noBackend.ok, false);
    assert.equal(noBackend.reason !== null, true, '拒绝了却不说为什么，等于静默丢掉结果');

    const ghost = await recordSelfTest(store.root, 'whispercpp-vulkan-win-x64', PASSED);
    assert.equal(ghost.ok, false);
    assert.equal((ghost.reason ?? '').includes('whispercpp-vulkan-win-x64'), true);

    assert.equal((await readBack(store, 'whispercpp-cpu-linux-x64'))?.selfTest, null);
  });
});
