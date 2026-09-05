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

/*
 * ★★ 这里原来还有两个：`x.transcribe.replaced` 与 `x.media.asset.ready`。
 *
 * **它们在 `packages/shared` 里早就转正了**（`transcribe.replaced` / `media.asset.ready`，
 * 见 `SSE_EVENT_TYPES`），而本地这两条 `x.` 定义连同 `notesSse` 里的两个 `bus.on`
 * 一起活了下来 —— 于是订阅端等的是 `x.media.asset.ready`，
 * 而 daemon（`media/peaksAsset.ts`）与 mock 源（`lib/api/mock.ts`）发的都是
 * `media.asset.ready`。**两个字符串，永远碰不上。**
 *
 * 用户看得见的后果就是波形：转写完成时 daemon 已经把 peaks 算好并广播了，
 * 而详情页那条 invalidate 永远不触发，**波形要手动刷新才出来**。
 * 更贵的是它把生产端也骗了：`peaksAsset.ts` 的注释写着「前端 notesSse 也早就订阅着」，
 * 那句话在写下的那一刻就是假的（它订的是另一个名字），
 * 于是那条线被当成"已经接通"，没人再回来查。
 *
 * ⚠️ 这就是 `x.` 前缀这个约定自带的成本：它是**临时**的，而临时的东西没有到期日。
 * 现在由 `sseNaming.test.ts` 那条守卫钉住 ——
 * **shared 里已经有的事件，不许再有一份 `x.` 影子**，否则当场红。
 */

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

/**
 * ★ **客户端自己判定的"该整篇重拉了"** —— 与服务端的 `sync.required` **不是同一件事**。
 *
 * ## 为什么必须另起一个名字（#101 顺带）
 *
 * `source.ts` 原来两处直接发 `bus.emit('sync.required', { type:'sync.required',
 * reason:'replay_gap' })`，冒充服务端那条事件。而 `packages/shared` 的
 * `SyncRequiredEvent` 声明的是：
 *   · `reason: 'replay_buffer_overflow' | 'server_restarted'`（**没有** `'replay_gap'`）
 *   · 外加 `SseEventBase` 的 `ts` / `topic`，以及 `oldestAvailableId: number | null`
 *
 * 三处对不上，而 `bus.emit(type: string, payload: unknown)` 是松类型，**`tsc` 一个字都不报**。
 *
 * 修法**不是**把 shared 的 union 拓宽去迁就客户端 —— 那份契约描述的是
 * **服务端会发什么**，客户端伪造的东西不该写进去。也不是给本地事件编造一个
 * `ts`/`topic`/`oldestAvailableId`（那是把一句谎话补齐成三句）。
 *
 * 它本来就是另一个东西：**服务端说"你漏了"** vs **客户端自己发现"我漏了"**。
 * 按本仓既有约定（`x.` 前缀 = shared 未覆盖 / 本地扩展），给它自己的名字与自己的 `reason`。
 *
 * ⚠️ 它**故意不在** `EXTENSION_SSE_EVENT_TYPES` 里：那张表喂给 `addEventListener`，
 * 进去就等于声称"服务端会发这个类型"。它纯粹是进程内的，服务端永远不会发。
 */
export interface XSyncRequiredEvent {
  type: 'x.sync.required';
  /**
   * - `replay_gap` —— 收到的 `seq` 与上一条对不上，中间那几条我们没见过。
   * - `reconnected` —— 断开过又连上了。重放缓冲只有 256 条，一次批量下载就能滚过，
   *   所以宁可全量重拉。⚠️ 这一档原来也报 `'replay_gap'`，**那是第二句假话**：
   *   它不是缺口，是重连。两者的排查方向完全不同。
   * - `leader_reconnected` —— 多标签下**主标签**重连成功，跟随者也得跟着重拉
   *   （它自己那份 Query 缓存没人替它刷）。
   */
  reason: 'replay_gap' | 'reconnected' | 'leader_reconnected';
}

/**
 * ⚠️ **进这张表 = 声称"服务端会发这个类型"**（它逐条喂给 `addEventListener`）。
 * 所以只许放 shared **确实没有**的那几个；shared 里已经有的，直接订阅 shared 那个名字。
 * `sseNaming.test.ts` 会把"影子"当场判红。
 */
export const EXTENSION_SSE_EVENT_TYPES = [
  'x.summary.delta',
  'x.summary.done',
  'x.daemon.shutdown',
  'x.index.progress',
] as const;

export type ExtensionSseEvent =
  XSummaryDeltaEvent | XSummaryDoneEvent | XDaemonShutdownEvent | XIndexProgressEvent;

/** 前端要监听的全集 = shared 的 30 个 + 本地扩展的 4 个。 */
export const ALL_SSE_EVENT_TYPES: readonly string[] = [
  ...SHARED_SSE_EVENT_TYPES,
  ...EXTENSION_SSE_EVENT_TYPES,
];

export type AnySseEvent = SharedSseEvent | ExtensionSseEvent;

/**
 * **只活在进程内**的总线事件 —— 服务端永远不发，因此不在 `ALL_SSE_EVENT_TYPES` 里。
 *
 * 它们进 `EventMap` 的唯一目的是让 `bus.emit` / `bus.on` **对它们也做类型检查**。
 * 在此之前 `emit` 是 `(type: string, payload: unknown)`，这一族因此完全没人管。
 *
 * ## ⚠️ 登记的前提：**它今天真的还在被发**
 *
 * 这张表描述的是"进程内现在跑着哪些事件"。**给一个已经没人发的事件留一条形状登记，
 * 等于给下一个人一张过期的地图** —— 他会照着它去找发送方、去接订阅端，
 * 而那条路已经被走完并拆掉了。删掉一个事件时，这里必须跟着删。
 *
 * 这条不是假想：本文件初稿曾登记过两条 `ui.toast.*`，写的是「如实登记，不是背书」，
 * 当时也确实核过（2 个 emit、0 个 `bus.on`）。**但同一天另一路把那两个 emit 删了**
 * （#98 ⑤），于是那两行登记连同它们的说明一起变成了假话 ——
 * 两份都诚实、都核过，合在一起就有一份是错的，而 **git 一个冲突标记都不会报**。
 */
interface LocalBusEventMap {
  'x.sync.required': XSyncRequiredEvent;
}

/** 事件类型 → payload 映射，供 bus 做类型安全订阅**与发布**。 */
export type EventMap = { [E in AnySseEvent as E['type']]: E } & LocalBusEventMap;

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

/*
 * ★ `transcript_segments.flags` 的位域 —— **就是契约那一份**（`@openmemo/shared`）。
 *
 * 这里原来是第三份手写件（shared / pipeline / 这里各一份）。位值今天对得上**靠的是
 * 纪律不是机制**，而位错了的后果和别的分叉不是一个量级：**它是静默的，而且会污染
 * 已存数据** —— 写进库的是数字，读出来是另一个含义，历史行没有任何办法回溯纠正。
 *
 * ⚠️ 三份里**四个位有三个名字不同**（`HALLUCINATION`↔`SUSPECT_REPETITION`、
 *   `CONFIRMED`↔`HUMAN_CONFIRMED`、`SILENCE`↔`SILENCE_OR_MUSIC`），所以收敛它
 *   **不是删掉再 import** —— 本包 3 处读取跟着改了名。名字用的是离写入点最近的那一套
 *   （写入点在 pipeline 的 `whisperCpp.ts` / `whisperServer.ts` / `merge.ts`），
 *   判据（「哪个名字在它被写入时是可断言的」）与逐位对照表写在 shared 那份声明上。
 */
export { SEGMENT_FLAG } from '@openmemo/shared';
