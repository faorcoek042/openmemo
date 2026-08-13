#!/usr/bin/env node
/**
 * `e2e-record-assertions.mjs` 的**变异证明** —— 本机能跑，不需要 GitHub、不需要包。
 *
 * ## 它回答的问题只有一个
 *
 * > 「这条断言在事实为假的时候，**真的会红吗**？」
 *
 * 本仓最近两次事故都不是"忘了写断言"：
 *   · 一次断言的字段**在夹具里恒为假** —— 它永远通过；
 *   · 一次断言的是"**报出来的**预算"而不是"**实际用的**预算" —— 它盯着复述。
 * 两次都是绿的，两次都什么也没保证。
 *
 * 所以每条断言在这里都要过**三关**：
 *   ① **真形状的输入必须通过**（挡住"恒假"的断言 —— 那种断言在门禁上等于没有）；
 *   ② **每一个变异体必须被拒**（挡住"恒真"的断言）；
 *   ③ **变异体不能是空集** —— 没有变异体的断言视同没有证明，直接红。
 *
 * 还有一条 meta 断言：`e2e-record-assertions.mjs` 导出的**每一个** `check*` 函数
 * 都必须在这里出现。加了新断言却忘了写变异证明时当场红，而不是等它某天悄悄恒真。
 *
 * 用法：`node scripts/ci/selftest-e2e-record.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { strict as assert } from 'node:assert';

import * as A from './e2e-record-assertions.mjs';

let cases = 0;
let failures = 0;
const covered = new Set();

const say = (s = '') => console.log(s);

/**
 * 一条断言的完整证明：真输入过、每个变异体红。
 *
 * @param name      断言函数名（用于 meta 覆盖检查）
 * @param fn        `(input) => {ok, reason}`
 * @param good      真形状的输入
 * @param mutants   `[[说明, 变异后的输入], …]` —— 每一个都必须被拒
 */
function prove(name, fn, good, mutants) {
  covered.add(name);
  say('');
  say(`── ${name}`);

  cases += 1;
  const g = fn(good);
  if (!g.ok) {
    failures += 1;
    say(`   ✘ 真形状的输入被拒了 —— 这条断言恒假，等于没有护栏。理由：${g.reason}`);
  } else {
    say(`   ✔ 真输入通过：${g.reason}`);
  }

  if (mutants.length === 0) {
    cases += 1;
    failures += 1;
    say('   ✘ 一个变异体都没有 —— 没有证明就不算证明');
    return;
  }

  for (const [why, input] of mutants) {
    cases += 1;
    const r = fn(input);
    if (r.ok) {
      failures += 1;
      say(`   ✘ 变异「${why}」**没有让它变红** —— 这条断言对该缺陷是瞎的`);
    } else {
      say(`   ✔ 变异「${why}」→ 红：${r.reason.slice(0, 110)}`);
    }
  }
}

/* ═══════════════════════ 夹具：一段"像语音"的 PCM ═══════════════════════ */

/**
 * 造一段有说有停的 16 kHz 单声道 PCM16。
 *
 * **必须有响有静**：全静音时"波形逐桶相等"恒真（假波形也全是 0），
 * 恒定包络时它挡不住正弦波。这两条正是 `checkPeaksAreRealAudio` 的前提自检要拦的，
 * 而夹具本身得先满足它们，否则这里证明的东西也是空的。
 */
function speechLikePcm(seconds = 4) {
  const n = 16000 * seconds;
  const buf = Buffer.alloc(n * 2);
  let seed = 20260808;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < n; i += 1) {
    const t = i / 16000;
    // 每 1 秒一个"音节"：前 0.6 秒有声、后 0.4 秒接近静音
    const inWord = t % 1 < 0.6;
    const env = inWord ? 0.35 + 0.6 * Math.abs(Math.sin(t * 11)) : 0.001;
    const v = (rnd() * 2 - 1) * env * 30000;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return buf;
}

/** 按 `apps/daemon/src/media/peaks.ts` 的 `encodeOmpk` 组一份 `.ompk`（仅用于造夹具）。 */
function encodeOmpk({ values, channels, samplesPerPixel, durationMs }) {
  const header = Buffer.alloc(14);
  header.write('OMPK', 0, 'ascii');
  header.writeUInt8(1, 4);
  header.writeUInt8(channels, 5);
  header.writeUInt32LE(samplesPerPixel, 6);
  header.writeUInt32LE(durationMs, 10);
  return Buffer.concat([header, Buffer.from(values.buffer, values.byteOffset, values.length)]);
}

