/**
 * 笔记域的 SSE 绑定片段（D-05 §3.4 分片导出）。
 *
 * ★ 本文件由 **T-021 独占** ★
 * 它被 `lib/events/bindings.ts` 聚合。T-022 / T-023 各写各的 `sse.ts`，
 * 谁都不用改聚合文件 —— 这就是把写冲突结构性消灭的做法。
 *
 * 本文件同时承担**两处与 `packages/shared` 契约的适配**（见下方注释）：
 *   ① 秒 → 毫秒（D-02 §1.1 要求内部一律整数毫秒）
 *   ② transcriptUid → noteUid 的反查（shared 的 transcribe.segment 没带 noteUid）
 */

import type { QueryClient } from '@tanstack/react-query';
import type {
  MediaAssetReadyEvent,
  MediaReadyEvent,
  NoteCreatedEvent,
  NoteDeletedEvent,
  NoteUpdatedEvent,
  TranscribeDoneEvent,
  TranscribePartialEvent,
  TranscribeReplacedEvent,
  TranscribeSegmentEvent,
  TranscribeStartedEvent,
} from '@openmemo/shared';

import { bus } from '../../lib/events/bus';
import { qk } from '../../app/query';
import type { SseBinding } from '../../lib/events/bindings';
import type { TranscriptDto } from '../../lib/api/types';
import type { TranscriptSegmentDto, XSummaryDeltaEvent } from '../../lib/events/types';

/**
 * ✅ 两处适配已随契约更新删除（ADR-013 决策 2 / 决策 4）：
 *   ① 秒 → 毫秒的转换 —— shared 的事件现在直接是整数毫秒，与 D-02 §1.1 一致；
 *   ② transcriptUid → noteUid 的本地映射表 —— 事件已自带 `noteUid`。
 * 少两处适配就少两处可能漂移的地方。
 */

function upsertSegment(qc: QueryClient, noteUid: string, seg: TranscriptSegmentDto) {
  qc.setQueryData<TranscriptDto | null>(qk.transcript(noteUid), (old) => {
    if (!old) return old ?? null;
    if (old.segments.some((s) => s.seq === seg.seq)) return old; // 重放去重
    return { ...old, segments: [...old.segments, seg].sort((a, b) => a.seq - b.seq) };
  });
}

export const notesSse: SseBinding = (qc: QueryClient) => [
  /* ── 笔记域：全部 hint，只触发失效 ── */
  bus.on('note.created', (_e: NoteCreatedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.notes.all });
  }),

  bus.on('note.updated', (e: NoteUpdatedEvent) => {
    // `changed` 让我们只失效相关查询，而不是无脑全量重拉
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
    if (e.changed.some((c) => c === 'title' || c === 'tags' || c === 'folder')) {
      void qc.invalidateQueries({ queryKey: qk.notes.all });
    }
    if (e.changed.includes('transcript')) {
      void qc.invalidateQueries({ queryKey: qk.transcript(e.noteUid) });
    }
    if (e.changed.includes('mindmap')) {
      void qc.invalidateQueries({ queryKey: qk.mindmap(e.noteUid) });
    }
  }),

  bus.on('note.deleted', (_e: NoteDeletedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.notes.all });
  }),

  bus.on('media.ready', (e: MediaReadyEvent) => {
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
  }),

  /**
   * 单个产物（尤其是波形 peaks）就绪 —— 就绪前去拉会 404。
   *
   * ★ 这里原来订的是 **`x.media.asset.ready`**，而 daemon（`media/peaksAsset.ts`）
   * 与 mock 源（`lib/api/mock.ts`）发的一直是 **`media.asset.ready`**（shared 的正版，
   * 且 `SseHub.publish(event: SseEvent)` 在类型上就发不出 `x.*`）。
   * 差一个前缀 ⇒ **这条 invalidate 从来没有被触发过**，用户得手动刷新才看得到波形。
   * 见 `lib/events/types.ts` 里那段说明与 `sseNaming.test.ts` 的守卫。
   */
  bus.on('media.asset.ready', (e: MediaAssetReadyEvent) => {
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
  }),

  /* ── 转写域 ── */
  bus.on('transcribe.started', (e: TranscribeStartedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
  }),

  /**
   * ★ data 类事件：**载荷即真相**，直接追加进缓存，不重拉。
   *
   * 这是"边转边看"成立的关键：第一段文字十几秒内就出现，而不是等几十分钟。
   * 若改成 invalidate，每个 chunk 都要整篇重拉（3000 段），既慢又会打断用户滚动。
   */
  bus.on('transcribe.segment', (e: TranscribeSegmentEvent) => {
    upsertSegment(qc, e.noteUid, {
      seq: e.seq,
      startMs: e.startMs,
      endMs: e.endMs,
      text: e.text,
      speakerLabel: e.speaker,
      confidence: e.confidence,
      noSpeechProb: null,
      words: null,
      chunkIdx: null,
      flags: 0,
      // 新到的段一定是机器识别、未编辑 —— editedAt=null 才会被后续重跑正常覆盖
      editedAt: null,
      textRaw: null,
    });
  }),

  /**
   * F3 实时假名：**易失、不落库**。每条 partial 替换同 utteranceId 的上一条，
   * 最终被 `transcribe.segment` 取代。走 bus 给录音页自己消费，不进 Query 缓存
   * （~10Hz 写缓存会让 3000 行虚拟列表每帧重渲染，D-05 §2.4）。
   */
  bus.on('transcribe.partial', (_e: TranscribePartialEvent) => {
    /* 由 features/recorder 直接订阅，此处不动缓存 */
  }),

  bus.on('transcribe.done', (e: TranscribeDoneEvent) => {
    void qc.invalidateQueries({ queryKey: qk.transcript(e.noteUid) });
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
    // partial=true：转写提前结束但前面的段落仍然有效，必须保持可见
    // （D-05 §4.1 规则 6：部分成功优于全盘失败）
  }),

  /**
   * F3 两阶段覆盖完成。UI 据此渲染
   * 「已更新 47 段 · 你编辑过的 3 段已保留 · [撤销]」。
   *
   * ★ 与上面 `media.asset.ready` 同一处订正：原来订的是 `x.transcribe.replaced`，
   * 而 shared 早就把它转正成 `transcribe.replaced` 了。
   *
   * ⚠️ **诚实标注**：这一条与波形那条不同 —— `[实测]` 全仓**今天还没有任何生产方**
   * （daemon 侧 `makeEvent('transcribe.replaced')` 零命中），所以订对了名字它也还不会响。
   * 改的是"等生产方接上那天它自动就通"，**不是"现在就通了"**。
   */
  bus.on('transcribe.replaced', (e: TranscribeReplacedEvent) => {
    void qc.invalidateQueries({ queryKey: qk.transcript(e.noteUid) });
  }),

  /* ── 摘要流式（扩展事件）── */
  bus.on('x.summary.delta', (e: XSummaryDeltaEvent) => {
    qc.setQueryData<string>(qk.summary(e.noteUid), (old) => (old ?? '') + e.textDelta);
  }),
];
