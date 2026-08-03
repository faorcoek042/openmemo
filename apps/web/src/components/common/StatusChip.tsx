import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Info,
  Loader2,
  OctagonAlert,
  PauseCircle,
  XCircle,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { StatusTone } from './statusTone';

/**
 * 状态芯片。
 *
 * ★ 硬规则（D-05 §6.3）：**状态绝不只用颜色。** icon 与 label 都是必需的，
 * 没有"只要一个彩色圆点"的用法。状态色也**不得**被当作第 5 个分类色使用。
 *
 * ── T-114 改了两件事 ──
 *
 * ① **颜色档换了**：`text-good` 等工具类现在指向 `--status-*-ink`（文字档），
 *    不再指向按图表记号选的锚点档。原来的 `text-warning` 在明档只有 **1.74:1** ——
 *    那不是"颜色偏浅"，那是**看不见**；本组件当时的注释把它写成"设计取舍"，
 *    但取舍的前提（只当记号用）与实际用法（当文字用）对不上。现在 ink 档明暗都 ≥ 4.5:1。
 *
 * ② **多了 `variant="soft"`**：淡底 + 描边 + 文字三件套（`-tint` / `-line` / ink）。
 *    裸文字芯片挤在一行按钮和说明里时，"这是个状态"这件事本身要靠读文案才知道；
 *    给它一个容器，扫视时才分得出层级。`plain` 仍是默认 —— 表格与紧凑行里不该加框。
 *
 * tone 的判定不在这里，在 `./statusTone.ts`（唯一判定表）。
 */

/** 兼容既有调用点：`running` = `info` + 转圈图标（"正在跑"这件事由图标讲） */
export type StatusChipTone = StatusTone | 'running';

const TONE_TEXT: Record<StatusChipTone, string> = {
  good: 'text-good',
  info: 'text-info',
  warning: 'text-warning',
  serious: 'text-serious',
  critical: 'text-critical',
  neutral: 'text-ink-muted',
  running: 'text-info',
};

/** soft 变体的淡底 + 描边。都跑过对比度：ink 对自身淡底 ≥ 4.5:1，描边对表层 ≥ 3:1。 */
const TONE_SOFT: Record<StatusChipTone, string> = {
  good: 'bg-good-tint border-good-line/45',
  info: 'bg-info-tint border-info-line/45',
  warning: 'bg-warning-tint border-warning-line/45',
  serious: 'bg-serious-tint border-serious-line/45',
  critical: 'bg-critical-tint border-critical-line/45',
  /* 中性档用**内嵌层**而不是抬升层：T-124 之后明档 surface-2 = 白 = 卡片底，
     淡底会消失。芯片的底本来就该比它所在的面「凹」一点。 */
  neutral: 'bg-surface-0 border-line',
  running: 'bg-info-tint border-info-line/45',
};

const DEFAULT_ICON: Record<StatusChipTone, ReactNode> = {
  good: <CheckCircle2 className="size-3.5" aria-hidden />,
  info: <Info className="size-3.5" aria-hidden />,
  warning: <AlertTriangle className="size-3.5" aria-hidden />,
  serious: <OctagonAlert className="size-3.5" aria-hidden />,
  critical: <XCircle className="size-3.5" aria-hidden />,
  neutral: <CircleDashed className="size-3.5" aria-hidden />,
  running: <Loader2 className="size-3.5 animate-spin" aria-hidden />,
};

export interface StatusChipProps {
  tone: StatusChipTone;
  /** 必填 —— 这就是"不许只用颜色"的强制手段 */
  label: string;
  icon?: ReactNode;
  /** `soft` = 淡底 + 描边的胶囊；`plain` = 裸文字（默认，用于表格与紧凑行） */
  variant?: 'plain' | 'soft';
  className?: string;
}

export function StatusChip({ tone, label, icon, variant = 'plain', className }: StatusChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap',
        variant === 'soft' && 'rounded-full border px-2 py-0.5',
        variant === 'soft' && TONE_SOFT[tone],
        TONE_TEXT[tone],
        className,
      )}
      data-tone={tone}
    >
      {icon ?? DEFAULT_ICON[tone]}
      <span>{label}</span>
    </span>
  );
}

export const PausedIcon = <PauseCircle className="size-3.5" aria-hidden />;
