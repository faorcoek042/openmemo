/**
 * The transcription pipeline. D-01 §5 (F1/F2), §4.1, §4.5.
 *
 * fetch → probe → normalize → vad → [chunk → asr → PERSIST] × N
 *
 * The bracketed loop is the whole design. After every chunk we:
 *   1. hand the segments to `onChunkComplete`, which the daemon commits in ONE
 *      transaction — so the DB is always consistent and always current;
 *   2. report real progress (chunks done / chunks total), not a guess;
 *   3. check for preemption and yield the lane if something more urgent arrived;
 *   4. leave a resume point — a crash here costs at most one chunk.
 *
 * D-01 §4.5: the persisted segments ARE the checkpoint. `resumeFromChunk` is a cache to
 * skip work, but the database is the source of truth about what has been done.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AsrChunk } from './audio/vad.js';
import { detectSpeechSegments, planChunks, planFixedChunks, totalSpeechMs } from './audio/vad.js';
import { normalizeToPcm16k, probeMedia } from './audio/ffmpeg.js';
import type { AsrEngine, TranscriptSegment } from './asr/types.js';
import type { MediaSourceRegistry } from './media/registry.js';
import type { FetchedMedia, MediaInfo } from './media/types.js';
import type { Lane, LaneManager, PreemptionCheck } from './queue/lanes.js';
import type { ManagedDirs, ToolPaths } from './tools.js';

export type PipelineStep =
  | 'fetch'
  | 'probe'
  | 'normalize'
  | 'vad'
  | 'asr'
  | 'done';

export interface StepProgress {
  step: PipelineStep;
  /** 0..1 within the current step. */
  fraction: number;
  /** Populated during `asr`. */
  chunksDone?: number;
  chunksTotal?: number;
  message?: string;
}

export interface TranscribeRequest {
  /** URL or absolute local path. */
  input: string;
  /** Opaque id used for scratch directory naming. Ours, never user-supplied. */
  jobId: string;
  modelPath: string;
  language?: string;
  prompt?: string;
  threads?: number;
  maxBytes?: number;
  priority: number;
  signal: AbortSignal;

  onProgress?: (p: StepProgress) => void;
  /**
   * Called once per completed chunk. MUST be durable before it resolves — the pipeline
   * treats a resolved promise as "this chunk is safely persisted" and will not replay it.
   */
  onChunkComplete?: (chunk: AsrChunk, segments: TranscriptSegment[]) => Promise<void>;
  /**
   * Resume support (D-01 §4.5). Chunks whose index is in this set are skipped.
   * Derive it from `SELECT DISTINCT chunk_idx FROM transcript_segments`.
   */
  completedChunkIndices?: ReadonlySet<number>;
  /**
   * Plan version. If it does not match `PLAN_VERSION`, the caller must NOT resume by
   * chunk index — steps may have shifted. Re-derive from artifacts instead.
   */
  planVersion?: number;
}

/**
 * Bump whenever the step sequence changes.
 *
 * D-01 §4.5: an app upgrade that adds or reorders steps would otherwise make old
 * checkpoints point at the wrong step. Version mismatch means "re-derive progress from
 * which artifacts exist", never "trust the stored index".
 */
export const PLAN_VERSION = 1;

export interface TranscribeResult {
  info: MediaInfo;
  media: FetchedMedia;
  normalizedPath: string;
  durationMs: number;
  chunks: AsrChunk[];
  segments: TranscriptSegment[];
  speechMs: number;
  /** Wall-clock seconds / audio seconds. Measured, never estimated (ADR-004 decision 3). */
  rtf: number | null;
  timings: Record<PipelineStep, number>;
  /** True when we stopped early to let a higher-priority job through. */
  yielded: boolean;
  /** Chunks not attempted because we yielded — the resume set for next time. */
  remainingChunks: number[];
}

export interface TranscribePipelineOptions {
  tools: ToolPaths;
  dirs: ManagedDirs;
  registry: MediaSourceRegistry;
  asr: AsrEngine;
  lanes?: LaneManager;
  preemption?: PreemptionCheck;
  /** Chunk planning knobs; defaults follow D-01/whisper's 30 s window. */
  targetChunkMs?: number;
  maxChunkMs?: number;
}

export class TranscribePipeline {
  constructor(private readonly opts: TranscribePipelineOptions) {}

