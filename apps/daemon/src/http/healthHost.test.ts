/**
 * T-160 ④：**`/api/health` 的 `host` 字段是写死的 `'127.0.0.1'`。**
 *
 * 它不是一个显示错误，是**安全结论的输入**：
 *   · 单实例探测拿它拼「已在运行 http://<host>:<port>」的提示（`AlreadyRunningError`）；
 *   · 任何读这个字段判断"是不是只绑回环"的人或脚本，在 `OPENMEMO_HOST=0.0.0.0`
 *     的部署上会得到**恰好相反**的结论。
 * `[本机实测]` `ss -ltnp` 显示当前实例绑在 `0.0.0.0`，而 `/api/health` 回 `127.0.0.1`。
 *
 * ## 这条用例为什么打在 `attachHttpHandlers` 上，而不是起一个真 daemon
 *
 * 要让真 daemon 绑到非回环地址，就得在测试里真的 `listen('0.0.0.0')`（在 CI 上对外开一个口，
 * 且 `BIND_HOST` 是模块常量、只能靠改 import 顺序绕）或者绑 `127.0.0.2`（macOS 上默认不存在）。
 * 两条都是"为了测试去动机器状态"。
 *
 * 而要钉住的性质其实很小：**health 回的必须是调用方交给它的那个地址，不能是字面量**。
 * 所以这里直接给一个 `host: () => '0.0.0.0'` 的 deps —— 把字面量改回去，这条当场红。
 * 「地址是从真 socket 上取的」由 `single-instance.ts` 的 `boundAddress()` 负责，
 * 下面单独钉。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { boundAddress } from '../bootstrap/single-instance.js';
import { SessionStore } from './auth.js';
import { attachHttpHandlers, type ServerDeps } from './server.js';
import { SseHub } from './sse.js';

function makeDeps(host: string): ServerDeps {
  return {
    // token 不参与本用例，但必须是个真值 —— health 是公开端点，
    // 顺手也钉住"它绝不把 token 带出去"。
    sessions: new SessionStore('TOKEN-MUST-NOT-LEAK'),
    sse: new SseHub(),
    instanceId: () => 'INSTANCE',
    version: '0.0.0-test',
    dataDir: '/tmp/does-not-matter',
    port: () => 12345,
    host: () => host,
    status: () => ({}),
  };
}

async function withDaemon(
  host: string,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server: Server = createServer();
  attachHttpHandlers(server, makeDeps(host));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('/api/health 的 host：报实际绑定地址，不是字面量', () => {
  it('★ deps 说绑在 0.0.0.0，health 就必须回 0.0.0.0', async () => {
    await withDaemon('0.0.0.0', async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(
        body['host'],
        '0.0.0.0',
        '写死 127.0.0.1 的话这里会是 127.0.0.1 —— 而那会让"只绑回环吗"这个问题得到相反的答案',
      );
      assert.equal(body['port'], 12345);
      assert.equal(
        JSON.stringify(body).includes('TOKEN-MUST-NOT-LEAK'),
        false,
        'health 是公开端点（单实例探测在拿到 token 之前就要调它）',
      );
    });
  });

  it('对照组：真的绑回环时仍然回回环', async () => {
    await withDaemon('127.0.0.1', async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['host'], '127.0.0.1');
    });
  });

  it('boundAddress() 取的是内核给的那个地址，不是我们请求的那个', async () => {
    const server = createServer();
    assert.equal(boundAddress(server), null, '还没绑定就没有地址可报 —— 不许编一个');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      assert.equal(boundAddress(server), '127.0.0.1');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
