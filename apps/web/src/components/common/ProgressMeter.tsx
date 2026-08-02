import { cn } from '../../lib/utils';

/**
 * 进度条（D-05 §7.3 的 meter 规格）。
 *
 * 规格不是随手定的：
 * - **填充端 4px 圆角、基线端方角** —— 数据端圆角、基线端方角是柱状标记的通用规范，
 *   让"从 0 长出来"这件事在视觉上成立。
 * - **轨道 = 同色系更浅一档**（`--accent-track`），不是灰色。这样整条 bar 都在讲同一件事。
 * - **填充随严重度换色** accent → warning → critical。
 * - 颜色永远不是唯一信息载体：调用方必须同时给出文字标签（a11y 基线 D-05 §6.3）。
 */

export type MeterTone = 'accent' | 'warning' | 'critical' | 'good';

const TONE_BG: Record<MeterTone, string> = {
  accent: 'bg-accent',
  warning: 'bg-warning',
  critical: 'bg-critical',
  good: 'bg-good',
};

export interface ProgressMeterProps {
  /** 0..1。超出范围会被夹紧。 */
  value: number;
  tone?: MeterTone;
  /** 行内 6px / 抽屉 8px（D-05 §7.3） */
  size?: 'sm' | 'md';
  /** 不确定进度（如"解析中"）→ 显示轻微脉动而不是假装有百分比 */
  indeterminate?: boolean;
  className?: string;
  /** 屏幕阅读器用的说明；可见文字由调用方另行渲染 */
  label: string;
}

export function ProgressMeter({
  value,
  tone = 'accent',
  size = 'sm',
  indeterminate = false,
  className,
  label,
}: ProgressMeterProps) {
  const pct = Math.min(100, Math.max(0, (Number.isFinite(value) ? value : 0) * 100));
  const h = size === 'sm' ? 'h-1.5' : 'h-2';

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      className={cn('w-full overflow-hidden rounded-full bg-accent-track', h, className)}
    >
      <div
        className={cn(
          'h-full transition-[width] duration-200 ease-out',
          // 基线端方角、数据端圆角
          'rounded-l-none rounded-r-[4px]',
          TONE_BG[tone],
          indeterminate && 'animate-pulse',
        )}
        style={{ width: indeterminate ? '40%' : `${pct}%` }}
      />
    </div>
  );
}