  async run(req: TranscribeRequest): Promise<TranscribeResult> {
    const { tools, dirs, registry, asr } = this.opts;
    const timings = {} as Record<PipelineStep, number>;
    const scratch = join(dirs.tempDir, `job-${req.jobId}`);
    await mkdir(scratch, { recursive: true });

    const time = async <T>(step: PipelineStep, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        timings[step] = Date.now() - t0;
      }
    };

    // ---- 1. resolve + probe --------------------------------------------------------
    //
    // probeWithSource walks the candidate list and returns the adapter that actually
    // succeeded. Using resolve() + probe() separately would bypass the fallback chain
    // (D-01 §6.4): the GPL fallback would never engage, and a transient network error on
    // the first candidate would fail the whole job instead of trying the next one.
    const { source, info } = await time('probe', async () => {
      req.onProgress?.({ step: 'probe', fraction: 0 });
      const probed = await registry.probeWithSource(req.input, req.signal);
      req.onProgress?.({ step: 'probe', fraction: 1 });
      return probed;
    });

    if (info.isCollection) {
      // A feed or playlist is not one transcription job. The caller fans it out.
      throw new Error(
        `this link contains ${String(info.children?.length ?? 0)} items; import them individually`,
      );
    }

    // ---- 2. fetch ------------------------------------------------------------------
    const media = await time('fetch', () =>
      this.inLane('net.download', req.signal, () =>
        source.fetch({
          input: req.input,
          destDir: scratch,
          // D-01 §8.5: the filename is ours. The user's title is display-only.
          destBasename: 'source',
          preferAudioOnly: true,
          maxBytes: req.maxBytes ?? 4 * 1024 * 1024 * 1024,
          signal: req.signal,
          onProgress: (f) => req.onProgress?.({ step: 'fetch', fraction: f }),
        }),
      ),
    );

    // ---- 3. normalize to 16 kHz mono ----------------------------------------------
    const probed = await probeMedia(tools, media.path, { cwd: scratch, signal: req.signal });
    const normalized = await time('normalize', () =>
      this.inLane('cpu.media', req.signal, () =>
        normalizeToPcm16k(tools, media.path, {
          destDir: scratch,
          destBasename: 'audio16k',
          cwd: scratch,
          signal: req.signal,
          totalDurationMs: probed.durationMs,
          onProgress: (f) => req.onProgress?.({ step: 'normalize', fraction: f }),
        }),
      ),
    );

    const durationMs = normalized.durationMs ?? probed.durationMs ?? 0;
    if (durationMs <= 0) throw new Error('could not determine audio duration');

    // ---- 4. VAD --------------------------------------------------------------------
    const { chunks, speechMs } = await time('vad', () =>
      this.inLane('cpu.media', req.signal, async () => {
        req.onProgress?.({ step: 'vad', fraction: 0 });
        let plan: AsrChunk[];
        let speech: number;

        const vadUsable = tools.whisperVad !== null && tools.vadModel !== null;
        if (vadUsable) {
          const segments = await detectSpeechSegments(tools, normalized.path, {
            cwd: scratch,
            signal: req.signal,
            threads: req.threads,
          });
          speech = totalSpeechMs(segments);
          plan =
            segments.length > 0
              ? planChunks(segments, {
                  totalDurationMs: durationMs,
                  targetChunkMs: this.opts.targetChunkMs,
                  maxChunkMs: this.opts.maxChunkMs,
                })
              : // VAD ran and found no speech. Do not silently transcribe silence —
                // whisper hallucinates on it. Zero chunks is the honest answer.
                [];
        } else {
          // Degradation, not failure: fixed windows still produce a usable transcript.
          plan = planFixedChunks(durationMs, this.opts.targetChunkMs ?? 30_000);
          speech = durationMs;
        }

        req.onProgress?.({ step: 'vad', fraction: 1, message: `${String(plan.length)} chunks` });
        return { chunks: plan, speechMs: speech };
      }),
    );

    // ---- 5. ASR, chunk by chunk ----------------------------------------------------
    const completed = req.completedChunkIndices ?? new Set<number>();
    const segments: TranscriptSegment[] = [];
    const remaining: number[] = [];
    let yielded = false;
    let chunksDone = 0;

