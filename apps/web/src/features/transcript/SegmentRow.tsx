import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, PencilLine, RotateCcw, ShieldCheck } from 'lucide-react';

import { SEGMENT_FLAG, type TranscriptSegmentDto } from '../../lib/events/types';
import { timecode } from '../../lib/format/time';
import { cn } from '../../lib/utils';

/**
 * 单条转写段落（M-4）。
 *
 * 三个状态徽标，各自解决一个"用户会误解"的场景：
 *
 * | 徽标 | 何时出现 | 不显示会怎样 |
 * |---|---|---|
 * | 已编辑 | `editedAt != null` | 用户不知道哪些是自己改的、哪些是机器识别的 |
 * | **已保留（无对应更新）** | `flags & HUMAN_CONFIRMED` | 重跑后用户发现某段"没变"，会以为重跑漏了它 —— 其实是**故意保留**了他的编辑 |
 * | 疑似重复 | `flags & HALLUCINATION` | whisper 幻觉段混在正文里看不出来 |
 *
 * 第二条尤其重要：合并是**按时间轴对齐而非段落序号**（两遍模型断句天然不同），
 * 所以"编辑过但重跑里找不到对应位置"是**正常且预期**的结果，必须能表达出来。
 */
export function SegmentRow({
  seg,
  speakerName,
  active,
  editable,
  onSeek,
  onSave,
  onRevert,
}: {
  seg: TranscriptSegmentDto;
  speakerName: string | null;
  active: boolean;
  editable: boolean;
  onSeek: () => void;
  onSave: (text: string) => void;
  onRevert: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(seg.text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.setSelectionRange(draft.length, draft.length);
    }
  }, [editing]);

  const edited = seg.editedAt != null;
  const preserved = (seg.flags & SEGMENT_FLAG.CONFIRMED) !== 0;
  const hallucination = (seg.flags & SEGMENT_FLAG.HALLUCINATION) !== 0;
  const lowConf = (seg.flags & SEGMENT_FLAG.LOW_CONFIDENCE) !== 0;

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== seg.text) onSave(next);
    else setDraft(seg.text);
  };

  return (
    <div
      className={cn(
        'group flex gap-3 rounded-md px-3 py-2 transition-colors',
        active ? 'bg-accent-track/40' : 'hover:bg-surface-2',
        hallucination && 'border-l-2 border-l-warning',
      )}
    >
      <button
        type="button"
        onClick={onSeek}
        className="mt-0.5 shrink-0 tabular-nums text-xs text-ink-muted hover:text-accent"
        title={t('detail.seekHere')}
      >
        {timecode(seg.startMs)}
      </button>

      <div className="min-w-0 flex-1">
        {speakerName ? (
          <span className="mr-1.5 text-xs font-medium text-ink-secondary">{speakerName}</span>
        ) : null}

        {editing ? (
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(seg.text);
                setEditing(false);
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              }
            }}
            rows={Math.max(1, Math.ceil(draft.length / 42))}
            className="w-full resize-none rounded-md border border-accent bg-surface-0 px-2 py-1 text-transcript text-ink"
            aria-label={t('detail.editSegment')}
          />
        ) : (
          <span
            className={cn('text-transcript text-ink', lowConf && 'opacity-80')}
            onDoubleClick={() => editable && setEditing(true)}
            title={editable ? t('detail.doubleClickToEdit') : undefined}
          >
            {seg.text}
          </span>
        )}

        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {edited ? (
            <span className="inline-flex items-center gap-1 text-xs text-accent">
              <PencilLine className="size-3" aria-hidden />
              {t('detail.edited')}
            </span>
          ) : null}

          {/* ★ 「已保留（无对应更新）」—— 不说清楚，用户会以为重跑漏了这一段 */}
          {preserved ? (
            <span
              className="inline-flex items-center gap-1 text-xs text-good"
              title={t('detail.preservedWhy')}
            >
              <ShieldCheck className="size-3" aria-hidden />
              {t('detail.preserved')}
            </span>
          ) : null}

          {hallucination ? (
            <span className="inline-flex items-center gap-1 text-xs text-warning">
              <AlertTriangle className="size-3" aria-hidden />
              {t('detail.hallucination')}
            </span>
          ) : null}

          {edited && seg.textRaw ? (
            <button
              type="button"
              onClick={onRevert}
              className="inline-flex items-center gap-1 text-xs text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink-secondary"
              title={t('detail.revertHint', { raw: seg.textRaw })}
            >
              <RotateCcw className="size-3" aria-hidden />
              {t('detail.revert')}
            </button>
          ) : null}

          {editable && !editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ml-auto text-xs text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink-secondary"
            >
              {t('detail.editSegment')}
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
