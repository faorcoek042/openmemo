/**
 * Server-Sent Events contract.
 *
 * ADR-004 decision 5: SSE, not WebSocket, for server→client push.
 * HARD CONSTRAINT: exactly ONE global stream at `GET /api/events`.
 *
 * Why one stream: HTTP/1.1 caps concurrent connections at 6 per origin. One stream per
 * download would exhaust that with three downloads plus a transcription in flight, and
 * every subsequent fetch would hang. D-05 §2.3 additionally elects a single leader tab
 * via Web Locks and rebroadcasts over BroadcastChannel, so the whole browser holds one.
 *
 * Live microphone capture (F3) uploads audio over a WebSocket instead — that direction is
 * genuinely bidirectional and binary. Transport is chosen per use case.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE NOTE (ADR-007 decision 1)
 * Until 2026-08-02 this file only covered the model/download/backend domain (14 events).
 * `architect` correctly flagged in D-05 §9 that F1–F5 had no realtime events at all,
 * which would have forced T-021/T-023 to poll and lose "text on screen in 14 seconds".
 * The pipeline/transcription/mindmap/note events below close that gap.
 *
 * D-05 did not specify payloads, so these are derived from D-01's F1–F5 sequence
 * diagrams (`job.progress {step:"fetch", pct}`, `job.done {noteUid}`) and D-05 §4.1/4.3/4.6.
 * Derivation is recorded in coordination/inbox/model-mgmt.md for `architect` to confirm.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { DownloadJob, JobError, JobState } from './jobs.js';
import type { HardwareInfo } from './hardware.js';

export const SSE_EVENT_TYPES = [
  // ── job lifecycle (generic: downloads AND pipeline jobs) ──
  'job.created',
  'job.progress',
  'job.state',
  'job.done',
  'job.failed',
  'job.blocked',
  // ── model / backend / storage domain ──
  'model.installed',
  'model.removed',
  'model.activated',
  'backend.installed',
  'backend.removed',
  'storage.changed',
  'catalog.updated',
  'sources.probed',
  'hardware.changed',
  // ── F1/F2 media import ──
  'media.ready',
  'media.asset.ready',
  // ── F1/F2/F3 transcription ──
  'transcribe.started',
  'transcribe.partial',
  'transcribe.segment',
  'transcribe.done',
  'transcribe.replaced',
  // ── F3 recording ──
  'record.state',
  // ── F4 mindmap ──
  'mindmap.delta',
  'mindmap.done',
  // ── F5 notes ──
  'note.created',
  'note.updated',
  'note.deleted',
  // ── stream control ──
  'sync.required',
  'keepalive',
] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/**
 * Progress emission is throttled to at most 4 messages/second/topic server-side
 * (D-01 §3.3 specifies 250 ms coalescing per topic — the same number).
 * At 8 MB/s an unthrottled byte-level stream saturates the browser's render loop.
 */
export const PROGRESS_THROTTLE_HZ = 4;
export const PROGRESS_THROTTLE_MS = 250;
export const KEEPALIVE_INTERVAL_MS = 15_000;
/** Ring-buffer size for Last-Event-ID replay. Overflow emits `sync.required`. */
export const SSE_REPLAY_BUFFER_SIZE = 256;

/**
 * Fields every event carries.
 *
 * `topic` implements D-01 §3.3's `域.动作[.阶段]` addressing: it is the coalescing key for
 * throttled events (`job:<uid>`, `transcript:<uid>`) and lets the client route without
 * inspecting the payload.
 *
 * NOTE: the envelope is FLAT (fields at top level) rather than D-01's nested
 * `{type, ts, topic, payload}`. D-05 §2.3 was written against the flat shape and reads
 * e.g. `DownloadJob` straight off the event. Flat also gives TypeScript a clean
 * discriminated union on `type`. Flagged for Manager confirmation.
 */
