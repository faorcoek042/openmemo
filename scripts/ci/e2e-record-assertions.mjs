/**
 * F3（录音 → 转写 → 时间轴）端到端断言 —— **纯函数，与网络无关**。
 *
 * ## 为什么把断言从驱动脚本里抽出来
 *
 * 本仓刚刚栽过两次，两次都不是"忘了写断言"：
 *   ① 断言的字段**在夹具里恒为假** —— 于是它永远通过，看起来像一条护栏；
 *   ② 断言的是"**报出来的**预算"而不是"**实际用的**预算" —— 它盯着一个复述，
 *      而复述与事实之间没有任何东西把它们钉在一起。
 *
 * 这两种坏断言的共同点是：**没有人给它们喂过一份"本该让它变红"的输入。**
 * 一条从来没红过的断言，与一行注释没有区别。
 *
 * 所以这个文件里的每个函数都满足三条：
 *   1. **纯**：只吃数据、只回 `{ ok, reason }`，不发请求、不读盘、不看时钟；
 *   2. **可被喂坏数据**：`selftest-e2e-record.mjs` 对每一条都准备了 N 个变异体，
 *      要求**每个变异体都被拒**，并且**原始（真实形状的）输入被接受**
 *      —— 后半句同样是断言：只拒不收的函数（恒假）和只收不拒的函数（恒真）
 *      在门禁上的价值完全相同，都是零；
 *   3. **前提自检**：几条最关键的断言会先检查"这份输入本身有没有信息量"
 *      （典型：全静音的音频算出来的波形恒为 0，与"波形是编的"无法区分）。
 *      前提不成立时**报红**，而不是安静通过。
 *
 * 判据不是"我写了断言"，是"**这条断言在事实为假时真的会红**"。
 */

/* ────────────────────────── 通用小工具 ────────────────────────── */

/** 统一的返回形态。`ok:false` 必须带上**能定位**的理由，不要只说"不匹配"。 */
const no = (reason) => ({ ok: false, reason });
const yes = (reason = '') => ({ ok: true, reason });

/* ────────────────────────── `.ompk` 波形 ────────────────────────── */

/**
 * `.ompk` 解码 —— **逐位照抄 `apps/web/src/lib/format/peaks.ts` 的 `decodeOmpk`**。
 *
 * 抄而不是 import：这个脚本要在**预编译包**上跑，而包里装的是编译后的网页产物，
 * 没有可 import 的源码。更要紧的是——如果这里 import 了产品的解码器，
 * 那么"编码器和解码器同时错成一对"的情形就检不出来了：
 * 两边用同一份错的实现，round-trip 永远成立。
 *
 * ⚠️ magic 是**大端**，后面两个 u32 是**小端**，数据是 **planar**（不是交错）。
 * 这三条都不是笔误，是解码器真实的读法（D-02 §3.4 的文字与实现不一致，以实现为准）。
 */
export function decodeOmpk(buf) {
  if (!buf || buf.length < 14)
    return { ok: false, reason: `.ompk 短于 14 字节头（${buf?.length}）` };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const magic = view.getUint32(0, false);
  if (magic !== 0x4f4d504b) {
    return { ok: false, reason: `magic 不是 "OMPK"（0x${magic.toString(16)}）` };
  }
  const version = view.getUint8(4);
  const channels = view.getUint8(5);
  const samplesPerPixel = view.getUint32(6, true);
  const durationMs = view.getUint32(10, true);
  if (version !== 1) return { ok: false, reason: `version=${version}，只认 1` };
  if (channels < 1 || channels > 8) return { ok: false, reason: `channels=${channels} 不合理` };
  if (samplesPerPixel < 1)
    return { ok: false, reason: `samplesPerPixel=${samplesPerPixel} 不合理` };

  const body = new Int8Array(buf.buffer, buf.byteOffset + 14, buf.length - 14);
  if (body.length % (channels * 2) !== 0) {
    return {
      ok: false,
      reason: `数据长度 ${body.length} 不是 channels(${channels})×2 的整数倍`,
    };
  }
  return {
    ok: true,
    version,
    channels,
    samplesPerPixel,
    durationMs,
    /** planar：声道 c 的 2×buckets 个值连续排列。 */
    values: body,
    buckets: body.length / (channels * 2),
  };
}

