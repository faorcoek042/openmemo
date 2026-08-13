/**
 * #108 —— **探测阶段的退避重试**：抖动要被吸收，真的不可达要照样红。
 *
 * ## 这条测试对着的是一次真事故，不是一个假想
 *
 * `[CI 实测 2026-08-12]` 六条定时腿第一夜 4/6 红，查清是**同一个上游故障窗口**：
 *
 *     18:53  三条手动跑        github.com 全绿，6/6 后端包下载成功
 *     19:07  allcomponents     1 个文件 `socket hang up`
 *     19:51  notes             2/6 `fetch failed`
 *     19:59  import            6/6 `Origin error 503`
 *     20:06  record            6/6 又全部成功
 *
 * 产品这一侧的成因很具体：`downloadFromSource()` 的**第一步**是探文件大小，
 * 而那一步**零重试** —— 一次 503 就把整个源判死，用户看到"装不上"。
 *
 * ## 判据必须是**成对**的，只有一半的话谁都能糊弄过去
 *
 *   ① 前 N 次失败、第 N+1 次成功的上游 → **必须成功**，且说得出它重试过；
 *   ② 一直失败的上游               → **必须仍然失败**，且说得出试了几次、
 *                                     每次隔多久、每次为什么失败。
 *
 * 只有 ① 的话，「无限重试」也能过；只有 ② 的话，「根本不重试」也能过。
 *
 * ## 替身是**真的 HTTP 服务器**，实现的是真实契约的失败分支
 *
 * 不 stub `fetch`：那样测到的是我对 undici 的想象。这里起一个 `node:http`
 * 服务器（绑 `:0`，端口由 OS 分配，不出网），503 是真的状态行，
 * `socket hang up` 是真的把 socket 掐掉 —— 也就是 19:07 那条日志的形状。
 * 两个端到端用例走的是**产品自己的 `downloadFile()`**，不是内部函数。
 *
 * ⚠️ 那两个端到端用例故意**不缩短退避**：它们量的就是出厂策略
 * （`PROBE_RETRY_POLICY`：4 次 / 1.5s·3s·6s 带抖动 / 60s 总预算），
 * 所以"一直失败"那条真的要花 5–16 秒。给了 90s 的 `timeout` 兜底：
 * 万一有人把上限改成"重试到成功为止"，它会**超时判红**，而不是把 CI 挂死。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { DownloadError, downloadFile } from './download.js';
import {
  PROBE_RETRY_POLICY,
  ProbeFailedError,
  describeProbeAttemptsEn,
  describeProbeAttemptsZh,
  isRetriableHttpCode,
  nextProbeDelayMs,
  probeRemoteFileWithRetry,
} from './http.js';

/* ─────────────────────── 桩上游（真 HTTP，端口由 OS 分配） ─────────────────────── */

interface Plan {
  /** 前多少次请求要坏掉。`Infinity` = 永远坏。 */
  failTimes: number;
  /** `status` = 真的回一个状态行；`hangup` = 连响应行都不给，直接掐 socket。 */
  mode: 'status' | 'hangup';
  status?: number;
  failHeaders?: Record<string, string>;
  /** 修好之后吐的字节。 */
  body: Buffer;
}

interface Seen {
  url: string;
  range: string;
}

const plans = new Map<string, Plan>();
/** 地面真相：服务端**真的**收到了几次请求、每次带的 Range 是什么。 */
const seen: Seen[] = [];

