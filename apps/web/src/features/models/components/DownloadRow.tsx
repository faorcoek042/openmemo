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

const STEP_LABEL: Record<string, string> = {
  resolving: '正在选择下载源',
  downloading: '下载中',
  verifying: '正在校验完整性',
  installing: '正在安装',
};

/** ETA 文案：D-05 §4.1 规则 4 —— 只在有依据时显示，且四舍五入到"约 X 分钟"。
 *  不显示"剩余 03:47"这种假精确：实测速率波动很大。 */
function formatEta(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  if (sec < 60) return '剩余不到 1 分钟';
  return `剩余约 ${Math.round(sec / 60)} 分钟`;
}

export interface DownloadRowProps {
  job: DownloadJob;
  locale: string;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}

export function DownloadRow({ job, locale, onCancel, onRetry }: DownloadRowProps) {
  const live = useProgressStore(useShallow((s) => s.byJob[job.jobId]));

  const completed = live?.completedBytes ?? job.completedBytes;
  const total = live?.totalBytes ?? job.totalBytes;
  const step = live?.step ?? job.step;
  const state = live?.state ?? job.state;
  const speed = live?.speedBps ?? job.speedBps;
  const eta = formatEta(live?.etaSeconds ?? job.etaSeconds);
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
                {job.error?.messageZh ?? job.error?.message ?? '下载失败'}
                {job.attempt > 1 ? `（第 ${job.attempt}/${job.maxAttempts} 次）` : ''}
              </span>
            ) : (
              <>
                {STEP_LABEL[step ?? ''] ?? '排队中'}
                {job.provider ? ` · 来源 ${job.provider}` : ''}
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isVerifying ? (
            <StatusChip tone="running" label="校验中" icon={<ShieldCheck className="size-3.5" />} />
          ) : null}
          {failed ? (
            <Button size="sm" variant="secondary" onClick={() => onRetry(job.jobId)}>
              <RefreshCw className="size-3.5" aria-hidden />
              重试
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onCancel(job.jobId)}
              data-testid="models-download-cancel"
            >
              <Ban className="size-3.5" aria-hidden />
              取消
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
        label={`${job.displayName} 下载进度`}
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