/** int16 → Int8（−127…127）。与 `apps/daemon/src/media/peaks.ts` 的 `quantize` 严格一致。 */
function quantize(v) {
  const q = Math.round((v / 32768) * 127);
  return q > 127 ? 127 : q < -127 ? -127 : q;
}

/**
 * 从**我们自己送上去的那份 PCM** 独立算一遍峰值。
 *
 * 这是整个"波形是不是编的"判据的支点：驱动脚本手里有它推给 `/ws/recorder` 的
 * 每一个字节，于是"服务端算出来的波形"有了一个**不经过服务端**的参照物。
 * 不是"看起来像波形"，是**逐桶逐值相等**。
 *
 * @param pcm  Buffer/Uint8Array，PCM16LE 单声道（就是 WS 上行的那些字节拼起来）
 * @param samplesPerPixel  与产品默认一致：256
 */
export function computeExpectedPeaks(pcm, samplesPerPixel = 256) {
  const totalFrames = Math.floor(pcm.length / 2);
  const buckets = Math.max(1, Math.ceil(totalFrames / samplesPerPixel));
  const values = new Int8Array(buckets * 2);
  let curMin = 32767;
  let curMax = -32768;
  let inBucket = 0;
  let bucket = 0;
  let sawAny = false;
  const flush = () => {
    if (bucket >= buckets) return;
    values[bucket * 2] = sawAny ? quantize(curMin) : 0;
    values[bucket * 2 + 1] = sawAny ? quantize(curMax) : 0;
    curMin = 32767;
    curMax = -32768;
    bucket += 1;
    inBucket = 0;
    sawAny = false;
  };
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  for (let i = 0; i < totalFrames; i += 1) {
    const s = dv.getInt16(i * 2, true);
    if (s < curMin) curMin = s;
    if (s > curMax) curMax = s;
    sawAny = true;
    inBucket += 1;
    if (inBucket === samplesPerPixel) flush();
  }
  if (inBucket > 0) flush();
  return { values, buckets, samplesPerPixel, totalFrames };
}

/**
 * **波形是不是真的从音频算出来的。**
 *
 * 本仓的原始事故是：写入方从来不存在，前端 `mockPeaks()` **凭空造一条正弦波**，
 * 界面上一个字都不说 ——「每位用户看到的每一条波形都是编出来的」。
 * 所以这条断言的判据只能是**逐桶相等**，不能是"有数据"、"长度对"、"看起来非零"，
 * 那三条正弦波全都满足。
 *
 * ### 前提自检（这一段和断言本身一样重要）
 *
 * 如果送上去的是**静音**，真波形与假波形都是一片 0，逐桶相等会**恒真**。
 * 那正是"夹具里字段恒为假"那类事故的镜像。所以先要求这份音频本身有动态范围：
 *   · 至少有一个桶的振幅接近满量程（说明真有声音）
 *   · 至少有一小部分桶接近静音（说明不是一条恒定包络 —— 正弦/白噪都过不了这条）
 */
