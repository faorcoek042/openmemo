/**
 * `.ompk` 波形峰值生成器（D-02 §3.4）—— **daemon 第一个 `role='peaks'` 的写入方**（T-151 ③）。
 *
 * ## 在这之前发生过什么
 *
 * 前端**只有解码器**（`lib/format/peaks.ts` 的 `decodeOmpk`），而全仓**零处产出** `.ompk`。
 * 于是 `NoteDetailPage` 里的逻辑被写反了：有 peaks 资产时 `setPeaks(null)`（把真数据丢掉），
 * 没有时 `mockPeaks()` **凭空造一条正弦波**。因为写入方从来不存在，
 * **每一位用户看到的每一条波形都是编出来的**，界面上一个字都不说（T-139 A3）。
 * `notes-contract` 已经把 `mockPeaks` 整个删掉并接通了真的那条 fetch 路径；
 * 现在缺的就是**真的有东西可 fetch**。
 * D-07 #18 / D-08 #18 两次盘点都把它记成 🔴，`decodeOmpk` 至今没有过一个真实数据源。
 *
 * ## 为什么这件事比前一份评估里说的小得多（**不需要 ffmpeg**）
 *
 * 上一轮的判断是「要在音轨落地后用 ffmpeg 抽 PCM → 按桶算 min/max，M 级，
 * 且要跨 `packages/pipeline`（别人的地界）」。**那个前提不成立**：
 * 转写流水线已经把音频归一化成 **16 kHz 单声道 PCM16 WAV** 并**归档进了 media 根**
 * （`transcribe.ts` 的 `archiveIntoMedia` → `role='audio16k'`），录音会话落的也是同一种格式。
 * 也就是说**盘上躺着的就是解码后的 PCM** —— 再调一次 ffmpeg 是把已经做完的事又做一遍。
 * 剩下的只有「按窗口取 min/max + 量化到 Int8 + 写 14 字节头」，纯 Node，
 * 全部落在 `apps/daemon` 内，不碰 `packages/pipeline`。
 *
 * ## 格式：以**解码器的代码**为准，不是以文档为准
 *
 * D-02 §3.4 与 `lib/format/peaks.ts` 的注释都写「各声道**交错**存放」，
 * 而 `decodeOmpk` 的实现是 `arr[i] = body[c * perChannel + i]` —— **平铺（planar）**：
 * 声道 0 的全部值在前，声道 1 的在后。文档和实现不一致时，
 * **能跑的那个才是契约**（否则第一个按文档写生成器的人会产出前端解不开的文件，
 * 而且解出来是"能显示、但形状是错的"——最难查的一种）。这里按 planar 写，
 * 并且有一条用例直接拿 `decodeOmpk` 的算法反解回来核对（不是核对字节，是核对**解出来的值**）。
 *
 * ```
 * [0..3]   magic "OMPK"      big-endian u32 0x4f4d504b（解码器用 getUint32(0, false)）
 * [4]      version u8 = 1
 * [5]      channels u8
 * [6..9]   samplesPerPixel u32 **little-endian**
 * [10..13] durationMs u32 **little-endian**
 * [14..]   Int8 × (每声道 2×桶数)，planar
 * ```
 * ⚠️ magic 是大端、后面两个 u32 是小端 —— 这不是笔误，是解码器真实的读法。
 */
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

/** 与 `decodeOmpk` 的 `MAGIC = 0x4f4d504b` 逐位相同。 */
const MAGIC = 'OMPK';
export const OMPK_VERSION = 1;
export const OMPK_HEADER_BYTES = 14;

/**
 * 默认窗口：D-02 §3.4 的 `samplesPerPixel = 256`（16 kHz 下 = 16 ms/像素）。
 * 1 小时音频 ≈ 2 × 225000 ≈ 450 KB —— 体积与精度的取舍见 D-02 V-9（标注为未验证，沿用设计值）。
 */
export const DEFAULT_SAMPLES_PER_PIXEL = 256;

export interface WavPcmInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  /** `data` 块的起始字节偏移。 */
  readonly dataOffset: number;
  /** `data` 块的**可信**长度（已按文件真实大小夹过，见 `readWavPcmInfo`）。 */
  readonly dataBytes: number;
}

