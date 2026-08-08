/**
 * VAD parsing and chunk planning.
 *
 * The parser test uses the EXACT output captured from `whisper-vad-speech-segments`
 * v1.9.1 on samples/jfk.wav during T-020, including the centisecond units — the single
 * easiest thing to get wrong here (reading them as seconds yields chunks 100x too long).
 *
 * Run: node --test packages/pipeline/dist/audio/__tests__/vad.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseVadOutput, planChunks, planFixedChunks, totalSpeechMs } from '../vad.js';

/** Verbatim capture from the real binary. */
const REAL_VAD_OUTPUT = `
Detected 5 speech segments:
Speech segment 0: start = 29.00, end = 221.00
Speech segment 1: start = 330.00, end = 377.00
Speech segment 2: start = 400.00, end = 435.00
Speech segment 3: start = 538.00, end = 765.00
Speech segment 4: start = 816.00, end = 1059.00
`;

describe('parseVadOutput', () => {
  it('parses the real binary output and converts centiseconds to milliseconds', () => {
    const segs = parseVadOutput(REAL_VAD_OUTPUT);
    assert.equal(segs.length, 5);

    // 29.00 cs -> 290 ms, 221.00 cs -> 2210 ms.
    assert.deepEqual(segs[0], { startMs: 290, endMs: 2210 });
    assert.deepEqual(segs[4], { startMs: 8160, endMs: 10590 });

    // Sanity: jfk.wav is 11.0 s, so nothing may exceed 11000 ms. If the units were read
    // as seconds this assertion fails immediately.
    for (const s of segs) {
      assert.ok(s.endMs <= 11_000, `segment end ${String(s.endMs)}ms exceeds the 11s file`);
    }
  });

  it('returns [] for output with no segments rather than throwing', () => {
    assert.deepEqual(parseVadOutput('Detected 0 speech segments:\n'), []);
    assert.deepEqual(parseVadOutput(''), []);
  });

  it('skips malformed and zero-length entries', () => {
    const segs = parseVadOutput(`
Speech segment 0: start = 10.00, end = 10.00
Speech segment 1: start = abc, end = 50.00
Speech segment 2: start = 20.00, end = 60.00
`);
    assert.equal(segs.length, 1);
    assert.deepEqual(segs[0], { startMs: 200, endMs: 600 });
  });

  it('sums speech time', () => {
    assert.equal(totalSpeechMs(parseVadOutput(REAL_VAD_OUTPUT)), 1920 + 470 + 350 + 2270 + 2430);
  });
});

describe('planChunks', () => {
  it('merges short segments from a real 11s file into a single chunk', () => {
    const segs = parseVadOutput(REAL_VAD_OUTPUT);
    const chunks = planChunks(segs, { totalDurationMs: 11_000 });
    // All five segments fit inside one 30 s window with gaps under 2 s.
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.segmentCount, 5);
    assert.ok(chunks[0]!.startMs >= 0);
    assert.ok(chunks[0]!.endMs <= 11_000, 'padding must not run past the end of the media');
  });

  it('breaks at long silences instead of mid-speech', () => {
    const segs = [
      { startMs: 0, endMs: 5_000 },
      // 10 s gap — far beyond maxGapToBridgeMs, so this must start a new chunk.
      { startMs: 15_000, endMs: 20_000 },
    ];
    const chunks = planChunks(segs, { totalDurationMs: 25_000 });
    assert.equal(chunks.length, 2);
    // The silence itself is never sent to the model — whisper hallucinates on silence.
    assert.ok(chunks[0]!.endMs < chunks[1]!.startMs);
    assert.ok(chunks[1]!.startMs >= 14_000);
  });

  it('never exceeds maxChunkMs', () => {
    const segs = Array.from({ length: 60 }, (_, i) => ({
      startMs: i * 5_000,
      endMs: i * 5_000 + 4_900,
    }));
    const chunks = planChunks(segs, {
      totalDurationMs: 300_000,
      targetChunkMs: 30_000,
      maxChunkMs: 45_000,
    });
    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(
        c.endMs - c.startMs <= 45_000 + 400,
        `chunk ${String(c.index)} is ${String(c.endMs - c.startMs)}ms, over the cap`,
      );
    }
  });

  it('produces dense, ascending indices (they map to DB chunk_idx)', () => {
    const segs = Array.from({ length: 30 }, (_, i) => ({
      startMs: i * 9_000,
      endMs: i * 9_000 + 8_000,
    }));
    const chunks = planChunks(segs, { totalDurationMs: 300_000 });
    chunks.forEach((c, i) => assert.equal(c.index, i, 'indices must be dense and ordered'));
  });

  it('returns [] for no speech — silence is not transcribed', () => {
    assert.deepEqual(planChunks([], { totalDurationMs: 60_000 }), []);
  });

  it('folds a runt final chunk into its predecessor', () => {
    const segs = [
      { startMs: 0, endMs: 30_000 },
      { startMs: 30_100, endMs: 30_200 }, // 100 ms — not worth a model load
    ];
    const chunks = planChunks(segs, { totalDurationMs: 31_000, minChunkMs: 1_000 });
    assert.equal(chunks.length, 1);
  });
});

describe('planFixedChunks (VAD-unavailable degradation)', () => {
  it('covers the whole file with overlapping windows', () => {
    const chunks = planFixedChunks(100_000, 30_000, 500);
    assert.equal(chunks[0]!.startMs, 0);
    assert.equal(chunks[chunks.length - 1]!.endMs, 100_000);
    // Overlap keeps a word spanning a boundary from being lost.
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i]!.startMs < chunks[i - 1]!.endMs, 'consecutive windows must overlap');
    }
  });

  it('handles a file shorter than one window', () => {
    const chunks = planFixedChunks(5_000, 30_000);
    assert.equal(chunks.length, 1);
    assert.deepEqual([chunks[0]!.startMs, chunks[0]!.endMs], [0, 5_000]);
  });
});
