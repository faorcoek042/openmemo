/**
 * F1 / F2 / F5 contract — notes, import, transcript, search, media.
 *
 * PROVENANCE (ADR-012): these shapes are NOT newly designed here. They are
 * `oss-scout`'s implementation in `apps/daemon/src/http/rest/**`, transcribed verbatim
 * and formalised. He shipped and load-tested them (67 real SSE events, 49 segments
 * persisted, Range 206 on /media) before this file existed.
 *
 * Adopting rather than redesigning is deliberate: `architect` is concurrently switching
 * the frontend off mocks, and two parties inventing two shapes for the same endpoint is
 * exactly the collision this package exists to prevent. Where I would have chosen
 * differently, I kept his shape and noted it — a working implementation outranks my
 * preference. Any real objection goes through DISPUTE, not through a silent redefinition.
 *
 * UNIT RULE: all media time is INTEGER MILLISECONDS here, matching D-02 §1.1. The SSE
 * transcription events still carry float seconds; that discrepancy is tracked separately
 * and the daemon converts at the boundary.
 */

import type { Remediation } from './events.js';

/** ULID (26 chars, Crockford base32). The only note identifier the API exposes. */
export type NoteUid = string;

export const NOTE_KINDS = ['media', 'text', 'recording'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_STATUSES = [
  'draft',
  'importing',
  'transcribing',
  'structuring',
  'ready',
  'failed',
] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/* ------------------------------ F1/F2 import ------------------------------ */

/**
 * `POST /api/notes/import`
 *
 * One endpoint for both F1 (paste a URL) and F2 (a local file): `input` is either an
 * absolute local path or a URL, distinguished server-side by a scheme test. Local paths
 * must resolve inside a configured import root — otherwise this endpoint would be an
 * arbitrary-file-read primitive.
 */
export interface ImportNoteRequest {
  /** Absolute local path, or a URL (`https://…`). */
  input: string;
  /** Optional display title; defaults to the basename / remote title. */
  title?: string;
  /**
   * BCP-47 language, or `"auto"`.
   *
   * ⚠️ NEVER leave this empty for Whisper. With no `-l`, whisper.cpp silently TRANSLATES
   * non-English audio into English — a Chinese recording comes back as English prose and
   * the user never asked for a translation. Callers must send an explicit value.
   */
  language?: string | null;
}

export interface ImportNoteResponse {
  noteUid: NoteUid;
  /** ULID of the transcription job; progress arrives over the global SSE stream. */
  jobUid: string;
  status: NoteStatus;
}

/* -------------------------------- F5 notes -------------------------------- */

export interface NoteListItem {
  uid: NoteUid;
  title: string;
  status: NoteStatus;
  kind: NoteKind;
  language: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListNotesResponse {
  notes: NoteListItem[];
}

export interface NoteAsset {
  uid: string;
  /** e.g. "audio" | "video" | "peaks". */
  role: string;
  mime: string;
  bytes: number;
  durationMs: number | null;
  /**
   * Ready-to-use media URL, always `/media/asset/<ulid>`.
   *
   * The server returns a URL rather than a path, and `/media` accepts ONLY an asset uid —
   * never a filesystem path. That removes path traversal from this surface by construction
   * instead of by validation.
   */
  url: string;
}

/** A tag attached to a note. */
export interface NoteTag {
  uid: string;
  name: string;
  color: string | null;
}

export interface NoteDetail {
  uid: NoteUid;
  title: string;
  status: NoteStatus;
  kind: NoteKind;
  language: string | null;
  durationMs: number | null;
  summaryMd: string | null;
  assets: NoteAsset[];
  transcriptUid: string | null;
  segmentCount: number;
  createdAt: string;

  /**
   * Tags on this note. ALWAYS an array — `[]` when there are none, never absent.
   *
   * Added after a real-browser run found the note detail page white-screening with
   * "Cannot read properties of undefined (reading 'map')": `NoteDetailPage` renders
   * `<TagEditor tags={n.tags} />`, the daemon never returned the field, and nothing in
   * the contract declared it. Three parties, three different assumptions, one blank page.
   * Declaring it here — and requiring [] rather than optional — is what stops that
   * recurring: an absent array is indistinguishable from "no tags" at the call site,
   * so the schema forbids absence.
   */
  tags: NoteTag[];

  /** Whether the note is starred. Always present. */
  starred: boolean;

  /** Folder this note lives in, or null for the root. Always present. */
  folderUid: string | null;
}

/* ------------------------------- transcript ------------------------------- */

export interface TranscriptMeta {
  uid: string;
  engineId: string | null;
  modelId: string | null;
  language: string | null;
  status: string;
  progress: number;
  durationMs: number | null;
  /** Measured real-time factor for this run. Null until the run completes. */
  rtf: number | null;
  segmentCount: number;
}

/** Segment flags bitfield (D-02). */
export const SEGMENT_FLAG = {
  HALLUCINATION: 1 << 0,
  LOW_CONFIDENCE: 1 << 1,
  /** Human-confirmed. Two-pass merge must NEVER overwrite a segment carrying this. */
  CONFIRMED: 1 << 2,
  SILENCE: 1 << 3,
} as const;

export interface TranscriptSegment {
  seq: number;
  /** Integer milliseconds (D-02 §1.1). Float seconds accumulate drift over long audio. */
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  chunkIdx: number | null;
  flags: number;
  /** True when a human edited this segment; drives "your N edits were preserved". */
  edited: boolean;
}

export interface GetTranscriptResponse {
  transcript: TranscriptMeta | null;
  segments: TranscriptSegment[];
}

/* ----------------------------- retranscribe ------------------------------- */

/**
 * `POST /api/notes/:uid/retranscribe` — re-run transcription on an EXISTING note.
 *
 * Adopted verbatim from `oss-scout`'s implementation (ADR-012 process: his shipped shape
 * wins over my preference).
 *
 * Distinct from `POST /api/notes/import`, which creates a NEW note. This one reuses the
 * note, its media and its recorded source input, so:
 *   - the note's uid, tags, stars and folder survive
 *   - `resumableTranscript()` reuses an unfinished transcript and skips completed chunks,
 *     which is what makes "cancel, then continue later" work (D-01 §4.5)
 *   - the user's edited segments are preserved by the two-pass time-based merge
 *
 * 409 `NO_SOURCE_INPUT` when the note has no recorded original input — e.g. a recording
 * whose source was never a re-fetchable URL. There is nothing to re-run from, and the UI
 * must not offer the button in that case.
 */
export interface RetranscribeRequest {
  /**
   * Language override for this run. Omit to reuse the note's stored language.
   *
   * Same hazard as import: whisper.cpp with no `-l` silently TRANSLATES non-English audio
   * into English. The daemon falls back to `note.language`, so omitting this is safe here —
   * but never send an empty string.
   */
  language?: string;
}

export interface RetranscribeResponse {
  /** ULID of the new transcription job; progress arrives on the global SSE stream. */
  jobUid: string;
  noteUid: NoteUid;
}

/* --------------------------------- search --------------------------------- */

export const SEARCH_SOURCES = ['segment', 'note'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

export interface SearchHit {
  noteUid: NoteUid;
  noteTitle: string;
  transcriptUid: string | null;
  seq: number | null;
  /** Timestamp of the hit, so the UI can jump straight to that moment in the audio. */
  startMs: number | null;
  endMs: number | null;
  snippet: string;
  /** bm25 score. Lower is better (SQLite FTS5 convention) — do not sort descending. */
  score: number;
  source: SearchSource;
}

/** Which search backends are actually live; the UI must not offer a dead mode. */
export interface SearchModeReport {
  keyword: boolean;
  semantic: boolean;
  /** "simple" = libsimple Chinese segmentation; "trigram" = degraded fallback. */
  tokenizer: 'simple' | 'trigram';
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  modes: SearchModeReport;
}

/* --------------------------------- errors --------------------------------- */

/** Error codes this domain adds on top of the download/model codes in jobs.ts. */
export const NOTE_ERROR_CODES = [
  'BAD_REQUEST',
  'BAD_PATH',
  'PATH_NOT_ALLOWED',
  'NOTE_NOT_FOUND',
  'NO_SOURCE_INPUT',
  'METHOD_NOT_ALLOWED',
  'UNAUTHENTICATED',
] as const;
export type NoteErrorCode = (typeof NOTE_ERROR_CODES)[number];

/** Re-exported for convenience: import errors carry a remediation the UI renders. */
export type { Remediation };

/** Endpoint table for this domain, mirroring `ENDPOINTS` in api.ts. */
export const NOTE_ENDPOINTS = [
  { method: 'POST', path: '/api/notes/import', name: 'importNote' },
  { method: 'GET', path: '/api/notes', name: 'listNotes' },
  { method: 'GET', path: '/api/notes/:uid', name: 'getNote' },
  { method: 'DELETE', path: '/api/notes/:uid', name: 'deleteNote' },
  { method: 'GET', path: '/api/notes/:uid/transcript', name: 'getTranscript' },
  { method: 'POST', path: '/api/notes/:uid/retranscribe', name: 'retranscribeNote' },
  { method: 'GET', path: '/api/search', name: 'search' },
  { method: 'GET', path: '/api/selfcheck', name: 'selfcheck' },
  { method: 'GET', path: '/media/asset/:uid', name: 'mediaAsset' },
] as const;
