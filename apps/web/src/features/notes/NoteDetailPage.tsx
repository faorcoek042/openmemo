import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';

import { useNoteQuery, useTranscriptQuery } from './api';
import { qk } from '../../app/query';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { MockNotice } from '../../components/common/MockNotice';
import { WordLevelBadge } from '../transcript';
import { MindmapView, useMindmapQuery } from '../mindmap';
import { NoteProgressLine } from './NoteProgressLine';
import { TagEditor } from './TagEditor';
import { NoteEditor } from './NoteEditor';
import { ExportMenu } from './ExportMenu';
import { TranscriptList } from '../transcript';
import { PlayerBar } from '../player';
import { usePlayerStore } from '../../lib/stores/player.store';
import { useUiStore } from '../../lib/stores/ui.store';
import { mockPeaks, type DecodedPeaks } from '../../lib/format/peaks';
import { isMockEnabled } from '../../lib/api/mock';
import { cn } from '../../lib/utils';

type Tab = 'summary' | 'mindmap' | 'notes';

/** F5 笔记详情 —— 产品心脏（D-05 §4.4）。 */
export default function NoteDetailPage() {
  const { t } = useTranslation();
  const { noteUid } = useParams<{ noteUid: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'summary';

  const note = useNoteQuery(noteUid);
  const transcript = useTranscriptQuery(noteUid);
  const setSource = usePlayerStore((s) => s.setSource);
  const follow = useUiStore((s) => s.followPlayback);
  const setFollow = useUiStore((s) => s.setFollowPlayback);

  // 摘要走 summary.delta 流式累积（bindings 写进这个 key）
  const { data: streamedSummary } = useQuery({
    queryKey: qk.summary(noteUid ?? ''),
    queryFn: () => '',
    enabled: Boolean(noteUid),
    staleTime: Infinity,
  });

  const audioAsset = note.data?.assets.find((a) => a.role === 'audio16k' && a.state === 'ready');
  const peaksAsset = note.data?.assets.find((a) => a.role === 'peaks' && a.state === 'ready');

  useEffect(() => {
    if (!note.data) return;
    setSource(audioAsset?.uid ?? null, note.data.durationMs ?? 0);
  }, [note.data, audioAsset?.uid, setSource]);

  // 真实峰值需要 fetch `.ompk` 并 decodeOmpk()；daemon 未接通时用占位波形，
  // 并在 UI 上标注（诚实规则：不许把 mock 说成真数据）
  const [peaks, setPeaks] = useState<DecodedPeaks | null>(null);
  useEffect(() => {
    if (!note.data) return;
    if (peaksAsset && !isMockEnabled()) {
      setPeaks(null); // TODO(T-021): fetch mediaUrl(peaksAsset.uid) → decodeOmpk
    } else {
      setPeaks(mockPeaks(note.data.durationMs ?? 60_000));
    }
  }, [note.data, peaksAsset]);

  const mindmap = useMindmapQuery(tab === 'mindmap' ? noteUid : undefined);

  const speakerNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of transcript.data?.speakers ?? []) m[s.label] = s.displayName ?? s.label;
    return m;
  }, [transcript.data]);

  if (note.isError) return <ErrorBlock error={note.error} onRetry={() => void note.refetch()} className="m-6" />;
  if (!note.data) return <div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>;

  const n = note.data;

  return (
    <div className="flex h-full flex-col">
      {/* 进行中的任务：顶部进度条 + **主动告诉用户可以关页面** */}
      {n.activeJobId ? (
        <div className="border-b border-line bg-surface-1 px-4 py-2">
          <NoteProgressLine jobId={n.activeJobId} />
          <p className="mt-1 text-xs text-ink-muted">▸ {t('detail.backgroundHint')}</p>
        </div>
      ) : null}

      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h1 className="min-w-0 truncate text-base font-semibold text-ink">{n.title}</h1>
        <span className="flex items-center gap-2">
          <TagEditor noteUid={n.uid} tags={n.tags} />
          <ExportMenu note={n} />
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左：转写稿 */}
        <section className="flex min-w-0 flex-1 flex-col border-r border-line">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <h2 className="flex items-center gap-2 text-xs font-medium text-ink-secondary">
              {t('detail.transcript')}
              <MockNotice surface="transcript" compact />
              <WordLevelBadge segments={transcript.data?.segments ?? []} />
            </h2>
            <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
                className="size-3.5 accent-[var(--accent)]"
              />
              {t('detail.followPlayback')}
            </label>
          </div>
          <div className="min-h-0 flex-1">
            <TranscriptList
              segments={transcript.data?.segments ?? []}
              speakerNames={speakerNames}
              noteUid={noteUid}
              transcriptUid={transcript.data?.uid}
            />
          </div>
        </section>

        {/* 右：Tab */}
        <aside className="hidden w-[420px] shrink-0 flex-col lg:flex">
          <nav className="flex border-b border-line" role="tablist">
            {(['summary', 'mindmap', 'notes'] as Tab[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setParams((p) => {
                  p.set('tab', k);
                  return p;
                })}
                className={cn(
                  'flex-1 px-3 py-2 text-sm transition-colors',
                  tab === k ? 'border-b-2 border-b-accent text-ink' : 'text-ink-muted hover:text-ink-secondary',
                )}
              >
                {t(`detail.tabs.${k}`)}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-auto p-4 text-sm text-ink-secondary">
            {tab === 'summary' ? (
              (n.summaryMd ?? streamedSummary) ? (
                <p className="whitespace-pre-wrap">{n.summaryMd || streamedSummary}</p>
              ) : (
                <p className="text-ink-muted">{t('detail.summaryEmpty')}</p>
              )
            ) : tab === 'mindmap' ? (
              mindmap.data ? (
                <div className="-m-4 h-[60vh]">
                  <MindmapView doc={mindmap.data} />
                </div>
              ) : (
                <p className="text-ink-muted">{t('mindmap.empty')}</p>
              )
            ) : (
              <NoteEditor
                noteUid={n.uid}
                initialJson={n.bodyJson ?? null}
                transcriptUid={transcript.data?.uid}
                quoteAt={(ms) => {
                  // 取该毫秒所在段的原文，作为锚点的重定位依据（D-02 §3.5 第 2 层）
                  const segs = transcript.data?.segments ?? [];
                  const hit = segs.find((sg) => sg.startMs <= ms && ms < sg.endMs);
                  return hit ? hit.text.slice(0, 200) : null;
                }}
              />
            )}
          </div>
        </aside>
      </div>

      <PlayerBar peaks={peaks} />
    </div>
  );
}
