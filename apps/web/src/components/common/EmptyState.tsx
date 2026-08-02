import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * 空态（D-05 §5.4）。
 *
 * 原则：**空态即入口**。不要只放一句"暂无数据" —— 用户到这里是想做事的，
 * 直接把下一步动作放在眼前（笔记列表为空时，输入框直接可用）。
 */
export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  /** 主动作：把"下一步"直接放在空态里 */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      {icon ? <div className="mb-4 text-ink-muted">{icon}</div> : null}
      <h2 className="text-base font-medium text-ink">{title}</h2>
      {hint ? <p className="mt-1 max-w-md text-sm text-ink-secondary">{hint}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