let server: Server;
let origin = '';

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    seen.push({ url, range: String(req.headers.range ?? '') });
    const plan = plans.get(url);
    if (!plan) {
      res.writeHead(404).end();
      return;
    }
    const nth = seen.filter((s) => s.url === url).length;
    if (nth <= plan.failTimes) {
      if (plan.mode === 'hangup') {
        // 19:07 那一条的形状：TCP 层掐断，undici 抛 `fetch failed`。
        req.socket.destroy();
        return;
      }
      res.writeHead(plan.status ?? 503, {
        'content-type': 'text/plain',
        ...(plan.failHeaders ?? {}),
      });
      res.end('upstream is having a moment');
      return;
    }
    // 刻意**不**声明 accept-ranges：`download.ts` 会优雅退化成单流，
    // 走的仍然是产品的真实下载路径（与 installer.test.ts 的桩源同一个姿势）。
    res.writeHead(200, { 'content-length': String(plan.body.length) });
    res.end(req.method === 'HEAD' ? undefined : plan.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  origin = `http://127.0.0.1:${String(addr.port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let seq = 0;
/** 注册一条路由，返回它的 URL。每个用例一条，互不干扰。 */
function route(plan: Partial<Plan> & { failTimes: number }): string {
  seq += 1;
  const path = `/f${String(seq)}.bin`;
  plans.set(path, {
    mode: 'status',
    body: Buffer.from(`payload-${String(seq)}-${'x'.repeat(64)}`),
    ...plan,
  });
  return `${origin}${path}`;
}
const bodyOf = (url: string): Buffer => plans.get(new URL(url).pathname)?.body ?? Buffer.alloc(0);
const hits = (url: string): Seen[] => seen.filter((s) => s.url === new URL(url).pathname);
const probeHits = (url: string): Seen[] => hits(url).filter((s) => s.range === 'bytes=0-0');

/** 测试用的快策略：只压缩退避时长，**次数与判据一个字都不改**。 */
const FAST = { maxAttempts: 4, baseMs: 5, capMs: 20, budgetMs: 10_000 };

/* ─────────────────────────────── 策略本身 ─────────────────────────────── */

describe('#108 重试策略的两条上限都是显式且有限的', () => {
  it('★ 出厂策略：次数与总预算都必须有限 —— "重试到成功为止"不是可接受的实现', () => {
    assert.ok(
      Number.isFinite(PROBE_RETRY_POLICY.maxAttempts) && PROBE_RETRY_POLICY.maxAttempts >= 2,
      `次数上限必须有限且 ≥2，实际 ${String(PROBE_RETRY_POLICY.maxAttempts)}`,
    );
    assert.ok(
      PROBE_RETRY_POLICY.maxAttempts <= 10,
      `次数上限 ${String(PROBE_RETRY_POLICY.maxAttempts)} 太大：用户会以为界面卡死了`,
    );
    assert.ok(
      Number.isFinite(PROBE_RETRY_POLICY.budgetMs) && PROBE_RETRY_POLICY.budgetMs <= 120_000,
      `总预算必须有限且 ≤120s，实际 ${String(PROBE_RETRY_POLICY.budgetMs)}`,
    );
    // 单次退避的上限（含 backoffMs 的 ±50% 抖动）不该比总预算还大 —— 那样预算就是摆设。
    assert.ok(PROBE_RETRY_POLICY.capMs * 1.5 <= PROBE_RETRY_POLICY.budgetMs);
  });

  it('哪些码重试有救、哪些没救 —— 反面同样钉死', () => {
    assert.equal(isRetriableHttpCode('PROVIDER_UNREACHABLE'), true);
    assert.equal(isRetriableHttpCode('NETWORK_TIMEOUT'), true);
    assert.equal(isRetriableHttpCode('RATE_LIMITED'), true);
    // ★ 这三条才是"别把真的不可达重试成绿"的那一半
    assert.equal(isRetriableHttpCode('NOT_FOUND'), false);
    assert.equal(isRetriableHttpCode('GATED_REPO'), false);
    assert.equal(isRetriableHttpCode('INTERNAL'), false);
  });

  it('退避是**指数增长**且被 capMs 夹住', () => {
    const p = { maxAttempts: 8, baseMs: 1000, capMs: 12_000, budgetMs: 60_000 };
    // backoffMs 先算 min(cap, base*2^k) 再乘 [0.5, 1.5) 的抖动
    const d1 = nextProbeDelayMs(1, undefined, p);
    assert.ok(d1 >= 500 && d1 <= 1500, `第 1 次退避 ${String(d1)}ms 不在 [500,1500]`);
    const d3 = nextProbeDelayMs(3, undefined, p);
    assert.ok(d3 >= 2000 && d3 <= 6000, `第 3 次退避 ${String(d3)}ms 不在 [2000,6000]`);
    const dBig = nextProbeDelayMs(20, undefined, p);
    assert.ok(dBig <= 12_000 * 1.5, `退避没被 capMs 夹住：${String(dBig)}ms`);
  });

  it('429 带 Retry-After 时听服务端的，但仍被 capMs 夹住（"两小时后再来"不能照等）', () => {
    const p = { maxAttempts: 4, baseMs: 1000, capMs: 12_000, budgetMs: 60_000 };
    assert.equal(nextProbeDelayMs(1, 3, p), 3000);
    assert.equal(nextProbeDelayMs(1, 7200, p), 12_000);
  });
});

/* ──────────────────── ① 抖一下：重试之后必须成功，并说出来 ──────────────────── */

describe('#108 ① 前 N 次失败、第 N+1 次成功的上游', () => {
  it('★ 前 2 次 503、第 3 次好了 → 探测成功，且 attempts 里留着"第 3 次才成"的证据', async () => {
    const url = route({ failTimes: 2, status: 503 });
    const { info, attempts } = await probeRemoteFileWithRetry(url, { policy: FAST });

    assert.equal(info.sizeBytes, bodyOf(url).length);
    assert.equal(attempts.length, 3, `应当是 3 次尝试，实际 ${String(attempts.length)}`);
    assert.deepEqual(
      attempts.map((a) => a.ok),
      [false, false, true],
    );
    assert.equal(attempts[0]?.code, 'PROVIDER_UNREACHABLE');
    assert.match(attempts[0]?.message ?? '', /503/);
    // 第 1 次不该等，后面每次都必须真的等过（退避不是摆设）
    assert.equal(attempts[0]?.waitedMsBefore, 0);
    assert.ok((attempts[1]?.waitedMsBefore ?? 0) > 0);
    // 地面真相：服务端**真的**收到 3 次探测
    assert.equal(probeHits(url).length, 3);
  });

  it('★ `socket hang up`（TCP 掐断，19:07 那条日志的形状）同样能被吸收', async () => {
    const url = route({ failTimes: 1, mode: 'hangup' });
    const { attempts } = await probeRemoteFileWithRetry(url, { policy: FAST });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.ok, false);
    assert.equal(attempts[0]?.code, 'PROVIDER_UNREACHABLE');
    assert.equal(attempts[1]?.ok, true);
    assert.equal(probeHits(url).length, 2);
  });

  it('一次就好的上游**不许**多发请求（重试是补救，不是常态）', async () => {
    const url = route({ failTimes: 0 });
    const { attempts } = await probeRemoteFileWithRetry(url, { policy: FAST });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.ok, true);
    assert.equal(probeHits(url).length, 1);
  });
});

/* ──────────────── ② 一直失败：必须仍然红，并说清次数/间隔/原因 ──────────────── */

describe('#108 ② 一直失败的上游', () => {
  it('★★ 一直 503 → 仍然抛，次数用尽即止，且报告里有次数、间隔、每次的原因', async () => {
    const url = route({ failTimes: Infinity, status: 503 });
    const err = await probeRemoteFileWithRetry(url, { policy: FAST }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ProbeFailedError, `期望 ProbeFailedError，拿到 ${String(err)}`);
    assert.equal(err.code, 'PROVIDER_UNREACHABLE', '重试用尽不改变失败的分类');
    assert.equal(err.attempts.length, FAST.maxAttempts);
    assert.equal(err.budgetExhausted, false, '这一条是**次数**用尽，不是预算');
    assert.equal(
      err.attempts.every((a) => !a.ok),
      true,
    );
    // 地面真相：不多不少，正好试了 maxAttempts 次
    assert.equal(probeHits(url).length, FAST.maxAttempts);

    const zh = describeProbeAttemptsZh(err);
    assert.match(zh, /共 4 次尝试/, `没说清试了几次：${zh}`);
    assert.match(zh, /间隔/, `没说清每次隔多久：${zh}`);
    assert.match(zh, /503/, `没说清失败原因：${zh}`);
    assert.match(zh, /上限 4 次、总预算/, `没把上限说出来：${zh}`);
    assert.match(describeProbeAttemptsEn(err), /4 attempts/);
  });

  it('★ 404 一次都不重试 —— 确定性失败重试三次仍是 404，只是多晾用户十几秒', async () => {
    const url = route({ failTimes: Infinity, status: 404 });
    const err = await probeRemoteFileWithRetry(url, { policy: FAST }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ProbeFailedError);
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(err.attempts.length, 1);
    assert.equal(probeHits(url).length, 1, '404 被重试了 —— 那正是"把真的不可达重试成绿"的第一步');
    assert.match(describeProbeAttemptsZh(err), /未重试/);
  });

  it('★ 总预算先到时：停下、判红，并说清是**预算**用尽而不是次数用尽', async () => {
    const url = route({ failTimes: Infinity, status: 503 });
    // 单次退避最少 2000ms（baseMs 4000 × 抖动下限 0.5），必然超过 1000ms 的总预算
    const err = await probeRemoteFileWithRetry(url, {
      policy: { maxAttempts: 5, baseMs: 4000, capMs: 8000, budgetMs: 1000 },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ProbeFailedError);
    assert.equal(err.budgetExhausted, true);
    assert.equal(err.attempts.length, 1);
    assert.equal(probeHits(url).length, 1);
    const zh = describeProbeAttemptsZh(err);
    assert.match(zh, /总预算先用尽/, `预算用尽必须说出来，否则读者以为是次数用完了：${zh}`);
    assert.doesNotMatch(zh, /确定性失败/, '503 不是确定性失败 —— 别拿假理由解释一次真失败');
  });

  it('429 的 Retry-After 真的被照办（1s，不是 5ms 的退避基数）', async () => {
    const url = route({ failTimes: Infinity, status: 429, failHeaders: { 'retry-after': '1' } });
    const err = await probeRemoteFileWithRetry(url, {
      policy: { maxAttempts: 2, baseMs: 5, capMs: 20_000, budgetMs: 30_000 },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ProbeFailedError);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.attempts.length, 2);
    assert.equal(err.attempts[1]?.waitedMsBefore, 1000, '没听服务端的 Retry-After');
    assert.equal(probeHits(url).length, 2);
  });
});

/* ─────────────── 产品自己的路径：downloadFile()，出厂策略，不缩短 ─────────────── */

describe('#108 ③ 产品真实下载路径（downloadFile，出厂策略）', () => {
  it('★★ 探测第一次 503、第二次好了 → 整个下载照常成功', { timeout: 90_000 }, async () => {
    const url = route({ failTimes: 1, status: 503 });
    const body = bodyOf(url);
    const res = await downloadFile({
      sha256: createHash('sha256').update(body).digest('hex'),
      sizeBytes: body.length,
      sources: [{ provider: 'stub', url, official: true }],
      blobDir: await mkdtemp(join(tmpdir(), 'om-108-')),
      maxParts: 1,
    });

    assert.equal(res.cached, false);
    assert.equal(res.sizeBytes, body.length);
    // 地面真相：探测真的发了 2 次（第 1 次 503），之后才是取字节那一次
    assert.equal(probeHits(url).length, 2);
    assert.ok(hits(url).length >= 3, `除了探测还应有取字节的请求：${JSON.stringify(hits(url))}`);
  });

  it(
    '★★ 一直 503 → 仍然失败，且用户看得见的中文消息里有次数/间隔/原因**和代理提示**',
    { timeout: 90_000 },
    async () => {
      const url = route({ failTimes: Infinity, status: 503 });
      const body = bodyOf(url);
      const err = await downloadFile({
        sha256: createHash('sha256').update(body).digest('hex'),
        sizeBytes: body.length,
        sources: [{ provider: 'stub', url, official: true }],
        blobDir: await mkdtemp(join(tmpdir(), 'om-108-')),
        maxParts: 1,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      assert.ok(err instanceof DownloadError, `期望 DownloadError，拿到 ${String(err)}`);
      assert.equal(err.code, 'PROVIDER_UNREACHABLE');
      // 出厂策略里写着几次，就必须正好试几次 —— 不多（不是死等）、不少（不是零重试）
      assert.equal(probeHits(url).length, PROBE_RETRY_POLICY.maxAttempts);

      const zh = err.messageZh ?? '';
      assert.match(zh, /探测文件大小/, `没说清卡在哪一步：${zh}`);
      assert.match(
        zh,
        new RegExp(`共 ${String(PROBE_RETRY_POLICY.maxAttempts)} 次尝试`),
        `没说清试了几次：${zh}`,
      );
      assert.match(zh, /间隔/, `没说清每次隔多久：${zh}`);
      assert.match(zh, /503/, `没说清每次的原因：${zh}`);
      // e2e-allcomponents 第 7 节靠这句判绿，重试的措辞不许把它挤掉
      assert.match(zh, /设置\s*→\s*代理/, `代理提示被挤掉了：${zh}`);
      assert.match(err.message, /Retried with backoff/);
    },
  );
});
