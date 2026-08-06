/**
 * `.ompk` 生成器（T-151 ③）。
 *
 * ## 判据：**前端那份解码器解出来是对的**，不是"字节长这样"
 *
 * 这个文件里最要紧的一条是 `decodeOmpkLikeFrontend` —— 它把
 * `apps/web/src/lib/format/peaks.ts` 的 `decodeOmpk` **逐行照抄**过来（含大端 magic、
 * 小端 u32、以及 `body[c * perChannel + i]` 那个 **planar** 索引），
 * 然后拿它反解我生成的文件，核对**解出来的浮点值**。
 *
 * 为什么不断言字节：D-02 §3.4 与前端的注释都写「各声道**交错**存放」，
 * 而 `decodeOmpk` 的实现是**平铺**的。两者不一致时，能跑的那个才是契约 ——
 * 按文档写生成器会产出"解得开、但声道错位"的文件，而多声道下界面**照样画得出东西**，
 * 只是画的是别的声道。那是最难查的一类：没有报错、没有空白，只有错。
 *
 * ⚠️ 照抄一份解码器是**有代价的**（两份实现会漂）。所以：
 *   - 抄的那段带明确出处，且只在测试里；
 *   - 另有一条用例断言 web 那份源码**没有被改成交错**（读文件、剥注释、找索引表达式）。
 *     它不完美，但它会在有人改动排布时红一次 —— 而现在这条缝上一个人都没有。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_SAMPLES_PER_PIXEL,
  OMPK_HEADER_BYTES,
  computeWavPeaks,
  encodeOmpk,
  readWavPcmInfo,
} from './peaks.js';

const ROOT = mkdtempSync(join(tmpdir(), 'om-peaks-'));
after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

/** 造一份 PCM16 WAV。`extraChunk` 用来模拟 ffmpeg 夹带的 LIST 块。 */
async function writeWav(
  name: string,
  samples: Int16Array,
  opts: {
    channels?: number;
    sampleRate?: number;
    extraChunk?: boolean;
    declaredDataBytes?: number;
  } = {},
): Promise<string> {
  const channels = opts.channels ?? 1;
  const sampleRate = opts.sampleRate ?? 16_000;
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2);

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * 2, 16);
  fmt.writeUInt16LE(channels * 2, 20);
  fmt.writeUInt16LE(16, 22);

  const chunks: Buffer[] = [fmt];
  if (opts.extraChunk) {
    // ffmpeg 常写 LIST/INFO；奇数长度还要补一个填充字节 —— 两件事一起测
    // ⚠ 控制字节一律写转义序列：源码里夹一个字面 NUL，`grep -r` 会把整个文件当成 binary 静默跳过
    const payload = Buffer.from('INFOISFT\u0000\u0000\u0000\u0005Lavf\u0000', 'binary');
    const list = Buffer.alloc(8 + payload.length + (payload.length % 2));
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(payload.length, 4);
    payload.copy(list, 8);
    chunks.push(list);
  }
  const dataHdr = Buffer.alloc(8);
  dataHdr.write('data', 0, 'ascii');
  dataHdr.writeUInt32LE(opts.declaredDataBytes ?? pcm.length, 4);
  chunks.push(dataHdr);

  const body = Buffer.concat([...chunks, pcm]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'ascii');

  const path = join(ROOT, name);
  await fs.writeFile(path, Buffer.concat([riff, body]));
  return path;
}

interface DecodedPeaks {
  channels: Float32Array[];
  durationMs: number;
  samplesPerPixel: number;
}

/**
 * `apps/web/src/lib/format/peaks.ts` 的 `decodeOmpk`，**逐行照抄**（2026-08-06）。
 * 改这里之前先去那边看一眼 —— 两边不一致时，以 web 那份为准，因为它才在用户面前跑。
 */
function decodeOmpkLikeFrontend(buf: ArrayBuffer): DecodedPeaks {
  const view = new DataView(buf);
  if (view.byteLength < 14) throw new Error('ompk: 文件过短');
  if (view.getUint32(0, false) !== 0x4f4d504b) throw new Error('ompk: magic 不匹配');
  const version = view.getUint8(4);
  if (version !== 1) throw new Error(`ompk: 不支持的版本 ${version}`);
  const channels = view.getUint8(5);
  const samplesPerPixel = view.getUint32(6, true);
  const durationMs = view.getUint32(10, true);
  const body = new Int8Array(buf, 14);
  const perChannel = Math.floor(body.length / channels);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) {
    const arr = new Float32Array(perChannel);
    for (let i = 0; i < perChannel; i += 1) arr[i] = (body[c * perChannel + i] as number) / 127;
    out.push(arr);
  }
  return { channels: out, durationMs, samplesPerPixel };
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
}

