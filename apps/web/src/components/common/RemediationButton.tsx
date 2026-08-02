import { useNavigate } from 'react-router';
import { ArrowRight, HardDrive, KeyRound, PackagePlus, RefreshCw, Shuffle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Remediation } from '@openmemo/shared';
import { Button } from './Button';

/**
 * `remediation` → 一个用户能点的按钮。
 *
 * ★ 这是章程要求 2.1「用户不碰命令行」能否成立的最后一环。
 *
 * 一个只有文字的错误（"缺少 ASR 模型"）读完仍然不知道该点哪里，用户只能去翻文档或命令行 ——
 * 那要求 2.1 在错误路径上就没达成。`ApiErrorBody.error.remediation` 与
 * `JobBlockedEvent.remediation` 携带的是**机器可读的动作**（ADR-007 决策 2），
 * 前端把它渲染成按钮，点一下就修好。
 *
 * 未知 `action` 不静默吞掉：仍然渲染按钮并跳到最可能相关的页面，
 * 因为"前端版本旧、后端加了新 action"时，什么都不显示是最差的结果。
 */

const ACTION_ICON: Record<string, ReactNode> = {
  install_model: <PackagePlus className="size-3.5" aria-hidden />,
  install_backend: <PackagePlus className="size-3.5" aria-hidden />,
  free_disk: <HardDrive className="size-3.5" aria-hidden />,
  switch_source: <Shuffle className="size-3.5" aria-hidden />,
  configure_api_key: <KeyRound className="size-3.5" aria-hidden />,
  retry: <RefreshCw className="size-3.5" aria-hidden />,
};

/** action → 应用内目标路由。未知 action 落到模型页（最常见的前置条件缺失来源）。 */
function targetFor(r: Remediation): string {
  const p = r.params ?? {};
  switch (r.action) {
    case 'install_model':
      return p.modelId ? `/models/${encodeURIComponent(String(p.modelId))}` : '/models';
    case 'install_backend':
      return '/runtime';
    case 'free_disk':
      return '/settings/storage';
    case 'switch_source':
      return '/models?panel=sources';
    case 'configure_api_key':
      return '/settings';
    default:
      return '/models';
  }
}

export interface RemediationButtonProps {
  remediation: Remediation;
  /** 覆盖默认的路由跳转（例如就地重试，不必离开当前页） */
  onAct?: (r: Remediation) => void;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary';
}

export function RemediationButton({
  remediation,
  onAct,
  size = 'sm',
  variant = 'primary',
}: RemediationButtonProps) {
  const navigate = useNavigate();
  const icon = ACTION_ICON[remediation.action] ?? <ArrowRight className="size-3.5" aria-hidden />;

  return (
    <Button
      variant={variant}
      size={size}
      data-testid={`remediation-${remediation.action}`}
      onClick={() => {
        if (onAct) onAct(remediation);
        else void navigate(targetFor(remediation));
      }}
    >
      {icon}
      {/* labelZh 由服务端给，前端不猜文案 —— 后端最清楚缺的是什么 */}
      {remediation.labelZh || remediation.label || '去处理'}
    </Button>
  );
}
