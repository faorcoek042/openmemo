/**
 * T-172 ★★ **捂热失败绝不能让装包失败** —— 走产品自己的那条安装路径。
 *
 * ## 为什么光有 `warmup.test.ts` 不够
 *
 * 那一份钉的是「`warmProbeCache()` 自己不抛」。但本仓最贵的那一族缺陷是
 * **「函数写好了、没有人调它」**（`useDeleteNoteMutation` 笔记删不掉、
 * `ERROR_MESSAGES_ZH` 中文错误不显示、`stashForRollback` 回滚永远不可用 ——
 * 每一条的单元测试当时都是绿的）。所以这里补两件单元测试证不了的事：
 *
 *   ① **装包路径真的调了它**（注入一个替身，断言它被调用过）；
 *   ② **它抛出来的时候，job 仍然是 `succeeded`、manifest 仍然落了盘**。
 *
 * ② 才是要害。`DownloadQueue.run()` 是 `await entry.task(ctx)` 外面套 try/catch
 * （`packages/downloader/src/queue.ts:201`）——**任务里任何一处抛出都会把整个 job 判失败**。
 * 于是用户看到"安装失败"，而包其实已经完整装好了：一次纯粹由优化步骤制造的假故障。
 * 对照组就在同一个文件里（下面最后一条）：让任务体的**别处**抛，job 确实变 failed ——
 * 证明这条断言有区分力，不是恒真。
 */

/*
 * ⚠️ PROTOCOL §9-bis：模型根 / 扩展目录 / 指针文件一律在**模块顶层**钉进 tmp，窗口为零。
 * `RestState.create()` 会 mkdir 模型根、读写 active.json / prefs.json ——
 * 不重定向就会去动这台机器上真实的数据目录（用户的 demo 就在那儿）。
 * node:test 一个文件一个子进程，进程退了环境变量就没了，**不需要清理代码**。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-warminstall-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');
process.env['OPENMEMO_POINTER_FILE'] = join(TEST_ROOT, 'datadir.json');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { TERMINAL_JOB_STATES, type BackendPack, type DownloadJob } from '@openmemo/shared';

import type { WarmProbeCacheResult } from '../../runtime/warmup.js';
import { SseHub } from '../sse.js';
import { currentPlatform, startPackInstall } from './backends.js';
import { RestState } from './state.js';

/** 仓库根 —— dist/http/rest/ 上溯 4 层。真实清单目录，省得再造一份合成目录。 */
const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

const BINARY = Buffer.from('#!/bin/sh\necho t-172-warmup\n');
const SHA = createHash('sha256').update(BINARY).digest('hex');

let server: Server;
let origin = '';