describe('computeWavPeaks —— 真 WAV → .ompk', () => {
  it('★ 前端那份解码器解出来的 min/max 与真实样本一致（判据钉解出来的值，不钉字节）', async () => {
    /*
     * 3 个桶，每桶 4 帧，值刻意设计成"最大值和最小值都在桶的中间"，
     * 这样只取首尾或只取绝对值最大的实现都会红。
     */
    const spp = 4;
    const samples = new Int16Array([
      0,
      16384,
      -8192,
      0, // 桶 0: min=-8192 max=16384
      100,
      200,
      300,
      400, // 桶 1: min=100   max=400
      -32768,
      1,
      2,
      3, // 桶 2: min=-32768 max=3
    ]);
    const wav = await writeWav('three.wav', samples);
    const r = await computeWavPeaks(wav, spp);

    assert.equal(r.channels, 1);
    assert.equal(r.buckets, 3);
    assert.equal(r.samplesPerPixel, spp);
    assert.equal(r.durationMs, Math.round((12 / 16_000) * 1000));

    const d = decodeOmpkLikeFrontend(toArrayBuffer(r.bytes));
    assert.equal(d.channels.length, 1);
    assert.equal(d.samplesPerPixel, spp);
    const ch = d.channels[0] as Float32Array;
    assert.equal(ch.length, 6);

    const q = (v: number): number => Math.round((v / 32768) * 127) / 127;
    const want = [q(-8192), q(16384), q(100), q(400), -1, q(3)];
    for (let i = 0; i < want.length; i += 1) {
      assert.ok(
        Math.abs((ch[i] as number) - (want[i] as number)) < 1e-6,
        `第 ${i} 个值：期望 ${want[i]}，实得 ${ch[i]}`,
      );
    }
  });

  it('★ 多声道按 planar 排布（照 decodeOmpk 的索引来，不照文档里的"交错"）', async () => {
    // 立体声：左声道恒 +32767，右声道恒 −32767。交错写的话解出来会左右各半
    const frames = 8;
    const samples = new Int16Array(frames * 2);
    for (let f = 0; f < frames; f += 1) {
      samples[f * 2] = 32767;
      samples[f * 2 + 1] = -32767;
    }
    const wav = await writeWav('stereo.wav', samples, { channels: 2 });
    const r = await computeWavPeaks(wav, 4);
    assert.equal(r.channels, 2);
    assert.equal(r.buckets, 2);

    const d = decodeOmpkLikeFrontend(toArrayBuffer(r.bytes));
    const left = d.channels[0] as Float32Array;
    const right = d.channels[1] as Float32Array;
    assert.equal(left.length, 4);
    for (const v of left) assert.ok(v > 0.99, `左声道应当恒为 +1，实得 ${v}`);
    for (const v of right) assert.ok(v < -0.99, `右声道应当恒为 −1，实得 ${v}`);
  });

  it('★ 头长度声明为 0 时按文件实际大小算（录音回填失败的真实形态）', async () => {
    /*
     * `ws/recorder.ts` 的 WAV 头是"先写占位 0、停止时回填"，
     * 而回填在 `#finalizeWav()` 里被 try/catch 包着（磁盘满 / 文件被占用都会走到 catch）。
     * 照 0 去算的话结论是"这段录音没有波形" —— 一个由元数据造成、
     * 却表现成内容缺失的假象。PCM 明明一个字节都没少。
     */
    const samples = new Int16Array(64).fill(12_345);
    const wav = await writeWav('unfinalized.wav', samples, { declaredDataBytes: 0 });
    const info = await readWavPcmInfo(wav);
    assert.equal(info.dataBytes, 128, 'data 长度没有按文件实际大小兜底');
    const r = await computeWavPeaks(wav, 16);
    assert.equal(r.buckets, 4);
    const ch = decodeOmpkLikeFrontend(toArrayBuffer(r.bytes)).channels[0] as Float32Array;
    const want = Math.round((12_345 / 32768) * 127) / 127; // 48/127 ≈ 0.3780
    for (let i = 0; i < ch.length; i += 1) {
      assert.ok(
        Math.abs((ch[i] as number) - want) < 1e-6,
        `本该是一整段 12345 的波形，第 ${i} 个值实得 ${ch[i]}（期望 ${want}）`,
      );
    }
  });

  it('能跳过 ffmpeg 夹带的 LIST 块（不假设 data 在第 36 字节）', async () => {
    const samples = new Int16Array(32).fill(-20_000);
    const wav = await writeWav('withlist.wav', samples, { extraChunk: true });
    const info = await readWavPcmInfo(wav);
    assert.ok(info.dataOffset > 44, `data 偏移没被块链表推开：${info.dataOffset}`);
    assert.equal(info.dataBytes, 64);
    const r = await computeWavPeaks(wav, 8);
    assert.equal(r.buckets, 4);
  });

  it('不是 PCM16 / 不是 RIFF → 抛，不产出半份文件', async () => {
    const notRiff = join(ROOT, 'nope.bin');
    await fs.writeFile(notRiff, Buffer.from('this is not a wav at all'));
    await assert.rejects(() => computeWavPeaks(notRiff), /RIFF/);

    // 8-bit PCM：fmt 里 bits=8
    const path = join(ROOT, 'pcm8.wav');
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(8000, 12);
    fmt.writeUInt32LE(8000, 16);
    fmt.writeUInt16LE(1, 20);
    fmt.writeUInt16LE(8, 22);
    const dataHdr = Buffer.alloc(8);
    dataHdr.write('data', 0, 'ascii');
    dataHdr.writeUInt32LE(4, 4);
    const body = Buffer.concat([fmt, dataHdr, Buffer.from([1, 2, 3, 4])]);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(4 + body.length, 4);
    riff.write('WAVE', 8, 'ascii');
    await fs.writeFile(path, Buffer.concat([riff, body]));
    await assert.rejects(() => computeWavPeaks(path), /PCM16/);
  });

  it('跨 chunk 的半帧被正确拼接（长音轨不会整体错位半个采样）', async () => {
    /*
     * `createReadStream` 不保证按帧对齐。不拼接的话样本会错位一个字节，
     * 波形"有内容但形状不对"，而且不会有任何东西报错。
     * 用一段够长的、逐样本递增的音轨，只要错位一个字节，值就会整体乱掉。
     */
    const n = 200_000; // 400 KB，远超默认 64 KB 的 chunk
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i += 1) samples[i] = ((i * 37) % 30_000) - 15_000;
    const wav = await writeWav('long.wav', samples);
    const r = await computeWavPeaks(wav, DEFAULT_SAMPLES_PER_PIXEL);
    assert.equal(r.buckets, Math.ceil(n / DEFAULT_SAMPLES_PER_PIXEL));

    // 拿同一份数据在内存里算一遍参考值，逐桶比对
    const ch = decodeOmpkLikeFrontend(toArrayBuffer(r.bytes)).channels[0] as Float32Array;
    for (let b = 0; b < r.buckets; b += 1) {
      let lo = 32767;
      let hi = -32768;
      for (
        let i = b * DEFAULT_SAMPLES_PER_PIXEL;
        i < Math.min(n, (b + 1) * DEFAULT_SAMPLES_PER_PIXEL);
        i += 1
      ) {
        const v = samples[i] as number;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const q = (v: number): number => Math.round((v / 32768) * 127) / 127;
      assert.ok(Math.abs((ch[b * 2] as number) - q(lo)) < 1e-6, `桶 ${b} 的 min 对不上`);
      assert.ok(Math.abs((ch[b * 2 + 1] as number) - q(hi)) < 1e-6, `桶 ${b} 的 max 对不上`);
    }
  });

  it('头是 14 字节，magic 大端、两个 u32 小端（与解码器的读法逐位一致）', () => {
    const bytes = encodeOmpk({
      values: Int8Array.from([-1, 1]),
      channels: 1,
      samplesPerPixel: 256,
      durationMs: 1234,
    });
    assert.equal(bytes.length, OMPK_HEADER_BYTES + 2);
    assert.equal(bytes.toString('ascii', 0, 4), 'OMPK');
    assert.equal(bytes.readUInt32BE(0), 0x4f4d504b);
    assert.equal(bytes.readUInt8(4), 1);
    assert.equal(bytes.readUInt8(5), 1);
    assert.equal(bytes.readUInt32LE(6), 256);
    assert.equal(bytes.readUInt32LE(10), 1234);
  });

  it('★ 护栏：web 的 decodeOmpk 仍然是 planar 索引（改了这里就得改生成器）', async () => {
    const src = await fs.readFile(
      new URL('../../../../apps/web/src/lib/format/peaks.ts', import.meta.url),
      'utf8',
    );
    /*
     * **先剥注释再匹配** —— 这个文件的注释里就写着"各声道交错存放"，
     * 直接 grep 关键词会命中注释，得出与代码相反的结论（本仓今天已踩过六次）。
     */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(
      /body\s*\[\s*c\s*\*\s*perChannel\s*\+\s*i\s*\]/.test(code),
      '前端解码器的声道索引变了（不再是 planar 的 body[c*perChannel+i]）——\n' +
        '生成器仍在按 planar 写，两边已经不一致：波形会解得开但声道错位，界面上看不出来。',
    );
  });
});
