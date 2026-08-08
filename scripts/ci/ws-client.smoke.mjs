#!/usr/bin/env node
/**
 * `ws-client.mjs` 的 smoke —— **对着一个真的 daemon 跑**，不是对着桩。
 *
 * ## 它证明什么
 *
 * 端到端腿里最容易静默写错的一段就是这个手写的 RFC 6455 客户端：
 * 掩码位、扩展长度、分片、控制帧 —— 任何一处错了，表现都是
 * 「连不上 / 收不到消息」，**与"产品坏了"长得一模一样**。
 * 那样的话，`e2e-record` 红了我们会先去查产品，而错在客户端。
 *
 * 所以这里把它单独钉住，钉的是**三件必须做对的事**（都由 daemon 的闸门执行）：
 *   ① `Host` 用域名（`localhost`）会被 `checkHost` 拒 —— **反向断言**：
 *      必须真的被拒。这一条同时证明"闸门在生效"，否则后面那条绿灯没有意义。
 *   ② 不带 `Origin` 会被 `checkOrigin(required:true)` 拒 —— 同样是反向断言。
 *   ③ 三条头都对时**必须握手成功**，并且能**真的收到服务端发来的 JSON 帧**。
 *
 * ## 为什么不需要装模型
 *
 * 没装流式模型时，`RecorderSession.start()` 会发一条
 * `{type:'error', code:'ASR_STREAM_UNAVAILABLE'}` 然后服务端主动关连接。
 * 那**正是**一条真实的、由产品生成的下行文本帧 —— 对"客户端解得开服务端的帧吗"
 * 这个问题来说，它和 `ready` 一样有效，而且不需要下载任何东西。
 * （判据写的是"收到**任意一条**合法 JSON 下行帧"，不是"收到 ready"——
 *   把它写成 ready 就变成了在测模型装没装，而那不是这个 smoke 的事。）
 *
 * 用法：
 *   本机：`node scripts/ci/ws-client.smoke.mjs`（需先 `pnpm build:safe`）
 *   CI ：`node scripts/ci/ws-client.smoke.mjs --daemon <包>/app/daemon/dist/main.js \
 *                                             --node <包>/runtime/node`
 *
 * CI 上刻意指向**包里的** daemon 与**包自带的** Node：这一步跑在重活之前，
 * 它红了说明是客户端/闸门这一层的问题，20 秒就知道，而不是等 40 分钟之后
 * 从一堆下载日志里去猜。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { wsConnect, parseFrames, encodeFrame } from './ws-client.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const PORT = Number(arg('--port', '19795'));
const DAEMON = arg('--daemon', join(REPO, 'apps', 'daemon', 'dist', 'main.js'));
/* 默认用跑本脚本的这个 Node；CI 上指向**包自带的**那个（用户机器上没有 node）。 */
const NODE_BIN = arg('--node', process.execPath);
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function ok(cond, what, detail = '') {
  checks += 1;
  if (cond) {
    console.log(`  ✔ ${what}${detail ? ` —— ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${what}${detail ? ` —— ${detail}` : ''}`);
  }
}

/* ── 0. 纯函数层：帧编解码自反 ── */

console.log('── 帧编解码（纯函数，不需要 daemon）');
for (const [label, payload] of [
  ['短帧 (<126)', Buffer.from('hello')],
  ['中帧 (126..65535)', Buffer.alloc(1000, 7)],
  ['长帧 (>65535)', Buffer.alloc(70_000, 3)],
]) {
  // 客户端帧带掩码；parseFrames 认掩码位，所以自反可测
  const { frames, rest } = parseFrames(encodeFrame(0x2, payload));
  ok(
    frames.length === 1 && rest.length === 0 && frames[0].payload.equals(payload),
    `${label} 编码后解得回来`,
    `${payload.length} 字节`,
  );
}
{
  // 粘包 + 半包：TCP 不保证一次 data 正好一帧，这是最常见的漏消息成因
  const a = encodeFrame(0x1, Buffer.from('one'));
  const b = encodeFrame(0x1, Buffer.from('two'));
  const glued = Buffer.concat([a, b]);
  const r1 = parseFrames(glued);
  ok(r1.frames.length === 2, '两帧粘在一起时两帧都解得出来');
  const r2 = parseFrames(glued.subarray(0, a.length + 2));
  ok(
    r2.frames.length === 1 && r2.rest.length === 2,
    '半帧留在 rest 里等下一批（不是丢掉，也不是当成完整帧）',
  );
}

/* ── 1. 起一个真 daemon ── */

if (!existsSync(DAEMON)) {
  console.error(`✘ 找不到 ${DAEMON} —— 先跑 pnpm build:safe`);
  process.exit(2);
}
const ROOT = mkdtempSync(join(tmpdir(), 'om-wsclient-smoke-'));
const DATA_DIR = join(ROOT, 'data');
const proc = spawn(NODE_BIN, [DAEMON, '--data-dir', DATA_DIR, '--port', String(PORT)], {
  env: {
    ...process.env,
    OPENMEMO_AUTH: 'none',
    OPENMEMO_DATA_DIR: DATA_DIR,
    // PROTOCOL §9：绝不碰全局指针
    OPENMEMO_POINTER_FILE: join(ROOT, 'pointer.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
proc.stdout.on('data', (d) => logs.push(String(d)));
proc.stderr.on('data', (d) => logs.push(String(d)));

function get(path, headers = {}) {
  return new Promise((res, rej) => {
    const req = httpRequest(
      {
        host: HOST,
        port: PORT,
        path,
        method: 'POST',
        headers: { host: `${HOST}:${PORT}`, ...headers },
      },
      (r) => {
        const c = [];
        r.on('data', (x) => c.push(x));
        r.on('end', () =>
          res({
            status: r.statusCode,
            headers: r.headers,
            body: Buffer.concat(c).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', rej);
    req.end();
  });
}

try {
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    try {
      const r = await fetch(`http://${HOST}:${PORT}/api/health`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break;
  }
  if (!up) throw new Error(`daemon 没起来：\n${logs.join('')}`);

  console.log('');
  console.log('── 闸门（反向断言：闸门必须真的在拦，否则下面的绿灯没有意义）');

  // ① Host 用域名 —— checkHost 拒绝一切域名，包括 localhost
  let rejected = null;
  try {
    await wsConnect({ host: 'localhost', port: PORT, path: '/ws/recorder' });
  } catch (e) {
    rejected = e.message;
  }
  ok(
    rejected !== null && /403|ENOTFOUND|ECONNREFUSED/.test(rejected),
    'Host 是域名（localhost）时被拒',
    String(rejected).slice(0, 120),
  );

  // ② 不带 Origin —— checkOrigin(required:true)
  const noOrigin = await new Promise((res) => {
    const req = httpRequest({
      host: HOST,
      port: PORT,
      path: '/ws/recorder',
      headers: {
        host: `${HOST}:${PORT}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': Buffer.alloc(16).toString('base64'),
        'sec-websocket-version': '13',
      },
    });
    req.on('response', (r) => {
      r.resume();
      res(r.statusCode);
    });
    req.on('upgrade', () => res(101));
    req.on('error', () => res(0));
    req.end();
  });
  ok(noOrigin === 403, '不带 Origin 时被拒（403）', `实际 HTTP ${noOrigin}`);

  console.log('');
  console.log('── 正路：三条头都对时必须握手成功，并且真的收得到服务端的帧');

  const sess = await get('/api/auth/session');
  const setCookie = sess.headers['set-cookie'];
  const cookie = setCookie ? (/om_sid=[^;]+/.exec(setCookie.join(';')) ?? [''])[0] : '';
  ok(cookie.length > 0, 'POST /api/auth/session 换到了 om_sid', `HTTP ${sess.status}`);

  const ws = await wsConnect({ host: HOST, port: PORT, path: '/ws/recorder?language=en', cookie });
  ok(true, 'WS 升级成功（101 且 Sec-WebSocket-Accept 校验通过）');

  const received = [];
  let closed = false;
  ws.onMessage((opcode, payload) => {
    if (opcode === 0x1) {
      try {
        received.push(JSON.parse(payload.toString('utf8')));
      } catch {
        received.push({ type: 'unparsable' });
      }
    }
  });
  ws.onClose(() => {
    closed = true;
  });

  // 推一帧真 PCM：没装流式模型时会被忽略，装了则进引擎。两种都不该让连接炸掉。
  ws.sendBinary(Buffer.alloc(640));
  const deadline = Date.now() + 15_000;
  while (received.length === 0 && !closed && Date.now() < deadline) await sleep(50);

  ok(
    received.length > 0,
    '收到服务端发来的 JSON 下行帧（客户端解帧路径通）',
    received.length > 0 ? JSON.stringify(received[0]).slice(0, 160) : '一条都没收到',
  );
  /*
   * **不断言它是 ready** —— 那取决于这台机器上装没装流式模型，
   * 而这个 smoke 问的是"客户端解得开服务端的帧吗"。
   * 但要断言它是个**认得出来的**消息类型：收到一坨解不开的东西同样算失败。
   */
  const known = ['ready', 'error', 'partial', 'final', 'overrun', 'stopped'];
  ok(
    received.length > 0 && known.includes(received[0].type),
    '下行帧是契约里认得出的类型',
    received.length > 0 ? `type=${received[0].type}` : '(无)',
  );

  ws.sendText(JSON.stringify({ type: 'stop' }));
  await sleep(500);
  ws.close();
} catch (e) {
  failures += 1;
  console.log(`  ✘ smoke 中断：${e.message}`);
  console.log(logs.join('').split('\n').slice(-25).join('\n'));
} finally {
  proc.kill('SIGTERM');
  await sleep(800);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

console.log('');
if (failures > 0) {
  console.log(`✘ ws-client smoke：${checks} 条里 ${failures} 条不成立`);
  process.exit(1);
}
console.log(`✔ ws-client smoke：${checks} 条全部成立`);