export interface SseEventBase {
  type: SseEventType;
  /** ISO-8601 emission time. */
  ts: string;
  /** Coalescing / routing key, e.g. "job:01J8…", "transcript:01J9…". */
  topic: string;
}

/* ------------------------------ job lifecycle ----------------------------- */

export interface JobCreatedEvent extends SseEventBase {
  type: 'job.created';
  job: DownloadJob;
}

/**
 * Generic progress. Used by downloads AND pipeline jobs (fetch/demux/vad/asr/structure).
 * D-05 §2.3: never written into the Query cache — it goes to a transient store.
 */
export interface JobProgressEvent extends SseEventBase {
  type: 'job.progress';
  jobId: string;
  /** Machine-readable stage, e.g. "probe" | "fetch" | "demux" | "vad" | "asr" | "structure". */
  step: string | null;
  /** 0..1. Null when the step genuinely cannot report a fraction. */
  pct: number | null;
  /** Byte counters, for transfer-shaped steps. Null for compute-shaped steps. */
  completedBytes: number | null;
  totalBytes: number | null;
  speedBps: number | null;
  /**
   * Seconds remaining. D-05 §4.1 rule 4: only show when there is a real basis, and round
   * to "about X minutes" — never render a false-precision countdown.
   */
  etaSeconds: number | null;
  state: JobState;
}

export interface JobStateEvent extends SseEventBase {
  type: 'job.state';
  jobId: string;
  state: JobState;
  previousState: JobState;
}

export interface JobDoneEvent extends SseEventBase {
  type: 'job.done';
  jobId: string;
  /** Primary entity produced, e.g. the note ULID. D-01: `job.done {noteUid}`. */
  resultUid: string | null;
  resultKind: 'note' | 'transcript' | 'mindmap' | 'model' | 'backend' | null;
}

export interface JobFailedEvent extends SseEventBase {
  type: 'job.failed';
  jobId: string;
  error: JobError;
  /** D-05 §2.3: only toast when this is false — retries in flight should not nag. */
  willRetry: boolean;
  nextProvider: string | null;
}

/**
 * Job cannot proceed until a precondition is met (D-02 `jobs.blocked_code`).
 *
 * `remediation` is the machine-readable fix. This is what makes charter requirement 2.1
 * ("the user never touches a command line") actually hold: the UI renders it as a button.
 */
export interface JobBlockedEvent extends SseEventBase {
  type: 'job.blocked';
  jobId: string;
  blockedCode: string;
  messageZh: string;
  message: string;
  remediation: Remediation | null;
}

/**
 * A machine-readable corrective action the UI turns into a button.
 * ADR-007 decision 2 requires this on API errors too — see `ApiErrorBody` in api.ts.
 */
export interface Remediation {
  /** e.g. "install_model" | "install_backend" | "free_disk" | "switch_source" | "configure_api_key" */
  action: string;
  /** Action-specific arguments, e.g. { modelId: "asr/whisper-…" }. */
  params: Record<string, string | number | boolean | null>;
  /** Button label. */
  labelZh: string;
  label: string;
}

/* ------------------------- model / backend / storage ---------------------- */

export interface ModelInstalledEvent extends SseEventBase {
  type: 'model.installed';
  modelId: string;
  active: boolean;
}

export interface ModelRemovedEvent extends SseEventBase {
  type: 'model.removed';
  modelId: string;
  freedBytes: number;
}

export interface ModelActivatedEvent extends SseEventBase {
  type: 'model.activated';
  role: 'asr' | 'llm';
  modelId: string | null;
  previous: string | null;
}

export interface BackendInstalledEvent extends SseEventBase {
  type: 'backend.installed';
  packId: string;
  backend: string;
  /** null = self-test not run yet. D-05: false must raise a persistent warning. */
  selfTestPassed: boolean | null;
}

export interface BackendRemovedEvent extends SseEventBase {
  type: 'backend.removed';
  packId: string;
  freedBytes: number;
}