export function checkPeaksAreRealAudio({
  ompk,
  pcm,
  samplesPerPixel = 256,
  durationToleranceMs = 2,
}) {
  const dec = decodeOmpk(ompk);
  if (!dec.ok) return no(`.ompk 解不开：${dec.reason}`);
  if (dec.channels !== 1) return no(`录音必然是单声道，实际 channels=${dec.channels}`);
  if (dec.samplesPerPixel !== samplesPerPixel) {
    return no(`samplesPerPixel=${dec.samplesPerPixel}，期望 ${samplesPerPixel}`);
  }

  const exp = computeExpectedPeaks(pcm, samplesPerPixel);

  /* ── 前提自检：这份音频本身要有信息量，否则下面的相等是恒真 ── */
  let loud = 0;
  let quiet = 0;
  let peakAbs = 0;
  for (let b = 0; b < exp.buckets; b += 1) {
    const amp = Math.max(Math.abs(exp.values[b * 2]), Math.abs(exp.values[b * 2 + 1]));
    if (amp > peakAbs) peakAbs = amp;
    if (amp >= 40) loud += 1;
    if (amp <= 4) quiet += 1;
  }
  if (peakAbs < 40) {
    return no(
      `前提不成立：送进去的音频最大振幅只有 ${peakAbs}/127 —— ` +
        `这么弱的信号上"波形相等"接近恒真，证明不了波形是真的`,
    );
  }
  if (loud === 0 || quiet === 0) {
    return no(
      `前提不成立：${exp.buckets} 个桶里响的 ${loud} 个、静的 ${quiet} 个 —— ` +
        `需要两者都有（恒定包络的假波形也能通过"逐桶相等"之外的所有弱判据）`,
    );
  }

  /* ── 判据本体：逐桶逐值相等 ── */
  if (dec.buckets !== exp.buckets) {
    return no(`桶数不符：产品 ${dec.buckets}，独立算出 ${exp.buckets}`);
  }
  for (let i = 0; i < exp.values.length; i += 1) {
    if (dec.values[i] !== exp.values[i]) {
      const b = Math.floor(i / 2);
      return no(
        `第 ${b} 桶的${i % 2 === 0 ? 'min' : 'max'}对不上：` +
          `产品 ${dec.values[i]}，独立算出 ${exp.values[i]}` +
          `（共 ${exp.buckets} 桶，峰值 ${peakAbs}/127）`,
      );
    }
  }

  /* durationMs 也要对得上 —— 它是播放器换算时间轴的依据。 */
  const expDurationMs = Math.round((exp.totalFrames / 16000) * 1000);
  if (Math.abs(dec.durationMs - expDurationMs) > durationToleranceMs) {
    return no(`durationMs=${dec.durationMs}，按送进去的采样数应当是 ${expDurationMs}`);
  }

  return yes(
    `${exp.buckets} 桶 × 2 值逐个相等；峰值 ${peakAbs}/127，响 ${loud} 桶 / 静 ${quiet} 桶；` +
      `durationMs=${dec.durationMs}`,
  );
}

/* ────────────────────────── 词级时间戳 ────────────────────────── */

/**
 * **词级时间戳真的在，而且是有意义的。**
 *
 * `parseWordsJson` 的约定是"解析不出来一律 null"，所以 `words` 为 null
 * 与"这个引擎没有词级时间戳"长得一模一样 —— 只断言"字段存在"抓不到任何东西。
 * 这里要的是：至少一段有非空 `words`，且每个词的 `[s,e]` 落在所属段的
 * `[startMs,endMs]` 里、时间不倒流、文字非空。
 *
 * `minSegmentsWithWords` 默认 1：tiny 模型在静音段上给不出词是正常的，
 * 判据是"这条链路会产出词级时间戳"，不是"每段都有"。
 */
