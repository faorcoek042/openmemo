import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { useUiStore } from '../../lib/stores/ui.store';
import { Button } from '../../components/common/Button';
import { MockNotice } from '../../components/common/MockNotice';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { JobList } from './JobList';
import { useMergedJobs } from './api';

/**
 * 任务中心抽屉（D-05 §4.5）。
 *
 * M-5 后数据源已从内存改为 `GET /api/jobs` + 内存进度覆盖 ——
 * **刷新后任务仍在**，底部那句"关闭页面不会中断"才不再是空头支票。
 */
export function TasksDrawer() {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.tasksDrawerOpen);
  const setOpen = useUiStore((s) => s.setTasksDrawer);
  const { jobs, isLoading, isError, error } = useMergedJobs();

  if (!open) return null;

  return (
    <aside
      className="fixed inset-y-0 right-0 z-30 flex w-[380px] flex-col border-l border-line bg-surface-1 shadow-e2"
      role="dialog"
      aria-label={t('tasks.title')}
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold text-ink">{t('tasks.title')}</h2>
        <Button size="icon" variant="ghost" onClick={() => setOpen(false)} aria-label={t('common.close')}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <MockNotice surface="jobs" className="mb-3" />
        {isError ? (
          <ErrorBlock error={error} />
        ) : isLoading ? (
          <p className="px-1 py-8 text-center text-sm text-ink-muted">{t('common.loading')}</p>
        ) : jobs.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-ink-muted">{t('tasks.empty')}</p>
        ) : (
          <JobList jobs={jobs} compact />
        )}
      </div>

      <footer className="border-t border-line px-4 py-2.5 text-xs text-ink-muted">
        ⓘ {t('tasks.backgroundNotice')}
      </footer>
    </aside>
  );
}