export interface StorageChangedEvent extends SseEventBase {
  type: 'storage.changed';
  usedBytes: number;
  freeBytes: number;
}

export interface CatalogUpdatedEvent extends SseEventBase {
  type: 'catalog.updated';
  catalogVersion: string;
  source: 'remote' | 'cache' | 'bundled';
  stale: boolean;
}

export interface SourcesProbedEvent extends SseEventBase {
  type: 'sources.probed';
  effective: string;
  probes: { id: string; ok: boolean; ttfbMs: number | null; throughputKbps: number | null }[];
}

/**
 * Hardware or backend selection changed.
 * Every cached fit verdict is now stale — the client MUST refetch the model catalog,
 * not just the hardware panel.
 */
export interface HardwareChangedEvent extends SseEventBase {
  type: 'hardware.changed';
  hardware: HardwareInfo;
}

/* ---------------------------- F1/F2 media import -------------------------- */

/** Media downloaded/demuxed and ready for ASR; lets the UI show duration and a player. */
export interface MediaReadyEvent extends SseEventBase {
  type: 'media.ready';
  noteUid: string;
  mediaUid: string;
  durationMs: number;
  title: string | null;
  hasVideo: boolean;
}

/* ------------------------------ transcription ----------------------------- */

export interface TranscribeStartedEvent extends SseEventBase {
  type: 'transcribe.started';
  transcriptUid: string;
  noteUid: string;
  modelId: string;
  /** Total audio duration in integer milliseconds. */
  durationMs: number;
  /**
   * Resolved language. NEVER null in practice — whisper.cpp with no `-l` silently
   * TRANSLATES non-English audio to English, so the pipeline always resolves a value
   * ("auto" at minimum) before starting.
   */
  language: string | null;
}

/**
 * Volatile in-progress hypothesis (F3 live capture).
 *
 * Explicitly NOT durable: each partial REPLACES the previous one for the same `utteranceId`
 * and is superseded by the eventual `transcribe.segment`. D-05 §2.4 routes this to a
 * transient store — writing ~10 Hz partials into the Query cache would re-render a
 * 3000-row virtual list every frame.
 */
export interface TranscribePartialEvent extends SseEventBase {
  type: 'transcribe.partial';
  transcriptUid: string;
  /** Present so clients never need a transcriptUid→noteUid lookup table. */
  noteUid: string;
  /** Groups partials belonging to one utterance; replace-on-match. */
  utteranceId: string;
  text: string;
  startMs: number;
}

/**
 * A finalised segment. Durable, ordered, append-only.
 *
 * This is the event behind D-05 §4.1's "text on screen in 14 seconds" instead of "wait 40
 * minutes for a result". One of only two events whose payload IS the data rather than a
 * hint to refetch (the other being `job.progress`) — so `seq` must be respected:
 * apply strictly increasing, drop duplicates, and refetch the transcript on a gap.
 */
export interface TranscribeSegmentEvent extends SseEventBase {
  type: 'transcribe.segment';
  transcriptUid: string;
  /** Present so clients never need a transcriptUid→noteUid lookup table. */
  noteUid: string;
  /** Monotonic per transcript, starting at 0. A gap means events were missed. */
  seq: number;
  /** Integer milliseconds, matching D-02 §1.1 and the REST DTO. */
  startMs: number;
  endMs: number;
  text: string;
  /** Speaker label when diarization ran. */
  speaker: string | null;
  /** Model confidence when the engine reports one. */
  confidence: number | null;
}

export interface TranscribeDoneEvent extends SseEventBase {
  type: 'transcribe.done';
  transcriptUid: string;
  noteUid: string;
  segmentCount: number;
  /** Measured real-time factor for this run; feeds the honest ETA (ADR-004 decision 3). */
  rtf: number | null;
  /**
   * True when transcription ended early but earlier segments are still valid.
   * D-05 §4.1 rule 6 requires partial results stay visible rather than being discarded.
   */
  partial: boolean;
}