const PCM = speechLikePcm(4);
const EXPECTED = A.computeExpectedPeaks(PCM, 256);
const DURATION_MS = Math.round((EXPECTED.totalFrames / 16000) * 1000);
const GOOD_OMPK = encodeOmpk({
  values: EXPECTED.values,
  channels: 1,
  samplesPerPixel: 256,
  durationMs: DURATION_MS,
});

/** 历史上真实发生过的那条假波形：一条正弦。桶数、格式、时长全对，**只有内容是编的**。 */
function fabricatedSineOmpk() {
  const v = new Int8Array(EXPECTED.buckets * 2);
  for (let b = 0; b < EXPECTED.buckets; b += 1) {
    const a = Math.round(90 * Math.sin((b / EXPECTED.buckets) * Math.PI * 8));
    v[b * 2] = -Math.abs(a);
    v[b * 2 + 1] = Math.abs(a);
  }
  return encodeOmpk({ values: v, channels: 1, samplesPerPixel: 256, durationMs: DURATION_MS });
}

/** 只改一个桶的一个值 —— 最小的"内容不对"，用来量这条断言的分辨率。 */
function oneBucketOffOmpk() {
  const v = Int8Array.from(EXPECTED.values);
  const i = Math.floor(v.length / 2);
  v[i] = v[i] === 127 ? 126 : v[i] + 1;
  return encodeOmpk({ values: v, channels: 1, samplesPerPixel: 256, durationMs: DURATION_MS });
}

const SILENT_PCM = Buffer.alloc(16000 * 2 * 4);
const SILENT_EXPECTED = A.computeExpectedPeaks(SILENT_PCM, 256);
const SILENT_OMPK = encodeOmpk({
  values: SILENT_EXPECTED.values,
  channels: 1,
  samplesPerPixel: 256,
  durationMs: Math.round((SILENT_EXPECTED.totalFrames / 16000) * 1000),
});

/** 满量程方波：有响、**没有静** —— 用来证明前提自检里"要有安静的桶"那一条真的在起作用。 */
const LOUD_FLAT_PCM = (() => {
  const n = 16000 * 4;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) b.writeInt16LE(i % 2 === 0 ? 30000 : -30000, i * 2);
  return b;
})();
const LOUD_FLAT_EXPECTED = A.computeExpectedPeaks(LOUD_FLAT_PCM, 256);
const LOUD_FLAT_OMPK = encodeOmpk({
  values: LOUD_FLAT_EXPECTED.values,
  channels: 1,
  samplesPerPixel: 256,
  durationMs: Math.round((LOUD_FLAT_EXPECTED.totalFrames / 16000) * 1000),
});

/* ═══════════════════════ 1. 波形是不是真的 ═══════════════════════ */

prove('checkPeaksAreRealAudio', A.checkPeaksAreRealAudio, { ompk: GOOD_OMPK, pcm: PCM }, [
  ['正弦波假波形（本仓真实发生过的那一条）', { ompk: fabricatedSineOmpk(), pcm: PCM }],
  [
    '全零波形',
    {
      ompk: encodeOmpk({
        values: new Int8Array(EXPECTED.buckets * 2),
        channels: 1,
        samplesPerPixel: 256,
        durationMs: DURATION_MS,
      }),
      pcm: PCM,
    },
  ],
  ['只有一个桶的一个值差 1', { ompk: oneBucketOffOmpk(), pcm: PCM }],
  ['桶数少一个（截断）', { ompk: GOOD_OMPK.subarray(0, GOOD_OMPK.length - 2), pcm: PCM }],
  [
    'durationMs 被改大 500ms',
    {
      ompk: encodeOmpk({
        values: EXPECTED.values,
        channels: 1,
        samplesPerPixel: 256,
        durationMs: DURATION_MS + 500,
      }),
      pcm: PCM,
    },
  ],
  [
    'samplesPerPixel 头写成 512',
    {
      ompk: encodeOmpk({
        values: EXPECTED.values,
        channels: 1,
        samplesPerPixel: 512,
        durationMs: DURATION_MS,
      }),
      pcm: PCM,
    },
  ],
  [
    'magic 被改坏',
    {
      ompk: (() => {
        const b = Buffer.from(GOOD_OMPK);
        b.write('XMPK', 0, 'ascii');
        return b;
      })(),
      pcm: PCM,
    },
  ],
  [
    '声道数谎报成 2',
    {
      ompk: (() => {
        const b = Buffer.from(GOOD_OMPK);
        b.writeUInt8(2, 5);
        return b;
      })(),
      pcm: PCM,
    },
  ],
  [
    '★前提：送的是纯静音（此时真假波形都是全零，"相等"恒真）',
    { ompk: SILENT_OMPK, pcm: SILENT_PCM },
  ],
  [
    '★前提：送的是满量程恒定包络（没有安静的桶，挡不住等幅假波形）',
    { ompk: LOUD_FLAT_OMPK, pcm: LOUD_FLAT_PCM },
  ],
]);

