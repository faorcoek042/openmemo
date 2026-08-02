import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  OctagonAlert,
  PauseCircle,
  XCircle,
} from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * 状态芯片。
 *
 * ★ 硬规则（D-05 §7.2 + §6.3）：**状态绝不只用颜色。**
 * 明档的 warning(1.79:1) 与 serious(2.57:1) 在浅底上达不到 3:1 —— 这是调色板的设计取舍，
 * 缓解手段就是**强制配图标 + 文字标签**。所以本组件的 icon 与 label 都是必需的，
 * 没有"只要一个彩色圆点"的用法。
 *
 * 另：状态色**不得**被当作第 5 个分类色使用，否则状态语义就废了。
 */

export type StatusTone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'running';

const TONE_TEXT: Record<StatusTone, string> = {
  good: 'text-good',
  warning: 'text-warning',
  serious: 'text-serious',
  critical: 'text-critical',
  neutral: 'text-ink-muted',
  running: 'text-accent',
};

const DEFAULT_ICON: Record<StatusTone, ReactNode> = {
  good: <CheckCircle2 className="size-3.5" aria-hidden />,
  warning: <AlertTriangle className="size-3.5" aria-hidden />,
  serious: <OctagonAlert className="size-3.5" aria-hidden />,
  critical: <XCircle className="size-3.5" aria-hidden />,
  neutral: <CircleDashed className="size-3.5" aria-hidden />,
  running: <Loader2 className="size-3.5 animate-spin" aria-hidden />,
};

export interface StatusChipProps {
  tone: StatusTone;
  /** 必填 —— 这就是"不许只用颜色"的强制手段 */
  label: string;
  icon?: ReactNode;
  className?: string;
}

export function StatusChip({ tone, label, icon, className }: StatusChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap',
        TONE_TEXT[tone],
        className,
      )}
    >
      {icon ?? DEFAULT_ICON[tone]}
      <span>{label}</span>
    </span>
  );
}

export const PausedIcon = <PauseCircle className="size-3.5" aria-hidden />;
