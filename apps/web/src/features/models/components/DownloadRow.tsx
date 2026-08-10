import { useTranslation } from 'react-i18next';
import { Ban, RefreshCw, ShieldCheck } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { DownloadJob } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { ProgressMeter } from '../../../components/common/ProgressMeter';
import { StatusChip } from '../../../components/common/StatusChip';
import { useProgressStore } from '../../../lib/stores/progress.store';
import { formatBytes, formatSpeed } from '../../../lib/format/bytes';
import { stepLabel } from '../../../lib/format/stepLabel';
import { jobDisplayName } from '../../../lib/format/jobName';
import { useModelCatalogNames } from '../../../lib/catalog/useModelCatalogNames';

/**
 * 下载中的一行（R-04 §9.3 线框）。
 *
 * ★ 进度**只从 transient store 读，不从 Query 缓存读**（D-05 §2.4）：
 * 用 selector 只订阅自己那一个 jobId，别的任务刷新不会让这一行重渲染。
 * store 内部已节流到 200ms，服务端也限流到 4 次/秒/job。
 */

/*
 * ★ 这里原本有一张 `STEP_KEY` 表 + 一整套 `models.download.*` 阶段词条 ——
 *   **和 `progress.*` 是同一件事的第二份实现。**
 *
 * 后果不是"多写了几行"，是**两份实现会各自漂**：`[实测]` 收敛前
 * `warming` 在两套词条里是两句不同的中文，`unpacking` 一度只有其中一套有；
 * 而三个渲染点（任务中心 / Toast / 这一行）读的是不同的套，
 * 于是同一时刻同一个 job，两个页面可以说两句互相矛盾的话。
 *
 * 现已收敛到 `lib/format/stepLabel.ts` —— **一份实现**。
 * 兜底也随之统一：缺词条时给中性的「处理中」，
 * **不是「排队中」**（那是在断言一件假事：进度倒退回起点），
 * **也不是原始英文 key**（把机器枚举值摆给用户看）。
 */
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
  const { t, i18n } = useTranslation();
  const live = useProgressStore(useShallow((s) => s.byJob[job.jobId]));
  // 名字按当前界面语言现算；兜底仍是 daemon 的 displayName（见 lib/format/jobName.ts）
  const catalogNames = useModelCatalogNames();
  const shownName = jobDisplayName(i18n.language, job, catalogNames);

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
          <p className="truncate text-sm font-medium text-ink">{shownName}</p>
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
                {/*
                  `step` 为空 = 这个 job **真的还在排队**（不是词条缺失），
                  所以这一档仍然说「排队中」—— 那是事实。
                  词条缺失那一档由 `stepLabel` 兜成「处理中」。两者别混。
                */}
                {step
                  ? stepLabel(step, t, (k: string) => i18n.exists(k))
                  : t('progress.state.queued')}
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
        label={t('models.download.progressLabel', { name: shownName })}
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
