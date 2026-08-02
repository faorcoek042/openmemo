import { useTranslation } from 'react-i18next';
import { Pause, Play, RotateCcw, X } from 'lucide-react';

import { ProgressMeter } from '../../components/common/ProgressMeter';
import { StatusChip } from '../../components/common/StatusChip';
import { Button } from '../../components/common/Button';
import { approxEta } from '../../lib/format/time';
import { formatBytes, formatPercent, formatSpeed } from '../../lib/format/bytes';
import { groupJobs, useJobActions, type MergedJob } from './api';

/**
 * 任务列表（抽屉与整页共用）。
 *
 * 分组顺序刻意是 进行中 → 等待中 → **需要处理** → 已完成：
 * `blocked`/`failed` 是唯一需要用户动手的一类，埋在"已完成"下面等于没有。
 */
export function JobList({ jobs, compact }: { jobs: MergedJob[]; compact?: boolean }) {
  const { t } = useTranslation();
  const g = groupJobs(jobs);

  const sections: [string, MergedJob[]][] = [
    [t('tasks.running'), g.running],
    [t('tasks.waiting'), g.waiting],
    [t('tasks.needsAttention'), g.attention],
    [t('tasks.done'), g.done],
  ];

  return (
    <div className="flex flex-col gap-4">
      {sections.map(([label, list]) =>
        list.length === 0 ? null : (
          <section key={label}>
            <h3 className="mb-2 px-1 text-xs font-medium text-ink-secondary">
              {label} ({list.length})
            </h3>
            <ul className="flex flex-col gap-2" role="list">
              {list.map((j) => (
                <JobRow key={j.jobId} job={j} compact={compact} />
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  );
}

function JobRow({ job, compact }: { job: MergedJob; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const actions = useJobActions();

  const stepLabel = job.step ? t(`progress.${job.step}`, { defaultValue: job.step }) : '';
  const eta = approxEta(job.etaSeconds, i18n.language);
  const running = job.state === 'running' || job.state === 'leased';
  const attention = job.state === 'blocked' || job.state === 'failed';

  return (
    <li className="rounded-lg border border-line bg-surface-0 p-3">
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-ink">{job.displayName || job.type}</span>
        {running ? (
          <StatusChip tone="running" label={stepLabel || t('tasks.running')} />
        ) : job.state === 'failed' ? (
          <StatusChip tone="critical" label={t('notes.failed')} />
        ) : job.state === 'blocked' ? (
          <StatusChip tone="warning" label={t('tasks.needsAttention')} />
        ) : job.state === 'paused' ? (
          <StatusChip tone="neutral" label={t('progress.pause')} />
        ) : job.state === 'succeeded' ? (
          <StatusChip tone="good" label={t('tasks.done')} />
        ) : (
          <StatusChip tone="neutral" label={job.state} />
        )}
      </div>

      {job.state !== 'succeeded' && job.state !== 'cancelled' ? (
        <>
          <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-ink-muted">
            <span className="min-w-0 truncate">
              {job.totalBytes
                ? `${formatBytes(job.completedBytes, i18n.language)} / ${formatBytes(job.totalBytes, i18n.language)}`
                : stepLabel}
              {job.speedBps ? ` · ${formatSpeed(job.speedBps, i18n.language)}` : ''}
            </span>
            <span className="shrink-0 tabular-nums">
              {formatPercent(job.progress, i18n.language)}
              {eta ? ` · ${eta}` : ''}
            </span>
          </div>
          <ProgressMeter
            value={job.progress}
            size={compact ? 'sm' : 'md'}
            tone={attention ? 'warning' : 'accent'}
            label={stepLabel || job.type}
          />
        </>
      ) : null}

      {/* 失败/阻塞必须给出可点击的动作，否则"用户不碰命令行"就没做到 */}
      {job.error ? (
        <p className="mt-1.5 text-xs text-critical">
          {i18n.language.startsWith('zh') ? job.error.messageZh : job.error.message}
          {job.maxAttempts > 0 ? ` (${job.attempt}/${job.maxAttempts})` : ''}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {running ? (
          <Button size="sm" variant="ghost" onClick={() => actions.pause.mutate(job.jobId)}>
            <Pause className="size-3" />
            {t('progress.pause')}
          </Button>
        ) : job.state === 'paused' ? (
          <Button size="sm" variant="ghost" onClick={() => actions.resume.mutate(job.jobId)}>
            <Play className="size-3" />
            {t('progress.resume')}
          </Button>
        ) : null}

        {attention ? (
          <Button size="sm" variant="secondary" onClick={() => actions.retry.mutate(job.jobId)}>
            <RotateCcw className="size-3" />
            {t('progress.retry')}
          </Button>
        ) : null}

        {job.state !== 'succeeded' && job.state !== 'cancelled' ? (
          <Button size="sm" variant="ghost" onClick={() => actions.cancel.mutate(job.jobId)}>
            <X className="size-3" />
            {t('progress.cancel')}
          </Button>
        ) : null}

        {job.transientOnly ? (
          <span className="ml-auto text-xs text-ink-muted" title={t('tasks.transientHint')}>
            {t('tasks.transient')}
          </span>
        ) : null}
      </div>
    </li>
  );
}