/* ═══════════════════════ 2. 词级时间戳 ═══════════════════════ */

const GOOD_SEGMENTS = [
  {
    seq: 0,
    startMs: 0,
    endMs: 2000,
    text: 'and so my fellow americans',
    words: [
      { w: 'and', s: 40, e: 220, p: 0.9 },
      { w: 'so', s: 220, e: 400, p: 0.88 },
      { w: 'my', s: 400, e: 700, p: 0.91 },
      { w: 'fellow', s: 700, e: 1300, p: 0.95 },
      { w: 'americans', s: 1300, e: 1980, p: 0.93 },
    ],
  },
  {
    seq: 1,
    startMs: 2000,
    endMs: 4200,
    text: 'ask not what your country can do for you',
    words: [
      { w: 'ask', s: 2040, e: 2300 },
      { w: 'not', s: 2300, e: 2600 },
      { w: 'what', s: 2600, e: 3000 },
      { w: 'your', s: 3000, e: 3400 },
      { w: 'country', s: 3400, e: 4100 },
    ],
  },
];
const stripWords = (segs) => segs.map((s) => ({ ...s, words: null }));

prove('checkWordTimestamps', A.checkWordTimestamps, GOOD_SEGMENTS, [
  ['全稿 words 被抹成 null（T-164 ④ 那次重转事故的形态）', stripWords(GOOD_SEGMENTS)],
  ['words 都是空数组', GOOD_SEGMENTS.map((s) => ({ ...s, words: [] }))],
  ['一个词的时间落在段外', [{ ...GOOD_SEGMENTS[0], words: [{ w: 'and', s: 40, e: 9000 }] }]],
  [
    '词序倒流',
    [
      {
        ...GOOD_SEGMENTS[0],
        words: [
          { w: 'a', s: 900, e: 950 },
          { w: 'b', s: 100, e: 150 },
        ],
      },
    ],
  ],
  ['词的结束早于开始', [{ ...GOOD_SEGMENTS[0], words: [{ w: 'a', s: 900, e: 100 }] }]],
  ['词文本是空串', [{ ...GOOD_SEGMENTS[0], words: [{ w: '   ', s: 40, e: 220 }] }]],
  ['s/e 是字符串不是数值', [{ ...GOOD_SEGMENTS[0], words: [{ w: 'a', s: '40', e: '220' }] }]],
  ['一段都没有', []],
  ['segments 不是数组', null],
]);

/* ═══════════════════════ 3. 换模型重转，词级时间戳不丢 ═══════════════════════ */

const BEFORE = { transcript: { modelId: 'ggml-tiny-q5_1.bin' }, segments: GOOD_SEGMENTS };
const AFTER = { transcript: { modelId: 'ggml-tiny.en-q5_1.bin' }, segments: GOOD_SEGMENTS };

