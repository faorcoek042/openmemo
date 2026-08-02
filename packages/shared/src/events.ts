/**
 * Server-Sent Events contract.
 *
 * ADR-004 decision 5: SSE, not WebSocket, for management progress.
 * HARD CONSTRAINT: exactly ONE global stream at `GET /api/events`.
 *
 * Why one stream: HTTP/1.1 caps concurrent connections at 6 per origin. One stream per
 * download would exhaust that with three downloads plus a transcription in flight, and
 * every subsequent fetch would hang. The UI opens a single EventSource in its store
 * layer and fans out by `event` name.
 *
 * Live transcription (F3) uses a WebSocket instead — it is genuinely bidirectional and
 * carries binary audio frames. Transport is chosen per use case, not unified for
 * aesthetics.
 */

import type { DownloadJob, JobError, JobState } from './jobs.js';
import type { HardwareInfo } from './hardware.js';

export const SSE_EVENT_TYPES = [
  'job.created',
  'job.progress',
  'job.state',
  'job.failed',
  'model.installed',
  'model.removed',
  'model.activated',
  'backend.installed',
  'backend.removed',
  'storage.changed',
  'catalog.updated',
  'sources.probed',
  'hardware.changed',
  'keepalive',
] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/**
 * Progress emission is throttled to at most 4 messages/second/job server-side.
 * At 8 MB/s an unthrottled byte-level stream saturates the browser's render loop.
 * The UI throttles again to >=200 ms before touching React state.
 */
export const PROGRESS_THROTTLE_HZ = 4;
export const KEEPALIVE_INTERVAL_MS = 15_000;

export interface JobCreatedEvent {
  type: 'job.created';
  job: DownloadJob;
}

export interface JobProgressEvent {
  type: 'job.progress';
  jobId: string;
  completedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  state: JobState;
}

export interface JobStateEvent {
  type: 'job.state';
  jobId: string;
  state: JobState;
  previousState: JobState;
}

export interface JobFailedEvent {
  type: 'job.failed';
  jobId: string;
  error: JobError;
  willRetry: boolean;
  nextProvider: string | null;
}

export interface ModelInstalledEvent {
  type: 'model.installed';
  modelId: string;
  active: boolean;
}

export interface ModelRemovedEvent {
  type: 'model.removed';
  modelId: string;
  freedBytes: number;
}

export interface ModelActivatedEvent {
  type: 'model.activated';
  role: 'asr' | 'llm';
  modelId: string | null;
  previous: string | null;
}

export interface BackendInstalledEvent {
  type: 'backend.installed';
  packId: string;
  backend: string;
  selfTestPassed: boolean | null;
}

export interface BackendRemovedEvent {
  type: 'backend.removed';
  packId: string;
  freedBytes: number;
}

export interface StorageChangedEvent {
  type: 'storage.changed';
  usedBytes: number;
  freeBytes: number;
}

export interface CatalogUpdatedEvent {
  type: 'catalog.updated';
  catalogVersion: string;
  source: 'remote' | 'cache' | 'bundled';
  stale: boolean;
}

export interface SourcesProbedEvent {
  type: 'sources.probed';
  effective: string;
  probes: {
    id: string;
    ok: boolean;
    ttfbMs: number | null;
    throughputKbps: number | null;
  }[];
}

/**
 * Hardware or backend selection changed — every cached fit verdict is now stale and the
 * UI must refetch the catalog.
 */
export interface HardwareChangedEvent {
  type: 'hardware.changed';
  hardware: HardwareInfo;
}

export interface KeepaliveEvent {
  type: 'keepalive';
  at: string;
}

export type SseEvent =
  | JobCreatedEvent
  | JobProgressEvent
  | JobStateEvent
  | JobFailedEvent
  | ModelInstalledEvent
  | ModelRemovedEvent
  | ModelActivatedEvent
  | BackendInstalledEvent
  | BackendRemovedEvent
  | StorageChangedEvent
  | CatalogUpdatedEvent
  | SourcesProbedEvent
  | HardwareChangedEvent
  | KeepaliveEvent;

/**
 * Serialise to the SSE wire format.
 *
 * `id:` is monotonic so a reconnecting EventSource can send `Last-Event-ID` and the
 * server can replay what was missed — the main reason we chose SSE over WebSocket,
 * where reconnect/replay must be hand-rolled.
 */
export function formatSseFrame(id: number, event: SseEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Ring-buffer size for Last-Event-ID replay. */
export const SSE_REPLAY_BUFFER_SIZE = 256;