/**
 * A re-run replaced the transcript (F3 two-pass: streaming draft → offline high quality).
 *
 * Without this event the UI cannot say「已更新 47 段 · 你编辑过的 3 段已保留」, and that
 * sentence is what stops the two-pass design feeling like "the app rewrote my text".
 * The merge matches by TIME, not index — two passes segment differently, so index-matching
 * would hand a user's edit to someone else's sentence.
 */
export interface TranscribeReplacedEvent extends SseEventBase {
  type: 'transcribe.replaced';
  noteUid: string;
  oldTranscriptUid: string;
  newTranscriptUid: string;
  updatedSegments: number;
  /** Segments carrying SEGMENT_FLAG.CONFIRMED — never overwritten, even with no match. */
  preservedEditedSegments: number;
  canUndo: boolean;
}

/**
 * One derived media artifact finished (waveform peaks, transcode…).
 *
 * Distinct from `media.ready`, which fires once for the media as a whole. Peaks and
 * transcodes complete independently and the timeline needs each one as it lands, rather
 * than polling or waiting for the slowest.
 */
export interface MediaAssetReadyEvent extends SseEventBase {
  type: 'media.asset.ready';
  noteUid: string;
  assetUid: string;
  role: string;
  bytes: number;
}

/* -------------------------------- F3 record ------------------------------- */

export interface RecordStateEvent extends SseEventBase {
  type: 'record.state';
  recordingUid: string;
  state: 'starting' | 'recording' | 'paused' | 'finalizing' | 'stopped' | 'failed';
  elapsedMs: number;
  /** Bytes captured so far, for the disk-space warning. */
  bytesWritten: number;
}

/* ------------------------------- F4 mindmap ------------------------------- */

/**
 * Incremental mindmap construction (D-05 §4.6: render progressively, do not spin for 60 s).
 *
 * Nodes arrive as the LLM streams structure. `parentKey` is the stable in-document node
 * key from D-02 `mindmap_nodes.node_key`, so the client can attach without a refetch.
 */
export interface MindmapDeltaEvent extends SseEventBase {
  type: 'mindmap.delta';
  mindmapUid: string;
  /**
   * Present so clients never need a mindmapUid→noteUid lookup table — consistent with
   * `transcribe.*`. The mindmap is rendered inside the note view, so every consumer of
   * this event needs the note it belongs to.
   */
  noteUid: string;
  seq: number;
  nodes: {
    nodeKey: string;
    parentKey: string | null;
    text: string;
    /** Source transcript segment range this node was derived from, when known. */
    sourceStartMs: number | null;
    sourceEndMs: number | null;
  }[];
}

export interface MindmapDoneEvent extends SseEventBase {
  type: 'mindmap.done';
  mindmapUid: string;
  noteUid: string;
  nodeCount: number;
}

/* --------------------------------- F5 notes ------------------------------- */

export interface NoteCreatedEvent extends SseEventBase {
  type: 'note.created';
  noteUid: string;
  title: string;
  folderUid: string | null;
}

export interface NoteUpdatedEvent extends SseEventBase {
  type: 'note.updated';
  noteUid: string;
  /** Which aspects changed, so the client can invalidate narrowly. */
  changed: ('title' | 'body' | 'tags' | 'folder' | 'transcript' | 'mindmap')[];
}

export interface NoteDeletedEvent extends SseEventBase {
  type: 'note.deleted';
  noteUid: string;
}

/* ----------------------------- stream control ----------------------------- */

/**
 * The client's Last-Event-ID fell outside the replay buffer, so some events are
 * unrecoverable. D-01 §3.3: the client must refetch the current view in full.
 * A bulk download can roll 256 entries quickly, so this is expected, not exceptional.
 */
