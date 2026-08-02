import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../lib/api/client';
import { Button } from './Button';
import { cn } from '../../lib/utils';

/**
 * 区块级错误（D-05 §5.1 的第 2 层级）：某个区域拉取失败，**其余页面照常可用**。
 *
 * 文案策略（D-05 §6.2，ADR-007 决策 3 已采纳）：
 * 1. 优先按 `code` 查本地文案表 `errors.<CODE>`；
 * 2. 查不到才回退服务端的 `message` / `messageZh`（前端版本旧、后端加了新 code 时不至于白屏）；
 * 3. 技术细节折叠在"查看详情"里 —— **禁止把 error.detail 原样甩给用户**。
 *
 * 三段式：发生了什么 → 为什么 → 现在能做什么。
 */

export function resolveErrorText(
  err: unknown,
  t: (k: string, o?: Record<string, unknown>) => string,
  locale: string,
): { title: string; detail: string; action?: string } {
  const code = err instanceof ApiError ? err.code : 'unknown';
  const key = `errors.${code}`;
  const title = t(`${key}.title`, { defaultValue: '' });

  if (title) {
    return {
      title,
      detail: t(`${key}.detail`, { defaultValue: '' }),
      action: t(`${key}.action`, { defaultValue: '' }) || undefined,
    };
  }

  // 未知 code → 用服务端文案兜底
  if (err instanceof ApiError) {
    const server = locale.startsWith('zh') ? err.serverMessageZh || err.serverMessage : err.serverMessage;
    return { title: t('errors.unknown.title'), detail: server || err.message };
  }
  return { title: t('errors.unknown.title'), detail: err instanceof Error ? err.message : String(err) };
}

export interface ErrorBlockProps {
  error: unknown;
  onRetry?: () => void;
  /** `remediation.action` 对应的处理器（ADR-007 决策 2） */
  onRemediate?: (action: string, params?: Record<string, unknown>) => void;
  className?: string;
}

export function ErrorBlock({ error, onRetry, onRemediate, className }: ErrorBlockProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const { title, detail, action } = resolveErrorText(error, t, i18n.language);
  const api = error instanceof ApiError ? error : null;
  const raw = api ? JSON.stringify({ code: api.code, status: api.status, details: api.details }, null, 2) : String(error);

  return (
    <div className={cn('rounded-lg border border-line bg-surface-1 p-4', className)}>
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">{title}</div>
          {detail ? <p className="mt-1 text-sm text-ink-secondary">{detail}</p> : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {onRetry && api?.retryable !== false ? (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : null}
            {/* remediation 是一等公民：让 UI 能直接渲染"去安装"按钮，
                而不是给用户看一段死文本再让他去查文档（章程要求 2.1） */}
            {api?.remediation && onRemediate ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => onRemediate(api.remediation!.action, api.remediation!.params)}
              >
                {action ?? api.remediation.action}
              </Button>
            ) : null}
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink-secondary"
            >
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {t('errors.detailToggle')}
            </button>
          </div>

          {open ? (
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-surface-0 p-2 text-xs text-ink-muted">
              {raw}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
