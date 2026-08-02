/**
 * F1–F5 的 SSE 事件类型 —— **D-05 §11 规格的前端镜像**。
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ 临时性说明（**重要**）                                                    │
 * │ 这些类型的**权威定义应当在 `@openmemo/shared`**，由 `model-mgmt` 实现      │
 * │ （ADR-007 决策 1：规格我出、实现归他，因为他独占 packages/shared）。        │
 * │ 在他落地之前，这里放一份同形状的本地镜像，让前端能先跑起来。                │
 * │ 他落地后：删掉本文件的 F1–F5 部分，改为从 shared import，                  │
 * │ **分发层（bus / source / bindings）零改动**。                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { SSE_EVENT_TYPES as SHARED_SSE_EVENT_TYPES, type SseEvent as SharedSseEvent } from '@openmemo/shared';

/* ────────────────────────── D-05 §11.0 总则 ────────────────────────── */

/**
 * 事件分两类（D-05 §11.0 总则 1）：
 * - `hint`：提示"该去拉数据了"。可丢、可乱序、可合并节流。
 * - `data`：载荷即真相。**不节流、不合并、必达有序**，带单调 `seq`，前端检缺口。
 *
 * 全部事件里**只有 3 个是 data**：transcribe.segment / mindmap.delta / summary.delta。
 * 它们是增量内容流，丢了就少一段文字，重拉整篇代价高。
 */
export type EventClass = 'hint' | 'data';

export const DATA_EVENTS = ['transcribe.segment', 'mindmap.delta', 'summary.delta'] as const;
export type DataEventType = (typeof DATA_EVENTS)[number];

export function classOf(type: string): EventClass {
  return (DATA_EVENTS as readonly string[]).includes(type) ? 'data' : 'hint';
}

/* ─────────────────────── D-05 §11.6：新增 20 个类型 ─────────────────────── */

export const PIPELINE_SSE_EVENT_TYPES = [
  'transcribe.started',
  'transcribe.segment',
  'transcribe.chunk',
  'transcribe.done',
  'transcribe.failed',
  'transcribe.replaced',
  'mindmap.started',
  'mindmap.delta',
  'mindmap.done',
  'mindmap.failed',
  'summary.delta',
  'summary.done',
  'note.created',
  'note.updated',
  'note.status',
  'note.deleted',
  'media.asset.ready',
  'daemon.shutdown',
  'sync.required',
  'index.progress',
] as const;

export type PipelineSseEventType = (typeof PIPELINE_SSE_EVENT_TYPES)[number];

/** 前端要监听的全集 = shared 已有的 14 个 + 本文件新增的 20 个。 */
export const ALL_SSE_EVENT_TYPES: readonly string[] = [
  ...SHARED_SSE_EVENT_TYPES,
  ...PIPELINE_SSE_EVENT_TYPES,
];

/* ────────────────────────── payload 形状 ────────────────────────── */

export type NoteStatus = 'draft' | 'processing' | 'ready' | 'partial' | 'failed';

/** 对齐 D-02 §1.5 `transcript_segments`。 */
export interface TranscriptSegmentDto {
  seq: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;
  confidence: number | null;
  noSpeechProb: number | null;
  words: { w: string; s: number; e: number; p: number }[] | null;
  chunkIdx: number | null;
  /** 位图：bit0 疑似幻觉 / bit1 低置信 / bit2 人工确认 / bit3 静音 */
  flags: number;
}

export const SEGMENT_FLAG = {
  HALLUCINATION: 1 << 0,
  LOW_CONFIDENCE: 1 << 1,
  CONFIRMED: 1 << 2,
  SILENCE: 1 << 3,
} as const;

export interface MindMapNodeDraft {
  key: string;
  parentKey: string | null;
  text: string;
  refs?: { startMs: number; endMs: number; quote?: string }[];
}

export interface JobErrorLike {
  code: string;
  message: string;
  messageZh: string;
  retryable: boolean;
  details?: unknown;
}

/**
 * D-05 §11.1：通用作业进度。
 *
 * 既有的 `JobProgressEvent` 是**下载专用**的（completedBytes/speedBps）。F1/F2 的流水线
 * 作业没有"字节"这个单位。这里是建议给 shared 的扩展形状：既有字段改可空 + 新增通用字段。
 * `progress` 是唯一的进度真相，进度条只认它。
 */
export interface PipelineJobProgress {
  type: 'job.progress';
  jobId: string;
  state: string;
  jobType: string;
  noteUid?: string;
  progress: number;
  step: string | null;
  stepIndex?: number;
  stepCount?: number;
  completedBytes: number | null;
  totalBytes: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
}

export interface TranscribeStarted {
  type: 'transcribe.started';
  transcriptUid: string;
  noteUid: string;
  jobId: string;
  engineId: string;
  modelId: string;
  backend: string;
  language: string | null;
  durationMs: number;
  totalChunks: number;
}

