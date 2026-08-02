/**
 * 波形峰值：`.ompk` → wavesurfer 期望的格式（D-05 §7.3a）。
 *
 * 为什么要预计算：浏览器 `decodeAudioData` 一个 2 小时的文件会占数百 MB 内存
 * 并阻塞主线程（D-01 §5 F5）。所以峰值由 daemon 用 ffmpeg 预生成，前端只解析二进制。
 *
 * `.ompk` 格式（D-02 §3.4）：
 *   [magic "OMPK"(4B)][version u8][channels u8][samplesPerPixel u32][durationMs u32]
 *   [数据: Int8 × N × 2 (min,max) × channels]
 *
 * wavesurfer v7 的 `peaks` 选项要的是**每声道一个归一化到 −1..1 的数组**，
 * 所以这里做 `v / 127` 的转换。
 *
 * ⚠️ 这层转换故意放在共享工具里而不是 player feature 里：
 * 日后换掉 wavesurfer 只有这一个文件 + player 受影响，`.ompk` 格式本身不绑任何库。
 */

export interface DecodedPeaks {
  /** 每声道一个数组，值域 −1..1。直接喂 wavesurfer 的 `peaks` 选项。 */
  channels: Float32Array[];
  durationMs: number;
  samplesPerPixel: number;
}

const MAGIC = 0x4f4d504b; // "OMPK"

export function decodeOmpk(buf: ArrayBuffer): DecodedPeaks {
  const view = new DataView(buf);
  if (view.byteLength < 14) throw new Error('ompk: 文件过短');
  if (view.getUint32(0, false) !== MAGIC) throw new Error('ompk: magic 不匹配');

  const version = view.getUint8(4);
  if (version !== 1) throw new Error(`ompk: 不支持的版本 ${version}`);

  const channels = view.getUint8(5);
  const samplesPerPixel = view.getUint32(6, true);
  const durationMs = view.getUint32(10, true);

  const body = new Int8Array(buf, 14);
  // 每个像素 2 个值（min,max），各声道交错存放
  const perChannel = Math.floor(body.length / channels);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) {
    const arr = new Float32Array(perChannel);
    for (let i = 0; i < perChannel; i += 1) arr[i] = body[c * perChannel + i] / 127;
    out.push(arr);
  }
  return { channels: out, durationMs, samplesPerPixel };
}

/**
 * 在没有真实 `.ompk` 时生成一条占位波形，让 UI 能被看到与评审。
 * **调用处必须把它标成 mock**，不许假装是真数据（诚实规则）。
 */
export function mockPeaks(durationMs: number, buckets = 800): DecodedPeaks {
  const arr = new Float32Array(buckets);
  for (let i = 0; i < buckets; i += 1) {
    const t = i / buckets;
    const env = 0.35 + 0.4 * Math.sin(t * Math.PI * 6) ** 2;
    const detail = 0.55 + 0.45 * Math.sin(i * 1.7) * Math.cos(i * 0.31);
    arr[i] = Math.min(1, Math.abs(env * detail));
  }
  return { channels: [arr], durationMs, samplesPerPixel: 256 };
}
