import { reportProgressDimensionViolation } from '@openmemo/shared';

import { cn } from '../../lib/utils';

/** 浮点累加出来的 `1.0000000000000002` 不该被当成量纲错。 */
const EPSILON = 1e-9;

/**
 * 进度条（D-05 §7.3 的 meter 规格）。
 *
 * 规格不是随手定的：
 * - **填充端 4px 圆角、基线端方角** —— 数据端圆角、基线端方角是柱状标记的通用规范，
 *   让"从 0 长出来"这件事在视觉上成立。
 * - **轨道 = 同色系更浅一档**，不是灰色。这样整条 bar 都在讲同一件事。
 * - 颜色永远不是唯一信息载体：调用方必须同时给出文字标签（a11y 基线 D-05 §6.3）。
 *
 * ── T-114 修的是"轨道只有一种颜色"这个漏洞 ──
 *
 * 原来轨道写死 `--accent-track`（浅蓝，T-124 已更名为 `--accent-tint`），
 * 填充却会换成 warning / critical。
 * 实测这条组合在明档是坏的：
 *
 *     填充 vs 轨道   warning **1.39:1** · good 2.53:1 · accent 3.34 · critical 3.63
 *
 * 也就是说**橙黄色的进度条压在浅蓝轨道上，几乎看不出走到哪了** ——
 * 而进度条恰恰是"填充与轨道能否分辨"这一件事的全部意义。
 * 现在轨道跟着 tone 走（`--status-*-tint`），填充用 ink 档，明暗两档全部 ≥ 4.5:1。
 */

/** `accent` 是既有调用点的名字，等价于 `info`（进行中）。 */
export type MeterTone = 'accent' | 'info' | 'warning' | 'critical' | 'good';

const TONE_FILL: Record<MeterTone, string> = {
  accent: 'bg-info',
  info: 'bg-info',
  warning: 'bg-warning',
  critical: 'bg-critical',
  good: 'bg-good',
};

const TONE_TRACK: Record<MeterTone, string> = {
  accent: 'bg-info-tint',
  info: 'bg-info-tint',
  warning: 'bg-warning-tint',
  critical: 'bg-critical-tint',
  good: 'bg-good-tint',
};

export interface ProgressMeterProps {
  /**
   * **0..1 的比例**，不是百分数。
   *
   * 越界（含 NaN）不再被夹紧成满条 —— 它会**出声并退化成不确定表达**，理由见下面
   * `outOfRange` 那一段。要画"没有刻度"，用 `indeterminate` 明说，别传越界值。
   */
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
  /*
   * ── ★ #90：越界不再被夹成满条，而是**出声 + 退化成不确定表达** ──────────────
   *
   * 原来是 `const pct = Math.min(100, Math.max(0, value * 100))`。于是上游把
   * 0–100 的百分比当 0–1 传进来（`value = 90`）时，`9000` 被夹成 `100`：
   * **满格的条 + `aria-valuenow="100"`** —— 屏幕阅读器和视力正常的用户一起被骗，
   * 而屏幕上没有任何一处显得不对劲。一条 40 分钟的音频转到 72%，它说 100%。
   *
   * 夹紧本身要留（绝不能让 `width: 9000%` 撑破布局），要改的是**夹完不吭声**。
   * 越界现在走 `indeterminate` 那条既有的路：脉动、不给 `aria-valuenow` ——
   * 与本组件对 `verifying` 的处理是同一条规则：
   * **没有可信刻度时画脉动，不画一个假的百分比。**
   */
  const outOfRange = !Number.isFinite(value) || value < -EPSILON || value > 1 + EPSILON;
  if (outOfRange && Number.isFinite(value))
    reportProgressDimensionViolation('ProgressMeter', value);
  const unknown = indeterminate || outOfRange;
  const pct = Math.min(100, Math.max(0, (Number.isFinite(value) ? value : 0) * 100));
  const h = size === 'sm' ? 'h-1.5' : 'h-2';

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={unknown ? undefined : Math.round(pct)}
      className={cn('w-full overflow-hidden rounded-full', TONE_TRACK[tone], h, className)}
    >
      <div
        className={cn(
          'h-full transition-[width] duration-200 ease-out',
          // 基线端方角、数据端圆角
          'rounded-l-none rounded-r-[4px]',
          TONE_FILL[tone],
          unknown && 'animate-pulse',
        )}
        style={{ width: unknown ? '40%' : `${pct}%` }}
      />
    </div>
  );
}
