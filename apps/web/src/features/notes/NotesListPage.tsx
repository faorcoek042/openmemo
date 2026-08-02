import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FileAudio, Mic, Star } from 'lucide-react';

import { useNotesQuery } from './api';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { StatusChip } from '../../components/common/StatusChip';
import { Button } from '../../components/common/Button';
import { NoteProgressLine } from './NoteProgressLine';
import { humanDuration, relativeTime } from '../../lib/format/time';

/** F5 笔记列表。 */
export default function NotesListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { data: notes, isLoading, isError, error, refetch } = useNotesQuery();

  if (isError) return <ErrorBlock error={error} onRetry={() => void refetch()} className="m-6" />;
  if (isLoading) return <div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>;

  if (!notes || notes.length === 0) {
    return (
      <EmptyState
        icon={<FileAudio className="size-10" />}
        title={t('notes.empty')}
        hint={t('notes.emptyHint')}
        // 空态即入口：直接把下一步动作放眼前，而不是只说"暂无数据"
        action={
          <Button variant="primary" onClick={() => navigate('/capture')}>
            {t('nav.newCapture')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="px-6 py-6">
      <h1 className="mb-4 text-xl font-semibold text-ink">{t('notes.title')}</h1>
      <ul className="flex flex-col gap-2" role="list">
        {notes.map((n) => (
          <li key={n.uid}>
            <Link
              to={`/notes/${n.uid}`}
              className="block rounded-lg border border-line bg-surface-1 p-3 transition-colors hover:bg-surface-2"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 text-ink-muted" aria-hidden>
                  {n.kind === 'recording' ? <Mic className="size-4" /> : <FileAudio className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-medium text-ink">{n.title || t('notes.untitled')}</h2>
                    {n.starred ? <Star className="size-3.5 shrink-0 text-warning" aria-label={t('nav.starred')} /> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                    {n.durationMs ? <span>{humanDuration(n.durationMs, i18n.language)}</span> : null}
                    {n.source?.site ? <span>{n.source.site}</span> : null}
                    <span>{relativeTime(Date.parse(n.updatedAt), i18n.language)}</span>
                    {n.tags.map((tag) => (
                      <span key={tag.uid} className="rounded bg-surface-0 px-1.5 py-0.5 text-ink-secondary">
                        {tag.name}
                      </span>
                    ))}
                  </div>
                  {/* 未完成的任务在列表里也要能看到进度 —— 进度来自 jobs，与页面无关 */}
                  {n.activeJobId ? <NoteProgressLine jobId={n.activeJobId} className="mt-2" /> : null}
                </div>
                <div className="shrink-0">
                  {n.status === 'processing' ? (
                    <StatusChip tone="running" label={t('notes.processing')} />
                  ) : n.status === 'failed' ? (
                    <StatusChip tone="critical" label={t('notes.failed')} />
                  ) : n.status === 'partial' ? (
                    <StatusChip tone="warning" label={t('notes.partial')} />
                  ) : null}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
