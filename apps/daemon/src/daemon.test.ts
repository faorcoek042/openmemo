/**
 * daemon 生命周期测试 —— 覆盖 T-016 的验收标准。
 *
 * 用高位端口（19xxx）跑测试，避免与真实实例的 17650 打架。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CSRF_HEADER, SESSION_COOKIE } from './http/auth.js';
import { pinAuthMode } from './http/authMode.testkit.js';
import { AlreadyRunningError, StartupConflictError, startDaemon } from './main.js';

/**
 * 底层 http 请求。`fetch` 会忽略 Host 等 forbidden header，
 * 要真正测 DNS rebinding 防护就必须绕开它。
 */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const ROOT = mkdtempSync(join(tmpdir(), 'omd-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let portCursor = 19340;
const nextPort = (): number => portCursor++;
const freshDir = (name: string): string => join(ROOT, name);

describe('daemon 生命周期', () => {
  it('能起来，/api/health 无需鉴权即可响应，且**不泄露 token**', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('health'), maxPort: port });
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['app'], 'openmemo');
      assert.equal(body['port'], d.port);
      assert.equal(body['instanceId'], d.instanceId);
      assert.ok(body['db'], 'health 应包含 db 状态');

      // 安全：health 是公开端点（单实例探测在拿到 token 前就要调它）
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes(d.token), 'health 响应绝不能包含 token');
    } finally {
      await d.stop();
    }
  });

  it('DNS rebinding 防护：伪造 Host 头被 403 拒绝', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('bind'), maxPort: port });
    try {
      // 注意：不能用 fetch —— Host 是 forbidden header，fetch 会忽略它。
      // 必须用底层 http.request 才能真正伪造 Host（这正是 DNS rebinding 的形态）。
      const { status, body } = await rawRequest(d.port, '/api/daemon/status', {
        Host: 'evil.example.com',
      });
      assert.equal(status, 403, `伪造 Host 必须被拒，实际 ${status}: ${body}`);
      assert.match(body, /FORBIDDEN_ORIGIN/);
    } finally {
      await d.stop();
    }
  });

  it('跨源 Origin 被 403 拒绝（CSRF 面）', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('origin'), maxPort: port });
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/daemon/status`, {
        headers: { Origin: 'http://evil.example.com' },
      });
      assert.equal(res.status, 403);
    } finally {
      await d.stop();
    }
  });

  it('**第二个实例被正确挡住**（单实例锁 = 端口绑定）', async () => {
    const port = nextPort();
    const dataDir = freshDir('single');
    const first = await startDaemon({ port, dataDir, maxPort: port });
    try {
      await assert.rejects(
        () => startDaemon({ port, dataDir, maxPort: port }),
        (err: unknown) => {
          assert.ok(err instanceof AlreadyRunningError, `期望 AlreadyRunningError，实际 ${err}`);
          assert.equal(err.info.port, first.port);
          assert.equal(err.info.instanceId, first.instanceId);
          return true;
        },
      );
    } finally {
      await first.stop();
    }
  });

  it('不同 dataDir 抢同一端口 → StartupConflictError（v1 不支持多 profile）', async () => {
    const port = nextPort();
    const first = await startDaemon({ port, dataDir: freshDir('profA'), maxPort: port });
    try {
      await assert.rejects(
        () => startDaemon({ port, dataDir: freshDir('profB'), maxPort: port }),
        StartupConflictError,
      );
    } finally {
      await first.stop();
    }
  });

  it('端口被**别人的服务**占用 → 递增，且明确警告麦克风需重新授权（不静默漂移）', async () => {
    const port = nextPort();
    // 用一个非 OpenMemo 的普通 http 服务占位 —— 这是 D-01 §2.2 阶梯第 2 步
    // "其它响应/超时 → 是别人的服务，继续下一步" 的场景。
    const blocker = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not openmemo');
    });
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));

    try {
      const d = await startDaemon({ port, dataDir: freshDir('drifted'), maxPort: port + 3 });
      try {
        assert.equal(d.portDrifted, true);
        assert.equal(d.port, port + 1, '应顺延到下一个端口');
        assert.ok(d.portWarning, '漂移必须带警告，绝不静默');
        assert.match(d.portWarning ?? '', /麦克风/, '警告必须提到麦克风需重新授权');
      } finally {
        await d.stop();
      }
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('runtime.json 写出且权限为 0600（内含 token）', async () => {
    const port = nextPort();
    const dataDir = freshDir('runtimejson');
    const d = await startDaemon({ port, dataDir, maxPort: port });
    try {
      assert.ok(existsSync(d.paths.runtimeJson));
      const info = JSON.parse(readFileSync(d.paths.runtimeJson, 'utf8')) as Record<string, unknown>;
      assert.equal(info['port'], d.port);
      assert.equal(info['token'], d.token);
      if (process.platform !== 'win32') {
        const mode = statSync(d.paths.runtimeJson).mode & 0o777;
        assert.equal(mode, 0o600, `runtime.json 权限应为 0600，实际 ${mode.toString(8)}`);
      }
    } finally {
      await d.stop();
    }
    // 退出后必须清理
    assert.ok(!existsSync(join(dataDir, 'runtime', 'runtime.json')));
  });
});

/**
 * ★ 这一组测的是 `OPENMEMO_AUTH=token` 档的**访问控制边界**，所以必须把档位钉死。
 *
 * 它原来依赖"鉴权默认开着"这个前提。默认值后来被翻成 `none`（用户显式决定），
 * 这一组**从那一刻起就是红的，而且没有任何人看得见** —— 当时的 test 脚本
 * 用了一个被 sh 吃掉的 glob，`dist/daemon.test.js` 一次都没被跑到（T-135 同轮已修）。
 *
 * 判据不是"让它变绿"，是**"默认值再翻一次也不该让它红"**：
 * 用例要什么档，用例自己说，不问默认值。
 * 另一半（`none` 档）在下面那一组 —— **开关的两个方向都必须有人守**，
 * 本项目在 `AUTH_MODE` 上吃过一次"单向门"的亏。
 */
describe('鉴权链路（token → cookie → CSRF）', () => {
  pinAuthMode('token');

  it('未认证请求被 401 拒绝', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('auth1'), maxPort: port });
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/daemon/status`);
      assert.equal(res.status, 401);
    } finally {
      await d.stop();
    }
  });

  it('Bearer token 换 HttpOnly cookie，之后 cookie 可用', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('auth2'), maxPort: port });
    try {
      const sess = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${d.token}` },
      });
      assert.equal(sess.status, 200);
      const setCookie = sess.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /HttpOnly/, 'cookie 必须是 HttpOnly');
      assert.match(setCookie, /SameSite=Strict/);
      const { csrf } = (await sess.json()) as { csrf: string };
      assert.ok(csrf);

      const sid = /om_sid=([^;]+)/.exec(setCookie)?.[1] ?? '';
      assert.ok(sid);

      const ok = await fetch(`http://127.0.0.1:${d.port}/api/daemon/status`, {
        headers: { Cookie: `${SESSION_COOKIE}=${sid}` },
      });
      assert.equal(ok.status, 200);
    } finally {
      await d.stop();
    }
  });

  it('错误的 token 换不到 session', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('auth3'), maxPort: port });
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token-value' },
      });
      assert.equal(res.status, 401);
    } finally {
      await d.stop();
    }
  });

  it('cookie 通道的非 GET 请求缺 CSRF 头 → 403；带上则通过', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('csrf'), maxPort: port });
    try {
      const sess = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${d.token}` },
      });
      const setCookie = sess.headers.get('set-cookie') ?? '';
      const sid = /om_sid=([^;]+)/.exec(setCookie)?.[1] ?? '';
      const { csrf } = (await sess.json()) as { csrf: string };

      const without = await fetch(`http://127.0.0.1:${d.port}/api/echo`, {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=${sid}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      });
      assert.equal(without.status, 403, '缺 CSRF 头必须被拒');

      const withCsrf = await fetch(`http://127.0.0.1:${d.port}/api/echo`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE}=${sid}`,
          'Content-Type': 'application/json',
          [CSRF_HEADER]: csrf,
        },
        body: JSON.stringify({ a: 1 }),
      });
      assert.equal(withCsrf.status, 200);
      assert.deepEqual(await withCsrf.json(), { echo: { a: 1 } });
    } finally {
      await d.stop();
    }
  });

  it('Bearer 通道免 CSRF（供 CLI / 脚本用）', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('bearer'), maxPort: port });
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/echo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ b: 2 }),
      });
      assert.equal(res.status, 200);
    } finally {
      await d.stop();
    }
  });
});

/**
 * ★ 开关的**另一半**：`OPENMEMO_AUTH=none`（当前的默认档）。
 *
 * 把上面那一组钉到 `token` 之后，`none` 档就一条覆盖都没有了 ——
 * 那等于把刚补上的洞换个位置又挖一遍。所以这一组必须同时存在。
 *
 * 它守的是 **T-134** 那个修复：鉴权关掉时**握手不该失败**。
 * 当时的现象是「SSE 端点开着 200，前端却从不去连」——
 * `providers.tsx` 的 `if (reachable && authed) startSse()` 里 `authed` 恒 false，
 * 因为握手要求"有 Bearer 或有有效 cookie"，而**没人再发得出 Bearer**。
 * 转写逐段出字、下载进度、装完提示全部静默失效，
 * **而每个单独的端点测起来都是好的**。
 *
 * ⚠️ T-134 的反向验证是**手工**跑的（两个方向都跑了，写在 commit message 里），
 * 但**没有留下任何自动化用例**。下面这三条就是补这个。
 */
describe('鉴权关闭档（OPENMEMO_AUTH=none，当前默认）', () => {
  pinAuthMode('none');

  it('★ 不带任何凭据的握手必须 200 —— 否则前端的 authed 恒 false，全站 SSE 从不建立', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('none1'), maxPort: port });
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, { method: 'POST' });
      assert.equal(res.status, 200, '鉴权关了，握手就不该失败');
      const body = (await res.json()) as { csrf?: string; authMode?: string };
      // 让前端/诊断页能看出这是"鉴权已关"的握手，而不是误以为验过身份
      assert.equal(body.authMode, 'none');
      assert.ok(body.csrf, '仍要发 CSRF 令牌，前端不必为两种模式写两套流程');
      assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/);
    } finally {
      await d.stop();
    }
  });

  it('未认证的 GET 直接放行（这正是上面那条 401 断言的反面）', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('none2'), maxPort: port });
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/daemon/status`);
      assert.equal(res.status, 200);
    } finally {
      await d.stop();
    }
  });

  it('写请求不带 CSRF 头也放行 —— CSRF 防的是"借用你已有的凭据"，而凭据不存在', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('none3'), maxPort: port });
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ c: 3 }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { echo: { c: 3 } });
    } finally {
      await d.stop();
    }
  });
});

