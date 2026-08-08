/**
 * SherpaOnnxEngine — streaming ASR for F3 (live recording). D-01 §6.1.
 *
 * whisper.cpp is batch-only: it needs a complete audio window before it decodes, so it
 * cannot produce the running partial captions F3 requires. sherpa-onnx's
 * `OnlineRecognizer` is a streaming transducer — you push PCM as it arrives and read a
 * continuously-refining hypothesis.
 *
 * MEASURED on the T-025 Linux box (streaming-zipformer-zh-14M, int8, 4 threads, CPU):
 *   test_wavs/0.wav  5.61 s audio -> 0.06 s wall  (RTF 0.010, ~100x real time)
 *   test_wavs/1.wav  5.15 s audio -> 0.05 s wall  (RTF 0.009, ~111x real time)
 * That headroom is what makes live captioning feel instant, and it is why F3 uses this
 * engine rather than a small whisper model.
 *
 * DEPENDENCY NOTE: `sherpa-onnx-node` is loaded via dynamic import and treated as
 * optional. It is a large native package (per-platform prebuilt binaries), and by the
 * same reasoning as the yt-dlp adapter, a missing optional component must degrade to an
 * explainable "not installed" state rather than crashing the daemon at import time.
 * It is therefore NOT listed in package.json by this module — see D-06 §10.
 */

import type { Backend } from '@openmemo/shared';

import type {
  AsrAvailability,
  AsrCapabilities,
  AsrEngine,
  AsrStream,
  AsrStreamEvents,
  StreamRequest,
  TranscribeChunkRequest,
  TranscriptSegment,
} from './types.js';
import { loadSherpaModule } from './sherpaModule.js';
import { detectRepetition } from './types.js';

/** Paths to the four files every sherpa-onnx transducer model ships. */
export interface SherpaTransducerModel {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  /** Display id, e.g. "streaming-zipformer-zh-14M". Recorded on the transcript row. */
  modelId: string;
  /** Languages this model covers, for engine selection. */
  languages: string[];
}

export interface SherpaOnnxEngineOptions {
  model: SherpaTransducerModel;
  numThreads?: number;
  /** sherpa provider string: 'cpu' | 'cuda' | 'coreml'. */
  provider?: string;
  /**
   * Endpoint detection turns a running hypothesis into a committed segment.
   * Defaults mirror sherpa-onnx's own recommended values.
   */
  rule1MinTrailingSilence?: number;
  rule2MinTrailingSilence?: number;
  rule3MinUtteranceLength?: number;
  /** Injected for tests. Defaults to `import('sherpa-onnx-node')`. */
  loadModule?: () => Promise<SherpaModule>;
}

// ---------------------------------------------------------------------------------------
// Minimal structural types for the parts of sherpa-onnx-node we use.
//
// ADR-001 mandate 2: the upstream object never crosses this module's boundary. Callers
// only ever see our TranscriptSegment.
// ---------------------------------------------------------------------------------------

interface SherpaResult {
  text: string;
  tokens?: string[];
  /** Seconds from the start of the stream, one per token. */
  timestamps?: number[];
  ys_probs?: number[];
}

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaRecognizer {
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  decode(stream: SherpaStream): void;
  isEndpoint(stream: SherpaStream): boolean;
  reset(stream: SherpaStream): void;
  getResult(stream: SherpaStream): SherpaResult;
}

export interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => SherpaRecognizer;
}

export const SHERPA_SAMPLE_RATE = 16_000;

export class SherpaOnnxEngine implements AsrEngine {
  readonly id = 'sherpa-onnx';
  readonly kind = 'asr' as const;

  private module: SherpaModule | null = null;
  private recognizer: SherpaRecognizer | null = null;

  constructor(private readonly opts: SherpaOnnxEngineOptions) {}

  async capabilities(): Promise<AsrCapabilities> {
    return {
      modes: ['stream'],
      backends: [(this.opts.provider === 'cuda' ? 'cuda' : 'cpu') as Backend],
      languages: this.opts.model.languages,
      // The transducer emits per-token timestamps, which is how we build word timings.
      wordTimestamps: true,
      // sherpa-onnx does offer diarization, but through a separate offline API.
      diarization: false,
    };
  }

  async isAvailable(): Promise<AsrAvailability> {
    try {
      await this.loadModule();
    } catch (err) {
      return {
        ok: false,
        reason: `the streaming recognition component is not installed (${
          err instanceof Error ? err.message : String(err)
        })`,
        remediation: 'Install the live-transcription component from Settings → Components.',
      };
    }
    const { access } = await import('node:fs/promises');
    for (const [label, p] of [
      ['encoder', this.opts.model.encoder],
      ['decoder', this.opts.model.decoder],
      ['joiner', this.opts.model.joiner],
      ['tokens', this.opts.model.tokens],
    ] as const) {
      try {
        await access(p);
      } catch {
        return {
          ok: false,
          reason: `streaming model file missing: ${label} (${p})`,
          remediation: 'Download the live-transcription model from Settings → Models.',
        };
      }
    }
    return { ok: true };
  }

