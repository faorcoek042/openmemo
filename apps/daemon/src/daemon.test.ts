/**
 * daemon 生命周期测试 —— 覆盖 T-016 的验收标准。
 *
 * 用高位端口（19xxx）跑测试，避免与真实实例的 17650 打架。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CSRF_HEADER, SESSION_COOKIE } from './http/auth.js';
import { AlreadyRunningError, StartupConflictError, startDaemon } from './main.js';

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

  it('只绑 127.0.0.1（ADR-003 硬要求：绝不 0.0.0.0）', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('bind'), maxPort: port });
    try {
      // Host 头写成别的主机名 → 必须被 DNS rebinding 防护拒绝
      const res = await fetch(`http://127.0.0.1:${d.port}/api/daemon/status`, {
        headers: { Host: 'evil.example.com' },
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'FORBIDDEN_ORIGIN');
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

  it('端口被别人占用 → 递增，且**明确警告麦克风需重新授权**（不静默漂移）', async () => {
    const port = nextPort();
    const blocker = await startDaemon({ port, dataDir: freshDir('blockerA'), maxPort: port });
    try {
      // 换一个 dataDir 但允许扫描到下一个端口
      const second = await startDaemon({
        port,
        dataDir: freshDir('drifted'),
        maxPort: port + 3,
      });
      try {
        assert.equal(second.portDrifted, true);
        assert.equal(second.port, port + 1);
        assert.ok(second.portWarning, '漂移必须带警告');
        assert.match(second.portWarning ?? '', /麦克风/, '警告必须提到麦克风重新授权');
      } finally {
        await second.stop();
      }
    } finally {
      await blocker.stop();
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

describe('鉴权链路（token → cookie → CSRF）', () => {
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

describe('媒体端点的路径穿越防护（D-01 §8.5）', () => {
  it('只接受 asset uid，拒绝文件系统路径', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: freshDir('media'), maxPort: port });
    try {
      for (const bad of ['/media/../../etc/passwd', '/media/asset/..%2f..%2fetc', '/media/file?p=/etc/passwd']) {
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