describe('媒体端点的路径穿越防护（D-01 §8.5）', () => {
  it('只接受 asset uid，拒绝文件系统路径', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('media'), maxPort: port });
    try {
      for (const bad of [
        '/media/../../etc/passwd',
        '/media/asset/..%2f..%2fetc',
        '/media/file?p=/etc/passwd',
      ]) {
        const res = await fetch(`http://127.0.0.1:${d.port}${bad}`, {
          headers: { Authorization: `Bearer ${d.token}` },
        });
        assert.ok(res.status === 400 || res.status === 404, `${bad} 应被拒绝，实际 ${res.status}`);
      }
    } finally {
      await d.stop();
    }
  });
});

describe('DB 与队列接入', () => {
  it('启动即完成迁移，且崩溃恢复扫描已跑过', async () => {
    const port = nextPort();
    const dataDir = freshDir('db1');
    const d = await startDaemon({ port, dataDir, maxPort: port });
    try {
      assert.ok(d.database.schema.to >= 1);
      assert.equal(d.database.journalMode, 'wal');
      // 队列可用
      const job = d.queue.enqueue({ type: 'transcribe', lane: 'gpu.asr', payload: { x: 1 } });
      assert.equal(job.state, 'queued');
      assert.equal(job.lane, 'gpu.asr');
      assert.ok(job.uid.length === 26);
    } finally {
      await d.stop();
    }

    // 重启后 job 仍在（持久化在 SQLite，不是内存队列）
    const port2 = nextPort();
    const d2 = await startDaemon({ port: port2, dataDir, maxPort: port2 });
    try {
      assert.equal(d2.queue.counts()['queued'], 1, '重启后任务应仍在库里');
      assert.deepEqual(d2.database.schema.applied, [], '第二次启动不应重复迁移（幂等）');
    } finally {
      await d2.stop();
    }
  });
});

