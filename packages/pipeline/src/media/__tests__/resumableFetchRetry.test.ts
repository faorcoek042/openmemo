/**
 * #111 ②：媒体导入那条路的**探测重试**。
 *
 * ## 这份文件在钉什么
 *
 * `resumableFetch()` 第一行的探测以前是 `probeRemoteFile()` —— 零重试，
 * 而且它坐在下面那个重试循环**外面**、没有任何 try/catch 包着。于是上游抖一下
 * （503、socket hang up）就直接抛穿整个导入：用户从链接导入音视频，一次抖动 = 失败。
 * PR #56 给组件下载加了 `probeRemoteFileWithRetry()`，这条腿当时没跟上。
 *
 * ## 判据必须**成对**（照抄 `packages/downloader/src/probeRetry.test.ts` 的形状）
 *
 * 一条一条单独看都能被绕过，所以四类一起钉：
 *   ① 抖动之后能成 —— 只有"真的重试了"才过（挡**零重试**）；
 *   ② 一直失败时请求数**正好等于次数上限** ——
 *      多 = 死等（重试到天荒地老），少 = 零重试。上下都封死；
 *   ③ 确定性失败（404 / 403）**一次都不重试** ——
 *      挡"把真的不可达重试成绿"，那是重试最贵的失败形态；
 *   ④ 上游一切正常时**只探一次** —— 挡"无条件重试"（②③在那种实现下也可能碰巧过）。
 *
 * ## 地面真相取自服务端，不取自被测对象的自述
 *
 * 计数用的是**桩上游真的收到了几个请求**（`seen[]`），不是 `err.attempts.length`。
 * 后者是被测代码自己报的数 —— 拿它当判据，一个"报告写得很好但根本没发请求"的
 * 实现照样全绿。两者都断言，但只有前者是地面真相。
 *
 * ## 不 stub `fetch`
 *
 * 起一个真的 `node:http` 服务器，绑 `:0`（端口由 OS 分配，**不出网**）。
 * stub 掉 `fetch` 测到的是"我对 undici 的想象"，而这一路要验的恰恰是
 * 真实传输层上的失败分类。
 *
 * ⚠️ 本文件是 `packages/pipeline` 里**第一个**起桩上游的测试，服务器那一段
 *    是从 `probeRetry.test.ts` 搬过来的 —— 那边已经跑住了 #108。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MEDIA_PROBE_RETRY_POLICY, ProbeFailedError } from '@openmemo/downloader';

import { resumableFetch } from '../resumableFetch.js';

interface Plan {
  /** 前多少次请求要坏掉。`Infinity` = 永远坏。 */
  failTimes: number;
  status: number;
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
let tmp = '';

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    const range = String(req.headers.range ?? '');
    seen.push({ url, range });
    const plan = plans.get(url);
    if (!plan) {
      res.writeHead(404).end();
      return;
    }
    const nth = seen.filter((s) => s.url === url).length;
    if (nth <= plan.failTimes) {
      res.writeHead(plan.status, { 'content-type': 'text/plain' });
      res.end('upstream is having a moment');
      return;
    }
    // Range 支持：探测发的是 `bytes=0-0`，取字节发的是 `bytes=<start>-<end>`
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), plan.body.length - 1) : plan.body.length - 1;
      const slice = plan.body.subarray(start, end + 1);
      res.writeHead(206, {
        'content-length': String(slice.length),
        'content-range': `bytes ${String(start)}-${String(end)}/${String(plan.body.length)}`,
        'accept-ranges': 'bytes',
      });
      res.end(req.method === 'HEAD' ? undefined : slice);
      return;
    }
    res.writeHead(200, { 'content-length': String(plan.body.length), 'accept-ranges': 'bytes' });
    res.end(req.method === 'HEAD' ? undefined : plan.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  origin = `http://127.0.0.1:${String(addr.port)}`;
  tmp = await mkdtemp(join(tmpdir(), 'media-retry-'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let seq = 0;
/** 注册一条路由，返回它的 URL。每个用例一条，互不干扰。 */
function route(plan: Partial<Plan> & { failTimes: number }): string {
  seq += 1;
  const path = `/m${String(seq)}.mp3`;
  plans.set(path, {
    status: 503,
    body: Buffer.from(`audio-${String(seq)}-${'x'.repeat(4096)}`),
    ...plan,
  });
  return `${origin}${path}`;
}

const bodyOf = (url: string): Buffer => plans.get(new URL(url).pathname)?.body ?? Buffer.alloc(0);
const hits = (url: string): Seen[] => seen.filter((s) => s.url === new URL(url).pathname);
/** 只数**探测**那种请求：`probeRemoteFile()` 发的 Range 恒为 `bytes=0-0`。 */
const probeHits = (url: string): Seen[] => hits(url).filter((s) => s.range === 'bytes=0-0');

let destSeq = 0;
const dest = (): string => {
  destSeq += 1;
  return join(tmp, `out-${String(destSeq)}.bin`);
};

const run = async (url: string): Promise<unknown> =>
  resumableFetch({
    url,
    destPath: dest(),
    maxBytes: 64 * 1024 * 1024,
    signal: AbortSignal.timeout(120_000),
  });

describe('#111 ② 媒体导入的探测重试', () => {
  it('★★ ① 前 2 次 503、第 3 次好了 → 导入照常成功（挡"零重试"）', async () => {
    const url = route({ failTimes: 2, status: 503 });

    const r = (await run(url)) as { sizeBytes: number };

    assert.equal(r.sizeBytes, bodyOf(url).length, '文件没下全');
    assert.equal(
      probeHits(url).length,
      3,
      `探测应当试到第 3 次才成，实际 ${String(probeHits(url).length)} 次 —— ` +
        '如果是 1，说明重试根本没接上（这正是 #111 ② 要修的那个状态）',
    );
    assert.ok(
      hits(url).length > probeHits(url).length,
      `除了探测还应当有取字节的请求：${JSON.stringify(hits(url))}`,
    );
  });

  it('★★ ② 一直 503 → 抛，且请求数**正好**等于次数上限（多=死等，少=零重试）', async () => {
    const url = route({ failTimes: Infinity, status: 503 });

    const err = await run(url).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ProbeFailedError, `期望 ProbeFailedError，拿到 ${String(err)}`);
    assert.equal(err.code, 'PROVIDER_UNREACHABLE', '重试用尽不改变失败的分类');
    // 地面真相：不多不少
    assert.equal(
      probeHits(url).length,
      MEDIA_PROBE_RETRY_POLICY.maxAttempts,
      `一直失败时应当正好探 ${String(MEDIA_PROBE_RETRY_POLICY.maxAttempts)} 次，` +
        `实际 ${String(probeHits(url).length)} 次`,
    );
    assert.equal(err.attempts.length, MEDIA_PROBE_RETRY_POLICY.maxAttempts);
    assert.equal(
      err.attempts.every((a) => !a.ok),
      true,
    );
    assert.equal(err.budgetExhausted, false, '这一条是**次数**用尽，不是预算');
  });

  it('★★ ③ 404 一次都不重试 —— 确定性失败重试三次仍是 404，只是白等', async () => {
    const url = route({ failTimes: Infinity, status: 404 });

    const err = await run(url).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ProbeFailedError, `期望 ProbeFailedError，拿到 ${String(err)}`);
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(probeHits(url).length, 1, '404 被重试了 —— 那正是"把真的不可达重试成绿"的第一步');
  });

  it('★★ ③ 403 同样一次都不重试（GATED_REPO 不在重试白名单里）', async () => {
    const url = route({ failTimes: Infinity, status: 403 });

    const err = await run(url).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ProbeFailedError, `期望 ProbeFailedError，拿到 ${String(err)}`);
    assert.equal(err.code, 'GATED_REPO');
    assert.equal(probeHits(url).length, 1, '403 被重试了 —— 权限不会因为再问一次就变');
  });

  it('★ ④ 上游一切正常 → 只探一次（挡"无条件重试"）', async () => {
    const url = route({ failTimes: 0, status: 200 });

    const r = (await run(url)) as { sizeBytes: number };

    assert.equal(r.sizeBytes, bodyOf(url).length);
    assert.equal(probeHits(url).length, 1, '一切正常还探了不止一次 —— 那说明重试不是按失败触发的');
  });

  /*
   * ⚠️ 关于「URL 非法」与「重定向成环」这两类，本文件**刻意不写**断言，因为写了会
   *    是"过得对不上原因"的绿灯（第③类失效：量错东西）。实测结论：
   *
   *    · **URL 非法**：`fetch()` 抛 `TypeError`，落到 `http.ts` 的兜底分支被归成
   *      `PROVIDER_UNREACHABLE` —— 那**在重试白名单里**，所以在探测层它会被重试满
   *      `maxAttempts` 次。真正拦住它的是上游 `directHttp.ts::requireSafeUrl()`
   *      （`validateHttpUrl()` + `requirePublicHost()`），在到达探测之前就抛了。
   *      也就是说"零重试"这条性质属于**那一层**，不属于这一层；在这里断言它，
   *      要么恒真（请求根本发不出去，服务端计数恒为 0），要么在钉一个不存在的契约。
   *
   *    · **重定向成环**：`probeRemoteFile()` 跟 5 跳之后**不抛错** ——
   *      `classifyStatus()` 对 3xx 直接返回 `null`（`status >= 200 && status < 400`），
   *      于是它返回一个 `status: 302`、`sizeBytes: null` 的"成功"。
   *      在这里断言"成环不重试"会**通过，但理由是错的**（它压根没被当成失败），
   *      而且将来有人把成环改成真正的错误时，这条断言还会继续绿。
   *
   *    两条都已单独记为待办，不在 #111 ② 的范围内解决 —— 但也不假装它们被覆盖了。
   */
});
