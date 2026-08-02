/**
 * @openmemo/pipeline — media import → transcription → structured segments (F1/F2/F3).
 *
 * Every native tool runs as a subprocess (ADR-003 decision 1). `subprocess/runner.ts` is
 * the only module here permitted to import `node:child_process`.
 *
 * Two design commitments worth knowing before reading further:
 *
 *  1. TD-002 / ADR-002 — yt-dlp (GPLv3+) is ONE registry entry. Disable it and the
 *     product still imports podcasts, RSS feeds, HLS streams and direct links. This is
 *     asserted by a test, not by a comment.
 *
 *  2. D-01 §4.1 — transcription is chunked at VAD boundaries so that one completed chunk
 *     is simultaneously a DB transaction, a preemption point, a resume point and a real
 *     progress tick. Everything in `transcribe.ts` follows from that.
 */

import { DirectHttpSource } from './media/sources/directHttp.js';
import { LocalFileSource } from './media/sources/localFile.js';
import { RssSource } from './media/sources/rss.js';
import { YtDlpSource } from './media/sources/ytdlp.js';
import { MediaSourceRegistry } from './media/registry.js';
import type { ToolPaths } from './tools.js';

export const PACKAGE_NAME = '@openmemo/pipeline' as const;

// -- subprocess + security ----------------------------------------------------------------
export {
  MAX_PROMPT_CHARS,
  MAX_URL_BYTES,
  MEDIA_EXTENSIONS,
  PLAYLIST_EXTENSIONS,
  assertHostNotPrivate,
  assertWithinRoot,
  buildArgv,
  hasAllowedMediaExtension,
  isLocalImportSafeExtension,
  isPlaylistExtension,
  isPrivateOrReservedHost,
  isSafeExecutable,
  rejectsLeadingDash,
  safePrompt,
  validateHttpUrl,
} from './subprocess/argGuard.js';
export type { ArgvSpec, GuardFailureCode, GuardResult, SafeUrl } from './subprocess/argGuard.js';

export {
  KILL_GRACE_MS,
  MAX_STREAM_BYTES,
  SubprocessError,
  buildChildEnv,
  run,
  runOrThrow,
} from './subprocess/runner.js';
export type { RunOptions, RunResult } from './subprocess/runner.js';

// -- tools ---------------------------------------------------------------------------------
export {
  defaultStoreRoot,
  discoverTools,
  fileExists,
  findInBackendPacks,
  findInstalledModel,
  isExecutable,
  listInstalledModels,
} from './tools.js';
export type { ManagedDirs, ToolPaths } from './tools.js';

// -- media sources -------------------------------------------------------------------------
export { MediaSourceRegistry } from './media/registry.js';
export type { RegistryEntry } from './media/registry.js';
export { NoMediaSourceError } from './media/types.js';
export type {
  Availability,
  FetchRequest,
  FetchedMedia,
  MediaInfo,
  MediaSource,
  MediaSourceId,
  MediaTrack,
} from './media/types.js';

export { LocalFileSource } from './media/sources/localFile.js';
export { DirectHttpSource } from './media/sources/directHttp.js';
export {
  MAX_FEED_ITEMS,
  RssSource,
  looksLikeFeed,
  parseFeed,
  parseItunesDuration,
} from './media/sources/rss.js';
export type { FeedItem } from './media/sources/rss.js';
/**
 * The GPL fallback. This import site is deliberately the only place the identifier
 * appears outside its own module — see D-06 §8 for the CI grep that keeps it that way.
 */
export { YtDlpSource } from './media/sources/ytdlp.js';

// -- audio ----------------------------------------------------------------------------------
export {
  ASR_CHANNELS,
  ASR_SAMPLE_RATE,
  checkFfmpeg,
  normalizeToPcm16k,
  parseFfprobeJson,
  probeMedia,
  sliceWav,
} from './audio/ffmpeg.js';
export type { NormalizeResult, ProbeResult } from './audio/ffmpeg.js';

export {
  detectSpeechSegments,
  parseVadOutput,
  planChunks,
  planFixedChunks,
  totalSpeechMs,
} from './audio/vad.js';
export type { AsrChunk, ChunkPlanOptions, SpeechSegment, VadOptions } from './audio/vad.js';

// -- ASR ------------------------------------------------------------------------------------
export { SEGMENT_FLAG, detectRepetition, logprobToConfidence } from './asr/types.js';
export type {
  AsrAvailability,
  AsrCapabilities,
  AsrEngine,
  AsrStream,
  StreamRequest,
  TranscribeChunkRequest,
  TranscriptSegment,
  WordTimestamp,
} from './asr/types.js';

