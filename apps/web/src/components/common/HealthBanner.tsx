import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { AlertTriangle } from 'lucide-react';

import { rawFetch } from '../../lib/api/client';
import { Button } from './Button';

/**
 * 产品降级态的可见化（T-041）。
 *
 * ## 为什么必须有
 *
 * D-07 §3 的实地探针发现：运行中的 daemon **`libsimple` 与 `sqlite-vec` 都没加载成功**，
 * tokenizer 降级为 `trigram`，`pipeline.missing: ["whisper-cli","asr-model"]`。
 * 降级路径本身工作得很好 —— 这是设计对的地方 ——
 * **但产品处于降级态而用户完全不知道**：搜索框照常能用、只是搜中文不准；
 * 点转写照常有按钮、只是永远失败。
 *
 * 用户遇到的会是"这软件搜不到东西"，而不是"我缺一个扩展"。
 * **一个能自我诊断却不告诉用户的系统，等于没有自我诊断。**
 *
 * ## 自动消失
 *
 * 数据源是 `/api/health`（公开端点，无需鉴权），30 秒轮询。
 * `gpu-runtime` 编好 libsimple/sqlite-vec、或装上 whisper-cli 之后，
 * 这些条幅会**自己消失**，不需要谁回来删代码。
 */

interface HealthDegradation {
  db?: {
    extensions?: {
      tokenizer?: string;
      libsimple?: boolean;
      sqliteVec?: boolean;
      failures?: Record<string, string>;
    };
  };
  pipeline?: { missing?: string[] };
}

export function HealthBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: async (): Promise<HealthDegradation | null> => {
      try {
        const res = await rawFetch('/api/health');
        if (!res.ok) return null;
        return (await res.json()) as HealthDegradation;
      } catch {
        // daemon 没起 —— 由 ConnectivitySummary 负责提示，这里不重复报
        return null;
      }
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (!data) return null;

  const ext = data.db?.extensions;
  const missing = data.pipeline?.missing ?? [];

  const items: { key: string; text: string; action?: () => void; actionLabel?: string }[] = [];

  // 中文分词未启用 → 搜索不准（用户最可能误判为"这软件搜不到东西"）
  if (ext && ext.libsimple === false) {
    items.push({
      key: 'tokenizer',
      text: t('health.tokenizerDegraded', { tokenizer: ext.tokenizer ?? 'trigram' }),
      action: () => navigate('/runtime'),
      actionLabel: t('health.fix'),
    });
  }

  // 语义检索不可用
  if (ext && ext.sqliteVec === false) {
    items.push({ key: 'vec', text: t('health.semanticDisabled') });
  }

  // 转写引擎缺失 → 导入了也转不了
  if (missing.length > 0) {
    items.push({
      key: 'pipeline',
      text: t('health.pipelineMissing', { items: missing.join(', ') }),
      action: () => navigate(missing.includes('asr-model') ? '/models' : '/runtime'),
      actionLabel: t('health.fix'),
    });
  }

  if (items.length === 0) return null;

  return (
    <div role="status" aria-live="polite">
      {items.map((it) => (
        <div
          key={it.key}
          className="flex items-start gap-2 border-b border-b-line border-l-4 border-l-warning bg-surface-1 px-4 py-1.5 text-xs"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span className="flex-1 text-ink-secondary">{it.text}</span>
          {it.action ? (
            <Button size="sm" variant="ghost" className="h-5 px-1.5 text-xs" onClick={it.action}>
              {it.actionLabel}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