export function checkWordTimestamps(
  segments,
  { minSegmentsWithWords = 1, toleranceMs = 250 } = {},
) {
  if (!Array.isArray(segments)) return no(`segments 不是数组（${typeof segments}）`);
  if (segments.length === 0) return no('一段都没有 —— 词级时间戳无从谈起');

  let withWords = 0;
  let totalWords = 0;
  for (const seg of segments) {
    const words = seg?.words;
    if (words === null || words === undefined) continue;
    if (!Array.isArray(words)) return no(`seq=${seg.seq} 的 words 不是数组（${typeof words}）`);
    if (words.length === 0) continue;

    let prev = -Infinity;
    for (const w of words) {
      const text = typeof w?.w === 'string' ? w.w : null;
      if (text === null || text.trim().length === 0) {
        return no(`seq=${seg.seq} 有一个词的 w 为空/不是字符串：${JSON.stringify(w)}`);
      }
      if (typeof w.s !== 'number' || typeof w.e !== 'number') {
        return no(`seq=${seg.seq} 的词「${text}」缺 s/e 数值：${JSON.stringify(w)}`);
      }
      if (w.e < w.s) return no(`seq=${seg.seq} 的词「${text}」结束早于开始（${w.s}→${w.e}）`);
      if (w.s < prev) {
        return no(`seq=${seg.seq} 的词「${text}」时间倒流（上一个词起点 ${prev}，它是 ${w.s}）`);
      }
      prev = w.s;
      if (typeof seg.startMs === 'number' && w.s < seg.startMs - toleranceMs) {
        return no(`seq=${seg.seq} 的词「${text}」起点 ${w.s} 落在段外（段起 ${seg.startMs}）`);
      }
      if (typeof seg.endMs === 'number' && w.e > seg.endMs + toleranceMs) {
        return no(`seq=${seg.seq} 的词「${text}」终点 ${w.e} 落在段外（段止 ${seg.endMs}）`);
      }
      totalWords += 1;
    }
    withWords += 1;
  }

  if (withWords < minSegmentsWithWords) {
    return no(
      `${segments.length} 段里只有 ${withWords} 段带词级时间戳，要求至少 ${minSegmentsWithWords} 段` +
        `（words 恒为 null 正是"重转之后被抹掉"的形态，T-164 ④）`,
    );
  }
  return yes(`${withWords}/${segments.length} 段带词级时间戳，共 ${totalWords} 个词`);
}

/**
 * **换模型重转之后，词级时间戳还在吗。**
 *
 * 两条缺一不可：
 *   ① 模型**真的换了** —— 判据是转写稿自报的 `modelId` 变了，
 *      而不是"我在请求里写了另一个 modelId"。
 *      `transcribe.ts:154-157` 在指定模型未安装时会**打一行 warn 然后回退到自动选择**，
 *      于是"请求里写了什么"与"实际用了什么"可以完全无关 ——
 *      本仓刚栽过的第二种坏断言（盯复述而不盯事实）就是这个形状。
 *   ② 词级时间戳在重转之后仍然在（T-164 ④ 的回归护栏）。
 */
export function checkRetranscribeKeptWords({ before, after }) {
  const bId = before?.transcript?.modelId ?? null;
  const aId = after?.transcript?.modelId ?? null;
  if (aId === null) return no('重转之后的转写稿没有 modelId —— 无法判断用的是哪个模型');
  if (bId === aId) {
    return no(
      `模型没换成：重转前后 modelId 都是 ${aId}。` +
        `（指定的模型没装上时 transcribe.ts 会静默回退，所以这里必须盯稿子自报的值）`,
    );
  }
  const beforeWords = checkWordTimestamps(before?.segments ?? []);
  if (!beforeWords.ok) {
    return no(
      `前提不成立：**重转之前**就没有词级时间戳（${beforeWords.reason}）—— 这一轮证明不了"没丢"`,
    );
  }
  const afterWords = checkWordTimestamps(after?.segments ?? []);
  if (!afterWords.ok) return no(`重转之后词级时间戳没了：${afterWords.reason}`);
  return yes(`模型 ${bId} → ${aId}；重转前 ${beforeWords.reason}；重转后 ${afterWords.reason}`);
}

/* ────────────────────────── VAD 切分 ────────────────────────── */

/**
 * `pipeline.vad.reason` 那一格**说没说出成因** —— 判据是**结构**，不是那句话长什么样。
 *
 * ## ⚠️ 为什么不读 `reasonZh`（#106）
 *
 * 上一版读的是 `String(vad.reasonZh ?? '')` 非不非空。那一格已经从契约里删掉了：
 * 它是 daemon 拼的**整句中文**，被诊断页原样渲染 ⇒ 英文界面上那一行必然是中文。
 * 现在 daemon 交出的是 `VadChunkingReason`（机器可读，见
 * `packages/shared/src/api.ts`），措辞归 `apps/web` 的两份 locale。
 *
 * **改成读 `reasonEn` 是错的修法**：那只是把"读中文散文"换成"读英文散文"，
 * 下次措辞一动它照样漂 —— 而本仓在拿散文当判据上已经栽过两次
 * （`unavailableReason` 那两条）。**读结构才是收法。**
 */