/**
 * 解析 RIFF/WAVE 头，定位 `fmt ` 与 `data` 两个块。
 *
 * 不用现成的库，是因为这里只需要 PCM16 这一种情形，而且**必须能处理两种真实来源**：
 *   - `ws/recorder.ts` 写的规范 44 字节头；
 *   - ffmpeg 归一化出来的 `audio16k.wav`（可能夹带 `LIST` / `fact` 之类的块）。
 * 所以老老实实走一遍块链表，而不是假设 `data` 在第 36 字节。
 *
 * ⚠️ **`data` 块声明的长度不能全信**。录音的 WAV 头是"先写占位 0、停止时回填"的，
 * 而回填那一步在 `#finalizeWav()` 里被 try/catch 包着（磁盘满、文件被占用都会走到 catch）。
 * 真发生时头里写的是 0，若照它算就会得出"这段录音没有波形"——
 * 一个由**元数据**造成、却表现为**内容缺失**的假象。所以：
 * 声明长度为 0 或超出文件实际大小时，一律按"从 `data` 到文件末尾"处理，并如实标注。
 */
export async function readWavPcmInfo(path: string): Promise<WavPcmInfo> {
  const fileBytes = (await stat(path)).size;
  const fh = await open(path, 'r');
  try {
    // 头部块链表通常远小于 64 KB；再大就是不正常的文件，宁可报错也不猜
    const probeLen = Math.min(fileBytes, 64 * 1024);
    const head = Buffer.alloc(probeLen);
    await fh.read(head, 0, probeLen, 0);

    if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF') {
      throw new Error(`不是 RIFF 文件：${path}`);
    }
    if (head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`RIFF 里不是 WAVE：${path}`);
    }

    let pos = 12;
    let fmt: { sampleRate: number; channels: number; bitsPerSample: number; format: number } | null =
      null;
    let data: { offset: number; declared: number } | null = null;

    while (pos + 8 <= head.length) {
      const id = head.toString('ascii', pos, pos + 4);
      const size = head.readUInt32LE(pos + 4);
      const body = pos + 8;
      if (id === 'fmt ' && body + 16 <= head.length) {
        fmt = {
          format: head.readUInt16LE(body),
          channels: head.readUInt16LE(body + 2),
          sampleRate: head.readUInt32LE(body + 4),
          bitsPerSample: head.readUInt16LE(body + 14),
        };
      } else if (id === 'data') {
        data = { offset: body, declared: size };
        break; // data 之后就是几十 MB 的 PCM，没必要继续走
      }
      // RIFF 的块按偶数字节对齐（奇数长度后面补一个填充字节）
      pos = body + size + (size % 2);
    }

    if (!fmt) throw new Error(`WAV 里没有 fmt 块：${path}`);
    if (!data) throw new Error(`WAV 里没有 data 块（或它在前 64 KB 之外）：${path}`);
    if (fmt.format !== 1 || fmt.bitsPerSample !== 16) {
      throw new Error(
        `只支持 PCM16（audioFormat=1, bits=16），实际是 format=${fmt.format} bits=${fmt.bitsPerSample}：${path}`,
      );
    }
    if (fmt.channels < 1 || fmt.channels > 8) {
      throw new Error(`声道数不合理（${fmt.channels}）：${path}`);
    }

    const available = Math.max(0, fileBytes - data.offset);
    const dataBytes =
      data.declared > 0 && data.declared <= available ? data.declared : available;

    return {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitsPerSample: fmt.bitsPerSample,
      dataOffset: data.offset,
      dataBytes,
    };
  } finally {
    await fh.close();
  }
}

export interface OmpkResult {
  /** 可直接落盘的完整 `.ompk` 字节。 */
  readonly bytes: Buffer;
  readonly channels: number;
  readonly samplesPerPixel: number;
  readonly durationMs: number;
  /** 每声道的桶数（每桶两个值：min、max）。 */
  readonly buckets: number;
}

/**
 * 把已算好的 min/max 序列封成 `.ompk`。
 *
 * `values` 必须是 **planar** 排布：声道 0 的 `2 × buckets` 个值在前，声道 1 的在后。
 */