export interface SyncRequiredEvent extends SseEventBase {
  type: 'sync.required';
  reason: 'replay_buffer_overflow' | 'server_restarted';
  /** Oldest id still replayable, for diagnostics. */
  oldestAvailableId: number | null;
}

export interface KeepaliveEvent extends SseEventBase {
  type: 'keepalive';
}

export type SseEvent =
  | JobCreatedEvent
  | JobProgressEvent
  | JobStateEvent
  | JobDoneEvent
  | JobFailedEvent
  | JobBlockedEvent
  | ModelInstalledEvent
  | ModelRemovedEvent
  | ModelActivatedEvent
  | BackendInstalledEvent
  | BackendRemovedEvent
  | StorageChangedEvent
  | CatalogUpdatedEvent
  | SourcesProbedEvent
  | HardwareChangedEvent
  | MediaReadyEvent
  | TranscribeStartedEvent
  | TranscribePartialEvent
  | TranscribeSegmentEvent
  | TranscribeDoneEvent
  | TranscribeReplacedEvent
  | MediaAssetReadyEvent
  | RecordStateEvent
  | MindmapDeltaEvent
  | MindmapDoneEvent
  | NoteCreatedEvent
  | NoteUpdatedEvent
  | NoteDeletedEvent
  | SyncRequiredEvent
  | KeepaliveEvent;

/** Narrow an event by type. */
export type SseEventOf<T extends SseEventType> = Extract<SseEvent, { type: T }>;

/**
 * Events whose payload IS the data (apply directly, in order) rather than a hint to
 * refetch. Everything else follows D-01 §3.3's rule: "an event only means go fetch;
 * the truth is always in REST/DB."
 */
export const AUTHORITATIVE_EVENT_TYPES: readonly SseEventType[] = [
  'job.progress',
  'transcribe.partial',
  'transcribe.segment',
  'mindmap.delta',
];

/** Events that carry a monotonic `seq` and must be applied in order. */
export const SEQUENCED_EVENT_TYPES: readonly SseEventType[] = [
  'transcribe.segment',
  'mindmap.delta',
];

/**
 * Serialise to the SSE wire format.
 *
 * ⚠️ Emits a named `event:` field, so per the SSE spec these messages dispatch ONLY to
 * `addEventListener('<type>', …)` — `EventSource.onmessage` never fires for them.
 * Clients must iterate `SSE_EVENT_TYPES` and register a listener for each.
 * (D-05 §2.3 calls this out as the single easiest trap to lose half a day to.)
 *
 * `id:` is monotonic so a reconnecting EventSource sends `Last-Event-ID` and the server
 * replays what was missed — the main reason SSE beats WebSocket here, where reconnect and
 * replay have to be hand-rolled.
 */
export function formatSseFrame(id: number, event: SseEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Retry hint (ms) sent once when the stream opens; EventSource honours it on reconnect. */
export function formatSseRetry(ms: number): string {
  return `retry: ${ms}\n\n`;
}

/** SSE comment line; keeps proxies from closing an idle connection. */
export function formatSseKeepalive(): string {
  return `: keepalive\n\n`;
}

/** Build an event with the envelope fields filled in. */
export function makeEvent<T extends SseEventType>(
  type: T,
  topic: string,
  rest: Omit<SseEventOf<T>, 'type' | 'ts' | 'topic'>,
): SseEventOf<T> {
  return { type, ts: new Date().toISOString(), topic, ...rest } as SseEventOf<T>;
}

/** Conventional topic builders — keep coalescing keys consistent across producers. */
export const topics = {
  job: (jobUid: string) => `job:${jobUid}`,
  transcript: (uid: string) => `transcript:${uid}`,
  mindmap: (uid: string) => `mindmap:${uid}`,
  note: (uid: string) => `note:${uid}`,
  recording: (uid: string) => `recording:${uid}`,
  models: () => 'models',
  backends: () => 'backends',
  runtime: () => 'runtime',
  system: () => 'system',
} as const;