function vadReasonKind(vad) {
  const k = vad?.reason?.kind;
  return typeof k === 'string' && k.length > 0 ? k : null;
}

/**
 * **没装 VAD 时是"明确降级"，不是"静默出错"。**
 *
 * 三档要分清（`apps/daemon/src/pipeline/vadStatus.ts`）：
 *   · `chunking:'vad'`                          → 装上了，按静音切
 *   · `chunking:'fixed'` + `rejected` 为空      → **合法降级**：没装，退固定窗口，转写照跑
 *   · `chunking:'fixed'` + `rejected` 非空      → **事故**：装了一份 whisper.cpp 加载不了的权重
 *
 * "明确"的判据不是"有个字段"，是：**成因说得出来**（`reason.kind` 在，且它没有
 * 反过来说"没降级"），且**转写仍然产出了文本**（降级 ≠ 失败）。
 * 只断言 `chunking==='fixed'` 抓不到"它退了但整单也死了"这种情形，
 * 而那恰恰是 T-148 的现场。
 */
export function checkVadDegradedExplicitly({ vad, segments }) {
  if (!vad) return no('/api/health 里没有 pipeline.vad —— 切分方式无从判断');
  if (vad.chunking !== 'fixed') return no(`期望降级到固定窗口，实际 chunking=${vad.chunking}`);
  const kind = vadReasonKind(vad);
  if (kind === null) {
    return no(
      '降级了但 pipeline.vad.reason 这一格是空的 —— 这就是"静默降级"，用户看不到发生了什么',
    );
  }
  /*
   * ★★ **同一格自相矛盾比没有这一格更坏。**
   * `chunking:'fixed'` 说"退到固定窗口了"，而 `reason.kind:'vad_active'` 说"按静音切分"——
   * 诊断页读的就是后者，于是屏幕上会写着「VAD 可用：按静音切分」，而每一次转写都在降级。
   * 那正是 T-148 要消灭的假绿灯，只是换了一格来发作。
   */
  if (kind === 'vad_active') {
    return no(
      'chunking=fixed 却报 reason.kind=vad_active —— 同一格自相矛盾，诊断页会显示一盏假绿灯',
    );
  }
  if ((vad.rejected ?? []).length > 0) {
    return no(
      `装上的 VAD 权重 whisper.cpp 加载不了：${vad.rejected.join('、')}（这是事故不是降级）`,
    );
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return no('降级之后一段都没转出来 —— 那不是降级，是失败');
  }
  const text = segments
    .map((s) => String(s.text ?? ''))
    .join(' ')
    .trim();
  if (text.length < 20) {
    return no(`降级之后只转出 ${text.length} 个字符 —— 判据是"仍然可用"，不是"没报错"`);
  }
  return yes(`chunking=fixed，成因 ${kind}，仍转出 ${segments.length} 段 / ${text.length} 字符`);
}

/** 装了 VAD 之后必须真的用上它 —— 且要报出用的是哪份权重。 */
export function checkVadActive(vad) {
  if (!vad) return no('/api/health 里没有 pipeline.vad');
  if (vad.chunking !== 'vad') {
    return no(
      `装了 ggml VAD，chunking 却是 ${vad.chunking}（成因 ${vadReasonKind(vad) ?? '(空)'}）`,
    );
  }
  if (!vad.model || String(vad.model).trim().length === 0) {
    return no('chunking=vad 却说不出用的是哪份权重 —— "报告说好了"不等于"真的好了"');
  }
  /*
   * ★ 反方向的同一条（#106）：`chunking:'vad'` 而 `reason.kind` 说的是别的成因
   * （典型 `no_vad_model_installed`），两格在讲两件事。这里读**结构**，
   * 所以它不会随文案漂 —— 上一版这一格只把 `reasonZh` 拿去拼错误信息，
   * 一个字都没判过。
   */
  const kind = vadReasonKind(vad);
  if (kind !== null && kind !== 'vad_active') {
    return no(`chunking=vad 却报 reason.kind=${kind} —— 两格在说两件事，界面读哪一格都可能说假话`);
  }
  return yes(`chunking=vad，权重 ${vad.model}，成因 ${kind ?? '(未报)'}`);
}

