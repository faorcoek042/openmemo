import { useTranslation } from 'react-i18next';
import { useActiveNoteJob } from '../tasks';
import { ProgressMeter } from '../../components/common/ProgressMeter';
import { approxEta } from '../../lib/format/time';
import { formatPercent } from '../../lib/format/bytes';

/**
 * 一条笔记上"正在进行中"的那条进度行。
 *
 * ## ⚠️ 这个组件在生产环境**曾经是死代码**（T-138 ②）
 *
 * 它原来的入参是 `jobId`，两个调用点都写 `n.activeJobId ? <NoteProgressLine …/> : null` ——
 * 而 `GET /api/notes/:uid` 与 `GET /api/notes` **从来没有返回过 `activeJobId`**，
 * 全仓唯一提供这个字段的是 `lib/api/mock.ts`。
 * 也就是说：**它只在测试和 mock 数据下"工作过"，真实环境里一次都没有渲染过。**
 *
 * 而且这一半还不够 —— 旧实现只读 `progressStore`（由 `job.progress` 事件喂养），
 * 于是 `queued` / `blocked` 的任务连一条 progress 都不会发，
 * 就算补上 `activeJobId` 也仍然什么都不显示。
 *
 * 现在改成按 **`noteUid`** 问 `useActiveNoteJob()`：
 * 服务端 `GET /api/jobs`（T-130 起如实包含流水线任务，刷新后仍在）+ 内存进度（4Hz）两层合并。
 * 为什么选这条路而不是给笔记 DTO 补字段，见 `lib/jobs/noteJobs.ts` 的文件头。
 *
 * ★ 保留了原来的关键性质：**selector 只订阅自己那一条 jobId**，
 * 5 个任务同时跑时各条进度行互不牵连（D-05 §2.4）。
 */
export function NoteProgressLine({
  noteUid,
  className,
  hint,
}: {
  noteUid: string;
  className?: string;
  /** 详情页那句「可以离开此页面」。**和进度行同生共死** —— 没任务时整块都不该在。 */
  hint?: string;
}) {
  const { t, i18n } = useTranslation();
  const job = useActiveNoteJob(noteUid);

  if (!job) return null;

  /*
   * 有 step 就说 step（"转写中" / "整理笔记"），没有就说状态（"排队中" / "暂时无法继续"）。
   * **不能只认 step**：排队中与阻塞中都没有 step，那正是用户最想知道"它在等什么"的时刻。
   */
  const stepLabel = job.step
    ? t(`progress.${job.step}`, { defaultValue: job.step })
    : t(`progress.state.${job.state}`, { defaultValue: job.state });
  const eta = approxEta(job.etaSeconds, i18n.language);

  return (
    <div className={className} data-testid="note-progress-line">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-secondary">
        <span className="truncate">
          {stepLabel}
          {job.stepIndex && job.stepCount ? ` · ${job.stepIndex}/${job.stepCount}` : ''}
        </span>
        <span className="shrink-0 tabular-nums text-ink-muted">
          {formatPercent(job.progress, i18n.language)}
          {eta ? ` · ${eta}` : ''}
        </span>
      </div>
      <ProgressMeter value={job.progress} label={stepLabel} />
      {hint ? <p className="mt-1 text-xs text-ink-muted">▸ {hint}</p> : null}
    </div>
  );
}