  /**
   * Not supported: this engine exists for the live path.
   *
   * Throwing beats a silent fallback — if the scheduler ever routes a batch chunk here,
   * that is a routing bug and we want to see it, not to quietly transcribe with the
   * wrong engine.
   */
  async transcribeChunk(_req: TranscribeChunkRequest): Promise<TranscriptSegment[]> {
    throw new Error(
      'SherpaOnnxEngine is stream-only; use WhisperCppEngine for batch transcription',
    );
  }

  openStream(req: StreamRequest): AsrStream {
    return new SherpaAsrStream(this, req);
  }

  /** @internal */
  async ensureRecognizer(): Promise<SherpaRecognizer> {
    if (this.recognizer !== null) return this.recognizer;
    const mod = await this.loadModule();
    const m = this.opts.model;

    this.recognizer = new mod.OnlineRecognizer({
      featConfig: { sampleRate: SHERPA_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: m.encoder, decoder: m.decoder, joiner: m.joiner },
        tokens: m.tokens,
        numThreads: this.opts.numThreads ?? 4,
        provider: this.opts.provider ?? 'cpu',
        debug: false,
      },
      decodingMethod: 'greedy_search',
      // Endpointing is what converts "still talking" into a finalised segment.
      enableEndpoint: true,
      rule1MinTrailingSilence: this.opts.rule1MinTrailingSilence ?? 2.4,
      rule2MinTrailingSilence: this.opts.rule2MinTrailingSilence ?? 1.2,
      rule3MinUtteranceLength: this.opts.rule3MinUtteranceLength ?? 20,
    });
    return this.recognizer;
  }

  private async loadModule(): Promise<SherpaModule> {
    if (this.module !== null) return this.module;
    /*
     * Goes through the shared loader, not a bare dynamic import.
     *
     * This path USED to do `await import('sherpa-onnx-node')` directly and appeared to
     * work — but only because Node's cjs-module-lexer happens to hoist `OnlineRecognizer`
     * onto the namespace while leaving the offline constructors reachable only via
     * `.default`. It was passing by luck. See sherpaModule.ts.
     */
    const loader =
      this.opts.loadModule ??
      (async (): Promise<SherpaModule> => (await loadSherpaModule()) as unknown as SherpaModule);
    this.module = await loader();
    return this.module;
  }
}

/**
 * One live recording session.
 *
 * Lifecycle: `write()` PCM as it arrives → `partial` events while the hypothesis is still
 * moving → a `final` event each time sherpa reports an endpoint → `close()` flushes the
 * tail. Segment times are absolute from the start of the recording, which is what the
 * F5 timeline needs.
 */
class SherpaAsrStream implements AsrStream {
  /**
   * Handlers, stored type-erased.
   *
   * A `{ [K in keyof AsrStreamEvents]?: AsrStreamEvents[K][] }` map looks tidier but is
   * unusable: indexing it with a generic `K` gives TypeScript a UNION of array types, and
   * `push` on a union of arrays accepts only `never`. The public `on()` signature keeps
   * callers type-safe, which is where the safety actually matters.
   */
  private readonly handlers = new Map<keyof AsrStreamEvents, ((...args: never[]) => void)[]>();
  private recognizer: SherpaRecognizer | null = null;
  private stream: SherpaStream | null = null;
  private ready: Promise<void>;
  private closed = false;

  /** Samples consumed so far — the clock for absolute timestamps. */
  private samplesSeen = 0;
  /** Where the current utterance began, in ms from the start of the recording. */
  private utteranceStartMs = 0;
  private segmentIndex = 0;
  private lastPartialText = '';
  /** Serialises async work so writes cannot interleave mid-decode. */
  private queue: Promise<void> = Promise.resolve();
  /**
   * Set as soon as close() is called, to stop NEW writes being accepted.
   *
   * Distinct from `closed`, which is only set after the queue has drained. Collapsing
   * the two was a real bug: close() flipped the flag first, every already-queued write
   * saw it and bailed, and a whole recording produced zero segments.
   */
  private closing = false;

  constructor(
    private readonly engine: SherpaOnnxEngine,
    private readonly req: StreamRequest,
  ) {
    this.ready = (async () => {
      this.recognizer = await engine.ensureRecognizer();
      this.stream = this.recognizer.createStream();
    })().catch((err: unknown) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    req.signal.addEventListener('abort', () => void this.close(), { once: true });
  }

  on<K extends keyof AsrStreamEvents>(event: K, handler: AsrStreamEvents[K]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (...args: never[]) => void);
    this.handlers.set(event, list);
  }