prove(
  'checkRetranscribeKeptWords',
  A.checkRetranscribeKeptWords,
  { before: BEFORE, after: AFTER },
  [
    [
      '★模型压根没换成（指定的模型没装 → transcribe.ts 静默回退，请求里写了什么都没用）',
      { before: BEFORE, after: { ...AFTER, transcript: { modelId: 'ggml-tiny-q5_1.bin' } } },
    ],
    [
      '重转之后 words 全没了',
      { before: BEFORE, after: { ...AFTER, segments: stripWords(GOOD_SEGMENTS) } },
    ],
    [
      '★前提：重转之前就没有 words（这一轮证明不了"没丢"）',
      { before: { ...BEFORE, segments: stripWords(GOOD_SEGMENTS) }, after: AFTER },
    ],
    [
      '重转后的稿子说不出自己用的哪个模型',
      { before: BEFORE, after: { transcript: {}, segments: GOOD_SEGMENTS } },
    ],
    ['重转之后一段都没有', { before: BEFORE, after: { ...AFTER, segments: [] } }],
  ],
);

/* ═══════════════════════ 4. VAD ═══════════════════════ */

/*
 * ★★ #106：这一组的夹具从 `reasonZh`（一句中文）换成了 `reason`（`VadChunkingReason`，
 *   机器可读）。那一格已经从 `/api/health` 的契约里删掉 —— 它是 daemon 拼的整句中文，
 *   诊断页原样渲染 ⇒ 英文界面上那一行必然是中文。
 *
 *   ⚠️ **不是改成读 `reasonEn`**：那只是把"读中文散文"换成"读英文散文"，
 *   下次措辞一动照样漂。判据现在读 `reason.kind` —— 结构不随文案变。
 *
 *   下面第 1、2 两个变异体就是这条新判据的**牙齿证明**：
 *   把 `checkVadDegradedExplicitly` 里那两行结构判断抽掉，它们会当场存活 ⇒ 自检红。
 */
const DEGRADED_OK = {
  vad: { chunking: 'fixed', reason: { kind: 'no_vad_model_installed' }, rejected: [] },
  segments: GOOD_SEGMENTS,
};

prove('checkVadDegradedExplicitly', A.checkVadDegradedExplicitly, DEGRADED_OK, [
  [
    '成因这一格是空的（= 静默降级，用户看不到发生了什么）',
    { ...DEGRADED_OK, vad: { ...DEGRADED_OK.vad, reason: null } },
  ],
  [
    '成因这一格在，但里面没有 kind（老 daemon / 半个对象，同样等于没说）',
    { ...DEGRADED_OK, vad: { ...DEGRADED_OK.vad, reason: {} } },
  ],
  [
    '★★ 同一格自相矛盾：chunking=fixed 却报 reason.kind=vad_active —— 诊断页会显示假绿灯',
    { ...DEGRADED_OK, vad: { ...DEGRADED_OK.vad, reason: { kind: 'vad_active' } } },
  ],
  [
    '装了一份 whisper.cpp 加载不了的权重（T-148 的事故形态，不是降级）',
    { ...DEGRADED_OK, vad: { ...DEGRADED_OK.vad, rejected: ['/x/silero_vad.onnx'] } },
  ],
  ['★降级之后整单转写死了（一段都没有）—— 那不是降级', { ...DEGRADED_OK, segments: [] }],
  [
    '★降级之后只转出几个字符（"没报错"不等于"仍然可用"）',
    { ...DEGRADED_OK, segments: [{ seq: 0, startMs: 0, endMs: 10, text: '。' }] },
  ],
  ['其实没降级（chunking=vad）', { ...DEGRADED_OK, vad: { ...DEGRADED_OK.vad, chunking: 'vad' } }],
  ['health 里根本没有 pipeline.vad', { vad: null, segments: GOOD_SEGMENTS }],
]);

prove(
  'checkVadActive',
  A.checkVadActive,
  {
    chunking: 'vad',
    model: '/m/ggml-silero-v6.2.0.bin',
    reason: { kind: 'vad_active' },
    rejected: [],
  },
  [
    [
      '装了却没用上',
      { chunking: 'fixed', reason: { kind: 'no_vad_model_installed' }, rejected: [] },
    ],
    ['说用上了却报不出用的哪份权重', { chunking: 'vad', model: '', rejected: [] }],
    [
      '★ 反方向的自相矛盾：chunking=vad 却报 reason.kind=no_vad_model_installed',
      {
        chunking: 'vad',
        model: '/m/ggml-silero-v6.2.0.bin',
        reason: { kind: 'no_vad_model_installed' },
        rejected: [],
      },
    ],
    ['没有 pipeline.vad', null],
  ],
);

