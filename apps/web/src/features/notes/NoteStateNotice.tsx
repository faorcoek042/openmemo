import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { AlertTriangle, CircleSlash, RotateCcw } from 'lucide-react';

import type { NoteDetail } from '../../lib/api/types';
import { useJobActions } from '../tasks';
import { Button } from '../../components/common/Button';
import { ErrorBlock } from '../../components/common/ErrorBlock';

/**
 * 笔记页上的**状态告知条** —— 这条笔记有一件用户需要知道的事（#98）。
 *
 * ## 为什么改名（它上一轮叫 `NoteFailureNotice`）
 *
 * 现在它还要说「这次转写被你取消了」。一个叫 `NoteFailureNotice` 的组件渲染出
 * 「已取消」，就是本仓一直在清的那种命名谎话 —— 下一个人会按名字相信它只管失败，
 * 然后在别处再造一条取消提示。**名字执行，注释不执行。**
 *
 * ## 它管哪两档，为什么只管这两档
 *
 * | 笔记状态 | 这里说不说 | 理由 |
 * |---|---|---|
 * | `failed` | ✅ | 详情页此前对一次失败**一个字都不显示** |
 * | `cancelled` | ✅ | 同上，而且更隐蔽：终态 ⇒ `NoteProgressLine` 直接返回 null，**整页零解释** |
 * | `blocked` / `paused` | ❌ | `NoteProgressLine` **已经**在页顶如实说了（「暂时无法继续」/「已暂停」） |
 *
 * 后两档不在这里再说一遍是**判断**：同一件事在同一屏说两遍，用户会当成两回事。
 * ⚠️ 但那条进度行只说「状态」，不说 `blockedCode` 的**原因**，也不给动作 ——
 * 那是同一族的另一个缺口（`GenerateMindmapButton` 已经用 `mindmap.blocked.*`
 * 那张表解过导图那一半）。本轮**没做**，已单独报出。
 *
 * ## 两档的动作刻意不同
 *
 * 「我自己取消的」和「它失败了」对用户是两件事：
 *
 * - `failed` → 主按钮是**重试**（`POST /api/jobs/:uid/retry`），落点与任务中心
 *   那颗按钮逐字相同。「这条任务还能不能再来一次」只准有一个答案 ——
 *   本仓在两张 remediation 路由表上吃过一次亏（同一个 action 两个落点）。
 * - `cancelled` → **不给「重试」**。他没遇到故障，他是自己停下的；
 *   他要的是**重新转写**（可以顺便换引擎/换模型/加 prompt），
 *   那颗按钮就在转写稿面板头上，这里指名道姓地把他领过去，不另开第二个入口。
 *
 * ⚠️ 两档都**不承诺一点就好**：`NO_MEDIA_SOURCE` 这类失败换多少次结果都一样，
 * 所以失败那句提示如实说「先按上面的原因处理，再试」。
 *
 * ## 原因永远不在这里现编
 *
 * `lastFailure` 是 daemon 判定并明说的，与 `canRetranscribe` / `retranscribeBlocked`
 * 同一条规矩（#95 立的）：**服务端说，客户端不猜**。客户端不知道 runner 走到哪一步、
 * 试过哪些适配器，编出来的必然是假诊断 —— 一句可信口气的假诊断比沉默更贵。
 */
