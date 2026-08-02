/**
 * SherpaOnnxEngine stream lifecycle, with a faked sherpa module.
 *
 * BUG THIS GUARDS (found on the first real F3 run): close() set `closed = true` BEFORE
 * draining the write queue, so every already-queued write saw the flag and bailed out.
 * A whole 5-second recording produced ZERO events. The fix splits `closing` (stop
 * accepting new audio) from `closed` (queue fully drained).
 *
 * Run: node --test packages/pipeline/dist/asr/__tests__/sherpaStream.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SherpaOnnxEngine, int16ToFloat32 } from '../sherpaOnnx.js';
import type { SherpaModule } from '../sherpaOnnx.js';
import type { TranscriptSegment } from '../types.js';

/** Fake recogniser: accumulates samples and reports text proportional to audio fed. */
function fakeModule(opts: { endpointAfter?: number } = {}): SherpaModule {
  let fed = 0;
  return {
    OnlineRecognizer: class {
      createStream(): { acceptWaveform(i: { sampleRate: number; samples: Float32Array }): void } {
        return {
          acceptWaveform(i) {
            fed += i.samples.length;
          },
        };
      }
      isReady(): boolean {
        return false;
      }
      decode(): void {}
      isEndpoint(): boolean {
        return opts.endpointAfter !== undefined && fed >= opts.endpointAfter;
      }
      reset(): void {
        fed = 0;
      }
      getResult(): { text: string; tokens: string[]; timestamps: number[] } {
        const n = Math.floor(fed / 1600);
        return {
          text: '字'.repeat(Math.max(0, n)),
          tokens: Array.from({ length: Math.max(0, n) }, () => '字'),
          timestamps: Array.from({ length: Math.max(0, n) }, (_, i) => i * 0.1),
        };
      }
    },
  };
}

function engineWith(mod: SherpaModule): SherpaOnnxEngine {
  return new SherpaOnnxEngine({
    model: {
      encoder: 'e', decoder: 'd', joiner: 'j', tokens: 't',
      modelId: 'fake', languages: ['zh'],
    },
    loadModule: async () => mod,
  });
}

describe('SherpaAsrStream lifecycle', () => {
  it('emits a final segment for audio written before close() — the drain-order bug', async () => {
    const engine = engineWith(fakeModule());
    const ac = new AbortController();
    const stream = engine.openStream({ modelPath: 'm', language: 'zh', signal: ac.signal });

    const finals: TranscriptSegment[] = [];
    stream.on('final', (s) => finals.push(s));

    // Write, then immediately close — the exact sequence that produced zero events.
    for (let i = 0; i < 10; i++) stream.write(new Int16Array(1600));
    await stream.close();

    assert.ok(finals.length > 0, 'audio written before close() MUST still be decoded');
    assert.ok(finals[0]!.text.length > 0);
  });

  it('emits partials as the hypothesis grows', async () => {
    const engine = engineWith(fakeModule());
    const stream = engine.openStream({
      modelPath: 'm', language: 'zh', signal: new AbortController().signal,
    });
    const partials: TranscriptSegment[] = [];
    stream.on('partial', (s) => partials.push(s));

    for (let i = 0; i < 5; i++) stream.write(new Int16Array(1600));
    await stream.close();

    assert.ok(partials.length >= 2, 'live captions need incremental updates');
    // Text should be monotonically growing while the utterance is open.
    assert.ok(partials[partials.length - 1]!.text.length > partials[0]!.text.length);
  });

  it('ignores writes issued after close()', async () => {
    const engine = engineWith(fakeModule());
    const stream = engine.openStream({
      modelPath: 'm', language: 'zh', signal: new AbortController().signal,
    });
    stream.write(new Int16Array(1600));
    await stream.close();

    const after: TranscriptSegment[] = [];
    stream.on('final', (s) => after.push(s));
    stream.write(new Int16Array(1600));
    await stream.close();
    assert.equal(after.length, 0, 'a closed stream must not resurrect');
  });

  it('is idempotent on repeated close()', async () => {
    const engine = engineWith(fakeModule());
    const stream = engine.openStream({
      modelPath: 'm', language: 'zh', signal: new AbortController().signal,
    });
    stream.write(new Int16Array(1600));
    await stream.close();
    await stream.close();
  });

  it('refuses batch transcription rather than silently using the wrong engine', async () => {
    const engine = engineWith(fakeModule());
    await assert.rejects(
      () =>
        engine.transcribeChunk({
          audioPath: 'a', chunkIndex: 0, offsetMs: 0, durationMs: 1000,
          modelPath: 'm', signal: new AbortController().signal,
        }),
      /stream-only/,
    );
  });
});

describe('int16ToFloat32', () => {
  it('scales to [-1, 1)', () => {
    const out = int16ToFloat32(Int16Array.from([0, 32767, -32768, 16384]));
    assert.equal(out[0], 0);
    assert.ok(Math.abs(out[1]! - 0.99997) < 1e-4);
    assert.equal(out[2], -1);
    assert.equal(out[3], 0.5);
  });
});
