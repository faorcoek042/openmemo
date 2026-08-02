/**
 * ParaformerEngine — the Chinese offline default (ADR-013 decision 1).
 *
 * WHY THIS IS THE DEFAULT FOR CHINESE (measured, T-026, same audio / same VAD plan /
 * same GPU-less machine):
 *
 *   whisper base            RTF 0.055   18x realtime   proper nouns ~2/13   ← unusable
 *   paraformer-zh-small     RTF 0.0119  84x realtime   proper nouns 12/13   ← this
 *   whisper large-v3-turbo  RTF 0.377   2.7x realtime  proper nouns 13/13
 *
 * For a one-hour recording that is 43 seconds versus 22 minutes. A 30x gap is not a
 * tuning difference, it is the difference between "usable without a GPU" and "not".
 *
 * WHAT IT COSTS (ADR-013 requires these be surfaced, not hidden):
 *   1. NO WORD-LEVEL TIMESTAMPS. Offline Paraformer returns text for a whole chunk and
 *      nothing finer. F5's Chinese highlighting degrades to segment level. This is the
 *      real reason `wordTimestamps: false` below is load-bearing rather than cosmetic —
 *      the UI reads it to decide which highlighting mode to draw.
 *   2. Chinese numerals ("两千零八年" not "2008年") — post-processed, see postprocess.ts.
 *   3. English arrives lowercase ("twitter") — post-processed, imperfectly.
 *
 * Punctuation is restored by a separate CT-Transformer model (measured 3–21 ms/chunk),
 * because the acoustic model emits none at all.
 */

import type { Backend } from '@openmemo/shared';

import { sliceWav } from '../audio/ffmpeg.js';
import type { ToolPaths } from '../tools.js';
import { fileExists } from '../tools.js';
import { restoreEnglishCasing, zhNumeralsToArabic } from './postprocess.js';
import { loadSherpaModule } from './sherpaModule.js';
import type {
  AsrAvailability,
  AsrCapabilities,
  AsrEngine,
  TranscribeChunkRequest,
  TranscriptSegment,
} from './types.js';
import { detectRepetition } from './types.js';

export interface ParaformerModel {
  /** Path to the Paraformer ONNX (typically `model.int8.onnx`). */
  model: string;
  tokens: string;
  modelId: string;
  languages: string[];
}

export interface PunctuationModel {
  /** CT-Transformer punctuation ONNX. */
  model: string;
  modelId: string;
}

export interface ParaformerEngineOptions {
  tools: ToolPaths;
  cwd: string;
  model: ParaformerModel;
  /**
   * Optional. Without it the transcript has NO punctuation at all — technically usable,
   * genuinely unpleasant to read, and worse as LLM input for mind-map generation.
   */
  punctuation?: PunctuationModel;
  numThreads?: number;
  provider?: string;
  /**
   * Convert Chinese numerals to Arabic. **Default FALSE — do not turn this on yet.**
   *
   * MEASURED REGRESSION (T-030): the current rules fire on partial matches and make the
   * text WORSE than the raw model output:
   *     两千零六年 -> 两千06年     (mangled: 千 is a unit, so the digit-run parse bails
   *                                and the unit-word rule then eats only "零六")
   *     两千万人次 -> 20000000人次 (technically right, reads worse than 2000万)
   * A transcript the user cannot tell we corrupted is worse than one we left alone, so
   * this stays off until the parser handles mixed positional/digit-run forms. The code
   * and its tests are kept because the need is real (the mind-map LLM extracts dates),
   * it is just not correct yet. ADR-013 downgraded this to polish; shipping it broken
   * would not have been polish, it would have been damage.
   */
  normalizeNumerals?: boolean;
  /**
   * Restore casing for known terms (twitter -> Twitter, sms -> SMS). Default TRUE.
   * Verified safe: it is a fixed allowlist, so an unlisted term is left exactly as the
   * model produced it and no text can be made worse.
   */
  restoreCasing?: boolean;
  loadModule?: () => Promise<ParaformerSherpaModule>;
}

// ---------------------------------------------------------------------------------------
// Structural types for the sherpa-onnx surface we use. Nothing here escapes this module.
// ---------------------------------------------------------------------------------------

interface OfflineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface OfflineRecognizerLike {
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): { text: string };
}

interface OfflinePunctuationLike {
  addPunct(text: string): string;
}

export interface ParaformerSherpaModule {
  OfflineRecognizer: new (config: unknown) => OfflineRecognizerLike;
  OfflinePunctuation: new (config: unknown) => OfflinePunctuationLike;
  readWave: (path: string) => { sampleRate: number; samples: Float32Array };
}

export class ParaformerEngine implements AsrEngine {
  readonly id = 'paraformer';
  readonly kind = 'asr' as const;

  private module: ParaformerSherpaModule | null = null;
  private recognizer: OfflineRecognizerLike | null = null;
  private punct: OfflinePunctuationLike | null = null;
  /** Model path the cached recognizer was built for; drives cache invalidation. */
  private loadedModelPath: string | null = null;

  constructor(private readonly opts: ParaformerEngineOptions) {}

