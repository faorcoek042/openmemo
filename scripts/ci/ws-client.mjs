/**
 * 极简 RFC 6455 WebSocket **客户端** —— 给 CI 的端到端腿用。
 *
 * ## 为什么手写，而不是用 `ws`
 *
 * 这些腿要证明的是「**用户下载的那个预编译包**能用」。一旦驱动脚本依赖 npm 包，
 * workflow 就得先 `pnpm install` 一整个工作区 —— 那既慢，又把"被测对象是那个包"
 * 这件事弄浑：绿灯里混进了源码树的成分。手写之后，整条腿的前置条件只剩
 * 「一个 Node」和「那个包」。
 *
 * ## 为什么单独成文件
 *
 * 它是这几条腿里**最容易写错、又最不容易被发现写错**的一段：
 * 掩码位、扩展长度、分片、控制帧 —— 任何一处错了，表现都是"连不上/收不到消息"，
 * 而那与"产品坏了"长得一模一样。抽成一个模块之后它可以被单独 smoke
 * （`node scripts/ci/ws-client.smoke.mjs`），而不是只能靠整条腿的成败间接推断。
 * 抄一份到脚本里也能跑，但那样就有两份实现，改一份的人不会知道还有另一份。
 *
 * ## 三条它必须做对的事（都由 daemon 的闸门盯着，写错就 403/401）
 *
 * 1. **Host 必须是 IP 字面量** —— `apps/daemon/src/http/guard.ts` 的 `checkHost`
 *    拒绝一切域名，**包括 `localhost`**（DNS rebinding 防护）。
 * 2. **Origin 必须带，且与 Host 严格同源** —— `checkOrigin(..., {required:true})`，
 *    WS 不受 SameSite 保护，这是 D-01 §3.4 明确要求的。
 * 3. **Cookie 要带** —— `http/ws.ts` 的升级路径**没有** `authRequired()` 判断，
 *    所以即使 `OPENMEMO_AUTH=none` 也要先握一次 `/api/auth/session` 换 `om_sid`。
 *    （这一条与 REST 主路径不对称，是本仓的真实现状，不是我猜的。）
 */
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 组一个**客户端**帧。RFC 6455 §5.3：客户端发出的帧**必须**打掩码。 */
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, out]);
}

/**
 * 把字节流切成帧。**是个生成器状态机**：TCP 不保证一次 `data` 事件正好一帧，
 * 既可能半帧，也可能三帧粘在一起 —— 两种都得处理，否则表现是"偶尔丢消息"。
 *
 * 返回 `{ frames, rest }`：解得出来的完整帧，以及剩下的半截（下次接着拼）。
 */
export function parseFrames(buf) {
  const frames = [];
  let cur = buf;
  for (;;) {
    if (cur.length < 2) break;
    const fin = (cur[0] & 0x80) !== 0;
    const opcode = cur[0] & 0x0f;
    const masked = (cur[1] & 0x80) !== 0;
    let len = cur[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (cur.length < off + 2) break;
      len = cur.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (cur.length < off + 8) break;
      len = Number(cur.readBigUInt64BE(off));
      off += 8;
    }
    let mask = null;
    if (masked) {
      if (cur.length < off + 4) break;
      mask = cur.subarray(off, off + 4);
      off += 4;
    }
    if (cur.length < off + len) break;
    const payload = Buffer.from(cur.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    frames.push({ fin, opcode, payload });
    cur = cur.subarray(off + len);
  }
  return { frames, rest: cur };
}

/**
 * 连一路 WebSocket。
 *
 * @param opts.host  **必须是 IP 字面量**（见文件头第 1 条）
 * @param opts.cookie  `om_sid=…`，从 `POST /api/auth/session` 的 Set-Cookie 里取
 */
export function wsConnect({ host, port, path, cookie = '' }) {
  return new Promise((resolvePromise, reject) => {
    const key = randomBytes(16).toString('base64');
    const req = httpRequest({
      host,
      port,
      path,
      headers: {
        host: `${host}:${port}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        origin: `http://${host}:${port}`,
        ...(cookie ? { cookie } : {}),
      },
    });

    req.on('upgrade', (res, socket) => {
      const expect = createHash('sha1').update(`${key}${GUID}`).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        reject(new Error(`Sec-WebSocket-Accept 不对：${res.headers['sec-websocket-accept']}`));
        return;
      }
      socket.setNoDelay(true);

      const handlers = { message: [], close: [] };
      let buf = Buffer.alloc(0);
      let fragOpcode = 0;
      let fragParts = [];

      socket.on('data', (chunk) => {
        const { frames, rest } = parseFrames(Buffer.concat([buf, chunk]));
        buf = rest;
        for (const f of frames) {
          if (f.opcode === 0x9) {
            socket.write(encodeFrame(0xa, f.payload)); // ping → pong
            continue;
          }
          if (f.opcode === 0xa) continue; // pong
          if (f.opcode === 0x8) {
            for (const h of handlers.close) h();
            socket.end();
            return;
          }
          if (f.opcode === 0x0) {
            fragParts.push(f.payload);
            if (!f.fin) continue;
            const whole = Buffer.concat(fragParts);
            fragParts = [];
            for (const h of handlers.message) h(fragOpcode, whole);
            continue;
          }
          if (!f.fin) {
            fragOpcode = f.opcode;
            fragParts = [f.payload];
            continue;
          }
          for (const h of handlers.message) h(f.opcode, f.payload);
        }
      });
      socket.on('close', () => {
        for (const h of handlers.close) h();
      });
      socket.on('error', () => {
        for (const h of handlers.close) h();
      });

      resolvePromise({
        onMessage: (fn) => handlers.message.push(fn),
        onClose: (fn) => handlers.close.push(fn),
        sendBinary: (b) => socket.write(encodeFrame(0x2, b)),
        sendText: (s) => socket.write(encodeFrame(0x1, Buffer.from(s, 'utf8'))),
        close: () => {
          try {
            socket.write(encodeFrame(0x8, Buffer.alloc(0)));
          } catch {
            /* 已经关了 */
          }
          socket.end();
        },
      });
    });

    /*
     * 升级**没有**发生 —— 服务端回了普通响应。这一支必须把状态码和正文带出去：
     * 403（Host/Origin 闸门）与 401（没带 cookie）是两个完全不同的处置，
     * 只报"连不上"会让人去查网络，而问题在请求头上。
     */
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
        reject(new Error(`WS 升级被拒：HTTP ${res.statusCode} ${body}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}
