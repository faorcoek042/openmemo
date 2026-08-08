/**
 * **「health 说 ready 的时候，它承诺的东西必须真的在」。**
 *
 * ## 这组用例来自一次用户可见的 404
 *
 * `[CI 实测 2026-08-08 run 31205369931, windows-2025]` 预编译包的升级验证红在
 *
 * ```
 * ✘ 建文件夹失败 HTTP 404：{"code":"NOT_FOUND","message":"no route for POST /api/folders"}
 * ```
 *
 * **而同一份代码在 Linux 与 macOS 上都是绿的。** 不是 Windows 特有缺陷，是一个一直开着的
 * 窗口被慢一点的机器撞上了：`/api/health` 由 `server.ts` 直接应答、不经过路由表，
 * 而业务路由是 `main.ts` 的 `routers.push(...)`，发生在 server 建好**之后**。
 * `ServerDeps.instanceId` 的注释里早就记着**单实例探测撞过同一个窗口** ——
 * 同一个形状撞第二次了。
 *
 * ## 三条性质，缺一不可
 *
 *   ① 没 ready 时 `/api/health` **不许答 200**（一个会说谎的就绪信号比没有更糟）；
 *   ② 没 ready 时打真端点，答的必须是 **503「还在启动」**，不是 404「接口不存在」
 *      —— 后者是假话，调用方据此做的判断全是错的；
 *   ③ **但启动探测不许被饿死**：单实例探测靠打 `/api/health` 判断
 *      「这个端口上蹲着的是不是我们自己」。它必须**照样认得出**一个正在启动的实例，
 *      否则新进程会判定"端口上是别人的服务"然后**静默漂到下一个端口** ——
 *      而端口漂移会让浏览器把它当新站点，**用户的麦克风授权要重新点一次**
 *      （`single-instance.ts` 开头写着这条，直接影响 F3 录音转文字）。
 *
 * ③ 是这次改动最容易引入的**新** bug：只做 ①② 会把一个用户可见的 404
 * 换成一个更贵的静默端口漂移。所以它在这里有独立用例，而且是端到端的。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

/*
 * ★ 模块顶层设定，窗口为零（PROTOCOL §9-bis：不许"写下去再改回来"）。
 *   node:test 一个测试文件一个子进程，进程一退就没了，不需要清理代码 ——
 *   而"清理代码"正是靠不住的那个东西。
 *   鉴权关掉是为了让请求能走到路由那一层；Windows 上真实撞到 404 的那次
 *   也正是 `OPENMEMO_AUTH=none`。
 */
process.env['OPENMEMO_AUTH'] = 'none';
/** 前端产物不参与本组用例；留着它会让静态兜底把请求接走。 */
process.env['OPENMEMO_WEB_DIST'] = '/nonexistent-web-dist-for-readiness-test';

const { attachHttpHandlers } = await import('./server.js');
const { probeExisting, acquireSingleInstance } = await import('../bootstrap/single-instance.js');

const openServers: Server[] = [];
after(() => {
  for (const s of openServers) s.close();
});

/** 起一个只有 health 的最小 daemon-like 服务，`ready` 由调用方控制。 */
async function startDaemonLike(
  ready: () => boolean,
  dataDir = '/tmp/readiness-test',
): Promise<{
  base: string;
  port: number;
  server: Server;
}> {
  const server = createServer();
  openServers.push(server);
  attachHttpHandlers(server, {
    sessions: {
      create: () => ({ sid: 'sid', csrf: 'csrf' }),
      verifyBootToken: () => true,
    } as never,
    sse: { broadcast: () => {} } as never,
    instanceId: () => 'test-instance',
    version: '0.0.0-test',
    dataDir,
    host: () => '127.0.0.1',
    port: () => (server.address() as AddressInfo).port,
    status: () => ({ extra: 'only-when-ready' }),
    ready,
    routers: [],
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, server };
}

describe('① 没 ready 时 /api/health 不许答 200', () => {
  it('未 ready → 503，且 ready:false / status:starting', async () => {
    const { base } = await startDaemonLike(() => false);
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['ready'], false);
    assert.equal(body['status'], 'starting');
  });

  it('★ 未 ready 时**身份字段仍然给全** —— 单实例探测靠它，少一个就会导致端口漂移', async () => {
    const { base, port } = await startDaemonLike(() => false, '/tmp/dd-a');
    const body = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>;
    // 这四个是探测方真正要读的
    assert.equal(body['app'], 'openmemo');
    assert.equal(body['dataDir'], '/tmp/dd-a');
    assert.equal(body['host'], '127.0.0.1');
    assert.equal(body['port'], port);
  });

  it('★ 未 ready 时**不展开 status()** —— 那个闭包读的是启动中才赋值的东西', async () => {
    const { base } = await startDaemonLike(() => false);
    const body = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>;
    assert.equal('extra' in body, false);
  });

  it('ready 之后 → 200，ready:true，且 status() 回来了', async () => {
    const { base } = await startDaemonLike(() => true);
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['ready'], true);
    assert.equal(body['extra'], 'only-when-ready');
  });
});

