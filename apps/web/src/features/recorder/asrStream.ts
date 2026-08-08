/**
 * F3 实时录音的**真实**上行通道 —— 麦克风 → PCM16 → `/ws/recorder`。
 *
 * ## 这个文件替换掉了什么
 *
 * `RecorderPage` 里原本是一段 `setInterval` 轮播写死的字幕，
 * 停止后弹「已更新 47 段 · 已保留 3 段」——**数字是常量**。
 * 后端 `/ws/recorder` 一直是真的（实测 40s 中文推流、partial 62 / final 7、
 * 停止后自动排离线重跑），**只有 UI 在演**。章程五功能里唯一 UI 层造假的一处。
 *
 * ## 协议（读 `apps/daemon/src/ws/recorder.ts` 与 `http/ws.ts` 得来，不是猜的）
 *
 * - **连上即开始**：`?language=&title=` 走查询串，**不需要再发 init**。
 * - **上行**：二进制帧 = PCM16 单声道小端，采样率 `16000`（`RECORD_SAMPLE_RATE`）。
 * - **上行**：`{"type":"stop"}` → 服务端收尾并关闭。
 * - **下行**：`ready` / `partial` / `final` / `overrun` / `stopped` / `error`。
 *
 * ## 三条实现约束（都来自冻结契约 D-06 §15）
 *
 * 1. **语义 1：音频回调不能被阻塞。** 所以采集走 `AudioWorklet`（独立音频线程），
 *    回调里只做 Float32→Int16 转换 + `postMessage`，**不碰 WS、不 await**。
 * 2. **语义 4：同一句内 `text` 单调增长。** 前端**整句替换**即可，不要 diff 拼接。
 * 3. **语义 3：stop 幂等。** 断线等同 stop，所以重复调用必须安全。
 */

/** 与 daemon 的 `RECORD_SAMPLE_RATE` 必须一致 —— 不一致会让识别结果整体错位。 */
export const RECORD_SAMPLE_RATE = 16_000;

export type RecorderServerMessage =
  | {
      type: 'ready';
      recordingUid: string;
      noteUid: string;
      transcriptUid: string;
      sampleRate: number;
    }
  | { type: 'partial'; utteranceId: string; text: string; startMs: number }
  | { type: 'final'; seq: number; startMs: number; endMs: number; text: string }
  | { type: 'overrun'; droppedSamples: number }
  | { type: 'stopped'; segmentCount: number; rerunJobUid: string | null }
  | { type: 'error'; code: string; messageZh: string };

export interface RecorderHandle {
  /** 发送 stop 并等待服务端的 `stopped`。幂等。 */
  stop(): Promise<void>;
  /** 立即断开，不等收尾（用于组件卸载）。 */
  dispose(): void;
}

/**
 * AudioWorklet 处理器源码。
 *
 * 用 Blob URL 内联而不是单独的静态资源文件：worklet 必须由**独立 URL** 加载，
 * 而单独文件在 dev/build 两种模式下的路径解析规则不同，最容易出现
 * "开发能跑、打包后 404" 的那类问题。内联把这个变量消掉。
 */
const WORKLET_SRC = `
class PcmDownsampler extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Float32 [-1,1] → Int16 小端。clamp 是必须的：超范围会绕回成刺耳的爆音
    const out = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // transfer 而不是拷贝 —— 音频线程上每一次分配都值得省
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
`;

function wsUrl(params: { language?: string; title?: string }): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const u = new URL(`${proto}//${window.location.host}/ws/recorder`);
  // 语言必须显式带上：whisper 缺 -l 会把中文翻译成英文（gpu-runtime 修过的事故）
  if (params.language) u.searchParams.set('language', params.language);
  if (params.title) u.searchParams.set('title', params.title);
  return u.toString();
}

export interface StartOptions {
  language?: string;
  title?: string;
  onMessage: (msg: RecorderServerMessage) => void;
  /** 音量电平 0..1，供波形显示。走回调而不是 state —— 它是 ~50Hz 的高频量。 */
  onLevel?: (level: number) => void;
  onSocketError?: (err: Error) => void;
}

/**
 * 开始录音。**调用前必须确认 `isMicrophoneAvailable()`** ——
 * 非安全上下文下 `navigator.mediaDevices` 是 `undefined`（`http://<IP>` 即是）。
 */
