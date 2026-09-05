import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * 持久条幅（D-05 §5.1 的第 4 个层级）。
 *
 * 用途仅限**全局降级态**：SSE 断开、磁盘将满、后端自检失败、端口漂移。
 * 特点：**可折叠但不可关闭** —— 问题还在就不该消失。
 * （能被关掉的问题提示等于没提示；用户关掉后就再也不知道自己处在降级状态。）
 *
 * ## ★ 这里原来还有第四档 `tone: 'mock'`。**已删（连同用途清单里的「MOCK 模式」）。**
 *
 * 它的样式注释写着「MOCK 用最刺眼的处理：绝不能让人误以为是真数据」——
 * 而 `tone="mock"` 在全仓**一次都没有被渲染过**，也就是说那句话描述的是一个
 * 从不存在的外观。它不是被忘了接上，是被**一个明确的设计决定取代**了：
 * `components/common/MockNotice.tsx` 的文件头论证过为什么"这块是假数据"必须
 * **按 API 面**而不是全局条幅（全局只有全真/全假两态，表达不了"笔记真了、转写还假着"
 * 这个真实中间态）。留着这一档，等于让那份论证的结论在类型上仍然可以被推翻。
 */

export type BannerTone = 'info' | 'warning' | 'critical';

const TONE_STYLES: Record<BannerTone, string> = {
  info: 'border-l-accent bg-surface-1',
  warning: 'border-l-warning bg-surface-1',
  critical: 'border-l-critical bg-surface-1',
};

export interface BannerProps {
  tone: BannerTone;
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
  /**
   * 挂在**条幅自己**这个元素上的测试标记（可选）。
   *
   * ⚠️ 刻意不用外面套一层 `<div data-testid>`：那样断言只够到包装盒，
   * 而这一族最容易出错的恰恰是条幅**自己**的属性 —— `tone` 一旦被改成
   * `critical`，`aria-live` 与左边那道色条会跟着变，而包装盒上什么都看不出来。
   * 标记落在条幅上，"它不是错误态"才断言得了（#109）。
   */
  testId?: string;
}

export function Banner({ tone, icon, title, detail, action, className, testId }: BannerProps) {
  return (
    <div
      // 降级/错误态用 assertive，让屏幕阅读器立即播报（D-05 §6.3）
      role="status"
      aria-live={tone === 'critical' ? 'assertive' : 'polite'}
      {...(testId ? { 'data-testid': testId } : {})}
      className={cn(
        'flex items-start gap-3 border-b border-l-4 border-b-line px-4 py-2 text-sm',
        TONE_STYLES[tone],
        className,
      )}
    >
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">{title}</div>
        {detail ? <div className="mt-0.5 text-ink-secondary">{detail}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