describe('② 没 ready 时打真端点：503「还在启动」，不是 404「接口不存在」', () => {
  it('★ 复现 Windows 那一次：POST /api/folders 未 ready 时必须是 503 SERVICE_STARTING', async () => {
    const { base } = await startDaemonLike(() => false);
    const res = await fetch(`${base}/api/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'SERVICE_STARTING');
  });

  it('未 ready 时带 Retry-After，调用方知道该重试而不是放弃', async () => {
    const { base } = await startDaemonLike(() => false);
    const res = await fetch(`${base}/api/folders`, { method: 'POST' });
    assert.equal(res.headers.get('retry-after'), '1');
  });

  /*
   * ★ `retryable` 必须是 true。`sendError` 的默认值是 **false**，
   *   而 `[本机实测]` 第一版正是漏给了它，抓到的响应体是 `"retryable":false` ——
   *   一个过几百毫秒就自己好的状态却说"重试没用"，等于把刚修掉的那个谎
   *   换个字段接着说。这条钉住它。
   */
  it('★ SERVICE_STARTING 必须 retryable:true（sendError 默认是 false，漏给就会说反）', async () => {
    const { base } = await startDaemonLike(() => false);
    const res = await fetch(`${base}/api/folders`, { method: 'POST' });
    const body = (await res.json()) as { error?: { retryable?: boolean } };
    assert.equal(body.error?.retryable, true);
  });

  /*
   * ★★ 反向：**ready 之后，真正不存在的端点仍然必须是 404。**
   *
   * 少了这条，"把 404 换成 503" 就可能被写成"永远回 503" —— 那会把
   * 「接口不存在」这个真实信号也一起吃掉，调用方再也分不清
   * 「还没起来」和「你打错地址了」。
   */
  it('★ 反向：ready 之后，不存在的端点仍然是 404 NOT_FOUND（503 不许吃掉真 404）', async () => {
    const { base } = await startDaemonLike(() => true);
    const res = await fetch(`${base}/api/definitely-not-a-real-endpoint`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'NOT_FOUND');
  });
});

describe('③ ★ 启动探测不许被饿死（这条是本次改动最容易引入的新 bug）', () => {
  it('probeExisting 认得出一个**正在启动**的实例（503 也算"是我们自己"）', async () => {
    const { port } = await startDaemonLike(() => false, '/tmp/dd-starting');
    const info = await probeExisting(port, 2000);
    assert.equal(info === undefined, false);
    assert.equal(info?.dataDir, '/tmp/dd-starting');
  });

  it('probeExisting 对 ready 的实例照常工作', async () => {
    const { port } = await startDaemonLike(() => true, '/tmp/dd-ready');
    const info = await probeExisting(port, 2000);
    assert.equal(info?.dataDir, '/tmp/dd-ready');
  });

  it('★ 反向：503 但不是 openmemo → 仍然判定"不是我们"（不许放宽成"只要 503 就算"）', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'someone-else', status: 'starting' }));
    });
    openServers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    assert.equal(await probeExisting(port, 2000), undefined);
  });

  it('★ 反向：其它状态码（500）不算"已有实例"', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'openmemo' }));
    });
    openServers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    assert.equal(await probeExisting(port, 2000), undefined);
  });

  /*
   * ★★★ 端到端的那一条：**端口上蹲着一个正在启动的同 dataDir 实例时，
   *      新进程必须判定 `existing`，而不是漂到下一个端口。**
   *
   * 这正是"把启动探测饿死"的实际后果所在：漂移 = 浏览器换 origin =
   * **用户的麦克风授权要重新点一次**。
   * 把 `probeExisting` 里那句 `res.status !== 503` 的放行去掉，这条当场红。
   */
  it('★★ 端口被一个"正在启动"的同 dataDir 实例占着 → existing，**不发生端口漂移**', async () => {
    const dataDir = '/tmp/dd-shared';
    const occupied = await startDaemonLike(() => false, dataDir);

    const contender = createServer();
    openServers.push(contender);
    const outcome = await acquireSingleInstance({
      requestedPort: occupied.port,
      dataDir,
      server: contender,
      maxPort: occupied.port + 3,
    });

    assert.equal(outcome.kind, 'existing');
    if (outcome.kind === 'existing') {
      assert.equal(outcome.info.dataDir, dataDir);
    }
    /*
     * 反面，而且比"kind 不是 acquired"更硬：**竞争者根本没有绑上任何端口。**
     * 漂移的物理表现就是它在别的端口上 listening 起来了；这里直接量那个事实，
     * 而不是量一个我们自己算出来的枚举值。
     */
    assert.equal(contender.listening, false);
  });

  it('★★ 同样情形但 dataDir 不同 → conflict（明确报错），仍然不是静默漂移', async () => {
    const occupied = await startDaemonLike(() => false, '/tmp/dd-other');
    const contender = createServer();
    openServers.push(contender);
    const outcome = await acquireSingleInstance({
      requestedPort: occupied.port,
      dataDir: '/tmp/dd-mine',
      server: contender,
      maxPort: occupied.port + 3,
    });
    assert.equal(outcome.kind, 'conflict');
  });
});
