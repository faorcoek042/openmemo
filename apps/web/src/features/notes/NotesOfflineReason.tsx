import { useTranslation } from 'react-i18next';
import { PlugZap } from 'lucide-react';

import { surfaceState } from '../../lib/api/surfaces';
import { cn } from '../../lib/utils';

/**
 * 笔记页头上那两颗按钮（导出 / ⋯）**灰掉时的真解释**。
 *
 * ## 在它之前，那条理由三条输入方式都拿不到
 *
 * 两颗按钮当时都是 `disabled={!live}` + `title={live ? undefined : t(…)}`，
 * 而 `Button` 基类带 `disabled:pointer-events-none`：
 *
 * - **鼠标**：`pointer-events: none` 的元素收不到 `mouseover`，原生 tooltip
 *   **根本不弹** —— 不是"悬停久一点就有"，是永远没有。
 * - **键盘**：`disabled` 把它移出 tab 序列，聚焦不到。
 * - **读屏**：`title` 在多数读屏配置下不播报。
 *
 * 这是 `RetranscribeButton` 在 v0.7.1 已知边界第 4 条上走过的同一条路，
 * 也是 v0.7.3 已知边界第 6 条公开承认的那一批里的两颗。
 *
 * ## 为什么是一条**共用**的可见文字，而不是各给各的 aria-label
 *
 * 两颗按钮灰掉的原因是**同一个**（本地服务没在跑）。给每颗按钮塞一句
 * 只有读屏听得到的话，等于把同一件事说两遍、而且鼠标用户仍然什么都看不到。
 * 一条可见的句子 + 两个 `aria-describedby` 指过来，三种输入方式同时成立。
 *
 * ⚠️ 它只在**不 live 时**渲染，两颗按钮也只在那时才指过来 ——
 * 否则 `aria-describedby` 会指向一个不存在的 id：**不报错、静默失效**
 * （`scripts/ci/check-usefulness.mjs` 的 `describedby-dangling` 就是钉这个的）。
 */
export const NOTES_OFFLINE_REASON_ID = 'notes-offline-reason';

export function NotesOfflineReason({ className }: { className?: string }) {
  const { t } = useTranslation();
  if (surfaceState('notes') === 'live') return null;

  return (
    <p
      id={NOTES_OFFLINE_REASON_ID}
      data-testid="notes-offline-reason"
      className={cn('flex items-center gap-1 text-xs text-serious', className)}
    >
      <PlugZap className="size-3 shrink-0" aria-hidden />
      {t('notes.exportNeedsDaemon')}
    </p>
  );
}
