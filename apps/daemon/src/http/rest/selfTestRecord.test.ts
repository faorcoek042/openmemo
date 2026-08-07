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
 *
 * ## ★★ T-166：上面这些用例**当时全绿，而产品那条路是死的**
 *
 * T-164 的认领规则是 `pack.backend === outcome.backendUsed`，用例喂的是
 * `backendUsed: 'cpu'`。而真正产出这个字段的 `parseBackendUsed()`
 * （`packages/runtime/src/selfTest.ts`）解析的是 whisper 的 stderr，返回的是
 * **日志文字**：`'CPU'` / `'CPU (ggml-cpu-zen4)'` / GPU 设备名 / `null` ——
 * 与 `Backend` 枚举（`'cpu'`）**一个都不相等**。
 *
 * 于是那条比较在**任何真实机器上恒真** → 恒拒绝写 → `selfTest` 照旧永远是 null，
 * 三条 UI 分支照旧不亮。**修复交付了、用例绿了，用户看到的东西一个字没变。**
 *
 * 成因是这一族里最贵的一种：**断言钉的是测试自己造的形状，不是产出方的真实形状。**
 * 所以现在多了一条用例，它把 `parseBackendUsed()` 的**真实输出**（喂进去的是
 * whisper 真实 stderr 的逐字样本）接到这条链上 —— 两个模块的词汇表在用例里碰面。
 *
 * 认领依据同时换成了**结构**：`resolveBackendTool()` 按安装记录把二进制所在目录
 * 反查回包，`runBackendSelfTest()` 交出 `packId`。不再比对任何字符串。
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
import { parseBackendUsed } from '@openmemo/runtime';
import type { InstalledBackendPack } from '@openmemo/shared';

import { createRuntimeRoutes, recordSelfTest, type SelfTestOutcomeLike } from './hardware.js';

/**
 * ⚠️ `backendUsed` 这里**刻意**用产出方真实会给的形状（`parseBackendUsed()` 的输出），
 * 不是 `Backend` 枚举那个 `'cpu'`。写成 `'cpu'` 正是 T-164 那条恒假比较能一路绿到
 * 交付的原因 —— 用例造了一个产品里不存在的形状，然后验证代码认得它。
 */
const PASSED: SelfTestOutcomeLike = {
  passed: true,
  ranAt: '2026-08-07T03:21:00.000Z',
  devicesFound: 0,
  rtf: 0.0538,
  backendUsed: 'CPU (ggml-cpu-zen4)',
  errorMessage: null,
};

/** 认领依据：跑的是哪个包 + 用户点的是哪张卡片。 */
const from = (packId: string | null, requestedId: string | null = packId) => ({
  packId,
  requestedId,
});

/**
 * whisper.cpp 在**没有 GPU 的机器**上的真实 stderr（逐字抄自
 * `packages/runtime/src/selfTest.ts` 里 `parseBackendUsed()` 的实测记录）。
 *
 * 用真日志而不是自造字符串，是因为这条链上的缺陷正是"用例造了一个产品里
 * 不存在的形状"。判据必须来自产出方。
 */