/*
 * ★★ **前提检查：这一组的判据必须真的与文案无关。**
 *
 * 上一版读 `reasonZh` 那句中文，措辞一改（T-191 那种）判据就静默漂掉 ——
 * 而"漂掉"在这里的表现是**恒不触发**，与本轮在 `e2e-runtime-audit.mjs` 里
 * 抓到的那条死门是同一个形状。所以这里正面钉一次：
 * 把成因那句话换成任意别的字符串、甚至根本不给这两个旧字段，结论都不许变。
 */
say('');
say('── checkVadDegradedExplicitly：判据必须与文案无关（#106）');
{
  const base = A.checkVadDegradedExplicitly(DEGRADED_OK);
  cases += 1;
  if (!base.ok) {
    failures += 1;
    say(`   ✘ 真形状先得过 —— 否则下面比的是两个假：${base.reason}`);
  }
  for (const noise of [
    { reasonZh: '随便一句完全不同的中文' },
    { reasonEn: 'some entirely different english sentence' },
    { reasonZh: '', reasonEn: '' },
  ]) {
    cases += 1;
    const r = A.checkVadDegradedExplicitly({
      ...DEGRADED_OK,
      vad: { ...DEGRADED_OK.vad, ...noise },
    });
    if (!r.ok) {
      failures += 1;
      say(`   ✘ 判据被文案影响了（${JSON.stringify(noise)}）：${r.reason}`);
    } else {
      say(`   ✔ 加噪 ${JSON.stringify(noise)} → 结论不变`);
    }
  }
  /*
   * ★ 反过来：结构没了、只剩一句中文，它**必须**红。
   * 少了这一条，上面那三条只是"恒真"的另一种说法 —— 一个什么都不看的判据
   * 也能让"加噪不改变结论"成立。
   */
  cases += 1;
  const broken = A.checkVadDegradedExplicitly({
    ...DEGRADED_OK,
    vad: { ...DEGRADED_OK.vad, reason: null, reasonZh: '未安装 VAD 模型 → 切分降级为固定窗口' },
  });
  if (broken.ok) {
    failures += 1;
    say('   ✘ 结构没了、只剩一句中文，它却照样通过 —— 判据还在读散文');
  } else {
    say('   ✔ 只剩一句中文（没有 reason.kind）→ 红：判据读的确实是结构');
  }
}

/* ═══════════════════════ 5. 时间轴 ═══════════════════════ */

prove(
  'checkTimelineSegments',
  A.checkTimelineSegments,
  { segments: GOOD_SEGMENTS, audioDurationMs: 4400 },
  [
    [
      '两段重叠 → "当前是哪一段"没有唯一答案',
      {
        segments: [GOOD_SEGMENTS[0], { ...GOOD_SEGMENTS[1], startMs: 1000 }],
        audioDurationMs: 4400,
      },
    ],
    [
      '某段 endMs <= startMs',
      { segments: [{ seq: 0, startMs: 500, endMs: 500, text: 'x' }], audioDurationMs: 4400 },
    ],
    [
      '某段起点超出音频时长',
      { segments: [{ seq: 0, startMs: 99000, endMs: 99500, text: 'x' }], audioDurationMs: 4400 },
    ],
    [
      '起点为负',
      { segments: [{ seq: 0, startMs: -10, endMs: 100, text: 'x' }], audioDurationMs: 4400 },
    ],
    [
      '★段落与音频不在同一条时间轴上（撒点一个都命中不了）',
      { segments: [{ seq: 0, startMs: 4399, endMs: 4400, text: 'x' }], audioDurationMs: 4400 },
    ],
    ['一段都没有', { segments: [], audioDurationMs: 4400 }],
    ['音频时长不可用', { segments: GOOD_SEGMENTS, audioDurationMs: 0 }],
  ],
);

const GOOD_HITS = [
  { noteUid: 'AAAAAAAAAAAAAAAAAAAAAAAAAA', startMs: 2000, snippet: 'ask not what your country' },
  { noteUid: 'BBBBBBBBBBBBBBBBBBBBBBBBBB', startMs: 12, snippet: '别的笔记' },
];

