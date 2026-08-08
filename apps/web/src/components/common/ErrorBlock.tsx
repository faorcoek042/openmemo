import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../lib/api/client';
import { Button } from './Button';
import { RemediationButton } from './RemediationButton';
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
    const server = locale.startsWith('zh')
      ? err.serverMessageZh || err.serverMessage
      : err.serverMessage;
    return { title: server || err.message || t('errors.unknown.title'), detail: '' };
  }
  /**
   * 非 ApiError（代码里 `throw new Error('…')` 的那些）。
   *
   * 以前一律显示"发生了未知错误"，把**唯一有用的信息（message）降级成折叠详情**。
   * 用户看到的就是一句无内容的报错。既然拿得到 message，就直接把它当标题 ——
   * "ompk: magic 不匹配"虽然技术，但**比"未知错误"有用得多**。
   */
  const msg = err instanceof Error ? err.message : String(err);
  return { title: msg || t('errors.unknown.title'), detail: '' };
}

export interface ErrorBlockProps {
  error: unknown;
  onRetry?: () => void;
  /**
   * **可选的就地覆盖**（ADR-007 决策 2）。
   *
   * ⚠️ T-140 之前，remediation 按钮的渲染条件是 `api?.remediation && onRemediate`
   * —— 也就是说**调用方不传这个 prop，服务端算好的补救动作就一个字都不显示**。
   * `[实测]` 全仓 26 个 `<ErrorBlock>` 调用点，**传过它的是 0 个**，
   * `RemediationButton.tsx` 的 importer 也是 0 个。整条补救链在生产里是死的。
   *
   * 根因不是"26 个地方都忘了"，是**这个 prop 要错了东西**：
   * remediation 是**服务端随错误一起发来的**，调用点对它没有任何额外信息可提供
   * —— 要它传，等于要它把 daemon 的 action→动作表再抄一遍。26 个人都不抄，
   * 是因为抄不出来，不是因为懒。
   *
   * 所以现在**默认就渲染**（按 `lib/remediation/routes.ts` 跳转），
   * 这个 prop 降级为"我能就地办、不必跳走"的覆盖点 ——
   * 目前唯一的真实用户是 `DataLocationSection`（`useExistingDataDir` = 重发一次请求）。
   */
  onRemediate?: (action: string, params?: Record<string, unknown>) => void;
  className?: string;
}

export function ErrorBlock({ error, onRetry, onRemediate, className }: ErrorBlockProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const { title, detail, action } = resolveErrorText(error, t, i18n.language);
  const api = error instanceof ApiError ? error : null;

  /**
   * 认证类错误给一个**可点的动作**，而不是"请重新打开应用"——
   * 用户不知道那是指刷新、重启服务、还是重开浏览器。
   * 我们自己有 token→cookie 的完整流程，能自己重来就别让用户猜（`remediation` 原则）。
   */
  const isAuth = api?.status === 401 || api?.code === 'UNAUTHENTICATED';
  const reconnect = async () => {
    setReconnecting(true);
    try {
      const { resetConnection } = await import('../../lib/api/connect');
      await resetConnection();
      onRetry?.();
    } finally {
      setReconnecting(false);
    }
  };
  const raw = api
    ? JSON.stringify({ code: api.code, status: api.status, details: api.details }, null, 2)
    : String(error);

  return (
    <div className={cn('rounded-lg border border-line bg-surface-1 p-4', className)}>
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">{title}</div>
          {detail ? <p className="mt-1 text-sm text-ink-secondary">{detail}</p> : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isAuth ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void reconnect()}
                disabled={reconnecting}
              >
                {reconnecting ? t('errors.reconnecting') : t('errors.reconnect')}
              </Button>
            ) : null}
            {onRetry && api?.retryable !== false ? (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : null}
            {/* remediation 是一等公民：让 UI 能直接渲染"去安装"按钮，
                而不是给用户看一段死文本再让他去查文档（章程要求 2.1）。
                按钮长什么样、跳哪里由 RemediationButton 一处决定 —— 不在这里再写一遍。 */}
            {api?.remediation ? (
              <RemediationButton
                remediation={api.remediation}
                {...(onRemediate ? { onAct: (r) => onRemediate(r.action, r.params) } : {})}
                {...(action ? { fallbackLabel: action } : {})}
              />
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