/* ────────────────────────── 时间轴 ────────────────────────── */

/**
 * **转写稿片段 ↔ 音频位置**：服务端交出来的数据支不支持双向定位。
 *
 * 双向各自的判据：
 *   · 片段 → 音频：每段的 `[startMs,endMs]` 必须落在音频时长内、且 start < end。
 *     越界的段在播放器上表现为"点了跳到结尾/跳不动"。
 *   · 音频 → 片段：任取一个时间点，**恰好**能定位到一段。所以段必须有序且互不重叠
 *     —— 重叠时"当前是哪一段"没有唯一答案，高亮会在两段之间跳。
 */
export function checkTimelineSegments({ segments, audioDurationMs, probeCount = 16 }) {
  if (!Array.isArray(segments) || segments.length === 0) return no('没有段落，时间轴无从谈起');
  if (!(audioDurationMs > 0)) return no(`音频时长不可用（${audioDurationMs}）`);

  let prevEnd = -1;
  for (const s of segments) {
    if (typeof s.startMs !== 'number' || typeof s.endMs !== 'number') {
      return no(`seq=${s.seq} 的 startMs/endMs 不是数值`);
    }
    if (s.startMs < 0) return no(`seq=${s.seq} 起点为负（${s.startMs}）`);
    if (s.endMs <= s.startMs)
      return no(`seq=${s.seq} 的 endMs<=startMs（${s.startMs}→${s.endMs}）`);
    if (s.startMs > audioDurationMs) {
      return no(`seq=${s.seq} 起点 ${s.startMs} 超出音频时长 ${audioDurationMs}`);
    }
    if (s.startMs < prevEnd) {
      return no(
        `seq=${s.seq} 与上一段重叠（上一段止于 ${prevEnd}，它起于 ${s.startMs}）—— 定位不唯一`,
      );
    }
    prevEnd = s.endMs;
  }

  /* 音频 → 片段：在整条时间轴上撒点，命中的段必须唯一。 */
  let hit = 0;
  for (let i = 0; i < probeCount; i += 1) {
    const t = Math.floor((audioDurationMs * i) / probeCount);
    const covering = segments.filter((s) => t >= s.startMs && t < s.endMs);
    if (covering.length > 1) {
      return no(`时间点 ${t}ms 同时落在 ${covering.length} 段里 —— 不唯一`);
    }
    if (covering.length === 1) hit += 1;
  }
  if (hit === 0) {
    return no(`撒了 ${probeCount} 个时间点，一个都没落进任何段里 —— 段落与音频不在同一条时间轴上`);
  }
  return yes(`${segments.length} 段有序不重叠；${probeCount} 个探测点命中 ${hit} 个`);
}

/**
 * **搜索结果能跳到时间点**（前端把它拼成 `/notes/<uid>?t=<startMs>`）。
 *
 * 服务端这一侧要成立的事：命中里带 `noteUid` 与**非 null 的 `startMs`**，
 * 且那个 `startMs` **真的是某一段的起点** —— 不是随便一个数。
 * 只断言 "startMs 不是 null" 是抓不到"它恒等于 0"这种形态的，
 * 而 `?t=0` 与"没有深链"在用户那里是同一件事。
 */
