import { useTranslation } from 'react-i18next';
import { useProgressStore } from '../../lib/stores/progress.store';
import { ProgressMeter } from '../../components/common/ProgressMeter';
import { approxEta } from '../../lib/format/time';
import { formatPercent } from '../../lib/format/bytes';

/**
 * 单个作业的进度行。
 *
 * ★ 关键：用 **selector 只订阅自己那一个 jobId**。
 * 这样 5 个任务同时跑时，每条进度行只在自己的数据变化时重渲染，
 * 互不牵连（D-05 §2.4）。
 */
export function NoteProgressLine({ jobId, className }: { jobId: string; className?: string }) {
  const { t, i18n } = useTranslation();
  const snap = useProgressStore((s) => s.byJob[jobId]);

  if (!snap) return null;

  const stepLabel = snap.step ? t(`progress.${snap.step}`, { defaultValue: snap.step }) : null;
  const eta = approxEta(snap.etaSeconds, i18n.language);

  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-secondary">
        <span className="truncate">
          {stepLabel}
          {snap.stepIndex && snap.stepCount ? ` · ${snap.stepIndex}/${snap.stepCount}` : ''}
        </span>
        <span className="shrink-0 tabular-nums text-ink-muted">
          {formatPercent(snap.progress, i18n.language)}
          {eta ? ` · ${eta}` : ''}
        </span>
      </div>
      <ProgressMeter value={snap.progress} label={stepLabel ?? t('common.loading')} />
    </div>
  );
}