  /**
   * Feed 16 kHz mono int16 PCM.
   *
   * Synchronous by contract (an audio callback must never await), so the real work is
   * chained onto an internal queue.
   */
  write(pcm: Int16Array): void {
    if (this.closing || this.closed) return;
    this.queue = this.queue
      .then(() => this.handleWrite(pcm))
      .catch((err: unknown) => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
  }

  private async handleWrite(pcm: Int16Array): Promise<void> {
    await this.ready;
    const rec = this.recognizer;
    const stream = this.stream;
    if (rec === null || stream === null || this.closed) return;

    stream.acceptWaveform({ sampleRate: SHERPA_SAMPLE_RATE, samples: int16ToFloat32(pcm) });
    this.samplesSeen += pcm.length;

    while (rec.isReady(stream)) rec.decode(stream);

    const result = rec.getResult(stream);
    const nowMs = (this.samplesSeen / SHERPA_SAMPLE_RATE) * 1000;

    if (rec.isEndpoint(stream)) {
      // Endpoint = the utterance is finished. Commit it and start a new one.
      if (result.text.trim().length > 0) {
        this.emit('final', this.toSegment(result, this.utteranceStartMs, nowMs, true));
      }
      rec.reset(stream);
      this.utteranceStartMs = nowMs;
      this.lastPartialText = '';
      return;
    }

    // Only emit when the hypothesis actually changed — the UI redraws on every event.
    if (result.text.length > 0 && result.text !== this.lastPartialText) {
      this.lastPartialText = result.text;
      this.emit('partial', this.toSegment(result, this.utteranceStartMs, nowMs, false));
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    // Drain BEFORE marking closed, so audio already handed to us is still decoded.
    await this.queue;
    await this.ready;
    this.closed = true;

    const rec = this.recognizer;
    const stream = this.stream;
    if (rec === null || stream === null) return;

    // Tail padding: without trailing silence the decoder holds back the last tokens and
    // the final words of a recording go missing.
    stream.acceptWaveform({
      sampleRate: SHERPA_SAMPLE_RATE,
      samples: new Float32Array(SHERPA_SAMPLE_RATE / 2),
    });
    while (rec.isReady(stream)) rec.decode(stream);

    const result = rec.getResult(stream);
    if (result.text.trim().length > 0) {
      const nowMs = (this.samplesSeen / SHERPA_SAMPLE_RATE) * 1000;
      this.emit('final', this.toSegment(result, this.utteranceStartMs, nowMs, true));
    }
    rec.reset(stream);
  }

  private toSegment(
    result: SherpaResult,
    startMs: number,
    endMs: number,
    isFinal: boolean,
  ): TranscriptSegment {
    const text = result.text.trim();

    // sherpa timestamps are seconds relative to the CURRENT utterance, so they are
    // shifted by the utterance start to become absolute.
    const words =
      result.tokens !== undefined && result.timestamps !== undefined
        ? result.tokens
            .map((tok, i) => ({
              w: tok,
              s: Math.round(startMs + (result.timestamps?.[i] ?? 0) * 1000),
              e: Math.round(
                startMs + (result.timestamps?.[i + 1] ?? result.timestamps?.[i] ?? 0) * 1000,
              ),
              ...(result.ys_probs?.[i] !== undefined ? { p: Math.exp(result.ys_probs[i]!) } : {}),
            }))
            .filter((w) => w.w.length > 0 && !w.w.startsWith('<'))
        : null;

    const confidence =
      result.ys_probs !== undefined && result.ys_probs.length > 0
        ? result.ys_probs.reduce((s, p) => s + Math.exp(p), 0) / result.ys_probs.length
        : null;

    return {
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      text,
      confidence,
      noSpeechProb: null,
      words: words !== null && words.length > 0 ? words : null,
      // Live segments are numbered sequentially; there is no VAD chunk plan here.
      chunkIdx: isFinal ? this.segmentIndex++ : this.segmentIndex,
      flags: detectRepetition(text) ? 1 : 0,
      speakerLabel: null,
    };
  }

  private emit<K extends keyof AsrStreamEvents>(
    event: K,
    ...args: Parameters<AsrStreamEvents[K]>
  ): void {
    const list = (this.handlers.get(event) ?? []) as ((...a: unknown[]) => void)[];
    for (const h of list) h(...args);
  }
}

/**
 * int16 PCM (what the browser's AudioWorklet and WAV files give us) to float32 (what
 * sherpa wants). Divide by 32768 so the range is [-1, 1).
 */
export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}
