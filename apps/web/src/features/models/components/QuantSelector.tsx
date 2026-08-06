import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import type { CatalogVariant } from '@openmemo/shared';
import { arr } from '../../../lib/safe';
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = variants.find((v) => v.id === selectedId) ?? variants[0];
  if (!selected) return null;

  /*
   * ★ T-150：**同一组里的变体不一定只差量化档。**
   *
   * `vad/silero-vad` 那一组有两个变体，`quantization` 都是 `f16`，
   * 但一个是 sherpa-onnx 的 `.onnx`、另一个是 whisper.cpp 的 ggml ——
   * **互相加载不了**。只按量化档标注的话，用户看到的是两行一模一样的「F16」，
   * 而选错那一个的后果 T-148 已经付过一次：whisper 报 `bad magic`，整单转写死。
   * （daemon 的 `model.vad` remediation 现在明确让用户装 `vad/silero-vad-ggml`，
   * 而这个选择器正是他要在上面做出那个选择的地方。）
   *
   * 判据是**这一组里 `engines` 是否真的不同**，不是"role 是不是 vad" ——
   * 前者是"这两个东西不可互换"的直接证据，后者只是它今天恰好的载体。
   */
  const enginesOf = (v: CatalogVariant) => [...arr(v.engines)].sort();
  const engineDiffers = new Set(variants.map((v) => enginesOf(v).join('+'))).size > 1;
  const labelOf = (v: CatalogVariant) =>
    engineDiffers && enginesOf(v).length > 0
      ? `${v.quantization.toUpperCase()} · ${enginesOf(v).join(' / ')}`
      : v.quantization.toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-1 px-2.5 py-1',
          'text-xs font-medium text-ink hover:bg-fill-hover',
        )}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-testid="models-quant-selector"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{t('models.quant.current', { quant: labelOf(selected) })}</span>
        <span className="text-ink-secondary">
          {formatBytes(selected.totalSizeBytes, locale)}
        </span>
        <ChevronDown className="size-3.5" aria-hidden />
      </button>

      {open ? (
        <div
          role="listbox"
          className={cn(
            'absolute z-20 mt-1 w-[26rem] rounded-lg border border-line bg-surface-2 p-1 shadow-lg',
            /*
             * Narrow screens: anchor to the viewport instead of to the button.
             *
             * The panel is 26rem wide and starts at the button's left edge, so on a phone
             * it ran 178px past the right edge — `max-w-[85vw]` capped the WIDTH but a
             * capped box still starts in the same place, so it clipped just the same.
             * Below `sm` we switch to fixed with equal gutters, which also lifts it out of
             * any clipping ancestor.
             */
            'max-sm:fixed max-sm:inset-x-3 max-sm:w-auto',
          )}
        >
          <div className="grid grid-cols-[auto_5.5rem_5.5rem_1fr] gap-x-3 border-b border-line px-2 pb-1.5 text-[11px] text-ink-muted">
            <span>{t('models.quant.colQuant')}</span>
            <span>{t('models.quant.colSize')}</span>
            <span>{t('models.quant.colVram')}</span>
            <span>{t('models.quant.colFit')}</span>
          </div>
          {variants.map((v) => (
            <button
              key={v.id}
              type="button"
              role="option"
              aria-selected={v.id === selectedId}
              className={cn(
                'grid w-full grid-cols-[auto_5.5rem_5.5rem_1fr] items-center gap-x-3 rounded px-2 py-1.5 text-left text-xs',
                /* 选中项：品牌淡底 + 品牌文字。
                   原来写 `bg-surface-1`，而这块面板本身是 `bg-surface-2` ——
                   T-124 之后明档两者同为白（抬升靠阴影），选中项会**完全消失**。
                   选中态本来就不该靠"表层差一档"来表达，它是语义不是层级。 */
                v.id === selectedId
                  ? 'bg-accent-tint text-accent-ink'
                  : 'hover:bg-fill-hover',
              )}
              onClick={() => {
                onSelect(v.id);
                setOpen(false);
              }}
            >
              <span className="inline-flex items-center gap-1 font-medium text-ink">
                {v.id === selectedId ? (
                  <Check className="size-3 text-accent-ink" aria-hidden />
                ) : (
                  <span className="size-3" />
                )}
                {labelOf(v)}
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
            {/* ⚠️ 插值名不能叫 `context` —— 那是 i18next 的保留选项（用于 key 变体），
                会被它吃掉而不是当变量插进去。这里用 `ctx`。 */}
            {t('models.quant.vramNote', {
              ctx: selected.requirements.computedAtContext
                ? t('models.quant.vramNoteContext', {
                    ctx: String(selected.requirements.computedAtContext),
                  })
                : '',
            })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
