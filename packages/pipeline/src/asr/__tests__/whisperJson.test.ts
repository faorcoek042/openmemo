/**
 * whisper.cpp JSON mapping + resume semantics.
 *
 * The critical assertion is chunk-offset arithmetic. MEASURED on whisper.cpp v1.9.1:
 * when driven with `--offset-t`, the reported `offsets` are ABSOLUTE to the source file,
 * not relative to the requested window — so nothing may be added. The first version of
 * this parser assumed the opposite and a 220 s recording produced segments at 419 s.
 * A single-chunk test cannot see that; only the multi-chunk end-to-end run could.
 *
 * Run: node --test packages/pipeline/dist/asr/__tests__/whisperJson.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SEGMENT_FLAG, detectRepetition, logprobToConfidence } from '../types.js';
import type { TranscriptSegment } from '../types.js';
import { parseWhisperJson } from '../whisperCpp.js';
import { parseServerResponse } from '../whisperServer.js';
import { PLAN_VERSION, dedupeBoundarySegments, deriveResumeSet } from '../../transcribe.js';

/** Shaped after real `whisper-cli --output-json-full` output. */
const SAMPLE = JSON.stringify({
  transcription: [
    {
      timestamps: { from: '00:00:00,000', to: '00:00:05,000' },
      offsets: { from: 0, to: 5000 },
      text: ' And so my fellow Americans',
      avg_logprob: -0.25,
      no_speech_prob: 0.01,
      tokens: [
        { text: ' And', offsets: { from: 0, to: 500 }, p: 0.99 },
        { text: ' so', offsets: { from: 500, to: 900 }, p: 0.98 },
      ],
    },
    {
      timestamps: { from: '00:00:05,000', to: '00:00:11,000' },
      offsets: { from: 5000, to: 11000 },
      text: ' ask not what your country can do for you',
      avg_logprob: -0.4,
      no_speech_prob: 0.02,
    },
  ],
});

describe('parseWhisperJson', () => {
  it('treats whisper offsets as ABSOLUTE and does not double-count', () => {
    /*
     * REGRESSION TEST for the bug the multi-chunk end-to-end run caught (D-06 §6).
     *
     * whisper.cpp driven with `--offset-t 60000` reports offsets.from = 60000, i.e.
     * already absolute to the file. The original parser added the chunk offset on top,
     * so a 220 s recording produced segments at 419 s. baseOffsetMs defaults to 0 and
     * must stay that way for this engine.
     */
    const segs = parseWhisperJson(SAMPLE, 3);
    assert.equal(segs[0]!.startMs, 0, 'offsets are absolute; nothing may be added');
    assert.equal(segs[1]!.endMs, 11_000);
    assert.equal(segs[0]!.chunkIdx, 3, 'chunkIdx drives resume and per-chunk re-runs');
  });

  it('still supports relative engines via baseOffsetMs', () => {
    const segs = parseWhisperJson(SAMPLE, 3, { baseOffsetMs: 90_000 });
    assert.equal(segs[0]!.startMs, 90_000);
    assert.equal(segs[0]!.words![0]!.s, 90_000, 'word timestamps shift too');
  });

  it('drops segments that over-run the requested window', () => {
    // whisper decodes in 30 s windows and will spill past --duration; without this the
    // next chunk re-transcribes the same speech and the transcript duplicates itself.
    const segs = parseWhisperJson(SAMPLE, 0, { windowStartMs: 0, windowEndMs: 5_000 });
    assert.equal(segs.length, 1, 'the 5000-11000ms segment belongs to the next chunk');
    assert.equal(segs[0]!.endMs, 5_000);
  });

  it('trims text and drops empty segments', () => {
    const segs = parseWhisperJson(SAMPLE, 0);
    assert.equal(segs[0]!.text, 'And so my fellow Americans');
    const empty = parseWhisperJson(
      JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1 }, text: '   ' }] }),
      0,
    );
    assert.equal(empty.length, 0);
  });

  it('derives confidence from token probabilities when avg_logprob is absent', () => {
    // MEASURED: v1.9.1 emits only ['timestamps','offsets','text','tokens'] — no
    // avg_logprob. Confidence therefore comes from the mean real-token `p`.
    const json = JSON.stringify({
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: 'hello world',
          tokens: [
            { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 0.99 },
            { text: ' hello', offsets: { from: 0, to: 500 }, p: 0.8 },
            { text: ' world', offsets: { from: 500, to: 1000 }, p: 0.6 },
          ],
        },
      ],
    });
    const segs = parseWhisperJson(json, 0);
    // Special markers are excluded — they are always near-certain and would inflate it.
    assert.ok(Math.abs(segs[0]!.confidence! - 0.7) < 1e-9, 'mean of 0.8 and 0.6');
  });

  it('prefers avg_logprob when a build does provide it', () => {
    const segs = parseWhisperJson(SAMPLE, 0);
    assert.ok(segs[0]!.confidence! > segs[1]!.confidence!, 'higher logprob = higher confidence');
    assert.ok(segs[0]!.confidence! <= 1 && segs[0]!.confidence! >= 0);
  });

  it('throws a clear error on unparseable output', () => {
    assert.throws(() => parseWhisperJson('not json', 0), /unparseable/);
  });

  it('flags likely silence via no_speech_prob', () => {
    const json = JSON.stringify({
      transcription: [
        { offsets: { from: 0, to: 1000 }, text: 'hmm', no_speech_prob: 0.9, avg_logprob: -0.1 },
      ],
    });
    const segs = parseWhisperJson(json, 0);
    assert.ok((segs[0]!.flags & SEGMENT_FLAG.SILENCE_OR_MUSIC) !== 0);
  });
});

