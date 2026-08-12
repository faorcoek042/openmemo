import { useTranslation } from 'react-i18next';
import { stepLabel as stepLabelOf } from '../../lib/format/stepLabel';
import { useActiveNoteJob } from '../tasks';
import { blockedReasonKey } from '../../lib/jobs/blockedReason';
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
  /*
   * ⚠️ 这里此前是**第四份**实现，而且兜底是 `defaultValue: job.step` ——
   *   缺词条时把 `unpacking` 这种**英文机器枚举值**直接摆给用户看
   *   （与 `JobList` 收敛前那份同一个毛病）。收敛到共享实现。
   *   无 step 那一档（排队/阻塞）保持原样：那不是词条缺失，是真的没有阶段。
   */
  const stepText = job.step
    ? stepLabelOf(job.step, t, (k: string) => i18n.exists(k))
    : t(`progress.state.${job.state}`, { defaultValue: job.state });
  const eta = approxEta(job.etaSeconds, i18n.language);

  /*
   * ★ 挂起时**说出在等什么**（Manager 2026-08-12 裁决的另一半）。
   *
   * 在这之前这一行只说得出「暂时无法继续」—— 一个状态词，没有原因、没有下一步。
   * 而 daemon 早就把答案发过来了：`PipelineJob.blockedCode`（`ActiveNoteJob` 上
   * 一直有这个字段，只是**从来没有人读它**）。最常见的那一档是"没装语音识别模型"，
   * 用户对着「暂时无法继续」是猜不出来的。
   *
   * 导图那一半（`GenerateMindmapButton`）早就把这句话说出来了，用的正是同一张表 ——
   * 现在两边共用 `lib/jobs/blockedReason.ts`，不许各建一张。
   *
   * ⚠️ 只在 `blocked` 时说：其余状态没有"在等什么"这回事，
   * 挂一句通用的"去任务中心看看"只会变成噪音。
   * ⚠️ 认不出的 code 由那张表回落到 `UNKNOWN`（"任务被挂起了，去任务中心看看"）——
   * daemon 随时可以新增一个码，而**前端不该因此变哑**。
   */
  const blockedReason = job.state === 'blocked' ? t(blockedReasonKey(job.blockedCode)) : null;

  return (
    <div className={className} data-testid="note-progress-line">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-secondary">
        <span className="truncate">
          {stepText}
          {job.stepIndex && job.stepCount ? ` · ${job.stepIndex}/${job.stepCount}` : ''}
        </span>
        <span className="shrink-0 tabular-nums text-ink-muted">
          {formatPercent(job.progress, i18n.language)}
          {eta ? ` · ${eta}` : ''}
        </span>
      </div>
      <ProgressMeter value={job.progress} label={stepText} />
      {blockedReason ? (
        <p className="mt-1 text-xs text-ink-secondary" data-testid="note-progress-blocked">
          {blockedReason}
        </p>
      ) : null}
      {hint ? <p className="mt-1 text-xs text-ink-muted">▸ {hint}</p> : null}
    </div>
  );
}