prove(
  'checkSearchSeek',
  A.checkSearchSeek,
  {
    hits: GOOD_HITS,
    noteUid: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
    segments: GOOD_SEGMENTS,
    needle: 'country',
  },
  [
    [
      '没命中这条笔记',
      {
        hits: [GOOD_HITS[1]],
        noteUid: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
        segments: GOOD_SEGMENTS,
        needle: 'country',
      },
    ],
    [
      '★命中了但 startMs 是 null（前端拼不出 ?t=，点了从 0:00 播）',
      {
        hits: [{ ...GOOD_HITS[0], startMs: null }],
        noteUid: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
        segments: GOOD_SEGMENTS,
        needle: 'country',
      },
    ],
    [
      '★startMs 不是任何一段的起点（跳到一个没有内容的位置）',
      {
        hits: [{ ...GOOD_HITS[0], startMs: 12345 }],
        noteUid: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
        segments: GOOD_SEGMENTS,
        needle: 'country',
      },
    ],
    [
      '一条命中都没有',
      {
        hits: [],
        noteUid: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
        segments: GOOD_SEGMENTS,
        needle: 'country',
      },
    ],
  ],
);

/* ═══════════════════════ 6. 资产 / Range ═══════════════════════ */

const SENT = 352034;
const GOOD_DETAIL = {
  assets: [
    {
      role: 'original',
      state: 'ready',
      mime: 'audio/wav',
      bytes: SENT + 44,
      url: '/media/asset/01JZZZZZZZZZZZZZZZZZZZZZZZ',
      uid: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    },
    {
      role: 'peaks',
      state: 'ready',
      mime: 'application/octet-stream',
      bytes: 1400,
      url: '/media/asset/01JYYYYYYYYYYYYYYYYYYYYYYY',
    },
  ],
};

prove('checkAudioAsset', A.checkAudioAsset, { detail: GOOD_DETAIL, sentPcmBytes: SENT }, [
  [
    '根本没有 role=original 的资产',
    { detail: { assets: [GOOD_DETAIL.assets[1]] }, sentPcmBytes: SENT },
  ],
  [
    '★只有 44 字节的空 WAV 头（T-164 ② 那条"0 秒、打不开、状态却是就绪"的死笔记）',
    { detail: { assets: [{ ...GOOD_DETAIL.assets[0], bytes: 44 }] }, sentPcmBytes: SENT },
  ],
  [
    '字节数少了一帧（中途丢帧）',
    {
      detail: { assets: [{ ...GOOD_DETAIL.assets[0], bytes: SENT + 44 - 640 }] },
      sentPcmBytes: SENT,
    },
  ],
  [
    'state 不是 ready',
    { detail: { assets: [{ ...GOOD_DETAIL.assets[0], state: 'pending' }] }, sentPcmBytes: SENT },
  ],
  [
    'mime 不是音频',
    { detail: { assets: [{ ...GOOD_DETAIL.assets[0], mime: 'text/plain' }] }, sentPcmBytes: SENT },
  ],
  [
    'url 是文件系统路径而不是 /media/asset/<ulid>',
    { detail: { assets: [{ ...GOOD_DETAIL.assets[0], url: '/tmp/x.wav' }] }, sentPcmBytes: SENT },
  ],
]);

const SLICE = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const GOOD_RANGE = {
  status: 206,
  headers: { 'content-range': 'bytes 100-107/1000' },
  body: SLICE,
  expected: SLICE,
  start: 100,
  end: 107,
  totalBytes: 1000,
};

prove('checkRangeSlice', A.checkRangeSlice, GOOD_RANGE, [
  ['服务端忽略了 Range，回 200 全量', { ...GOOD_RANGE, status: 200 }],
  [
    'Content-Range 指向别的区间',
    { ...GOOD_RANGE, headers: { 'content-range': 'bytes 0-107/1000' } },
  ],
  [
    '★取回的字节整体错位（能播但对不上口型）',
    { ...GOOD_RANGE, body: Buffer.from([9, 2, 3, 4, 5, 6, 7, 8]) },
  ],
  ['取回的长度不对', { ...GOOD_RANGE, body: Buffer.from([1, 2, 3]) }],
]);

/* ═══════════════════════ 7. 借宿主工具 ═══════════════════════ */

const OWN_CHECKS = [
  { id: 'tool.ffmpeg', status: 'ok', detail: '/data/models/packs/media-tools/ffmpeg' },
  { id: 'tool.whisperCli', status: 'ok', detail: '/data/models/packs/whispercpp/whisper-cli' },
  { id: 'ext.chineseSearch', status: 'ok', detail: '双字词搜得到' },
];

