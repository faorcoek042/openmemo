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
 * ADR-004 决策 3：宁可显示"未测量"，也不显示编造的数字。
 * 但**真实测量 + 诚实出处**是允许的，所以这里区分三种来源，措辞各不相同：
 *   - `measured_here`      本机实测 → 说"本机实测"
 *   - `reference_machine`  我们在参考机上实测 → 必须说明"参考机"，不能冒充本机数据
 *   - `none`               没有任何测量 → 说"未测量"，不外推
 *
 * ADR-011 决策 2 让这一栏变得重要：中文必须用 large-v3-turbo，而它在 CPU 上
 * 1 小时录音要跑 22 分钟。"装得下"和"用得了"是两件事，只答前者会误导用户。
 */
export function FitEta({ fitness }: { fitness: FitResult }) {
  const mins = fitness.estMinutesPerAudioHour;
  if (mins == null || fitness.speedSource === 'none') {
    return <span className="text-xs text-ink-muted">速度未测量</span>;
  }
  const slow = fitness.speedTier === 'slow' || fitness.speedTier === 'very_slow';
  return (
    <span className={cn('text-xs', slow ? 'text-warning' : 'text-ink-secondary')}>
      {slow ? <AlertTriangle className="mr-0.5 inline size-3" aria-hidden /> : null}
      1 小时音频约 {Math.round(mins)} 分钟
      <span className="text-ink-muted">
        {fitness.speedSource === 'measured_here' ? '（本机实测）' : '（参考机实测，仅供参考）'}
      </span>
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
