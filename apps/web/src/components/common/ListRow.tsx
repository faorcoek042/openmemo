import { Link } from 'react-router';
import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

/**
 * 列表行的**共用骨架** —— 笔记 / 任务 / 搜索结果三处共用（用户 2026-08-11 的要求：
 * 「统一「任务中心」和「全部笔记」的列表和点击样式，方便复用代码」）。
 *
 * ## 它统一什么
 *
 * **外观与结构**：卡片外框（圆角 / 边框 / 底色 / 内边距 / 过渡）、顶行的
 * 「前置图标 + 主标题 + 右上附加」这套布局、副行元信息、行下附加块。
 * 收敛之前三处各写各的，已经漂出可见差异 —— `[实测]` 任务行用的是 `bg-surface-0`，
 * 笔记行与搜索行用的是 `bg-surface-1`：**同一个界面里两种卡片底色**。
 *
 * ## 点击语义：三处**统一成整行可点**，参照笔记行
 *
 * 用户点名笔记行"更好用"，参照系就是它：整张卡是 `<Link>`，内嵌控件用
 * `preventDefault + stopPropagation` 把那次点击挡掉。任务行与搜索行都向它靠。
 *
 * ⚠️ **这里推翻了 T-192 写下的"任务行只把标题做成链接"，理由要说清楚**，
 * 因为那条注释当时是对的，只是它的论证不成立了：
 *
 * 1. T-192 的理由是「整行可点要靠 stopPropagation 去躲按钮，而『点击被父元素抢走』
 *    正是刚排除掉的失败模式」。**但那一轮排除的是一个没做好的实现**
 *    （行上根本没有任何监听器，点了什么都不发生），**不是这个做法本身**。
 *    拿一次失败的实现去否定一个正在成功运行的实现，是错的 —— 笔记行就是同一套做法
 *    做对了的现成样本。
 * 2. **但也不能因为"笔记行好用"就照搬**：`[实测]` demo 上笔记行每行是
 *    `链接=1 按钮=1`（只有一个星标），而任务行非终态时是 2~3 个动作按钮 +
 *    可能的 `ErrorBlock`（它自己还带重试/补救/展开三个）。
 *    数量差一个量级，笔记行不构成"4 个按钮也没问题"的证据。
 * 3. 所以采用的不是照搬，而是**把躲避从"每个控件各写一遍"收敛成"整块包一次"**
 *    （见 `JobList.tsx` 的 `stopRowNav`）。这样**控件数量不再是这条做法成不成立的变量** ——
 *    以后那块区域里加多少按钮都不用再想这件事。逐个写才是会漏的那种守卫。
 *
 * `clickTarget` 仍然保留成显式参数而不是写死 `'row'`：它承载的是上面这条判据，
 * 一旦某处出现"行内控件无法被统一挡住"的形态，它得有地方表达。
 *
 * ## 另一条随之而来的判据：hover 反馈跟着落点走
 *
 * 只有 `'row'` 才给整卡 hover 高亮。`'title'` 那档整卡不给 ——
 * 一个"看起来能点、点了没反应"的卡片，正是这一族 bug 的外观形态。
 */
export interface ListRowProps {
  /** 主标题内容（文字或带徽标的片段）。它**永远**是那个可点的落点。 */
  title: ReactNode;
  /**
   * 落点地址。三处都是应用内路由，所以一律 `<Link>`，不用 `navigate()` 包 `<button>`。
   *
   * **`null` = 这一行没有可去的地方 → 整行不渲染任何链接**（标题退回纯文本）。
   * 下载类任务就是这一档：`DownloadJob` 契约上没有 `noteUid`。
   * 给它一个 `to=""` 的链接是"点了到不了任何地方的假出口"，T-192 明确禁掉过。
   */
  href: string | null;
  /**
   * 落点范围。**判据：这一行里除主标题外还有没有别的可点控件。**
   * 有（任务行的 4 个动作按钮）→ `'title'`；没有或只有一个可 stopPropagation 的小控件 → `'row'`。
   */
  clickTarget: 'row' | 'title';
  /** 前置图标（笔记的媒体类型图标等）。 */
  leading?: ReactNode;
  /** 顶行右侧：状态芯片 / 星标 / 时间码。 */
  trailing?: ReactNode;
  /** 副行：时长、时间、阶段文字等元信息。 */
  meta?: ReactNode;
  /** 行下附加块：进度条、错误块、动作按钮组、命中摘要。 */
  children?: ReactNode;
  /**
   * 落点链接自己的 testid。
   *
   * ⚠️ 各处**保留自己原有的锚点名**，不要因为收敛到共用骨架就统一改名 ——
   * `job-result-link` 是 T-192 那批腿钉住的锚点（"任务中心点得进它做出来的东西"）。
   * 骨架换了名字，那些腿就会在**产品完全正常**的情况下报"元素不存在"：
   * 一次纯粹的锚点漂移伪装成行为回归，而这恰恰是本仓刚花了一整轮追过的形状。
   */
  linkTestId?: string;
}

/*
 * ★ 这个接口原来还有 `className?` 与 `'data-testid'?` 两格（后者由 `...rest` 摊到卡片上）。
 * **已删 —— 三个调用点一个都没传过。**
 * `data-testid` 那格尤其误导：`linkTestId` 是真在用的那个锚点（每处保留自己的原名，
 * 见上面那段），旁边再摆一个从没被用过的同类入口，只会让下一个要加锚点的人
 * 在两个入口之间猜一个。
 */

/** 卡片外框 —— 三处唯一的一份。 */
const CARD = 'rounded-lg border border-line bg-surface-1 p-3 transition-colors';

export function ListRow({
  title,
  href,
  clickTarget,
  linkTestId = 'list-row-link',
  leading,
  trailing,
  meta,
  children,
}: ListRowProps): ReactNode {
  const head = (
    <div className="flex items-start gap-3">
      {leading ? (
        <div className="mt-0.5 shrink-0 text-ink-muted" aria-hidden>
          {leading}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          {clickTarget === 'title' && href !== null ? (
            <Link
              to={href}
              className="min-w-0 truncate text-sm font-medium text-ink hover:text-accent-ink hover:underline"
              data-testid={linkTestId}
            >
              {title}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-sm font-medium text-ink">{title}</span>
          )}
          {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
        </div>
        {meta ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            {meta}
          </div>
        ) : null}
      </div>
    </div>
  );

  // 没有落点：整行都不是链接。**不给假出口**（T-192）。
  if (href === null) {
    return (
      <li className={CARD}>
        {head}
        {children}
      </li>
    );
  }

  if (clickTarget === 'row') {
    return (
      <li>
        <Link to={href} className={cn(CARD, 'block hover:bg-fill-hover')} data-testid={linkTestId}>
          {head}
          {children}
        </Link>
      </li>
    );
  }

  return (
    <li className={CARD}>
      {head}
      {children}
    </li>
  );
}