describe('detectRepetition — whisper hallucination flag (D-02 §1.5 bit 0)', () => {
  it('catches a repeated token run', () => {
    assert.equal(detectRepetition('thank you thank you thank you thank you thank you'), true);
  });

  it('catches a tiled phrase with no spaces (CJK)', () => {
    assert.equal(
      detectRepetition('字幕由社群提供字幕由社群提供字幕由社群提供字幕由社群提供'),
      true,
    );
  });

  it('does not flag ordinary prose', () => {
    assert.equal(
      detectRepetition('And so my fellow Americans, ask not what your country can do for you.'),
      false,
    );
  });

  it('ignores very short strings', () => {
    assert.equal(detectRepetition('ok ok'), false);
  });
});

describe('logprobToConfidence', () => {
  it('handles nulls and non-finite input', () => {
    assert.equal(logprobToConfidence(null), null);
    assert.equal(logprobToConfidence(Number.NaN), null);
  });

  it('clamps to 0..1', () => {
    assert.ok(logprobToConfidence(5)! <= 1);
    assert.ok(logprobToConfidence(-50)! >= 0);
  });
});

describe('deriveResumeSet — plan_version guard (D-01 §4.5)', () => {
  it('resumes from persisted chunks when the plan version matches', () => {
    const s = deriveResumeSet([0, 1, 2], PLAN_VERSION);
    assert.deepEqual(
      [...s].sort((a, b) => a - b),
      [0, 1, 2],
    );
  });

  it('refuses to resume across a plan change — indices would be misaligned', () => {
    // An upgrade that reorders steps or changes chunk boundaries makes old indices
    // meaningless. Correct-but-slow beats fast-but-wrong.
    assert.equal(deriveResumeSet([0, 1, 2], PLAN_VERSION - 1).size, 0);
    assert.equal(deriveResumeSet([0, 1, 2], null).size, 0);
  });
});

describe('dedupeBoundarySegments — chunk-overlap artifact', () => {
  const seg = (startMs: number, endMs: number, text: string): TranscriptSegment => ({
    startMs,
    endMs,
    text,
    confidence: null,
    noSpeechProb: null,
    words: null,
    chunkIdx: 0,
    flags: 0,
    speakerLabel: null,
  });

  it('drops the duplicate the real run produced at a chunk boundary', () => {
    // Verbatim from the multi-chunk end-to-end run before the fix.
    const accepted = [seg(23_100, 30_900, 'The link of the 50 million …')];
    const incoming = [
      seg(26_400, 30_900, 'with the 20 million equals of the West Indies …'), // duplicate
      seg(30_900, 36_900, 'America, with the 280 million equals of Africa …'), // genuine
    ];
    const kept = dedupeBoundarySegments(accepted, incoming);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.startMs, 30_900);
  });

  it('keeps everything when there is no overlap', () => {
    const accepted = [seg(0, 10_000, 'a')];
    const incoming = [seg(10_000, 20_000, 'b'), seg(20_000, 30_000, 'c')];
    assert.equal(dedupeBoundarySegments(accepted, incoming).length, 2);
  });

  it('keeps a slight overlap below the ratio — speakers do run on', () => {
    const accepted = [seg(0, 10_200, 'a')];
    // 200ms of a 5s segment = 4% overlap: real speech, not a duplicate.
    assert.equal(dedupeBoundarySegments(accepted, [seg(10_000, 15_000, 'b')]).length, 1);
  });

  it('passes the first chunk through untouched', () => {
    const incoming = [seg(0, 5_000, 'a')];
    assert.equal(dedupeBoundarySegments([], incoming), incoming);
  });
});