export function checkSearchSeek({ hits, noteUid, segments, needle }) {
  if (!Array.isArray(hits)) return no(`hits 不是数组（${typeof hits}）`);
  const mine = hits.filter((h) => h.noteUid === noteUid);
  if (mine.length === 0) {
    return no(`搜「${needle}」没有命中这条笔记（共 ${hits.length} 条命中，都是别的笔记）`);
  }
  const seekable = mine.filter((h) => typeof h.startMs === 'number');
  if (seekable.length === 0) {
    return no(
      `命中了 ${mine.length} 条，但没有一条带 startMs —— 前端拼不出 ?t=，点了只能从 0:00 开始`,
    );
  }
  const starts = new Set(segments.map((s) => s.startMs));
  const anchored = seekable.filter((h) => starts.has(h.startMs));
  if (anchored.length === 0) {
    return no(
      `命中带的 startMs（${seekable.map((h) => h.startMs).join(',')}）都不是任何一段的起点 —— ` +
        `?t= 会跳到一个没有内容的位置`,
    );
  }
  const nonZero = anchored.some((h) => h.startMs > 0);
  return yes(
    `${anchored.length} 条命中的 startMs 落在真实段落起点上` +
      `（${anchored.map((h) => h.startMs).join(',')}${nonZero ? '' : '；全为 0，见下'}）`,
  );
}

/* ────────────────────────── 资产 / Range ────────────────────────── */

/**
 * **落盘成了可播放的资产。**
 *
 * "可播放"在 HTTP 这一层的具体含义就是三件事：拿得到全量、支持 Range（播放器拖进度条
 * 靠它）、字节与我们送上去的一模一样。第三条是关键 —— 只验前两条的话，
 * 一个 44 字节的空 WAV 头也能全绿（T-164 ② 那条"0 秒、打不开、状态却是就绪"的死笔记
 * 正是这个形态）。
 */
export function checkAudioAsset({ detail, sentPcmBytes }) {
  const assets = detail?.assets ?? [];
  const original = assets.find((a) => a.role === 'original');
  if (!original)
    return no(
      `笔记上没有 role='original' 的资产（有的是：${assets.map((a) => a.role).join(',') || '(空)'}）`,
    );
  if (original.state !== 'ready') return no(`原始音频资产 state=${original.state}，不是 ready`);
  if (!/^audio\//.test(String(original.mime ?? ''))) {
    return no(`原始音频资产 mime=${original.mime}，不像音频`);
  }
  const expectBytes = sentPcmBytes + 44;
  if (original.bytes !== expectBytes) {
    return no(
      `资产字节数 ${original.bytes}，按送上去的 ${sentPcmBytes} 字节 PCM + 44 字节 WAV 头应当是 ${expectBytes}` +
        `（对不上说明中途丢帧，或者 WAV 头没回填）`,
    );
  }
  if (!original.url || !/^\/media\/asset\/[0-9A-HJKMNP-TV-Z]{26}$/.test(original.url)) {
    return no(`资产 url 不是 /media/asset/<ulid> 形态：${original.url}`);
  }
  return yes(
    `role=original state=ready mime=${original.mime} bytes=${original.bytes} url=${original.url}`,
  );
}

/**
 * **Range 请求真的按字节偏移取到了那一段音频。**
 *
 * 这是"转写稿片段 → 音频位置"在协议层的落点：段落的 `startMs` 换算成字节偏移
 * （`44 + ms × 16000 × 2 / 1000`），播放器就是这么拖进度条的。
 * 判据是**取回来的字节与我们送上去的那一段逐字节相等**，
 * 不是"回了 206"——206 加一段错位的音频，正是"能播但对不上口型"的成因。
 */
