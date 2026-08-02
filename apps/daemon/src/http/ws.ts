/**
 * WebSocket 骨架（D-01 §3.4）。**只给真正需要双向的两个场景**：
 *   - `/ws/recorder`    F3 实时录音：上行 PCM16 二进制帧，下行 JSON partial/final
 *   - `/ws/asr-worker`  浏览器作为 WebGPU ASR worker 的反向通道（ADR-006 决策 3 已降级为实验特性）
 *
 * ⚠️ 安全：WebSocket **不受 SameSite 完全保护**，握手时必须显式校验 Origin，
 *    否则任意网页都能发起跨源 WS。这是 WS 的经典坑。
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { type SessionStore, authenticate } from './auth.js';
import { guardRequest } from './guard.js';

export interface WsDeps {
  readonly sessions: SessionStore;
  readonly port: () => number;
}

const WS_ROUTES = new Set(['/ws/recorder', '/ws/asr-worker']);

/** 上行音频积压超过 3 秒就丢最老的帧（D-01 §3.4 背压）。 */
export const MAX_INBOUND_BACKLOG_MS = 3000;

export function attachWebSocket(server: Server, deps: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? '127.0.0.1'}`);

    const reject = (code: number, msg: string): void => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    if (!WS_ROUTES.has(url.pathname)) return reject(404, 'Not Found');

    // WS 必须**强制**校验 Origin（requireOrigin: true），比普通 REST 更严
    const guard = guardRequest(req, [deps.port()], { requireOrigin: true });
    if (!guard.ok) return reject(403, 'Forbidden');

    const auth = authenticate(req, deps.sessions);
    if (!auth.ok) return reject(401, 'Unauthorized');

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      onConnection(ws, url.pathname);
    });
  });

  return wss;
}

function onConnection(ws: WebSocket, route: string): void {
  // 骨架：真正的音频处理归 T-020（packages/pipeline）。
  // 这里只建立协议边界：二进制帧 = 音频，文本帧 = 控制消息，**不混编**。
  ws.on('message', (data: unknown, isBinary: boolean) => {
    if (isBinary) {
      // 音频帧 → 交给 pipeline 的流式 ASR（T-020 接入）
      return;
    }
    try {
      const msg = JSON.parse(String(data)) as { type?: string };
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', route }));
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'BAD_JSON' }));
    }
  });
  ws.send(JSON.stringify({ type: 'ready', route }));
}