/**
 * CLI 与 server 的 JSON **不一样**，而且不是"少个 flag"的问题（T-093 实测）。
 *
 * 同一个 v1.9.1 包、同一个模型、同一段音频：
 *   whisper-cli -oj -ojf → segment 键只有 timestamps / offsets / text / tokens
 *   whisper-server verbose_json → …还有 avg_logprob 与 no_speech_prob
 *
 * 原因在上游源码：`whisper_full_get_segment_no_speech_prob()` 是 libwhisper 的公开 API，
 * 但 `examples/cli/cli.cpp` 的 `output_json()` 从头到尾没调用过它，
 * 而 `examples/server/server.cpp:1145` 调了。`-nth/--no-speech-thold` 是**输入**阈值，
 * 不是输出开关 —— 没有任何 flag 能让 CLI 吐出这个字段。
 *
 * 所以 `noSpeechProb` 在 CLI 路径上**永远是 null**，这不是我们的 bug，也修不了；
 * 但 server 路径上必须收下来，之前那里硬编码 null 是白扔。
 */
describe('CLI vs server 的字段差异（实测，非假设）', () => {
  it('CLI 真实输出没有 avg_logprob / no_speech_prob → 解析器不能崩，只能报 null', () => {
    // 逐字对应 T-093 实跑 `whisper-cli -m … -oj -ojf` 得到的 segment 形状。
    const real = JSON.stringify({
      transcription: [
        {
          timestamps: { from: '00:00:00,120', to: '00:00:10,380' },
          offsets: { from: 120, to: 10_380 },
          text: ' And so, my fellow Americans',
          tokens: [{ text: ' And', offsets: { from: 220, to: 360 }, p: 0.910618 }],
        },
      ],
    });
    const segs = parseWhisperJson(real, 0);
    assert.equal(segs.length, 1);
    assert.equal(segs[0]!.noSpeechProb, null, 'CLI 给不了就是 null，不许编一个');
    // avg_logprob 缺失时退回 token 概率均值，confidence 仍要有值。
    assert.ok((segs[0]!.confidence ?? 0) > 0.9);
    assert.equal(segs[0]!.flags & SEGMENT_FLAG.SILENCE_OR_MUSIC, 0, '拿不到就不该乱打静音标');
  });

  it('server 的 verbose_json 有 no_speech_prob → 必须收下并据此打静音标', () => {
    const body = JSON.stringify({
      segments: [
        {
          start: 0,
          end: 2,
          text: ' (silence)',
          avg_logprob: -0.13,
          no_speech_prob: 0.93,
          words: [{ word: ' (silence)', start: 0, end: 2, probability: 0.8 }],
        },
        {
          start: 2,
          end: 5,
          text: ' real speech here',
          avg_logprob: -0.134,
          // 实测值：1.93e-05
          no_speech_prob: 0.0000192711,
          words: [{ word: ' real', start: 2, end: 3, probability: 0.99 }],
        },
      ],
    });
    const segs = parseServerResponse(body, 0);
    assert.equal(segs.length, 2);
    assert.equal(segs[0]!.noSpeechProb, 0.93);
    assert.ok((segs[0]!.flags & SEGMENT_FLAG.SILENCE_OR_MUSIC) !== 0);
    assert.equal(segs[1]!.flags & SEGMENT_FLAG.SILENCE_OR_MUSIC, 0);
    // confidence 与 CLI 分支同刻度：来自 avg_logprob，而不是词概率均值 0.99。
    assert.equal(segs[1]!.confidence, logprobToConfidence(-0.134));
  });
});
