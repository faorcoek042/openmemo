/**
 * 笔记域的 SSE 绑定片段（D-05 §3.4 分片导出）。
 *
 * ★ 本文件由 **T-021 独占** ★
 * 它被 `lib/events/bindings.ts` 聚合。T-022 / T-023 各自写自己的 `sse.ts`，
 * 谁都不用改聚合文件 —— 这就是把写冲突结构性消灭的做法。
 */

import type { QueryClient } from '@tanstack/react-query';
import { bus } from '../../lib/events/bus';
import { qk } from '../../app/query';
import type { SseBinding } from '../../lib/events/bindings';
import type { TranscriptDto } from '../../lib/api/types';
import type {
  MediaAssetReady,
  NoteCreated,
  NoteDeleted,
  NoteStatusEvent,
  NoteUpdated,
  SummaryDelta,
  TranscribeChunk,
  TranscribeDone,
  TranscribeFailed,
  TranscribeReplaced,
  TranscribeSegment,
} from '../../lib/events/types';

export const notesSse: SseBinding = (qc: QueryClient) => [
  /* ── 笔记域：全部是 hint，只触发失效 ── */
  bus.on('note.created', (_e: NoteCreated) => {
    void qc.invalidateQueries({ queryKey: qk.notes.all });
  }),

  bus.on('note.updated', (e: NoteUpdated) => {
    // `fields` 让我们只失效相关查询，而不是无脑全量重拉
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
    if (e.fields.some((f) => ['title', 'durationMs', 'coverAssetUid', 'tags', 'starred'].includes(f))) {
      void qc.invalidateQueries({ queryKey: qk.notes.all });
    }
  }),

  bus.on('note.status', (e: NoteStatusEvent) => {
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
    void qc.invalidateQueries({ queryKey: qk.notes.all });
  }),

  bus.on('note.deleted', (_e: NoteDeleted) => {
    void qc.invalidateQueries({ queryKey: qk.notes.all });
  }),

  /**
   * 波形（role='peaks'）与转码是异步生成的，就绪前去拉会 404。
   * 收到这条才让 player 去加载 —— 这就是这个事件存在的理由（D-05 §11.4）。
   */
  bus.on('media.asset.ready', (e: MediaAssetReady) => {
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
  }),

  /* ── 转写域 ── */
  bus.on('transcribe.started', () => {
    // 起始信息在 detail 里，直接失效即可
  }),

  /**
   * ★ data 类事件：**载荷即真相**，直接追加进缓存，不重拉。
   *
   * 这是"边转边看"成立的关键：第一段文字在十几秒内就出现，
   * 而不是等几十分钟看一个完整结果。若这里改成 invalidate，
   * 每个 chunk 都要整篇重拉（3000 段），既慢又会打断用户滚动。
   */
  bus.on('transcribe.segment', (e: TranscribeSegment) => {
    qc.setQueryData<TranscriptDto | null>(qk.transcript(e.noteUid), (old) => {
      if (!old) return old ?? null;
      // 按 seq 去重后追加（重连重放可能送来已有批次）
      const known = new Set(old.segments.map((s) => s.seq));
      const fresh = e.segments.filter((s) => !known.has(s.seq));
      if (fresh.length === 0) return old;
      return { ...old, segments: [...old.segments, ...fresh].sort((a, b) => a.seq - b.seq) };
    });
  }),

  bus.on('transcribe.chunk', (e: TranscribeChunk) => {
    qc.setQueryData<TranscriptDto | null>(qk.transcript(e.noteUid), (old) =>
      old ? { ...old, progress: e.totalChunks ? e.doneChunks / e.totalChunks : old.progress } : old,
    );
  }),

  bus.on('transcribe.done', (e: TranscribeDone) => {
    void qc.invalidateQueries({ queryKey: qk.transcript(e.noteUid) });
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
  }),

  bus.on('transcribe.failed', (e: TranscribeFailed) => {
    // partial=true 时前 N 段仍完整可见 —— 部分成功优于全盘失败（D-05 §4.1 规则 6）
    void qc.invalidateQueries({ queryKey: qk.transcript(e.noteUid) });
  }),

  /**
   * F3 两阶段的覆盖完成。UI 要据此渲染
   * 「已更新 47 段 · 你编辑过的 3 段已保留 · [撤销]」——
   * 不这么说清楚，用户会以为软件在乱改自己的字。
   */
  bus.on('transcribe.replaced', (e: TranscribeReplaced) => {
    void qc.invalidateQueries({ queryKey: qk.transcript(e.noteUid) });
    bus.emit('ui.toast.replaced', e);
  }),

  /* ── 摘要流式 ── */
  bus.on('summary.delta', (e: SummaryDelta) => {
    qc.setQueryData<string>(qk.summary(e.noteUid), (old) => (old ?? '') + e.textDelta);
  }),

  bus.on('summary.done', (e: { noteUid: string }) => {
    void qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
  }),
];
