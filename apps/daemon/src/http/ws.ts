/**
 * WebSocket（D-01 §3.4）。**只给真正需要双向的两个场景**：
 *   - `/ws/recorder`    F3 实时录音：上行 PCM16 二进制帧，下行 JSON partial/final
 *   - `/ws/asr-worker`  浏览器 WebGPU 作为 ASR worker（ADR-006 决策 3 已降级为实验特性，v1 不实现）
 *
 * ⚠️ 安全：WebSocket **不受 SameSite 完全保护**，握手时必须显式校验 Origin，
 *    否则任意网页都能发起跨源 WS。这是 WS 的经典坑。
 *
 * 帧约定（不混编）：**二进制帧 = 音频**，**文本帧 = 控制消息 JSON**。
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { RecorderSession, type RecorderDeps, type ServerMessage } from '../ws/recorder.js';
import { type SessionStore, authenticate } from './auth.js';
import { guardRequest } from './guard.js';

export interface WsDeps {
  readonly sessions: SessionStore;
  readonly port: () => number;
  /** 录音会话依赖；未装流式模型时 `openStream` 返回 undefined，会话会回一条明确错误。 */
  readonly recorder: RecorderDeps;
}

const WS_ROUTES = new Set(['/ws/recorder', '/ws/asr-worker']);

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
      if (url.pathname === '/ws/recorder') onRecorder(ws, url, deps);
      else onAsrWorker(ws);
    });
  });

  return wss;
}

/** F3 录音通道。 */
function onRecorder(ws: WebSocket, url: URL, deps: WsDeps): void {
  const send = (msg: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const session = new RecorderSession(deps.recorder, send);
  let started = false;

  const language = url.searchParams.get('language') ?? undefined;
  const title = url.searchParams.get('title') ?? undefined;

  // 连上就开始：前端不用再来一次 start 往返
  void session
    .start({ language, title })
    .then(() => {
      /*
       * ★ `start()` 正常 resolve **不等于**会话开起来了（T-164 ②）。
       *
       * 引擎不可用那一支会发一条 `ASR_STREAM_UNAVAILABLE` 然后正常返回。
       * 这里原来无条件 `started = true` 并把 socket 留着：浏览器于是继续
       * 推 PCM（`writeAudio` 全部丢掉）、界面继续显示"录音中"，
       * 直到用户点停止 —— 而那一下会造出一条 0 秒的"就绪"死笔记。
       * 病根已在 `RecorderSession.start()` 里修掉（失败时一行都不建），
       * 这里补上另一半：**开不起来就把连接关了**，别让前端对着一条死路推流。
       */
      if (!session.active) {
        ws.close();
        return;
      }
      started = true;
    })
    .catch((err: unknown) => {
      const detail = errorDetail(err);
      // 控制台那一侧没有 i18n（见 `finish()` 里那段说明），照旧说中文
      console.error(`[ws/recorder] 录音启动失败：${detail}`);
      send({
        type: 'error',
        code: 'RECORD_START_FAILED',
        reason: { kind: 'start_failed', detail },
      });
      ws.close();
    });

  /**
   * 收尾失败必须**说出来**，不能变成一条 unhandled rejection（T-151 ①）。
   *
   * `stop()` 现在会在"落盘路径算不出规范相对路径"时抛 —— 那是必须响亮失败的情形
   * （写绝对路径进 `media_assets.rel_path` = 数据目录一搬家录音就找不回来）。
   * 但三个调用点原来都是光秃秃的 `void session.stop()` / `void session.abandon()`：
   * 一旦真抛出来，Node 会按 unhandled rejection 处理 —— **默认直接终止整个 daemon 进程**，
   * 而用户看到的只是"录音停止时应用突然退出"，与真正的原因毫无关系。
   * 所以三处统一收口到这里：告诉前端 + 记日志 + 让会话正常关闭。
   */
  const finish = (p: Promise<void>, then?: () => void): void => {
    p.then(
      () => then?.(),
      (err: unknown) => {
        const detail = errorDetail(err);
        /*
         * ⚠️ **中文这一句留在 daemon 控制台，一个字没动**（#112 第 19 处）。
         *
         * 帧上那格 `messageZh` 删掉了，但这一侧**没有 i18n**：从启动横幅到每一条
         * `[daemon]` 都是中文，在这里插英文既不一致也救不了谁。变的只有
         * **上了网线、进浏览器**的那一份 —— 浏览器那边有两份 locale，
         * 而这个控制台没有。所以句子在这里现拼，不再由帧顺路捎带。
         */
        console.error(`[ws/recorder] 录音收尾失败：${detail}`);
        send({
          type: 'error',
          code: 'RECORD_FINALIZE_FAILED',
          reason: { kind: 'finalize_failed', detail },
        });
        try {
          ws.close();
        } catch {
          /* 已经关了就算了 */
        }
      },
    );
  };

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) {
      // 音频帧：同步送入（语义 1 —— 不能 await，否则阻塞浏览器音频线程）
      if (!started) return; // start 尚未完成的极短窗口，丢帧好过崩
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      session.writeAudio(buf);
      return;
    }
    try {
      const msg = JSON.parse(String(data)) as { type?: string };
      if (msg.type === 'stop') {
        finish(session.stop(), () => ws.close());
      }
    } catch {
      send({ type: 'error', code: 'BAD_JSON', reason: { kind: 'control_message_not_json' } });
    }
  });

  // 断线 = 停止录音。stop() 幂等（语义 3），与显式 stop 竞争也安全
  ws.on('close', () => {
    finish(session.abandon());
  });
  ws.on('error', () => {
    finish(session.abandon());
  });
}

/** `/ws/asr-worker`：ADR-006 决策 3 已把 L0 降级为实验特性，v1 不实现。 */
function onAsrWorker(ws: WebSocket): void {
  /*
   * ★ 这条帧原来是一个**没有类型标注的对象字面量** —— 于是它上面那句 `messageZh`
   * 从来不受 `ServerMessage` 约束，帧的形状换掉时编译器一个字都不会说。
   * 显式标成 `ServerMessage`：两条 WS 通道下行的是同一套帧，
   * 错误说法换形状时这里必须一起红。
   */
  const msg: ServerMessage = {
    type: 'error',
    code: 'NOT_IMPLEMENTED',
    reason: { kind: 'asr_worker_not_implemented' },
  };
  ws.send(JSON.stringify(msg));
  ws.close();
}

/**
 * `err.message` 的**原样串** —— 进 `RecorderErrorReason` 的 `detail`。
 *
 * ⚠️ 不加前缀、不翻译、不加工：这一格的全部含义就是「我们没有解读过的那段原文」。
 * 拼一句话进去（原来那三处 `录音启动失败：…` 就是这么干的）等于把散文塞进结构字段，
 * 前端想把原文单独取出来只能去劈那句话。
 */
function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
