import { useTranslation } from 'react-i18next';
import { Ban, RefreshCw, ShieldCheck } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { DownloadJob } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { ProgressMeter } from '../../../components/common/ProgressMeter';
import { StatusChip } from '../../../components/common/StatusChip';
import { useProgressStore } from '../../../lib/stores/progress.store';
import { formatBytes, formatSpeed } from '../../../lib/format/bytes';

/**
 * 下载中的一行（R-04 §9.3 线框）。
 *
 * ★ 进度**只从 transient store 读，不从 Query 缓存读**（D-05 §2.4）：
 * 用 selector 只订阅自己那一个 jobId，别的任务刷新不会让这一行重渲染。
 * store 内部已节流到 200ms，服务端也限流到 4 次/秒/job。
 */

/** 阶段 → 词条 key。**存 key 不存文案** —— 存文案的话切语言不会重算这张常量表。 */
const STEP_KEY: Record<string, string> = {
  resolving: 'models.download.resolving',
  downloading: 'models.download.downloading',
  verifying: 'models.download.verifying',
  installing: 'models.download.installing',
};

/** ETA 文案：D-05 §4.1 规则 4 —— 只在有依据时显示，且四舍五入到"约 X 分钟"。
 *  不显示"剩余 03:47"这种假精确：实测速率波动很大。 */
function formatEta(
  t: (k: string, o?: Record<string, unknown>) => string,
  sec: number | null,
): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  if (sec < 60) return t('models.download.etaUnderMinute');
  return t('models.download.etaMinutes', { minutes: Math.round(sec / 60) });
}

export interface DownloadRowProps {
  job: DownloadJob;
  locale: string;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}

export function DownloadRow({ job, locale, onCancel, onRetry }: DownloadRowProps) {
  const { t } = useTranslation();
  const live = useProgressStore(useShallow((s) => s.byJob[job.jobId]));

  const completed = live?.completedBytes ?? job.completedBytes;
  const total = live?.totalBytes ?? job.totalBytes;
  const step = live?.step ?? job.step;
  const state = live?.state ?? job.state;
  const speed = live?.speedBps ?? job.speedBps;
  const eta = formatEta(t, live?.etaSeconds ?? job.etaSeconds);
  const ratio = total ? Math.min(1, (completed ?? 0) / total) : 0;

  const isVerifying = step === 'verifying';
  const failed = state === 'failed';

  return (
    <div
      className="rounded-lg border border-line bg-surface-1 p-3"
      data-testid={`models-download-row-${job.targetId}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{job.displayName}</p>
          <p className="mt-0.5 text-xs text-ink-secondary">
            {failed ? (
              <span className="text-critical">
                {job.error?.messageZh ?? job.error?.message ?? t('models.download.failed')}
                {job.attempt > 1
                  ? t('models.download.attempt', { attempt: job.attempt, max: job.maxAttempts })
                  : ''}
              </span>
            ) : (
              <>
                {step && STEP_KEY[step] ? t(STEP_KEY[step]) : t('models.download.queued')}
                {job.provider
                  ? ` · ${t('models.download.source', { provider: job.provider })}`
                  : ''}
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isVerifying ? (
            <StatusChip
              tone="running"
              label={t('models.download.verifyingChip')}
              icon={<ShieldCheck className="size-3.5" />}
            />
          ) : null}
          {failed ? (
            <Button size="sm" variant="secondary" onClick={() => onRetry(job.jobId)}>
              <RefreshCw className="size-3.5" aria-hidden />
              {t('models.download.retry')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onCancel(job.jobId)}
              data-testid="models-download-cancel"
            >
              <Ban className="size-3.5" aria-hidden />
              {t('models.download.cancel')}
            </Button>
          )}
        </div>
      </div>

      <ProgressMeter
        className="mt-2"
        value={ratio}
        tone={failed ? 'critical' : 'info'}
        // 校验阶段没有可信百分比 —— 显示脉动而不是假装有进度
        indeterminate={isVerifying}
        label={t('models.download.progressLabel', { name: job.displayName })}
      />

      <div className="mt-1.5 flex items-center justify-between text-xs text-ink-secondary">
        <span className="tabular-nums">
          {formatBytes(completed ?? 0, locale)} / {formatBytes(total ?? 0, locale)}
          {total ? ` · ${Math.round(ratio * 100)}%` : ''}
        </span>
        <span className="tabular-nums">
          {speed ? formatSpeed(speed, locale) : ''}
          {eta ? ` · ${eta}` : ''}
        </span>
      </div>
    </div>
  );
}