/**
 * #77 finding①：`server.close()` 死等一条**一直在被轮询**的 keep-alive 连接。
 *
 * ## 这条测试钉的是什么、以及为什么之前只能靠"碰运气"
 *
 * 真实事故（`[CI 实测 run 31498002020, windows-2025]`）：`waitHealth()` 每 500ms
 * 轮询一次 `/api/health`，同一条 keep-alive 连接的**空闲计时器被连续清零**——
 * 它永远攒不够 `server.keepAliveTimeout`（Node 默认 5000ms）的空闲时间，Node
 * 自己那道"空闲连接自动回收"永远不会触发，而 `server.close()` 只等**自然结束**、
 * 不主动断连接，于是死等（`run 31498002020` 观测到 55/55 个逐秒 tick 全是
 * "这一秒有新请求=是"）。同一份代码在下一次 CI（`run 31508855804`）**没有**
 * 复现——这是竞态，不是必现缺陷。
 *
 * ## 为什么"只是轮询"在本地/单测里几乎撞不上——以及这条测试怎么绕开碰运气
 *
 * 直接翻源码验证过（Node v22.19.0，与 CI 一致）：`http.Server.prototype.close()`
 * 内部一上来就会同步调用一次 `closeIdleConnections()`，把"当下确实空闲"（没有
 * 一个尚未 `finished` 的 `_httpMessage` 挂在 socket 上）的连接直接摧毁——这一次
 * 性清扫**之后**，Node 不会再主动巡检空闲连接（周期检查器在 `close()` 里被
 * `clearInterval` 了）。所以一条 keep-alive 连接要挺过 `server.close()`，必须
 * 同时满足两个条件：
 *   1. **`close()` 执行的那一刻恰好正在处理请求**（真正在"飞行中"，才躲得过
 *      那一次性清扫）——普通的"每 300ms 发一次、每次几毫秒就答完"的轮询，
 *      绝大多数时刻这条连接其实是空闲的，"掐点掐中飞行中那一瞬间"是个亚毫秒级
 *      窗口，单测里直接照抄"轮询"这个动作只会几乎每次都被那一次性清扫收掉——
 *      这正是本文件早先一版测试的失败现象（`server.close()` 几乎瞬间返回，
 *      从未观测到强制关闭日志）。
 *   2. **躲过之后必须持续被"续命"**：只要后续每次新请求的间隔仍快于
 *      `keepAliveTimeout`，这条连接的 per-socket 空闲计时器就永远攒不够
 *      `keepAliveTimeout`，不会被 Node 自身的机制自然收掉——直到 stop() 里的
 *      强制关闭兜底，或者客户端自己收手。
 *
 * 条件 2（"轮询快于 keepAliveTimeout"）正是生产事故 & Manager 原话描述的形状，
 * 单测里原样保留（300ms 续写间隔，明显快于默认 5000ms 的 keepAliveTimeout）。
 * 条件 1 如果留给运气去撞，测试就退化成"跑一次看看"——所以这里改用**管线化
 * 突发写入**（同一条 TCP 连接上背靠背写入几千个 `GET /api/health` 请求，不等
 * 任何一个的响应）把"飞行中"这个瞬间从亚毫秒级的运气问题，变成"服务端需要
 * 实打实忙上一阵子才能churn 完"的确定性问题——`stop()` 一调用，这条连接**必然**
 * 正处于服务端仍未答完某个请求的状态。这依然是**产品真实的 `startDaemon()` /
 * `stop()` 代码路径 + 一条真实的 HTTP keep-alive 连接**，只是不再依赖"猜中那个
 * 瞬间"的运气。
 *
 * `main.ts` 的修法 (A)：`stop()` 内部给 `server.close()` 的自然等待设了上界
 * （`graceMs = server.keepAliveTimeout + 2000ms`），到点仍未自然关闭就调用
 * `server.closeAllConnections()` 强制收尾，并打一行"强制关闭"日志。
 *
 * ## 为什么两条断言都要有，少一条都不够
 *
 * 只断言"时间够短"不够：万一日后有人把 `graceMs` 改回 `Infinity` 或者干脆
 * 删掉这段却**恰好**这次轮询的时机对上了、连接碰巧自然关闭了，测试会侥幸绿灯——
 * 这正是本周已经抓到四道"从来没真正生效过的守卫"的那个形状。所以必须同时钉住
 * "强制关闭那行日志确实出现了"，这行日志**只有走到 `forceCloseTimer` 回调**
 * 才会被打印，能排除"侥幸自然关闭"这条路。
 *
 * ## 红/绿都验证过
 *
 * 手工把 `main.ts` 里 `server.closeAllConnections()` 那几行连同它的 `setTimeout`
 * 注释掉后本地跑过：这条测试稳定地卡在 `await d.stop()` 直到 node:test 的
 * `{ timeout: 20_000 }` 把整个用例判超时失败——因为没有任何机制会去主动摘掉
 * 那条被持续续命的连接。恢复修法后连续本地跑了多次，`elapsed` 稳定落在
 * 7000ms 左右（`keepAliveTimeout` + 2000ms 的宽限期），且每次都能看到"强制关闭"
 * 那行日志。
 */