export function encodeOmpk(p: {
  values: Int8Array;
  channels: number;
  samplesPerPixel: number;
  durationMs: number;
}): Buffer {
  const header = Buffer.alloc(OMPK_HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt8(OMPK_VERSION, 4);
  header.writeUInt8(p.channels, 5);
  header.writeUInt32LE(p.samplesPerPixel, 6);
  // u32 上限约 49.7 天，音频不可能超；夹一下只是不想在极端脏数据上写出乱码
  header.writeUInt32LE(Math.max(0, Math.min(0xffff_ffff, Math.round(p.durationMs))), 10);
  return Buffer.concat([header, Buffer.from(p.values.buffer, p.values.byteOffset, p.values.length)]);
}

/** int16 → Int8（−127…127）。用 127 而不是 128，与解码器的 `v / 127` 严格互逆。 */
function quantize(v: number): number {
  const q = Math.round((v / 32768) * 127);
  return q > 127 ? 127 : q < -127 ? -127 : q;
}

/**
 * 从一份 PCM16 WAV 算出 `.ompk`。**流式读取**，不把整个音轨读进内存。
 *
 * 这条不是洁癖：一段 2 小时的 16 kHz 单声道音轨就是 230 MB，
 * 而这个函数跑在转写 job 里 —— 那条路上同时还挂着一个 whisper 进程。
 * 一次性 `readFile` 会在最不该的时候把内存顶上去。
 */
export async function computeWavPeaks(
  path: string,
  samplesPerPixel: number = DEFAULT_SAMPLES_PER_PIXEL,
): Promise<OmpkResult> {
  if (!Number.isInteger(samplesPerPixel) || samplesPerPixel < 1) {
    throw new Error(`samplesPerPixel 必须是正整数，收到 ${samplesPerPixel}`);
  }
  const info = await readWavPcmInfo(path);
  const bytesPerFrame = info.channels * 2;
  const totalFrames = Math.floor(info.dataBytes / bytesPerFrame);
  const buckets = Math.max(1, Math.ceil(totalFrames / samplesPerPixel));
  const durationMs = info.sampleRate > 0 ? Math.round((totalFrames / info.sampleRate) * 1000) : 0;

  // planar：[ch0 的 2×buckets 个值][ch1 的 …]
  const values = new Int8Array(info.channels * buckets * 2);
  const curMin = new Int16Array(info.channels).fill(32767);
  const curMax = new Int16Array(info.channels).fill(-32768);
  let frameInBucket = 0;
  let bucket = 0;
  let sawAny = false;

  const flush = (): void => {
    if (bucket >= buckets) return;
    for (let c = 0; c < info.channels; c += 1) {
      const base = c * buckets * 2 + bucket * 2;
      // 空桶（不该发生，但别写出未初始化的哨兵值 32767/-32768）
      values[base] = sawAny ? quantize(curMin[c] as number) : 0;
      values[base + 1] = sawAny ? quantize(curMax[c] as number) : 0;
      curMin[c] = 32767;
      curMax[c] = -32768;
    }
    bucket += 1;
    frameInBucket = 0;
    sawAny = false;
  };

  if (totalFrames > 0) {
    const stream = createReadStream(path, {
      start: info.dataOffset,
      end: info.dataOffset + totalFrames * bytesPerFrame - 1,
    });
    /*
     * 一帧可能被切在两个 chunk 中间 —— `createReadStream` 不保证按帧对齐。
     * 不处理的话读出来的样本会整体错位半个采样，波形看起来"有内容但形状不对"，
     * 而且不会有任何东西报错。所以留一个不足一帧的尾巴，拼到下一个 chunk 前面。
     */
    let carry: Buffer = Buffer.alloc(0);
    for await (const chunk of stream) {
      const merged: Buffer =
        carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
      const usable = merged.length - (merged.length % bytesPerFrame);
      carry = usable === merged.length ? Buffer.alloc(0) : Buffer.from(merged.subarray(usable));
      const buf: Buffer = merged.subarray(0, usable);

      for (let off = 0; off < usable; off += bytesPerFrame) {
        for (let c = 0; c < info.channels; c += 1) {
          const s = buf.readInt16LE(off + c * 2);
          if (s < (curMin[c] as number)) curMin[c] = s;
          if (s > (curMax[c] as number)) curMax[c] = s;
        }
        sawAny = true;
        frameInBucket += 1;
        if (frameInBucket === samplesPerPixel) flush();
      }
    }
    if (frameInBucket > 0) flush();
  }

  return {
    bytes: encodeOmpk({
      values,
      channels: info.channels,
      samplesPerPixel,
      durationMs,
    }),
    channels: info.channels,
    samplesPerPixel,
    durationMs,
    buckets,
  };
}
