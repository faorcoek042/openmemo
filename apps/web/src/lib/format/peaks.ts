/**
 * 波形峰值：`.ompk` → 归一化到 −1..1 的每声道数组（D-05 §7.3a）。
 *
 * 为什么要预计算：浏览器 `decodeAudioData` 一个 2 小时的文件会占数百 MB 内存
 * 并阻塞主线程（D-01 §5 F5）。所以峰值由 daemon 用 ffmpeg 预生成，前端只解析二进制。
 *
 * `.ompk` 格式（D-02 §3.4）：
 *   [magic "OMPK"(4B)][version u8][channels u8][samplesPerPixel u32][durationMs u32]
 *   [数据: Int8 × N × 2 (min,max) × channels]
 *
 * `v / 127` 这层归一化最初是照 **wavesurfer v7 的 `peaks` 选项**做的。
 *
 * ─── ★ T-150 的裁决：**不接 wavesurfer，那个依赖该删** ─────────────────────────
 *
 * 现状：`wavesurfer.js` 在 `apps/web/package.json` 里挂了很久，**全仓零 import**，
 * 而 `features/player/Waveform.tsx` 已经用 112 行 canvas 直接把这份峰值画出来了
 * （T-151 之后 `.ompk` 真的有数据了，`NoteDetailPage` 是 `decodeOmpk` 的第一个调用方）。
 *
 * 判据不是"哪个更好看"，是**它能替我们做的那件事，我们刚好不要**：
 *
 * 1. wavesurfer 的核心价值是"在浏览器里解码音频 + 画 + 交互"。**解码那一半我们
 *    明确不做**（上面第二段就是理由），所以接进来也只用得上它的绘制层。
 * 2. 绘制层这边我们有两条它给不了的性质：**完全不进 React**（播放位置以 ~10Hz 变化，
 *    走 React 会拖垮整页）与**直接读 CSS 变量**（明暗主题切换零 JS 参与）。
 *    换成 wavesurfer 这两条都得自己再补一遍。
 * 3. 留着一个零 import 的依赖，最贵的不是 1.5 MB 和许可证清单里那一行，
 *    而是**它让读代码的人以为波形是它画的** —— 与本轮修的那几处过期注释同一种成本。
 *
 * → **结论：从 `apps/web/package.json` 删掉 `wavesurfer.js`。**
 *   `.ompk` 格式本身**不绑任何库**，删掉它这个文件一个字节都不用改。
 *
 * ✅ **T-153 已执行**：`pnpm --filter @openmemo/web remove wavesurfer.js`
 *   （`apps/web/package.json` −1 行、`pnpm-lock.yaml` −8 行）。上面这段判决**保留原文**，
 *   因为它记录的是"为什么不接"，而不是"待办" —— 下一个想引入波形库的人应该先读它。
 *   护栏：`peaks.test.ts` 断言 `apps/web/package.json` 的依赖里不许再出现 `wavesurfer`
 *   （零 import 的依赖不会被 tsc / eslint / 任何测试发现，只能直接钉清单）。
 */

export interface DecodedPeaks {
  /** 每声道一个数组，值域 −1..1。`Waveform.tsx` 的 canvas 直接按这个值域画。 */
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
