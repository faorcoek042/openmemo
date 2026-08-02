import { useTranslation } from 'react-i18next';
import { useProgressStore } from '../../lib/stores/progress.store';
import { EmptyState } from '../../components/common/EmptyState';

/** 任务中心整页版（抽屉的完整形态）。历史与失败重试待接后端。 */
export default function TasksPage() {
  const { t } = useTranslation();
  const jobs = useProgressStore((s) => Object.values(s.byJob));

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="mb-4 text-xl font-semibold text-ink">{t('tasks.title')}</h1>
      {jobs.length === 0 ? (
        <EmptyState title={t('tasks.empty')} hint={t('tasks.backgroundNotice')} />
      ) : (
        <ul className="flex flex-col gap-2" role="list">
          {jobs.map((j) => (
            <li key={j.jobId} className="rounded-lg border border-line bg-surface-1 p-3 text-sm text-ink">
              {j.jobType} · {j.step}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
