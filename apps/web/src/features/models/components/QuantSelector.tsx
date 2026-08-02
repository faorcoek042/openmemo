import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { CatalogVariant } from '@openmemo/shared';
import { formatBytes } from '../../../lib/format/bytes';
import { cn } from '../../../lib/utils';
import { FitBadge } from '../../../components/common/FitBadge';

/**
 * 量化档位选择器（R-04 §9.2 线框）。
 *
 * 这是我们相对 memo.ac 的差异化第 ① 条：它的 Whisper 全是 f16，**没有量化概念**，
 * 所以 large-v3 是 3.09 GB 的下载；我们同一模型可以给 q5_0（1.08 GB）。
 *
 * ⚠️ R-04 §9.2 初稿有一列 `★★★★☆` 相对质量，**已删除**：
 * ADR-004 决策 3 已是全项目标准，星级同样是没有出处的数字，留着就是自打嘴巴。
 * 质量差异只用文字描述（来自目录的 descriptionZh），或等用户跑基准得到本机实测值。
 */

export interface QuantSelectorProps {
  variants: CatalogVariant[];
  selectedId: string;
  onSelect: (id: string) => void;
  locale: string;
}

export function QuantSelector({ variants, selectedId, onSelect, locale }: QuantSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = variants.find((v) => v.id === selectedId) ?? variants[0];
  if (!selected) return null;

  return (
    <div className="relative">
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-1 px-2.5 py-1',
          'text-xs font-medium text-ink hover:bg-surface-2',
        )}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-testid="models-quant-selector"
        onClick={() => setOpen((v) => !v)}
      >
        <span>量化 {selected.quantization.toUpperCase()}</span>
        <span className="text-ink-secondary">
          {formatBytes(selected.totalSizeBytes, locale)}
        </span>
        <ChevronDown className="size-3.5" aria-hidden />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute z-20 mt-1 w-[26rem] max-w-[85vw] rounded-lg border border-line bg-surface-2 p-1 shadow-lg"
        >
          <div className="grid grid-cols-[auto_5.5rem_5.5rem_1fr] gap-x-3 border-b border-line px-2 pb-1.5 text-[11px] text-ink-muted">
            <span>量化</span>
            <span>体积</span>
            <span>需显存</span>
            <span>这台机器</span>
          </div>
          {variants.map((v) => (
            <button
              key={v.id}
              type="button"
              role="option"
              aria-selected={v.id === selectedId}
              className={cn(
                'grid w-full grid-cols-[auto_5.5rem_5.5rem_1fr] items-center gap-x-3 rounded px-2 py-1.5 text-left text-xs',
                v.id === selectedId ? 'bg-surface-1' : 'hover:bg-surface-1',
              )}
              onClick={() => {
                onSelect(v.id);
                setOpen(false);
              }}
            >
              <span className="inline-flex items-center gap-1 font-medium text-ink">
                {v.id === selectedId ? (
                  <Check className="size-3 text-accent" aria-hidden />
                ) : (
                  <span className="size-3" />
                )}
                {v.quantization.toUpperCase()}
              </span>
              <span className="text-ink-secondary">{formatBytes(v.totalSizeBytes, locale)}</span>
              {/* 显存数字由 CI 从 GGUF 头算出（含 KV cache），不是手填 */}
              <span className="text-ink-secondary">
                {formatBytes(v.requirements.vramRequiredMB * 1e6, locale)}
              </span>
              <FitBadge fitness={v.fitness} />
            </button>
          ))}
          <p className="px-2 pt-1.5 text-[11px] text-ink-muted">
            显存需求含 KV 缓存
            {selected.requirements.computedAtContext
              ? `（按 ${selected.requirements.computedAtContext} 上下文计算）`
              : ''}
            。本表不含质量星级 —— 我们没有可信的准确率数据源，不编造。
          </p>
        </div>
      ) : null}
    </div>
  );
}