export { WhisperCppEngine, parseWhisperJson } from './asr/whisperCpp.js';
export type { ParseWhisperOptions, WhisperCppEngineOptions } from './asr/whisperCpp.js';

// F3 live path.
export { SHERPA_SAMPLE_RATE, SherpaOnnxEngine, int16ToFloat32 } from './asr/sherpaOnnx.js';
export type {
  SherpaModule,
  SherpaOnnxEngineOptions,
  SherpaTransducerModel,
} from './asr/sherpaOnnx.js';

// Resident-server mode: keeps the model loaded across chunks (D-01 §6.1).
export { WhisperServerEngine, parseServerResponse } from './asr/whisperServer.js';
export type { WhisperServerEngineOptions } from './asr/whisperServer.js';

// Resumable media download.
export { resumableFetch } from './media/resumableFetch.js';
export type { ResumableFetchOptions, ResumableFetchResult } from './media/resumableFetch.js';

// Chinese offline default (ADR-013 decision 1).
export { ParaformerEngine } from './asr/paraformer.js';
export { loadSherpaModule, normalizeSherpaModule } from './asr/sherpaModule.js';
export type { SherpaExports } from './asr/sherpaModule.js';
export type {
  ParaformerEngineOptions,
  ParaformerModel,
  ParaformerSherpaModule,
  PunctuationModel,
} from './asr/paraformer.js';

// Paraformer post-processing (Chinese numerals, English casing).
export {
  hasChineseNumerals,
  parseChineseNumber,
  postprocessChinese,
  restoreEnglishCasing,
  zhNumeralsToArabic,
} from './asr/postprocess.js';

// Engine selection.
export { buildCandidates, isChinese, selectEngine } from './asr/selectEngine.js';
export type {
  EngineCandidate,
  EngineId,
  EngineSelection,
  EngineTradeoff,
  SelectEngineInput,
  TranscriptionMode,
} from './asr/selectEngine.js';

// In-product benchmark (ADR-004 decision 3).
export { BENCHMARK_CLIPS, clipForLanguage } from './benchmark/clips.js';
export type { BenchmarkClip } from './benchmark/clips.js';
export {
  decodeClip,
  formatBenchmark,
  runBenchmark,
  toBenchmarkResult,
} from './benchmark/runBenchmark.js';
export type { BenchmarkOutcome, BenchmarkReport, RunBenchmarkOptions } from './benchmark/runBenchmark.js';

// F3 two-phase merge (streaming draft -> offline re-run, preserving user edits).
export {
  buildDiff,
  formatMergeSummary,
  isEdited,
  mergeTranscripts,
  overlapFraction,
} from './asr/merge.js';
export type {
  MergeDecision,
  MergeOptions,
  MergeResult,
  MergeableSegment,
  SegmentDiff,
} from './asr/merge.js';

// -- queue -----------------------------------------------------------------------------------
export {
  LANES,
  LaneManager,
  PRIORITY,
  PriorityTracker,
  defaultCapacities,
} from './queue/lanes.js';
export type { Lane, LaneCapacities, LaneStats, PreemptionCheck, Priority } from './queue/lanes.js';

// -- pipeline ---------------------------------------------------------------------------------
export {
  PLAN_VERSION,
  TranscribePipeline,
  dedupeBoundarySegments,
  stripDuplicatedPrefix,
  deriveResumeSet,
} from './transcribe.js';
export type {
  PipelineStep,
  StepProgress,
  TranscribePipelineOptions,
  TranscribeRequest,
  TranscribeResult,
} from './transcribe.js';

export interface BuildRegistryOptions {
  tools: ToolPaths;
  cwd: string;
  /** Root that LocalFileSource is confined to. */
  allowedRoot: string;
  /**
   * TD-002's kill switch. Set false and the GPL adapter is never consulted;
   * everything else keeps working.
   */
  enableSiteExtractor?: boolean;
}

/**
 * Standard registry.
 *
 * Registration order is irrelevant (resolution sorts by `match` score); what matters is
 * that YtDlpSource scores lowest, so the licence-clean adapters always get first refusal.
 */
export function buildDefaultRegistry(opts: BuildRegistryOptions): MediaSourceRegistry {
  const registry = new MediaSourceRegistry();
  registry.register(
    new LocalFileSource({ tools: opts.tools, allowedRoot: opts.allowedRoot, cwd: opts.cwd }),
  );
  registry.register(new DirectHttpSource({ tools: opts.tools, cwd: opts.cwd }));
  registry.register(new RssSource());
  registry.register(
    new YtDlpSource({ tools: opts.tools, cwd: opts.cwd }),
    opts.enableSiteExtractor ?? true,
  );
  return registry;
}
