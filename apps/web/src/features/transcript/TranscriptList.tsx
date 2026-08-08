import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';

import type { TranscriptSegmentDto } from '../../lib/events/types';
import { SegmentRow } from './SegmentRow';
import { useEditSegmentMutation, useRevertSegmentMutation } from './api';
import { findActiveIndex, getPositionMs, usePlayerStore } from '../../lib/stores/player.store';
import { useUiStore } from '../../lib/stores/ui.store';

/**
 * F5 转写稿（D-05 §4.4）。
 *
 * 三个性能/体验要点：
 * 1. **虚拟滚动**：3 小时讲座有 3000+ 段，全量 DOM 会卡死。
 * 2. **高亮只重渲染受影响的段**：activeSeq 是低频状态（几秒一次），
 *    播放位置本身走 transient 通道不进 React。
 * 3. **用户手动滚动 → 自动关闭"跟随播放"**。不做这一条的话，
 *    用户想往回翻看前面的内容会被强行拽回当前位置 —— 这是最容易被忽略、
 *    但一旦缺失就非常恼人的细节。
 */
export function TranscriptList({
  segments,
  speakerNames,
  noteUid,
  editable = true,
}: {
  segments: readonly TranscriptSegmentDto[];
  speakerNames: Record<string, string>;
  /**
   * 段落编辑按 **noteUid** 寻址（`PATCH /api/notes/:uid/segments/:seq`）——
   * 服务端从 note 取"当前活跃转写稿"，所以换稿之后同一个 URL 依然有效。
   * 早先这里收的是 transcriptUid，那是我按设计猜的路径，实测 404（见 features/transcript/api.ts）。
   */
  noteUid?: string;
  editable?: boolean;
}) {
  const edit = useEditSegmentMutation(noteUid);
  const revert = useRevertSegmentMutation(noteUid);
  /**
   * ★ 逐字时间戳是否可用（ADR-013 §0）。
   *
   * Paraformer（中文默认引擎）**没有 words[]**，所以 F5 的卡拉 OK 式逐字高亮
   * 在中文默认档下**不成立**，只能整句高亮。
   * 这个降级必须**说出来**：否则用户只会觉得"高亮不准"，
   * 而不知道那是引擎取舍的必然结果、更不知道换 large-v3-turbo 就能拿到。
   */
  const hasWordLevel = segments.some((s) => s.words && s.words.length > 0);
  // 逐字数据缺失时，高亮粒度只能到句 —— 由 <WordLevelBadge/> 在标题栏说明。
  const highlightGranularity: 'word' | 'sentence' = hasWordLevel ? 'word' : 'sentence';
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);
  const activeSeq = usePlayerStore((s) => s.activeSeq);
  const setActiveSeq = usePlayerStore((s) => s.setActiveSeq);
  const requestSeek = usePlayerStore((s) => s.requestSeek);
  const setFollow = useUiStore((s) => s.setFollowPlayback);

  const starts = useMemo(() => segments.map((s) => s.startMs), [segments]);
  const ends = useMemo(() => segments.map((s) => s.endMs), [segments]);

  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 62,
    overscan: 8,
  });

  // 播放位置 → 当前段。订阅 transient 通道，不经过 React state。
  useEffect(() => {
    let raf = 0;
    let lastIdx = -2;
    const tick = () => {
      const idx = findActiveIndex(starts, ends, getPositionMs());
      if (idx !== lastIdx) {
        lastIdx = idx;
        setActiveSeq(idx >= 0 ? segments[idx].seq : null);
        if (idx >= 0 && useUiStore.getState().followPlayback) {
          virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'auto' });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [starts, ends, segments]);

  // 手动滚动 → 关掉跟随
  const suppress = useRef(false);
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onWheel = () => {
      if (suppress.current) return;
      if (useUiStore.getState().followPlayback) setFollow(false);
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', onWheel, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onWheel);
    };
  }, [setFollow]);

  if (segments.length === 0) {
    return <p className="px-4 py-8 text-sm text-ink-muted">{t('detail.noTranscript')}</p>;
  }

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      role="list"
      aria-label={t('detail.transcript')}
      data-highlight={highlightGranularity}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const seg = segments[row.index];
          const active = seg.seq === activeSeq;

          return (
            <div
              key={seg.seq}
              role="listitem"
              data-index={row.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${row.start}px)`,
              }}
            >
              <SegmentRow
                seg={seg}
                speakerName={
                  seg.speakerLabel ? (speakerNames[seg.speakerLabel] ?? seg.speakerLabel) : null
                }
                active={active}
                editable={editable && Boolean(noteUid)}
                onSeek={() => {
                  suppress.current = true;
                  requestSeek(seg.startMs);
                  setTimeout(() => (suppress.current = false), 300);
                }}
                onSave={(text) => edit.mutate({ seq: seg.seq, text })}
                onRevert={() => revert.mutate({ seq: seg.seq })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
