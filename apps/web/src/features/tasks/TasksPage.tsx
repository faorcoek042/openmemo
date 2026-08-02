import { useTranslation } from 'react-i18next';

import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { MockNotice } from '../../components/common/MockNotice';
import { JobList } from './JobList';
import { useMergedJobs } from './api';

/** 任务中心整页版。与抽屉共用 `JobList`，数据源同为服务端 + 内存进度覆盖。 */
export default function TasksPage() {
  const { t } = useTranslation();
  const { jobs, isLoading, isError, error } = useMergedJobs();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="mb-4 text-xl font-semibold text-ink">{t('tasks.title')}</h1>
      <MockNotice surface="jobs" className="mb-3" />

      {isError ? (
        <ErrorBlock error={error} />
      ) : isLoading ? (
        <p className="text-sm text-ink-muted">{t('common.loading')}</p>
      ) : jobs.length === 0 ? (
        <EmptyState title={t('tasks.empty')} hint={t('tasks.backgroundNotice')} />
      ) : (
        <JobList jobs={jobs} />
      )}
    </div>
  );
}
