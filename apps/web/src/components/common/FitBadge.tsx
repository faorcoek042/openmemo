import { AlertTriangle, CheckCircle2, HardDrive, OctagonAlert, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FitResult, FitTier } from '@openmemo/shared';
import { cn } from '../../lib/utils';

/**
 * "这台机器能跑吗" 徽标（章程要求 2.2 的核心可视化）。
 *
 * ★ 硬规则：**只渲染，绝不重算。**
 * `packages/shared/src/api.ts` 的注释写得很直白 —— fitness 由服务端算好下发，
 * 前端再实现一套判断迟早会和 `fitness.ts` 漂移，而且出问题时分不清是哪一层算错的。
 * 因此本组件只接收 `FitResult`，不接收硬件参数，**从类型上就没法重算**。
 *
 * ★ 硬规则：**状态绝不只用颜色。**
 * 明档 `--status-warning` 对比度 1.79:1、`--status-serious` 2.57:1，都低于 3:1。
 * 所以图标 + 文字标签是必需的，不是装饰（同 `StatusChip` 的取舍）。
 */

const TIER_STYLE: Record<FitTier, { text: string; icon: ReactNode; labelZh: string }> = {
  recommended: {
    text: 'text-good',
    icon: <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />,
    labelZh: '推荐',
  },
  slow_partial: {
    text: 'text-warning',
    icon: <AlertTriangle className="size-3.5 shrink-0" aria-hidden />,
    labelZh: '可跑但慢',
  },
  slow_cpu: {
    text: 'text-warning',
    icon: <AlertTriangle className="size-3.5 shrink-0" aria-hidden />,
    labelZh: '可跑但慢',
  },
  unsupported: {
    text: 'text-critical',
    icon: <XCircle className="size-3.5 shrink-0" aria-hidden />,
    labelZh: '跑不动',
  },
  blocked_disk: {
    text: 'text-serious',
    icon: <HardDrive className="size-3.5 shrink-0" aria-hidden />,
    labelZh: '空间不足',
  },
};

const FALLBACK = {
  text: 'text-ink-muted',
  icon: <OctagonAlert className="size-3.5 shrink-0" aria-hidden />,
  labelZh: '未知',
};

export interface FitBadgeProps {
  fitness: FitResult;
  /** 同时显示服务端给的原因说明（列表卡片用；紧凑场景可关掉） */
  showReason?: boolean;
  className?: string;
}

export function FitBadge({ fitness, showReason = false, className }: FitBadgeProps) {
  const s = TIER_STYLE[fitness.tier] ?? FALLBACK;
  return (
    <div className={cn('flex flex-col gap-0.5', className)} data-testid="fit-badge">
      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', s.text)}>
        {s.icon}
        <span>{s.labelZh}</span>
      </span>
      {showReason ? (
        // reasonZh 来自服务端（fitness.ts 生成），前端不拼装这句话。
        <span className="text-xs text-ink-secondary">{fitness.reasonZh}</span>
      ) : null}
    </div>
  );
}

/**
 * 预计耗时。
 *
 * ⚠️ `estMinutesPerAudioHour` 为 `null` 表示**尚未在本机实测**。
 * ADR-004 决策 3：宁可显示"未测量"，也不显示编造或外推的数字。
 * 有值时也标注"估算"——RTF 外推系数至今未标定（D-03 §11 第 4 项）。
 */
export function FitEta({ fitness }: { fitness: FitResult }) {
  if (fitness.estMinutesPerAudioHour == null) {
    return <span className="text-xs text-ink-muted">速度未测量</span>;
  }
  return (
    <span className="text-xs text-ink-secondary">
      估算：1 小时音频约 {Math.round(fitness.estMinutesPerAudioHour)} 分钟
    </span>
  );
}

/**
 * 部分卸载时的层数提示。
 *
 * ⚠️ 必须写"约"：`estimateGpuLayers` 假设各层等大，而 embedding/output 层更大，
 * 因此这是**乐观估计**且未经标定（D-03 §11 第 3 项）。不许显示成确定值。
 */
export function FitGpuLayers({ fitness }: { fitness: FitResult }) {
  if (fitness.estGpuLayers == null || fitness.tier !== 'slow_partial') return null;
  return (
    <span className="text-xs text-ink-muted">约 {fitness.estGpuLayers} 层可载入显存（估算）</span>
  );
}