export function NoteStateNotice({
  note,
  className,
}: {
  note: NoteDetail | undefined;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const actions = useJobActions();

  /*
   * ⚠️ 消费方对**字段缺失**要宽容：拿到一个老 daemon 的响应（真的没有这些键）时
   * 按"没什么要说的"处理，而不是崩掉或者显示一条空的告警条。
   * 这条规矩是 `NoteAsset.state` 那次事故立下的，写在共享契约的注释里。
   */
  const failure = note?.lastFailure ?? null;
  const cancelled = note?.status === 'cancelled';
  if (!failure && !cancelled) return null;

  /*
   * ★ 同时成立时**只说失败**。
   *
   * 这不是"哪个更重要"，是哪句话更准：`status === 'cancelled'` 说的是最近一条
   * **转写**任务被取消了，而 `lastFailure` 可能来自一条**导图**任务。
   * 两句一起摆会让用户以为是同一件事的两种说法。失败那一条带着原因和可点的动作，
   * 信息量严格更大，所以它优先；取消那件事在列表芯片上仍然如实写着「已取消」。
   */
  if (failure) {
    // 服务端两份文案都给了；无条件取中文会让英文界面上冒出一句中文（本仓实测见过）
    const reason = i18n.language.startsWith('zh')
      ? failure.messageZh || failure.message
      : failure.message || failure.messageZh;

    return (
      <div className={className} role="alert" data-testid="note-failure-notice">
        {/* 与 JobToaster 的 failed 一致：critical 左边条 + 三角图标。同一件事在两处长得一样。 */}
        <div className="flex items-start gap-2 rounded-lg border border-l-4 border-line border-l-critical-line bg-surface-2 p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink" data-testid="note-failure-title">
              {failure.kind === 'mindmap'
                ? t('notes.failureMindmap')
                : t('notes.failureTranscribe')}
            </p>
            {/* ② 为什么 —— daemon 的原话，一个字不改地摆出来 */}
            <p className="mt-0.5 text-xs text-critical" data-testid="note-failure-reason">
              {reason}
            </p>
            {/* ③ 他能做什么 —— 包括"直接重试多半没用"这种情况也明说，不留白 */}
            <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
              {t('notes.failureHint')}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                disabled={actions.retry.isPending}
                onClick={() => actions.retry.mutate(failure.jobUid)}
                data-testid="note-failure-retry"
              >
                <RotateCcw className="size-3" aria-hidden />
                {t('progress.retry')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigate('/tasks')}
                data-testid="note-failure-tasks"
              >
                {t('jobToast.viewTasks')}
              </Button>
            </div>

            {/*
              重试这一下**自己**失败了也要说 —— 一颗点了什么都不发生的按钮
              和一颗不存在的按钮，对用户是同一件事（`JobList.tsx` 为同一课付过账）。
            */}
            {actions.retry.error ? (
              <ErrorBlock error={actions.retry.error} className="mt-2" />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  /*
   * ── 已取消 ────────────────────────────────────────────────────────────────
   *
   * 中性色，不是红的：**用户自己按的按钮，不该看起来像故障。**
   * 与 `jobStateTone('cancelled') === 'neutral'`、列表那颗芯片同一个判断。
   */
  return (
    <div className={className} role="status" data-testid="note-cancelled-notice">
      <div className="flex items-start gap-2 rounded-lg border border-l-4 border-line border-l-line bg-surface-2 p-3">
        <CircleSlash className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink" data-testid="note-cancelled-title">
            {t('notes.cancelledTitle')}
          </p>
          {/*
            这句话里那个"接着跑"**是真的**，不是安慰：
            runner 的 `resumableTranscript()` 会复用未跑完的稿并跳过已完成的 chunk
            （D-01 §4.5，`rest/content.ts` 的重跑通道正是走这条路）。
            如果哪天它不再成立，这句话要跟着删 —— 别留一句描述了不存在行为的提示。
          */}
          <p className="mt-0.5 text-xs text-ink-secondary" data-testid="note-cancelled-hint">
            {t('notes.cancelledHint')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {/*
              ★ 这里**刻意没有**「重新转写」按钮：那颗按钮就在下面转写稿面板的头上，
              而它背后是一整套选项（换引擎 / 换模型 / 加 prompt / 「已保留你编辑过的 N 段」）。
              在这儿再放一颗只会出现两个入口、两种行为，正是本仓一直在拆的形状。
              上面那句提示直接点名了它的位置。
            */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigate('/tasks')}
              data-testid="note-cancelled-tasks"
            >
              {t('jobToast.viewTasks')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
