import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { AlertTriangle, RotateCcw } from 'lucide-react';

import type { NoteDetail } from '../../lib/api/types';
import { useJobActions } from '../tasks';
import { Button } from '../../components/common/Button';
import { ErrorBlock } from '../../components/common/ErrorBlock';

/**
 * 笔记页上的**失败告知条** —— 这条笔记最近一次流水线任务失败了，说清三件事（#98）。
 *
 * ## 修的是什么
 *
 * 在它之前，一次转写失败在整个产品里**只活几秒钟**：右下角一条 toast，
 * 刷新即无。而**笔记详情页对此一个字都不显示** —— 用户回到这条笔记，
 * 看到的是一个空的转写稿面板、一个不动的播放器，和零条解释。
 * 他唯一能得出的结论是"这软件坏了"。
 *
 * 判据（Manager #98 验收口径）是让用户知道三件事，缺一件都不算修好：
 *
 * | | 由谁回答 |
 * |---|---|
 * | ① **它失败了**（而不是永远"处理中"） | 列表页的 `status`（daemon 读时自愈）+ 这里的标题 |
 * | ② **为什么** | `lastFailure.messageZh` / `.message` —— daemon 早就写好了，别在最后一步丢掉 |
 * | ③ **他能做什么** | 「重试」（对**任何**终态任务都成立）+ 「查看任务」 |
 *
 * ## 为什么原因不在这里现编
 *
 * `lastFailure` 是 daemon 判定并明说的，与 `canRetranscribe` / `retranscribeBlocked`
 * 同一条规矩（#95 立的）：**服务端说，客户端不猜**。客户端不知道 runner 走到哪一步、
 * 试过哪些适配器，编出来的必然是假诊断 —— 而一句可信口气的假诊断比沉默更贵。
 *
 * ## 为什么「重试」无条件给
 *
 * 落点与任务中心那颗按钮**逐字相同**（`POST /api/jobs/:uid/retry`）。
 * 「这条任务还能不能再来一次」只准有一个答案 —— 本仓在两张 remediation 路由表上
 * 吃过一次亏（同一个 action 两个落点）。`queue.requeue()` 会把 attempt 归零，
 * 所以它对终态任务确实有效，不是一个点了没反应的假出口。
 *
 * ⚠️ 但**不承诺重试就能成**：`NO_MEDIA_SOURCE` 这类失败换多少次结果都一样。
 * 所以按钮旁边那句提示如实说「先按上面的原因处理，再试」，
 * 而不是「点一下就好了」。
 */
export function NoteFailureNotice({
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
   * ⚠️ 消费方对**字段缺失**要宽容：拿到一个老 daemon 的响应（真的没有这个键）时
   * 按"没有失败"处理，而不是崩掉或者显示一条空的告警条。
   * 这条规矩是 `NoteAsset.state` 那次事故立下的，写在共享契约的注释里。
   */
  const failure = note?.lastFailure ?? null;
  if (!failure) return null;

  // 服务端两份文案都给了；无条件取中文会让英文界面上冒出一句中文（本仓实测见过）
  const reason = i18n.language.startsWith('zh')
    ? failure.messageZh || failure.message
    : failure.message || failure.messageZh;

  return (
    <div
      className={className}
      role="alert"
      data-testid="note-failure-notice"
      // 与 JobToaster 的 failed 一致：critical 左边条 + 三角图标。同一件事在两处长得一样。
    >
      <div className="flex items-start gap-2 rounded-lg border border-l-4 border-line border-l-critical-line bg-surface-2 p-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink" data-testid="note-failure-title">
            {failure.kind === 'mindmap' ? t('notes.failureMindmap') : t('notes.failureTranscribe')}
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
          {actions.retry.error ? <ErrorBlock error={actions.retry.error} className="mt-2" /> : null}
        </div>
      </div>
    </div>
  );
}
