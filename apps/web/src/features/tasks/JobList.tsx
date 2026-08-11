import { useTranslation } from 'react-i18next';

import { TERMINAL_JOB_STATES } from '@openmemo/shared';

import { stepLabel as stepLabelOf } from '../../lib/format/stepLabel';
import { jobDisplayName } from '../../lib/format/jobName';
import { useJobCatalogNames } from '../../lib/catalog/useJobCatalogNames';
import { Pause, Play, RotateCcw, ShieldCheck, X } from 'lucide-react';

import { ProgressMeter } from '../../components/common/ProgressMeter';
import { StatusChip } from '../../components/common/StatusChip';
import { jobStateTone } from '../../components/common/statusTone';
import { Button } from '../../components/common/Button';
import { ListRow } from '../../components/common/ListRow';
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
  const catalogNames = useJobCatalogNames();
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

  /*
   * ⚠️ **停止冒泡的容器** —— 整行可点之后，行内每一个可点的东西都必须自己挡住那次点击，
   * 否则点「取消」会顺带把用户导航走。笔记行对它那一个星标做的就是这件事
   * （`preventDefault` 挡浏览器跟随 href，`stopPropagation` 挡 react-router 的 onClick）。
   *
   * 这里包**整块**而不是给 6 个控件各写一遍：动作按钮有 2~3 个、`ErrorBlock` 自己还带
   * 重试/补救/展开三个。逐个写等于给未来每一个新按钮留一个必须记得的动作 ——
   * 而"需要人记得"的守卫，本仓已经反复确认过等价于迟早会漏的守卫。
   * 包容器之后，**这块区域里以后加多少按钮都不用再想这件事**。
   */
  const stopRowNav = (e: { preventDefault: () => void; stopPropagation: () => void }): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <ListRow
      href={href}
      /*
       * ★ T-202：任务行与笔记行**统一成整行可点**。
       *
       * ⚠️ 这里推翻了 T-192 当时写下的"只把标题做成链接"，理由必须说清楚，
       * 因为那条注释本身是对的、只是前提变了：
       *
       * T-192 的理由是「整行可点要靠 stopPropagation 去躲按钮，而『点击被父元素抢走』
       * 正是刚排除掉的失败模式」。**那次排除的是一个没做好的实现（行上根本没有监听器），
       * 不是这个做法本身** —— 笔记行用同一套躲避方式跑了很久，用户点名它更好用。
       *
       * 但笔记行只有 1 个内嵌控件（`[实测]` demo 上每行 链接=1 按钮=1），
       * 任务行非终态时是 2~3 个动作按钮 + 可能的 `ErrorBlock`（自带 3 个）。
       * 所以不是照搬，而是**把躲避从"每个控件各写一遍"收敛成"整块包一次"**（见上），
       * 让控件数量不再是这条做法能不能成立的变量。
       *
       * 仍然保留的一条：`href` 为空（下载类任务没有 noteUid）时 `ListRow` 会退回纯文本，
       * **不给一个点了到不了地方的假出口**（T-192 那条判断没变）。
       */
      clickTarget={href ? 'row' : 'title'}
      // 锚点沿用 T-192 那批腿钉的名字，别因为换骨架就改名
      linkTestId="job-result-link"
      title={shownName}
      trailing={
        <StatusChip
          tone={running ? 'running' : tone}
          label={label}
          icon={verifying ? <ShieldCheck className="size-3.5" aria-hidden /> : undefined}
        />
      }
    >
      {job.state !== 'succeeded' && job.state !== 'cancelled' ? (
        <>
          <div className="mt-1.5 mb-1.5 flex items-center justify-between gap-2 text-xs text-ink-muted">
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

      {/* ★ 行内一切可点的东西都放进这个容器 —— 它替它们挡住整行那次导航 */}
      <div onClick={stopRowNav} data-testid="job-row-actions">
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

          {/*
            ★ T-198：**终态行不许再渲染取消按钮。**
            原判据是 `!== 'succeeded' && !== 'cancelled'` —— 漏了 `failed`，
            于是一条已经失败的任务还带着「取消」，点下去必然 409。
            判据收敛到 `TERMINAL_JOB_STATES`（succeeded|failed|cancelled）这一份，
            免得下一个终态加进来时这里又漏一个。

            ⚠️ T-202 重构这一行时我**把它退回过旧判据**（改骨架时顺手抄了上面进度块
            那句条件），是 eslint 报「`TERMINAL_JOB_STATES` 导入了没用」才发现的。
            记在这里：**这类"重构顺手抄错条件"不会有任何测试变红**（失败的任务少见，
            且断言的是按钮在不在），能拦住它的是那条未使用导入。别把它当噪音。
          */}
          {!(TERMINAL_JOB_STATES as readonly string[]).includes(job.state) ? (
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
          ⚠️ 上面 `job.error` 那个 `<p>` 渲染的是 **job 数据里的 error**（服务端记在任务上的），
          **不是这四次 mutation 的 error** —— 两者是不同的东西，而它长得很像"已经处理了"，
          这正是这处漏了这么久的原因。
        */}
        {actionError ? <ErrorBlock error={actionError} className="mt-2" /> : null}
      </div>
    </ListRow>
  );
}