  async capabilities(): Promise<AsrCapabilities> {
    return {
      modes: ['batch'],
      backends: [(this.opts.provider === 'cuda' ? 'cuda' : 'cpu') as Backend],
      languages: this.opts.model.languages,
      /**
       * FALSE, and this is not a limitation we can engineer around — offline Paraformer
       * simply does not emit per-token times. The UI keys F5's highlighting mode off
       * this flag, so reporting `true` here would produce a timeline that silently
       * cannot be drawn. ADR-013: expose the cost, do not paper over it.
       */
      wordTimestamps: false,
      diarization: false,
      /*
       * 8 s, not the 30 s default.
       *
       * One call returns one segment, so chunk length is the timeline granularity. At
       * 84x real time the extra calls cost almost nothing (a 30 s window is ~0.36 s of
       * compute either way), and it turns "one 30 s block of text" into a usable
       * timeline — which is the whole point of ADR-013's segment-level fallback.
       */
      preferredChunkMs: 8_000,
    };
  }

  async isAvailable(): Promise<AsrAvailability> {
    try {
      await this.loadModule();
    } catch (err) {
      return {
        ok: false,
        reason: `the Chinese recognition component is not installed (${
          err instanceof Error ? err.message : String(err)
        })`,
        remediation: 'Install the Chinese engine from Settings → Components.',
      };
    }
    for (const [label, p] of [
      ['model', this.opts.model.model],
      ['tokens', this.opts.model.tokens],
    ] as const) {
      if (!(await fileExists(p))) {
        return {
          ok: false,
          reason: `Chinese model file missing: ${label} (${p})`,
          remediation: 'Download the Chinese model from Settings → Models.',
        };
      }
    }
    return { ok: true };
  }

  /**
   * Transcribe one VAD chunk.
   *
   * The chunk is cut out with ffmpeg rather than read wholesale, so memory stays flat on
   * multi-hour input (measured on a 33.6-minute file: peak RSS 89 MB).
   */
  async transcribeChunk(req: TranscribeChunkRequest): Promise<TranscriptSegment[]> {
    // req.modelPath wins over the constructor default, so "switch model and re-run"
    // actually switches. Before this, the request's modelPath was ignored entirely and
    // the engine silently kept using whatever it was constructed with.
    const { recognizer, mod } = await this.ensure(req.modelPath);

    const slicePath = await sliceWav(this.opts.tools, req.audioPath, {
      startMs: req.offsetMs,
      endMs: req.offsetMs + req.durationMs,
      destDir: this.opts.cwd,
      destBasename: `para-${String(req.chunkIndex)}-${String(Date.now())}`,
      cwd: this.opts.cwd,
      signal: req.signal,
    });

    try {
      const wave = mod.readWave(slicePath);
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
      recognizer.decode(stream);

      let text = recognizer.getResult(stream).text.trim();
      if (text.length === 0) return [];

      if (this.punct !== null) text = this.punct.addPunct(text);
      // Opt-in, not opt-out: see normalizeNumerals in the options doc.
      if (this.opts.normalizeNumerals === true) text = zhNumeralsToArabic(text);
      if (this.opts.restoreCasing !== false) text = restoreEnglishCasing(text);

      req.onProgress?.(1);

      /**
       * ONE segment per chunk, spanning the whole chunk.
       *
       * This is the segment-level degradation in concrete form: the only timing
       * information available is the VAD chunk boundary the caller already knew. We do
       * NOT interpolate per-sentence times from character counts — that would look like
       * real timestamps while being fabricated, which is exactly what ADR-004 decision 3
       * forbids. Segment granularity is honest; invented sentence granularity is not.
       */
      return [
        {
          startMs: req.offsetMs,
          endMs: req.offsetMs + req.durationMs,
          text,
          // Paraformer exposes no per-utterance score through this API.
          confidence: null,
          noSpeechProb: null,
          words: null,
          chunkIdx: req.chunkIndex,
          flags: detectRepetition(text) ? 1 : 0,
          speakerLabel: null,
        },
      ];
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(slicePath).catch(() => undefined);
    }
  }

  private async ensure(
    modelPath?: string,
  ): Promise<{ recognizer: OfflineRecognizerLike; mod: ParaformerSherpaModule }> {
    const mod = await this.loadModule();
    const wanted = modelPath !== undefined && modelPath.length > 0 ? modelPath : this.opts.model.model;

    // Rebuild when the requested model differs from the cached one.
    if (this.recognizer !== null && this.loadedModelPath !== wanted) {
      this.recognizer = null;
    }

    if (this.recognizer === null) {
      this.recognizer = new mod.OfflineRecognizer({
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          paraformer: { model: wanted },
          tokens: this.opts.model.tokens,
          numThreads: this.opts.numThreads ?? 4,
          provider: this.opts.provider ?? 'cpu',
          debug: false,
        },
        decodingMethod: 'greedy_search',
      });
      this.loadedModelPath = wanted;
    }
    if (this.punct === null && this.opts.punctuation !== undefined) {
      if (await fileExists(this.opts.punctuation.model)) {
        this.punct = new mod.OfflinePunctuation({
          model: {
            ctTransformer: this.opts.punctuation.model,
            numThreads: this.opts.numThreads ?? 4,
            provider: this.opts.provider ?? 'cpu',
            debug: false,
          },
        });
      }
      // Missing punctuation model is a degradation, not a failure: unpunctuated text
      // still beats no transcript.
    }
    return { recognizer: this.recognizer, mod };
  }

  private async loadModule(): Promise<ParaformerSherpaModule> {
    if (this.module !== null) return this.module;
    const loader =
      this.opts.loadModule ??
      (async (): Promise<ParaformerSherpaModule> =>
        (await loadSherpaModule()) as unknown as ParaformerSherpaModule);
    this.module = await loader();
    return this.module;
  }
}
