import { CheckCircle2, CircleDashed, Cpu, Download, XCircle, Zap } from 'lucide-react';
import type { Backend } from '@openmemo/shared';
import { cn } from '../../lib/utils';

/**
 * 加速后端状态芯片（CUDA / Vulkan / ROCm / Metal / CoreML / CPU）。
 *
 * 建在 `components/common/` 而不是 `features/runtime/components/`：D-05 §3.1 目录树注释
 * 已标出这是提升项 —— 模型详情页要显示"这台机器当前用哪个后端跑"，任务中心的
 * blocked 任务也要显示"因为后端未安装"。三处都要用，一开始就放共享区。
 *
 * ★ 状态三态必须**图标 + 文字**同时出现，不能只变色（features/runtime/README.md 明确要求）：
 * `--status-warning` / `--status-serious` 在亮底对比度不足 3:1，只染色对部分用户不可读。
 */

export type BackendChipState = 'active' | 'installed' | 'available' | 'not-installed' | 'failed';

const BACKEND_LABEL: Record<Backend, string> = {
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  rocm: 'ROCm',
  metal: 'Metal',
  coreml: 'CoreML',
  cpu: 'CPU',
};

const STATE_STYLE: Record<BackendChipState, { text: string; label: string; icon: React.ReactNode }> =
  {
    active: {
      text: 'text-good',
      label: '使用中',
      icon: <Zap className="size-3.5 shrink-0" aria-hidden />,
    },
    installed: {
      text: 'text-ink-secondary',
      label: '已安装',
      icon: <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />,
    },
    available: {
      text: 'text-accent',
      label: '可安装',
      icon: <Download className="size-3.5 shrink-0" aria-hidden />,
    },
    'not-installed': {
      text: 'text-ink-muted',
      label: '不可用',
      icon: <CircleDashed className="size-3.5 shrink-0" aria-hidden />,
    },
    failed: {
      text: 'text-critical',
      label: '自检失败',
      icon: <XCircle className="size-3.5 shrink-0" aria-hidden />,
    },
  };

export interface BackendChipProps {
  backend: Backend;
  state: BackendChipState;
  className?: string;
}

export function BackendChip({ backend, state, className }: BackendChipProps) {
  const s = STATE_STYLE[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-1 px-2 py-1 text-xs font-medium',
        s.text,
        className,
      )}
      data-testid={`backend-chip-${backend}`}
    >
      {backend === 'cpu' ? <Cpu className="size-3.5 shrink-0" aria-hidden /> : s.icon}
      <span className="text-ink">{BACKEND_LABEL[backend]}</span>
      <span className={cn('text-[11px]', s.text)}>{s.label}</span>
    </span>
  );
}

export function backendLabel(b: Backend): string {
  return BACKEND_LABEL[b] ?? b;
}