prove('checkNoBorrowedTools', A.checkNoBorrowedTools, { checks: OWN_CHECKS, shimHits: [] }, [
  [
    '自检说 ffmpeg 来自系统 PATH',
    {
      checks: [
        { id: 'tool.ffmpeg', status: 'warn', detail: '来自系统 PATH，非本产品安装' },
        ...OWN_CHECKS.slice(1),
      ],
      shimHits: [],
    },
  ],
  ['★自检没说，但 shim 在 daemon 日志里被执行到了', { checks: OWN_CHECKS, shimHits: ['yt-dlp'] }],
  [
    '★前提：报告里一个 tool.* 都没有（此时"没借"恒真）',
    { checks: [{ id: 'ext.chineseSearch', status: 'ok' }], shimHits: [] },
  ],
]);

/* ═══════════════════════ 8. 录音会话协议 ═══════════════════════ */

const GOOD_MSGS = [
  {
    type: 'ready',
    recordingUid: 'R',
    noteUid: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    transcriptUid: 'T',
    sampleRate: 16000,
  },
  { type: 'partial', utteranceId: 'u1', text: '你好', startMs: 0 },
  { type: 'final', seq: 0, startMs: 0, endMs: 1200, text: '你好世界' },
  { type: 'stopped', segmentCount: 1, rerunJobUid: 'J' },
];

prove('checkRecorderSession', A.checkRecorderSession, { messages: GOOD_MSGS }, [
  [
    '服务端没给 ready（引擎不可用那一支）',
    {
      messages: [
        { type: 'error', code: 'ASR_STREAM_UNAVAILABLE', messageZh: '流式识别引擎不可用' },
      ],
    },
  ],
  [
    '★ready 报的采样率与我们推流的不一致（会整体错位，双方都不报错）',
    { messages: [{ ...GOOD_MSGS[0], sampleRate: 48000 }, ...GOOD_MSGS.slice(1)] },
  ],
  ['没等到 stopped（收尾链不知道走没走完）', { messages: GOOD_MSGS.slice(0, 3) }],
  [
    '★中途 overrun 丢帧（服务端拿到的字节与我们送的不同）',
    {
      messages: [...GOOD_MSGS.slice(0, 3), { type: 'overrun', droppedSamples: 4800 }, GOOD_MSGS[3]],
    },
  ],
  [
    '会话中出现 error',
    {
      messages: [
        ...GOOD_MSGS.slice(0, 3),
        { type: 'error', code: 'ASR_STREAM_ERROR', messageZh: 'x' },
        GOOD_MSGS[3],
      ],
    },
  ],
  [
    'noteUid 不是 ULID',
    { messages: [{ ...GOOD_MSGS[0], noteUid: 'note-1' }, ...GOOD_MSGS.slice(1)] },
  ],
]);

/* ═══════════════════ meta：新加的断言不许没有变异证明 ═══════════════════ */

say('');
say('── meta：每一个导出的 check* 都必须有变异证明');
const exported = Object.keys(A).filter((k) => k.startsWith('check'));
const missing = exported.filter((k) => !covered.has(k));
cases += 1;
if (missing.length > 0) {
  failures += 1;
  say(`   ✘ 这些断言没有变异证明：${missing.join(', ')}`);
  say('     （没有证明的断言与一行注释等价 —— 它可能已经恒真了，而没有人会知道）');
} else {
  say(`   ✔ ${exported.length} 个断言全部有变异证明：${exported.join(', ')}`);
}

/* 前提自检：`covered` 是空的时候上面那条恒真。本仓同一形状已发生五次。 */
cases += 1;
if (covered.size === 0) {
  failures += 1;
  say('   ✘ 一条断言都没证明过 —— meta 检查在这种输入上恒真');
}

say('');
say('─'.repeat(78));
if (failures > 0) {
  say(`✘ selftest-e2e-record：${cases} 条里 ${failures} 条不成立`);
  process.exit(1);
}
say(
  `✔ selftest-e2e-record：${cases} 条断言全部成立（${exported.length} 个断言 × 真输入 + 变异体）`,
);
assert.equal(failures, 0);