    const asrStart = Date.now();
    await time('asr', async () => {
      for (const chunk of chunks) {
        if (req.signal.aborted) throw new Error('cancelled');

        // D-01 §4.5 — already persisted, never redo it.
        if (completed.has(chunk.index)) {
          chunksDone += 1;
          continue;
        }

        if (yielded) {
          remaining.push(chunk.index);
          continue;
        }

        const produced = await this.inLane('gpu.asr', req.signal, () =>
          asr.transcribeChunk({
            audioPath: normalized.path,
            chunkIndex: chunk.index,
            offsetMs: chunk.startMs,
            durationMs: chunk.endMs - chunk.startMs,
            modelPath: req.modelPath,
            language: req.language,
            prompt: req.prompt,
            threads: req.threads,
            signal: req.signal,
          }),
        );

        // Chunks overlap by design, and whisper over-runs its window, so the same
        // speech can be transcribed twice at a boundary. Drop the duplicate before it
        // reaches the database.
        const deduped = dedupeBoundarySegments(segments, produced);
        segments.push(...deduped);
        chunksDone += 1;

        // Persist BEFORE reporting progress: progress the user can see must never be
        // ahead of what survives a crash.
        await req.onChunkComplete?.(chunk, deduped);

        req.onProgress?.({
          step: 'asr',
          fraction: chunks.length === 0 ? 1 : chunksDone / chunks.length,
          chunksDone,
          chunksTotal: chunks.length,
        });

        // D-01 §4.3 — cooperative preemption, only at a chunk boundary.
        if (this.opts.preemption?.shouldYield(req.priority) === true) {
          yielded = true;
        }
      }
    });

    const asrSeconds = (Date.now() - asrStart) / 1000;
    const audioSeconds = durationMs / 1000;

    req.onProgress?.({ step: 'done', fraction: 1, chunksDone, chunksTotal: chunks.length });

    return {
      info,
      media,
      normalizedPath: normalized.path,
      durationMs,
      chunks,
      segments,
      speechMs,
      // Only meaningful if we actually transcribed the whole thing.
      rtf: audioSeconds > 0 && !yielded && completed.size === 0 ? asrSeconds / audioSeconds : null,
      timings,
      yielded,
      remainingChunks: remaining,
    };
  }

  private async inLane<T>(lane: Lane, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    if (this.opts.lanes === undefined) return fn();
    return this.opts.lanes.withLane(lane, fn, signal);
  }
}


/**
 * Drop segments that duplicate speech already captured by the previous chunk.
 *
 * WHY THIS IS NEEDED (observed in the real multi-chunk run, D-06 §6):
 * chunk plans overlap slightly by design (VAD padding), and whisper additionally
 * decodes in 30 s windows, so it will emit a segment that begins inside our window but
 * runs well past it. The next chunk then transcribes the same speech again, and the
 * transcript reads:
 *
 *     [26.5s ch0] with a 20 million because of the West Indies, the 40 million …
 *     [26.4s ch1] with the 20 million equals of the West Indies, the 40 million …
 *
 * Near-identical text, non-monotonic timestamps, and F5's playback highlighting would
 * flicker between the two. Text similarity alone is not a safe test — a speaker really
 * can repeat themselves — so we require substantial TIME overlap as well.
 */
export function dedupeBoundarySegments(
  accepted: TranscriptSegment[],
  incoming: TranscriptSegment[],
  overlapRatio = 0.5,
): TranscriptSegment[] {
  if (accepted.length === 0) return incoming;
  const lastEnd = Math.max(...accepted.map((s) => s.endMs));
  const out: TranscriptSegment[] = [];

  for (const seg of incoming) {
    const duration = Math.max(1, seg.endMs - seg.startMs);
    const overlap = Math.max(0, Math.min(lastEnd, seg.endMs) - seg.startMs);
    if (overlap / duration > overlapRatio) continue;
    out.push(seg);
  }
  return out;
}

/**
 * Rebuild the resume set from what is already in the database.
 *
 * D-01 §4.5: when `plan_version` does not match, chunk indices from the old plan are
 * meaningless — the chunk boundaries themselves may have moved. Returning an empty set
 * forces a clean re-run, which is correct-but-slow rather than fast-but-wrong.
 */
export function deriveResumeSet(
  persistedChunkIndices: number[],
  storedPlanVersion: number | null,
): ReadonlySet<number> {
  if (storedPlanVersion !== PLAN_VERSION) return new Set<number>();
  return new Set(persistedChunkIndices);
}