const REAL_WHISPER_STDERR = [
  'ggml_vulkan: No devices found.',
  'load_backend: loaded Vulkan backend from /x/libggml-vulkan.so',
  'load_backend: loaded CPU backend from /x/libggml-cpu-zen4.so',
  'whisper_backend_init_gpu: no GPU found',
  '',
].join('\n');

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

    const r = await recordSelfTest(store.root, from('whispercpp-cpu-linux-x64'), PASSED);
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
    /*
     * ★ T-166：「跑通了」与「加速用上了」必须能分开说。
     * 记录里要留下 whisper 自己报的那句"实际用的是哪个后端" ——
     * 否则一张 Vulkan 卡片上的"自检通过"与"它真的用上了 Vulkan"长得一模一样。
     */
    assert.equal(after?.selfTest?.backendUsed, 'CPU (ggml-cpu-zen4)');
  });

  it('★ 失败也要落库 —— D-05 要求 passed:false 留下一条持续的警告', async () => {
    const store = await storeWith([packRecord('whispercpp-cpu-linux-x64', 'cpu')]);
    const r = await recordSelfTest(store.root, from('whispercpp-cpu-linux-x64'), {
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

  it('★ 跑的是 CPU 包的二进制，就不许记到 CUDA 包头上（这是发明证据，不是少个功能）', async () => {
    const store = await storeWith([
      packRecord('whispercpp-cpu-linux-x64', 'cpu'),
      packRecord('whispercpp-cuda-linux-x64', 'cuda'),
    ]);
    // 用户点的是 CUDA 卡片，而这次真正跑的是 CPU 包给的 whisper-cli
    const r = await recordSelfTest(
      store.root,
      { packId: 'whispercpp-cpu-linux-x64', requestedId: 'whispercpp-cuda-linux-x64' },
      PASSED,
    );
    assert.equal(r.ok, false, '把一次 CPU 包的自检记成了 CUDA 包通过');
    assert.equal(
      (r.reason ?? '').includes('whispercpp-cuda-linux-x64'),
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

  it('没带 id（自检/CLI 出口）时，仍按"二进制是谁给的"认领', async () => {
    /*
     * 两个 cpu 包同时装着 —— T-164 的规则在这里认不出是哪一个（它只有 backend
     * 这一个信息，两个包的 backend 相同），于是**放弃写**。
     * 换成结构判据之后这个歧义根本不存在：跑的是哪个目录里的二进制是确定的。
     */
    const two = await storeWith([
      packRecord('whispercpp-cpu-linux-x64', 'cpu'),
      packRecord('llamacpp-cpu-linux-x64', 'cpu'),
    ]);
    const r = await recordSelfTest(two.root, from('llamacpp-cpu-linux-x64', null), PASSED);
    assert.equal(r.ok, true, `没写成：${String(r.reason)}`);
    assert.equal(r.packId, 'llamacpp-cpu-linux-x64');
    assert.equal((await readBack(two, 'llamacpp-cpu-linux-x64'))?.selfTest?.passed, true);
    // 另一个包**一个字都不许被碰**
    assert.equal((await readBack(two, 'whispercpp-cpu-linux-x64'))?.selfTest, null);
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
    /** 路由到底把什么交给了自检执行器 —— ① 的接线就在这一格里。 */
    let askedPackId: unknown = '<未调用>';
    const routes = createRuntimeRoutes({
      paths: { dataDir: join(store.root, '..'), modelsDir: store.root },
      runSelfTest: (opts) => {
        askedPackId = (opts as { packId?: unknown }).packId;
        return Promise.resolve({
          status: 'ran' as const,
          outcome: {
            passed: true,
            ranAt: PASSED.ranAt,
            devicesFound: 0,
            rtf: 0.0538,
            speedup: 18.6,
            /*
             * ★ 产出方的**真实**形状：跑一次真的 `parseBackendUsed()`，
             * 喂进去的是 whisper 真实 stderr 的逐字样本
             * （抄自 `packages/runtime/src/selfTest.ts` 里那段实测日志）。
             * 写死 `'cpu'` 的话，这条链上的认领规则就又可以恒假而全绿。
             */
            backendUsed: parseBackendUsed(REAL_WHISPER_STDERR),
            transcriptSimilarity: 0.98,
            errorMessage: null,
          },
          summary: '真实推理 18.6x',
          audioSeconds: 11,
          timeoutMs: 120000,
          resolved: { whisperCli: '/x/whisper-cli', model: '/x/m.bin', audio: '/x/jfk.wav' },
          requestedPackId: 'whispercpp-cpu-linux-x64',
          packId: 'whispercpp-cpu-linux-x64',
          packBackend: 'cpu' as const,
        } as never);
      },
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

    /*
     * ★ T-166 ①：请求体里的 `{id}` 必须**真的钉住那个包**。
     * 此前它只是个被忽略的候选：无论在哪张卡片上点，跑的都是统一规则选中的那一个 ——
     * 装了 CPU 与 Vulkan 两个包的用户永远只能测到其中一个。
     */
    assert.equal(
      askedPackId,
      'whispercpp-cpu-linux-x64',
      `路由没有把卡片上的包 id 钉给自检，实得：${JSON.stringify(askedPackId)}`,
    );

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

  it('★★ 产出方的真实 backendUsed 绝不等于 Backend 枚举 —— 认领规则不许拿它比对', () => {
    /*
     * 这条是 T-164 那个缺陷的**根因守卫**，不是复述。
     *
     * 它钉的是两个模块之间的**词汇表**：`parseBackendUsed()` 给的是日志文字，
     * `InstalledBackendPack.backend` 是小写枚举。任何人再写一次
     * `pack.backend === outcome.backendUsed`，那条比较就是恒假的 ——
     * 而恒假的比较**在单测里长得和"防线生效了"一模一样**。
     *
     * 之所以要显式断言"它们不相等"，是因为反过来的断言（"相等"）根本不可能成立，
     * 而**没有人会去写一条注定失败的断言**。所以这条护栏必须正面写出来。
     */
    const used = parseBackendUsed(REAL_WHISPER_STDERR);
    assert.equal(used, 'CPU', `parseBackendUsed 的真实输出变了：${String(used)}`);
    assert.notEqual(used, 'cpu', 'backendUsed 变成了 Backend 枚举 —— 认领规则的前提改了，去复核');

    // 另外两条真实分支，同样一个都不等于枚举值
    const variant = parseBackendUsed(
      'load_backend: loaded CPU backend from /x/libggml-cpu-zen4.so\n',
    );
    assert.equal(variant, 'CPU (ggml-cpu-zen4)');
    assert.equal(
      (['cpu', 'cuda', 'vulkan', 'rocm', 'metal', 'coreml'] as string[]).includes(variant ?? ''),
      false,
    );
  });

  it('二进制来源不明 / id 指向没装的包 —— 一律不写，并说明原因', async () => {
    const store = await storeWith([packRecord('whispercpp-cpu-linux-x64', 'cpu')]);

    // 二进制不属于任何已安装包（OPENMEMO_WHISPER_CLI 覆盖 / 手工布局）→ 不认领
    const unowned = await recordSelfTest(
      store.root,
      from(null, 'whispercpp-cpu-linux-x64'),
      PASSED,
    );
    assert.equal(unowned.ok, false);
    assert.equal(unowned.reason !== null, true, '拒绝了却不说为什么，等于静默丢掉结果');

    const ghost = await recordSelfTest(store.root, from('whispercpp-vulkan-win-x64'), PASSED);
    assert.equal(ghost.ok, false);
    assert.equal((ghost.reason ?? '').includes('whispercpp-vulkan-win-x64'), true);

    assert.equal((await readBack(store, 'whispercpp-cpu-linux-x64'))?.selfTest, null);
  });
});