before(async () => {
  server = createServer((req, res) => {
    if (req.url !== '/pack.bin') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-length': String(BINARY.length) });
    res.end(req.method === 'HEAD' ? undefined : BINARY);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  origin = `http://127.0.0.1:${String(addr.port)}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let packSeq = 0;
function makePack(): BackendPack {
  packSeq += 1;
  const here = currentPlatform();
  return {
    schemaVersion: 1,
    id: `t172-warm-${String(packSeq)}`,
    engine: 'whisper.cpp',
    engineVersion: '1.9.1',
    ggmlAbi: null,
    backend: 'cpu',
    tier: 'downloadable',
    os: here.os,
    arch: here.arch,
    displayName: 'T-172 warm',
    displayNameZh: 'T-172 捂热',
    totalSizeBytes: BINARY.length,
    requiresDriver: null,
    license: { id: 'MIT', gated: false, url: 'https://github.com/x/y/blob/main/LICENSE' },
    providesFiles: [`t172-warm-${String(packSeq)}.bin`],
    priority: 1,
    availability: 'published',
    benchmark: null,
    catalogVersion: '2026.08.08',
    files: [
      {
        role: 'binary',
        name: `t172-warm-${String(packSeq)}.bin`,
        sizeBytes: BINARY.length,
        sha256: SHA,
        mirrors: [{ provider: 'custom', url: `${origin}/pack.bin`, official: true }],
      },
    ],
  } as BackendPack;
}

async function settle(state: RestState, job: DownloadJob): Promise<DownloadJob> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const cur = state.queue.get(job.jobId);
    if (cur && TERMINAL_JOB_STATES.includes(cur.state)) return cur;
    if (Date.now() > deadline) throw new Error(`任务没有在 20s 内结束：${String(cur?.state)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function newState(): Promise<RestState> {
  return RestState.create({ sse: new SseHub(), dataDir: TEST_ROOT, manifestDir: MANIFEST_DIR });
}

describe('★★ T-172 捂热失败 ≠ 装包失败（走真实 startPackInstall）', () => {
  it('★ 捂热**同步 throw**：job 仍然 succeeded，manifest 仍然落盘', async () => {
    const state = await newState();
    const pack = makePack();

    const { job } = startPackInstall(state, pack, {
      warmProbeCache: () => {
        throw new Error('boom：捂热同步炸了');
      },
    });

    const done = await settle(state, job);

    assert.equal(
      done.state,
      'succeeded',
      `捂热抛异常把装包判成了 ${done.state} —— 包其实已经装好了，这是纯粹由优化步骤制造的假故障`,
    );
    assert.equal(done.error ?? null, null);

    // 真的装上了，不只是"没报错"
    const installed = await state.listInstalledBackends();
    assert.equal(
      installed.some((p) => p.id === pack.id),
      true,
      '安装记录没写成 —— 那这条用例证明不了"装包成功"',
    );
  });

  it('★ 捂热返回 rejected promise：同样 succeeded', async () => {
    const state = await newState();
    const pack = makePack();

    const { job } = startPackInstall(state, pack, {
      warmProbeCache: () => Promise.reject(new Error('boom：捂热异步拒绝')),
    });

    const done = await settle(state, job);
    assert.equal(done.state, 'succeeded');
    const installed = await state.listInstalledBackends();
    assert.equal(
      installed.some((p) => p.id === pack.id),
      true,
    );
  });

  it('★ 捂热如实报失败（不抛，返回 ok:false）：同样 succeeded', async () => {
    const state = await newState();
    const pack = makePack();

    const { job } = startPackInstall(state, pack, {
      warmProbeCache: async (): Promise<WarmProbeCacheResult> => ({
        attempted: true,
        ok: false,
        skipped: null,
        durationMs: 90_000,
        detail: '捂热未成功（timeout）',
      }),
    });

    const done = await settle(state, job);
    assert.equal(done.state, 'succeeded');
  });

  it('★ 装包路径**真的调用了**捂热（否则这个功能等于没接上）', async () => {
    const state = await newState();
    const pack = makePack();
    let calls = 0;

    const { job } = startPackInstall(state, pack, {
      warmProbeCache: async (options): Promise<WarmProbeCacheResult> => {
        calls += 1;
        // 传下来的路径必须是这台 daemon 真实的模型根，不是某个约定俗成的猜测
        assert.equal(options.modelsDir, state.modelsRoot);
        assert.equal(typeof options.dataDir, 'string');
        return {
          attempted: false,
          ok: false,
          skipped: 'not-darwin',
          durationMs: 0,
          detail: 'test',
        };
      },
    });

    const done = await settle(state, job);
    assert.equal(done.state, 'succeeded');
    assert.equal(calls, 1, '装包流程一次都没调捂热 —— 写好了没人调，正是本仓最贵的那一族缺陷');
  });

  it('★ 捂热真的开跑时，进度条上换了文案（onBeforeProbe → step=warming）', async () => {
    const state = await newState();
    const pack = makePack();
    const steps: (string | null)[] = [];

    let jobId = '';
    const { job } = startPackInstall(state, pack, {
      warmProbeCache: async (options): Promise<WarmProbeCacheResult> => {
        options.onBeforeProbe?.();
        steps.push(state.queue.get(jobId)?.step ?? null);
        return { attempted: true, ok: true, skipped: null, durationMs: 16_011, detail: 'ok' };
      },
    });
    jobId = job.jobId;

    const done = await settle(state, job);
    assert.equal(done.state, 'succeeded');
    assert.deepEqual(
      steps,
      ['warming'],
      '捂热那十几秒里进度条上没有任何说明 —— 用户只会以为卡死了',
    );
  });

  /*
   * ── 对照组 ──────────────────────────────────────────────────────────────
   * 上面那些断言只有在"任务体里抛异常确实会让 job 变 failed"的前提下才有意义。
   * 不放这一条，`succeeded` 可能只是因为队列压根不在乎异常 —— 那样全组恒真。
   */
  it('前提自检：任务体**别处**抛出时，job 确实变 failed（证明上面的断言有区分力）', async () => {
    const state = await newState();
    const { job } = state.queue.enqueue(
      { kind: 'backend-pack', targetId: 't172-control', displayName: 'x', totalBytes: 1 },
      () => Promise.reject(new Error('对照组：这一发就该失败')),
    );

    const done = await settle(state, job);
    assert.equal(done.state, 'failed');
  });
});
