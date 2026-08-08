/**
 * 前端的 SSE 事件类型入口。
 *
 * ✅ **权威定义在 `@openmemo/shared`** —— `model-mgmt` 已按 D-05 §11 的规格落地了
 * 29 个事件类型（ADR-007 决策 1）。本文件**不再重复定义**它们，只做两件事：
 *   1. 转发 shared 的类型；
 *   2. 定义 shared 尚未覆盖、但 UI 已经需要的少数扩展事件（下方 §扩展）。
 *
 * 扩展事件一律加 `x.` 前缀，**不与 shared 的命名空间冲突**，
 * 等 shared 补齐后删掉这一段即可，分发层与 UI 不用改。
 */

import {
  AUTHORITATIVE_EVENT_TYPES,
  SEQUENCED_EVENT_TYPES,
  SSE_EVENT_TYPES as SHARED_SSE_EVENT_TYPES,
  type SseEvent as SharedSseEvent,
} from '@openmemo/shared';

export type { SseEvent, SseEventType } from '@openmemo/shared';

/* ═══════════════════════════ 事件分类（D-05 §11.0）═══════════════════════════ */

/**
 * - `hint`：提示"该去拉数据了"。可丢、可乱序、可合并节流。
 * - `data`：载荷即真相，直接应用。
 *
 * ✅ **这个划分现在由 `packages/shared` 以常量编码**（`AUTHORITATIVE_EVENT_TYPES` /
 * `SEQUENCED_EVENT_TYPES`），不再是"只写在文档里靠人记"。
 * 前端直接消费这两个常量 —— 服务端加了新的权威事件，前端的缺口检测自动跟上，
 * 不需要两边各维护一份名单（那种名单必然会漂移）。
 */
export type EventClass = 'hint' | 'data';

export function classOf(type: string): EventClass {
  if ((AUTHORITATIVE_EVENT_TYPES as readonly string[]).includes(type)) return 'data';
  // 本地扩展事件里唯一的 data 类
  if (type === 'x.summary.delta') return 'data';
  return 'hint';
}

/** 需要按单调 `seq` 应用、并检测缺口的事件。 */
export function isSequenced(type: string): boolean {
  return (SEQUENCED_EVENT_TYPES as readonly string[]).includes(type) || type === 'x.summary.delta';
}

/* ═════════════════════ 扩展事件（shared 尚未覆盖，见 §缺口）═════════════════════ */

/**
 * ★ F3 两阶段转写的覆盖结果。
 *
 * **shared 目前没有这个事件**，但没有它，D-05 §4.3 的
 * 「已更新 47 段 · 你编辑过的 3 段已保留 · [撤销]」就写不出来 ——
 * 而这句话正是让用户不觉得"软件在乱改我的字"的关键（ADR-007 认定的产品成败点）。
 * 已上报，等 shared 补齐后删除本地定义。
 */
export interface XTranscribeReplacedEvent {
  type: 'x.transcribe.replaced';
  noteUid: string;
  oldTranscriptUid: string;
  newTranscriptUid: string;
  updatedSegments: number;
  preservedEditedSegments: number;
  canUndo: boolean;
}

/** 摘要流式生成（shared 有 mindmap.delta，但没有 summary 的对应物）。 */
export interface XSummaryDeltaEvent {
  type: 'x.summary.delta';
  noteUid: string;
  seq: number;
  textDelta: string;
}

export interface XSummaryDoneEvent {
  type: 'x.summary.done';
  noteUid: string;
  chars: number;
}

/**
 * 单个媒体产物就绪。
 *
 * shared 的 `media.ready` 是**整体**就绪（含 duration/title），但波形 `peaks`
 * 与转码是**逐个异步生成**的；F5 的时间轴需要知道"peaks 这一个好了没有"，
 * 否则只能轮询或干等。已上报。
 */
export interface XMediaAssetReadyEvent {
  type: 'x.media.asset.ready';
  noteUid: string;
  assetUid: string;
  role: string;
  bytes: number;
}

/** daemon 优雅退出（D-01 §2.5）。 */
export interface XDaemonShutdownEvent {
  type: 'x.daemon.shutdown';
  graceMs: number;
}

/** 后台重建检索索引（D-02 §4.5）。 */
export interface XIndexProgressEvent {
  type: 'x.index.progress';
  kind: 'fts' | 'vector';
  done: number;
  total: number;
}

export const EXTENSION_SSE_EVENT_TYPES = [
  'x.transcribe.replaced',
  'x.summary.delta',
  'x.summary.done',
  'x.media.asset.ready',
  'x.daemon.shutdown',
  'x.index.progress',
] as const;

export type ExtensionSseEvent =
  | XTranscribeReplacedEvent
  | XSummaryDeltaEvent
  | XSummaryDoneEvent
  | XMediaAssetReadyEvent
  | XDaemonShutdownEvent
  | XIndexProgressEvent;

/** 前端要监听的全集 = shared 的 29 个 + 本地扩展的 6 个。 */
export const ALL_SSE_EVENT_TYPES: readonly string[] = [
  ...SHARED_SSE_EVENT_TYPES,
  ...EXTENSION_SSE_EVENT_TYPES,
];

export type AnySseEvent = SharedSseEvent | ExtensionSseEvent;

/** 事件类型 → payload 映射，供 bus 做类型安全订阅。 */
export type EventMap = { [E in AnySseEvent as E['type']]: E };

/* ═══════════════════════════ REST DTO 的段落形状 ═══════════════════════════ */

/**
 * 转写段落（REST 返回的形状，对齐 D-02 §1.5）。
 *
 * ⚠️ **单位不一致的已知点**：D-02 §1.1 规定媒体时间一律**整数毫秒**
 * （浮点秒在字幕对齐上会累积误差，且不能做索引比较）；
 * 而 shared 的 SSE 事件用的是 `startSec`/`endSec` 浮点秒。
 * → 前端在 `sse.ts` 的边界做一次 `Math.round(sec * 1000)` 转换，
 *   **DB 与 UI 内部一律毫秒整数**。已上报请 Manager 裁决统一单位。
 */
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
  /** 位图：bit0 疑似幻觉 / bit1 低置信 / bit2 人工确认(=重跑时被保留) / bit3 静音 */
  flags: number;
  /**
   * 用户编辑时间。**这是"用户编辑过"的唯一判定依据**（D-06 §15.2 冻结契约）——
   * 非 NULL 的段在离线重跑合并时**永不覆盖、永不删除**。
   */
  editedAt: number | null;
  /** 编辑前的 ASR 原文。仅当被编辑过才非空，供"查看改动"与"还原"。 */
  textRaw: string | null;
}

export const SEGMENT_FLAG = {
  HALLUCINATION: 1 << 0,
  LOW_CONFIDENCE: 1 << 1,
  CONFIRMED: 1 << 2,
  SILENCE: 1 << 3,
} as const;
