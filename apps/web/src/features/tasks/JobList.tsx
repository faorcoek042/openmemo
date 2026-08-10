import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { stepLabel as stepLabelOf } from '../../lib/format/stepLabel';
import { jobDisplayName } from '../../lib/format/jobName';
import { useModelCatalogNames } from '../../lib/catalog/useModelCatalogNames';
import { Pause, Play, RotateCcw, ShieldCheck, X } from 'lucide-react';

import { ProgressMeter } from '../../components/common/ProgressMeter';
import { StatusChip } from '../../components/common/StatusChip';
import { jobStateTone } from '../../components/common/statusTone';
import { Button } from '../../components/common/Button';
import { approxEta } from '../../lib/format/time';
import { formatBytes, formatPercent, formatSpeed } from '../../lib/format/bytes';
import { groupJobs, jobResultHref, useJobActions, type MergedJob } from './api';
import { ErrorBlock } from '../../components/common/ErrorBlock';

/**
 * 任务列表（抽屉与整页共用）。
 *
 * 分组顺序刻意是 进行中 → 等待中 → **需要处理** → 已完成：
 * `blocked`/`failed` 是唯一需要用户动手的一类，埋在"已完成"下面等于没有。
 */
export function JobList({ jobs, compact }: { jobs: MergedJob[]; compact?: boolean }) {
  const { t } = useTranslation();
  const g = groupJobs(jobs);

  const sections: [string, MergedJob[]][] = [
    [t('tasks.running'), g.running],
    [t('tasks.waiting'), g.waiting],
    [t('tasks.needsAttention'), g.attention],
    [t('tasks.done'), g.done],
  ];

  return (
    <div className="flex flex-col gap-4">
      {sections.map(([label, list]) =>
        list.length === 0 ? null : (
          <section key={label}>
            <h3 className="mb-2 px-1 text-xs font-medium text-ink-secondary">
              {label} ({list.length})
            </h3>
            <ul className="flex flex-col gap-2" role="list">
              {list.map((j) => (
                <JobRow key={j.jobId} job={j} compact={compact} />
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  );
}

function JobRow({ job, compact }: { job: MergedJob; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const actions = useJobActions();

  // 收敛到共享实现：此前这里缺词条会**原样渲染 step key**（英文机器枚举值）
  const stepText = stepLabelOf(job.step, t, (k: string) => i18n.exists(k));
  /*
   * ★ 名字按**当前界面语言**现算，不直接渲染 daemon 那个写死的 `displayName`。
   *   兜底（目录没加载 / 不在目录里 / 后端包）仍然是 `displayName`，
   *   所以这一行不会让任何原本有名字的行变空。理由见 `lib/format/jobName.ts`。
   */
  // hook 单独一行、无条件调用 —— 别塞进表达式里（Rules of Hooks 被我踩过一次）
  const catalogNames = useModelCatalogNames();
  const shownName = jobDisplayName(i18n.language, job, catalogNames) || job.type;
  const eta = approxEta(job.etaSeconds, i18n.language);
  const running = job.state === 'running' || job.state === 'leased';
  const verifying = running && job.step === 'verifying';
  const attention = job.state === 'blocked' || job.state === 'failed';
  /*
   * 四个动作共用一个渲染点：同一时刻用户只可能点了其中一个，
   * 分成四个 ErrorBlock 只会让同一条错误有四个出处（D-10 §3.2 R3）。
   */
  const actionError =
    actions.pause.error ?? actions.resume.error ?? actions.retry.error ?? actions.cancel.error;

  /** 这条任务做出来的东西在哪；null = 没有可去的地方（下载类任务），那就不给链接。 */
  const href = jobResultHref(job);

  // 颜色判定不在这里做（T-114）：六个渲染点各写一份 switch 已经分叉过一次。
  const tone = jobStateTone(job.state);
  // fallback 分支原来把机器枚举值（queued / cancelled）直接当标签渲染 ——
  // 用户看到的是英文单词。词条缺失时至少退回 tasks.* 的既有中文。
  const label = running
    ? stepText || t('tasks.running')
    : job.state === 'failed'
      ? t('notes.failed')
      : job.state === 'blocked'
        ? t('tasks.needsAttention')
        : job.state === 'paused'
          ? t('progress.pause')
          : job.state === 'succeeded'
            ? t('tasks.done')
            : t(`jobState.${job.state}`, { defaultValue: job.state });

  return (
    <li className="rounded-lg border border-line bg-surface-0 p-3">
      <div className="mb-1 flex items-start justify-between gap-2">
        {/*
          ★ T-192：**标题是通往「这条任务做出来的东西」的链接**（用户报的
          「任务中心列表点击无法进入查看历史记录」）。

          `[实测]` 修之前在真浏览器里点过：点击**完整冒泡到 LI 和 UL**、
          `defaultPrevented:false` —— 没有任何东西吞它，是**路径上一个监听器都没有**；
          行内 `<a href>` 0 个、可聚焦元素 0 个（键盘同样到不了）、`cursor:auto`
          （连"这里能点"的手型都没有）、控制台零报错。

          ⚠️ **为什么只把标题做成链接，而不是整行可点** —— 这是判断，不是偷懒：
          非终态的行下面有 4 个动作按钮（暂停/继续/重试/取消）。整行可点就得靠
          `stopPropagation` 去躲它们，而"点击被父元素抢走 / 被 preventDefault 吃掉"
          **正是这次排查刚刚排除掉的那种失败模式**（第 2 种）。在修第 1 种的时候
          造出一个第 2 种，是这一族 bug 最典型的复发方式。
          → 标题是链接、按钮是按钮，两者永远不在同一个命中区域。
          **下一个人如果想"顺手让整行可点"，请先读完这一段。**

          没有落点时（下载类任务）**退回纯文本**，不给一个点了到不了地方的假出口。
        */}
        {href ? (
          <Link
            to={href}
            className="min-w-0 truncate text-sm text-ink hover:text-accent-ink hover:underline"
            data-testid="job-result-link"
          >
            {shownName}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-sm text-ink">{shownName}</span>
        )}
        <StatusChip
          tone={running ? 'running' : tone}
          label={label}
          icon={verifying ? <ShieldCheck className="size-3.5" aria-hidden /> : undefined}
        />
      </div>

      {job.state !== 'succeeded' && job.state !== 'cancelled' ? (
        <>
          <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-ink-muted">
            <span className="min-w-0 truncate">
              {job.totalBytes
                ? `${formatBytes(job.completedBytes, i18n.language)} / ${formatBytes(job.totalBytes, i18n.language)}`
                : stepText}
              {job.speedBps ? ` · ${formatSpeed(job.speedBps, i18n.language)}` : ''}
            </span>
            <span className="shrink-0 tabular-nums">
              {formatPercent(job.progress, i18n.language)}
              {eta ? ` · ${eta}` : ''}
            </span>
          </div>
          <ProgressMeter
            value={job.progress}
            size={compact ? 'sm' : 'md'}
            tone={tone === 'critical' ? 'critical' : tone === 'warning' ? 'warning' : 'info'}
            // 六个渲染点里这里原本是唯一漏掉 verifying 的：校验阶段没有可信百分比，
            // 画一个卡在 87% 不动的条比画脉动更像故障（D-09 §1.3）。
            indeterminate={verifying}
            label={stepText || job.type}
          />
        </>
      ) : null}

      {/* 失败/阻塞必须给出可点击的动作，否则"用户不碰命令行"就没做到 */}
      {job.error ? (
        <p className="mt-1.5 text-xs text-critical">
          {i18n.language.startsWith('zh') ? job.error.messageZh : job.error.message}
          {job.maxAttempts > 0 ? ` (${job.attempt}/${job.maxAttempts})` : ''}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {running ? (
          <Button size="sm" variant="ghost" onClick={() => actions.pause.mutate(job.jobId)}>
            <Pause className="size-3" />
            {t('progress.pause')}
          </Button>
        ) : job.state === 'paused' ? (
          <Button size="sm" variant="ghost" onClick={() => actions.resume.mutate(job.jobId)}>
            <Play className="size-3" />
            {t('progress.resume')}
          </Button>
        ) : null}

        {attention ? (
          <Button size="sm" variant="secondary" onClick={() => actions.retry.mutate(job.jobId)}>
            <RotateCcw className="size-3" />
            {t('progress.retry')}
          </Button>
        ) : null}

        {job.state !== 'succeeded' && job.state !== 'cancelled' ? (
          <Button size="sm" variant="ghost" onClick={() => actions.cancel.mutate(job.jobId)}>
            <X className="size-3" />
            {t('progress.cancel')}
          </Button>
        ) : null}

        {job.transientOnly ? (
          <span className="ml-auto text-xs text-ink-muted" title={t('tasks.transientHint')}>
            {t('tasks.transient')}
          </span>
        ) : null}
      </div>

      {/*
        ★ 这四个按钮（暂停/继续/重试/取消）此前**失败时一个字都不显示**。

        ⚠️ 上面 `:116` 那个 `<p>` 渲染的是 **job 数据里的 error**（服务端记在任务上的），
        **不是这四次 mutation 的 error** —— 两者是不同的东西，而它长得很像"已经处理了"，
        这正是这处漏了这么久的原因。

        后果最重的是暂停/继续：daemon 对它们回 **501 + `cancel_job` remediation**
        （`rest/jobs.ts`），也就是说**服务端算好了"这个做不到，但你可以取消"这句建议，
        而它在产品里到不了屏幕**。`ErrorBlock` 自 T-140 起默认渲染 remediation，
        所以接上这一行的同时那个按钮也就活了。

        `useJobActions()` 是在 **JobRow 里**调的（不是 JobList），四个 mutation 实例
        每行各一份 —— 所以这里不会把 A 行的错误显示到 B 行上。
      */}
      {actionError ? <ErrorBlock error={actionError} className="mt-2" /> : null}
    </li>
  );
}