export async function startRecording(opts: StartOptions): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // 这三项交给浏览器做，比我们自己在 worklet 里做得好得多
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // 直接以 16k 建 AudioContext：浏览器会替我们重采样，
  // 比自己写降采样滤波器可靠（自己写最容易出混叠，而混叠对 ASR 是致命的）
  const ctx = new AudioContext({ sampleRate: RECORD_SAMPLE_RATE });
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));

  let ws: WebSocket | null = null;
  let closed = false;
  let stopResolve: (() => void) | null = null;

  const cleanup = (): void => {
    closed = true;
    for (const t of stream.getTracks()) t.stop();
    void ctx.close().catch(() => undefined);
    URL.revokeObjectURL(blobUrl);
  };

  try {
    await ctx.audioWorklet.addModule(blobUrl);

    ws = new WebSocket(
      wsUrl({
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      }),
    );
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: RecorderServerMessage;
      try {
        msg = JSON.parse(ev.data) as RecorderServerMessage;
      } catch {
        return; // 服务端只发 JSON；解析不了就丢，不要因为一条坏消息终止会话
      }
      opts.onMessage(msg);
      if (msg.type === 'stopped') {
        stopResolve?.();
        stopResolve = null;
      }
    };
    ws.onerror = () => opts.onSocketError?.(new Error('websocket error'));
    ws.onclose = () => {
      // 服务端把断线当作 stop（语义 3），所以这里也要把等待中的 stop 解开，
      // 否则 stop() 会永远挂着
      stopResolve?.();
      stopResolve = null;
    };

    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-downsampler');

    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
      // 背压：socket 缓冲已经堆了超过 1 秒的音频就丢这一帧。
      // 无限缓冲会让"停止"之后还在传几十秒前的声音，比丢帧难解释得多。
      if (ws.bufferedAmount > RECORD_SAMPLE_RATE * 2) return;
      ws.send(ev.data);

      if (opts.onLevel) {
        const pcm = new Int16Array(ev.data);
        let peak = 0;
        for (let i = 0; i < pcm.length; i += 8) peak = Math.max(peak, Math.abs(pcm[i]!));
        opts.onLevel(peak / 0x8000);
      }
    };

    src.connect(node);
    /*
     * ⚠️ **不接到 destination**。接上去会把麦克风原声回放到扬声器 ——
     * 用户戴不戴耳机都会听见自己，不戴耳机还会形成啸叫。
     * AudioWorklet 不连 destination 在现代浏览器里照常被驱动。
     */
  } catch (err) {
    cleanup();
    ws?.close();
    throw err;
  }

  return {
    async stop(): Promise<void> {
      if (closed) return; // 语义 3：幂等
      const sock = ws;
      if (sock && sock.readyState === WebSocket.OPEN) {
        const done = new Promise<void>((res) => {
          stopResolve = res;
          // 兜底：服务端收尾要落盘 + 排重跑，给 10 秒；超时也要让 UI 往下走
          setTimeout(res, 10_000);
        });
        sock.send(JSON.stringify({ type: 'stop' }));
        await done;
      }
      cleanup();
      sock?.close();
    },
    dispose(): void {
      cleanup();
      ws?.close();
    },
  };
}

export interface CaptionRow {
  id: number;
  uid: string;
  text: string;
  final: boolean;
}

/**
 * 把一条下行消息合并进字幕列表 —— **纯函数，单独导出以便直接测语义**。
 *
 * 抽出来的理由和 `mergePurposeBinding` 一样：真正容易写错的是**合并规则**，
 * 而组件宿主里跑不动 `AudioWorklet` / `WebSocket`，把断言挂在渲染上只能测个空壳。
 *
 * 规则（D-06 §15 冻结契约）：
 * - **语义 4**：同一 `utteranceId` 内 `text` 单调增长 → **整句替换**，不做 diff 拼接；
 * - `final` 到达 = 该句定稿：丢掉所有未定稿行，追加定稿行
 *   （服务端一句定稿后就换新的 `utteranceId`，未定稿行不会再更新）。
 */
export function applyCaption(
  rows: readonly CaptionRow[],
  msg: RecorderServerMessage,
): CaptionRow[] {
  if (msg.type === 'partial') {
    const row: CaptionRow = { id: msg.startMs, uid: msg.utteranceId, text: msg.text, final: false };
    const idx = rows.findIndex((x) => !x.final && x.uid === msg.utteranceId);
    if (idx >= 0) return rows.map((x, i) => (i === idx ? row : x));
    return [...rows, row];
  }
  if (msg.type === 'final') {
    return [
      ...rows.filter((x) => x.final),
      { id: msg.seq, uid: `f${String(msg.seq)}`, text: msg.text, final: true },
    ];
  }
  return [...rows];
}
