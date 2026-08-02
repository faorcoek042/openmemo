import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { useUiStore } from '../../lib/stores/ui.store';
import { useProgressStore } from '../../lib/stores/progress.store';
import { ProgressMeter } from '../../components/common/ProgressMeter';
import { StatusChip } from '../../components/common/StatusChip';
import { Button } from '../../components/common/Button';
import { approxEta } from '../../lib/format/time';
import { formatBytes, formatPercent, formatSpeed } from '../../lib/format/bytes';

/**
 * 任务中心抽屉（D-05 §4.5）。
 *
 * ★ 用户的真实心智是"关掉页面 = 任务没了"。事实相反（任务在 daemon 里），
 * 所以**产品必须主动说**——底部那句常驻提示不是装饰。
 *
 * 分组用 `JOB_STATES` 的语义，且 **"需要处理"排在"已完成"之前**：
 * blocked/failed 是唯一需要用户动作的一类，埋在最下面等于没有。
 */
export function TasksDrawer() {
  const { t, i18n } = useTranslation();
  const open = useUiStore((s) => s.tasksDrawerOpen);
  const setOpen = useUiStore((s) => s.setTasksDrawer);
  const byJob = useProgressStore((s) => s.byJob);

  if (!open) return null;
  const jobs = Object.values(byJob);

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
        {jobs.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-ink-muted">{t('tasks.empty')}</p>
        ) : (
          <>
            <h3 className="mb-2 px-1 text-xs font-medium text-ink-secondary">{t('tasks.running')}</h3>
            <ul className="flex flex-col gap-2" role="list">
              {jobs.map((j) => {
                const eta = approxEta(j.etaSeconds, i18n.language);
                const stepLabel = j.step ? t(`progress.${j.step}`, { defaultValue: j.step }) : '';
                return (
                  <li key={j.jobId} className="rounded-lg border border-line bg-surface-0 p-3">
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm text-ink">{j.jobType}</span>
                      <StatusChip tone="running" label={stepLabel} />
                    </div>
                    <div className="mb-1.5 flex items-center justify-between text-xs text-ink-muted">
                      <span>
                        {j.totalBytes
                          ? `${formatBytes(j.completedBytes, i18n.language)} / ${formatBytes(j.totalBytes, i18n.language)}`
                          : stepLabel}
                        {j.speedBps ? ` · ${formatSpeed(j.speedBps, i18n.language)}` : ''}
                      </span>
                      <span className="tabular-nums">
                        {formatPercent(j.progress, i18n.language)}
                        {eta ? ` · ${eta}` : ''}
                      </span>
                    </div>
                    <ProgressMeter value={j.progress} size="md" label={stepLabel} />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* 这句是产品要求，不是可选文案 */}
      <footer className="border-t border-line px-4 py-2.5 text-xs text-ink-muted">
        ⓘ {t('tasks.backgroundNotice')}
      </footer>
    </aside>
  );
}
