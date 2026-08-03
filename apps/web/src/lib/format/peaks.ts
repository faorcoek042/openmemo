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

/*
 * ⚠️ 这里原本有一个 `mockPeaks(durationMs, buckets)`：在没有真 `.ompk` 时
 * 用正弦函数生成一条"占位波形"。**已删除，而不是留着不用。**
 *
 * 它的注释写着"调用处必须把它标成 mock，不许假装是真数据（诚实规则）"——
 * 而唯一的调用处（`NoteDetailPage`）**从来没有标注过**，并且逻辑是反的：
 * 有真 peaks 资产时反而 `setPeaks(null)`，没有时才造一份。
 * 又因为 daemon 全仓零处产出 peaks 资产，**每一位用户看到的每一条波形都是编的**，
 * 界面上一个字都不说（T-139 A3）。
 *
 * 为什么是删掉而不是"加上标注"：**一条编出来的波形不是占位符，它是一个断言** ——
 * 用户会据此判断哪里是安静段、哪里该拖过去。加个小字标注并不能收回这个断言。
 * 判据（architect 立、已在项目内生效）：
 * **用户看到的每一个具体东西，要么来自后端，要么根本不提。**
 * 没有峰值时 `Waveform` 会画一条基线 + 可点击定位的游标 —— 那才是"我不知道这段长什么样"
 * 的如实表达，而且定位功能一点不少。
 *
 * 留着函数不删同样不行：下一个人看到 `mockPeaks` 就会以为"没有数据时可以先用它顶上"，
 * 于是这个 bug 会以另一种形式回来（本项目已有先例：`MINDMAP_SAVE_SUPPORTED`
 * 就是被整个删掉而不是改成 true）。
 */