describe('#77 finding① self-lock —— server.close() 不能被"一直在轮询"的连接绑架', () => {
  it(
    '★ 客户端轮询间隔快于 keepAliveTimeout 时，stop() 必须在宽限期+余量内返回，且必须留下强制关闭日志',
    { timeout: 20_000 },
    async () => {
      const port = nextPort();
      const d = await startDaemon({ port, dataDir: freshDir('selflock'), maxPort: port });

      // 抓"强制关闭"那一行——不能只看耗时就认定修法生效，见上方文档。
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]): void => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
        originalLog(...args);
      };

      // ★ 用裸 net.Socket 手写管线化请求，而不是 http.Agent —— Node 的客户端
      //   Agent 默认不做请求管线化（发完一个等它答完才发下一个），没法制造出
      //   "服务端明确还在飞行中"的瞬间；管线化必须自己在字节层面拼。
      const sock = connect({ host: '127.0.0.1', port: d.port });
      sock.on('error', () => {
        /* stop() 强制关闭后这条连接会被 ECONNRESET，属预期，不许炸掉测试进程 */
      });
      sock.resume(); // 丢弃响应内容，这里只关心 server.close() 的行为，不关心响应对不对

      let polling = true;
      let dripTimer: NodeJS.Timeout | undefined;

      try {
        await new Promise<void>((resolve, reject) => {
          sock.once('connect', resolve);
          sock.once('error', reject);
        });

        const oneReq =
          'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n';

        // 条件 1：突发管线化写入几千个请求，保证 stop() 调用瞬间这条连接
        // **必然**正被服务端处理中，从而必然躲过 server.close() 内部那一次性的
        // closeIdleConnections() 扫描——不依赖撞中亚毫秒级窗口的运气。
        sock.write(Buffer.from(oneReq.repeat(5000)));

        // 条件 2：躲过扫描之后，持续以快于 keepAliveTimeout（默认 5000ms）的
        // 间隔续写新请求，防止这条连接在管线批量处理完之后重新空闲够久、被
        // Node 自身的 per-socket 空闲计时器自然收掉——这正是 waitHealth()
        // 500ms 轮询在生产里制造 race 的那个条件。
        dripTimer = setInterval(() => {
          if (polling) sock.write(Buffer.from(oneReq));
        }, 300);

        const t0 = Date.now();
        await d.stop();
        const elapsed = Date.now() - t0;

        // 宽限期 = keepAliveTimeout(默认 5000ms) + 2000ms = 7000ms；
        // 留出一倍多余量防 CI 抖动，但绝不该接近"无限期"。
        assert.ok(
          elapsed < 12_000,
          `stop() 花了 ${elapsed}ms —— 没有在宽限期附近返回，说明又回到了死等`,
        );
        assert.ok(
          lines.some((l) => l.includes('强制关闭')),
          '没有观测到"强制关闭"日志 —— 无法确认 stop() 是被 fix (A) 救回来的，' +
            '不能仅凭耗时短就认定修法生效',
        );
      } finally {
        polling = false;
        if (dripTimer) clearInterval(dripTimer);
        console.log = originalLog;
        sock.destroy();
      }
    },
  );
});