export function checkRangeSlice({ status, headers, body, expected, start, end, totalBytes }) {
  if (status !== 206) return no(`Range 请求回了 HTTP ${status}，期望 206`);
  const cr = String(headers?.['content-range'] ?? '');
  const want = `bytes ${start}-${end}/${totalBytes}`;
  if (cr !== want) return no(`Content-Range 是「${cr}」，期望「${want}」`);
  if (body.length !== expected.length) {
    return no(`Range 取回 ${body.length} 字节，期望 ${expected.length}`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (body[i] !== expected[i]) {
      return no(`Range 取回的第 ${i} 个字节是 ${body[i]}，期望 ${expected[i]} —— 音频与时间轴错位`);
    }
  }
  return yes(`bytes ${start}-${end}/${totalBytes}，${expected.length} 字节逐字节相等`);
}

/* ────────────────────────── 借宿主工具 ────────────────────────── */

/**
 * **一个都不许借。**
 *
 * 两条独立的证据，都要过：
 *   ① 产品自己的自检里，没有任何 `tool.*` 落在"来自系统 PATH"那一档
 *      （判据抄 `packages/runtime/src/selfcheck.ts`，不另发明）；
 *   ② daemon 的输出里**没有出现 shim 的标记** —— 屏蔽层放的是同名假二进制，
 *      产品真去借的话会执行到它，标记就会出现在日志里。
 *
 * 为什么要两条：① 只覆盖自检认识的那些名字，② 覆盖**任何**被调用到的名字。
 * 只有 ① 的话，一个自检没登记的工具被借走了也不会有人知道。
 */
export function checkNoBorrowedTools({ checks, shimHits }) {
  const tools = (checks ?? []).filter((c) => String(c.id).startsWith('tool.'));
  const borrowed = tools.filter((c) => c.status === 'warn' && /PATH/i.test(String(c.detail ?? '')));
  const hits = shimHits ?? [];
  if (borrowed.length > 0 || hits.length > 0) {
    const a = borrowed.length > 0 ? `自检说借了：${borrowed.map((c) => c.id).join(', ')}` : '';
    const b = hits.length > 0 ? `shim 被执行到：${[...new Set(hits)].join(', ')}` : '';
    return no([a, b].filter(Boolean).join('；'));
  }
  if (tools.length === 0 && hits.length === 0) {
    /*
     * 前提自检：自检里一个 tool.* 都没有时，"没有人借"是**恒真**的 ——
     * 与"确实没借"读起来一样，但证明力为零。本仓已经在别处栽过同一形状四次。
     */
    return no('自检报告里一个 tool.* 都没有 —— "没借"在这种输入上恒真，先怀疑报告取错了');
  }
  const own = tools.filter((c) => c.status === 'ok');
  return yes(
    `${tools.length} 个 tool.* 里 ${own.length} 个是产品自己装的，0 个借宿主；shim 零命中`,
  );
}

/* ────────────────────────── 录音会话协议 ────────────────────────── */

/**
 * **录音会话真的按契约跑完了一遍**（D-06 §15.1）。
 *
 * `ready` → (`partial`* / `final`*) → `stopped`。
 * 关键是 `ready` 里的 `sampleRate` 必须等于我们推流用的采样率 ——
 * 不一致会让识别结果整体错位，而且**双方都不会报错**。
 */
export function checkRecorderSession({ messages, sampleRate = 16000 }) {
  const ready = messages.find((m) => m.type === 'ready');
  if (!ready) {
    const err = messages.find((m) => m.type === 'error');
    return no(err ? `没等到 ready，服务端回的是 ${err.code}：${err.messageZh}` : '没等到 ready');
  }
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(String(ready.noteUid ?? ''))) {
    return no(`ready.noteUid 不是 ULID：${ready.noteUid}`);
  }
  if (ready.sampleRate !== sampleRate) {
    return no(`ready.sampleRate=${ready.sampleRate}，我们按 ${sampleRate} 推流 —— 会整体错位`);
  }
  const stopped = messages.find((m) => m.type === 'stopped');
  if (!stopped) return no('没等到 stopped —— 收尾链（落盘/资产/波形/重跑）不知道走没走完');
  const overruns = messages.filter((m) => m.type === 'overrun');
  if (overruns.length > 0) {
    return no(
      `发生了 ${overruns.length} 次 overrun 丢帧 —— 服务端拿到的字节与我们送的不同，后面的逐字节比对会失去意义`,
    );
  }
  const errors = messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    return no(`会话中出现 ${errors.length} 条 error：${errors.map((e) => e.code).join(',')}`);
  }
  return yes(
    `ready(note=${ready.noteUid}, sr=${ready.sampleRate}) → ` +
      `partial×${messages.filter((m) => m.type === 'partial').length} / ` +
      `final×${messages.filter((m) => m.type === 'final').length} → ` +
      `stopped(segmentCount=${stopped.segmentCount}, rerunJobUid=${stopped.rerunJobUid ?? 'null'})`,
  );
}