/** ★ data 类：不节流、必达有序。`seq` 是本次转写内的批次号（不是段序号）。 */
export interface TranscribeSegment {
  type: 'transcribe.segment';
  transcriptUid: string;
  noteUid: string;
  seq: number;
  chunkIdx: number;
  segments: TranscriptSegmentDto[];
}

export interface TranscribeChunk {
  type: 'transcribe.chunk';
  transcriptUid: string;
  noteUid: string;
  doneChunks: number;
  totalChunks: number;
  lastEndMs: number;
}

export interface TranscribeDone {
  type: 'transcribe.done';
  transcriptUid: string;
  noteUid: string;
  segmentCount: number;
  rtf: number | null;
  durationMs: number;
  speakers: { label: string; totalMs: number }[];
}

export interface TranscribeFailed {
  type: 'transcribe.failed';
  transcriptUid: string;
  noteUid: string;
  error: JobErrorLike;
  /** true = 前 N 段已可用（D-05 §4.1 规则 6：部分成功优于全盘失败） */
  partial: boolean;
  lastEndMs: number | null;
}

/**
 * ★ F3 两阶段的产品成败点（D-05 §4.3 步骤 4）。
 * `updatedSegments` / `preservedEditedSegments` **不是可选字段** ——
 * 没有这两个数字，「已更新 47 段 · 你编辑过的 3 段已保留」就写不出来，
 * 用户会以为软件在乱改自己的字。
 */
export interface TranscribeReplaced {
  type: 'transcribe.replaced';
  noteUid: string;
  oldTranscriptUid: string;
  newTranscriptUid: string;
  updatedSegments: number;
  preservedEditedSegments: number;
  canUndo: boolean;
}

export interface MindmapStarted {
  type: 'mindmap.started';
  mindmapUid: string;
  noteUid: string;
  jobId: string;
  modelId: string;
  providerId: string;
}

/** ★ data 类。服务端按 ~250ms 批量成组，**不要每个 token 一条**。 */
export interface MindmapDelta {
  type: 'mindmap.delta';
  mindmapUid: string;
  noteUid: string;
  seq: number;
  nodes: MindMapNodeDraft[];
}

export interface MindmapDone {
  type: 'mindmap.done';
  mindmapUid: string;
  noteUid: string;
  nodeCount: number;
  edgeCount: number;
  revision: number;
}

export interface MindmapFailed {
  type: 'mindmap.failed';
  mindmapUid: string;
  noteUid: string;
  error: JobErrorLike;
  /** 'heuristic' 对应 D-01 §7.2 的"无 LLM 时启发式大纲"降级 */
  degradedTo: 'heuristic' | null;
}

export interface SummaryDelta {
  type: 'summary.delta';
  noteUid: string;
  seq: number;
  textDelta: string;
}

export interface SummaryDone {
  type: 'summary.done';
  noteUid: string;
  chars: number;
}

export interface NoteCreated {
  type: 'note.created';
  noteUid: string;
  title: string;
  kind: 'media' | 'recording' | 'plain';
  folderUid: string | null;
}

export interface NoteUpdated {
  type: 'note.updated';
  noteUid: string;
  /** 让前端只失效相关查询，而不是无脑全量重拉 */
  fields: string[];
}

export interface NoteStatusEvent {
  type: 'note.status';
  noteUid: string;
  status: NoteStatus;
}

export interface NoteDeleted {
  type: 'note.deleted';
  noteUid: string;
  purged: boolean;
}

/**
 * 波形（role='peaks'）与转码是**异步生成**的，前端在就绪前去拉会 404。
 * 没有这个事件，F5 时间轴只能轮询或干等。
 */
export interface MediaAssetReady {
  type: 'media.asset.ready';
  noteUid: string;
  assetUid: string;
  role: string;
  bytes: number;
  durationMs?: number;
}

export interface DaemonShutdown {
  type: 'daemon.shutdown';
  graceMs: number;
}

export interface SyncRequired {
  type: 'sync.required';
  reason: 'replay_gap' | 'contract_mismatch';
}

export interface IndexProgress {
  type: 'index.progress';
  kind: 'fts' | 'vector';
  done: number;
  total: number;
}

export type PipelineSseEvent =
  | PipelineJobProgress
  | TranscribeStarted
  | TranscribeSegment
  | TranscribeChunk
  | TranscribeDone
  | TranscribeFailed
  | TranscribeReplaced
  | MindmapStarted
  | MindmapDelta
  | MindmapDone
  | MindmapFailed
  | SummaryDelta
  | SummaryDone
  | NoteCreated
  | NoteUpdated
  | NoteStatusEvent
  | NoteDeleted
  | MediaAssetReady
  | DaemonShutdown
  | SyncRequired
  | IndexProgress;

/** 前端看到的事件全集。 */
export type AnySseEvent = SharedSseEvent | PipelineSseEvent;

/** 事件类型 → payload 的映射，供 bus 做类型安全的订阅。 */
export type EventMap = { [E in AnySseEvent as E['type']]: E };
