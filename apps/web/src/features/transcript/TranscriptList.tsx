import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

import { SEGMENT_FLAG, type TranscriptSegmentDto } from '../../lib/events/types';
import { findActiveIndex, getPositionMs, usePlayerStore } from '../../lib/stores/player.store';
import { useUiStore } from '../../lib/stores/ui.store';
import { timecode } from '../../lib/format/time';
import { cn } from '../../lib/utils';

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
}: {
  segments: TranscriptSegmentDto[];
  speakerNames: Record<string, string>;
}) {
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
    <div ref={parentRef} className="h-full overflow-auto" role="list" aria-label={t('detail.transcript')}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const seg = segments[row.index];
          const active = seg.seq === activeSeq;
          const hallucination = (seg.flags & SEGMENT_FLAG.HALLUCINATION) !== 0;
          const lowConf = (seg.flags & SEGMENT_FLAG.LOW_CONFIDENCE) !== 0;

          return (
            <div
              key={seg.seq}
              role="listitem"
              data-index={row.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }}
            >
              <button
                type="button"
                onClick={() => {
                  suppress.current = true;
                  requestSeek(seg.startMs);
                  setTimeout(() => (suppress.current = false), 300);
                }}
                className={cn(
                  'flex w-full gap-3 rounded-md px-3 py-2 text-left transition-colors',
                  active ? 'bg-accent-track/40' : 'hover:bg-surface-2',
                  hallucination && 'border-l-2 border-l-warning',
                )}
              >
                <span className="mt-0.5 shrink-0 tabular-nums text-xs text-ink-muted">
                  {timecode(seg.startMs)}
                </span>
                <span className="min-w-0 flex-1">
                  {seg.speakerLabel ? (
                    <span className="mr-1.5 text-xs font-medium text-ink-secondary">
                      {speakerNames[seg.speakerLabel] ?? seg.speakerLabel}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      'text-transcript text-ink',
                      // 低置信不用颜色单独表达（色觉障碍不可见），配合下方的图标+文字
                      lowConf && 'opacity-80',
                    )}
                  >
                    {seg.text}
                  </span>
                  {hallucination ? (
                    <span className="mt-1 flex items-center gap-1 text-xs text-warning">
                      <AlertTriangle className="size-3" aria-hidden />
                      {t('detail.hallucination')}
                    </span>
                  ) : null}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
