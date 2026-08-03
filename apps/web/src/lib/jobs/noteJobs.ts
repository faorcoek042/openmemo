/**
 * 「这条笔记上现在有没有任务在跑」—— **纯决策部分**（T-138 ②/①）。
 *
 * ## 为什么需要它，以及为什么它在 `lib/` 而不是某个 feature 里
 *
 * 有两个地方要回答同一个问题：
 *   - 笔记详情页 / 列表页的 `NoteProgressLine`（"这条笔记正在转写吗"）
 *   - 思维导图的生成按钮（"这条笔记的导图正在生成吗"）
 *
 * 它们此前各自缺一半：进度行读的是 `note.activeJobId` —— **一个 daemon 从来没发过的字段**
 * （只有 `lib/api/mock.ts` 提供），所以它在真实环境里**永远不渲染**；
 * 导图那边则连按钮都没有。
 *
 * 补 `activeJobId` 进笔记 DTO 是**另一条路，本轮没有走**，理由写在这里以免下一个人再纠结：
 *
 * 1. **它会造出第二个事实来源。** T-130 之后 `GET /api/jobs` 已经如实列出流水线 job
 *    （`PipelineJob` 自带 `noteUid`），SSE 的 `job.created/state/progress` 也已成契约。
 *    再让笔记 DTO 回答一次"哪个 job 在跑"，两处就可能给出不同答案 ——
 *    本项目刚吃过这个亏（`/models` 与 `/settings` 对同一个问题给出相反答案）。
 * 2. **单加那个字段并不能让进度行活过来。** `NoteProgressLine` 的渲染条件是
 *    "进度 store 里有这个 jobId 的快照"，而 store 只由 `job.progress` 事件喂养 ——
 *    `queued` / `blocked` 的任务**一条 progress 都不会发**。也就是说走那条路要同时改
 *    DTO **和**组件，而走这条路只改组件。
 * 3. **一条笔记可以同时有多个未完成任务**（转写 + 导图），`activeJobId` 是单数，
 *    要么随便挑一个，要么改成数组 —— 而那就是 `/api/jobs` 已经在做的事。
 *
 * 本文件只做**选择**，不碰 React：这样它能进 `tsconfig.test.json` 那条 CommonJS 单测通道，
 * 规则本身可以被单独钉住，而不是只能靠渲染一个组件来间接验证。
 */
import { TERMINAL_JOB_STATES, isPipelineJob } from '@openmemo/shared';
import type { AnyJob, JobState, PipelineJob, PipelineJobKind } from '@openmemo/shared';

/**
 * "还没结束" = 不在终态。
 *
 * ⚠️ `blocked` **算未结束**，这是有意的：它正是最需要在笔记页上说话的状态
 * （没装 ASR 模型 / 没配 LLM）。把它当"结束了"会让一次零报错的卡住重新变成沉默 —— 见 T-130。
 */
export function isActiveJobState(state: JobState): boolean {
  return !(TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

/**
 * 挑出这条笔记上**还没结束**的流水线任务。
 *
 * 顺序：`createdAt` 倒序（新的在前），**在这里显式排，不依赖调用方给的顺序** ——
 * `GET /api/jobs` 目前恰好是新的在前，但那是实现细节，不是契约。
 *
 * @param kind 只要某一类（`'mindmap'` / `'transcribe'`）时传；不传 = 任意流水线任务。
 */
export function activeNoteJobs(
  jobs: readonly AnyJob[],
  noteUid: string | undefined,
  kind?: PipelineJobKind,
): PipelineJob[] {
  if (!noteUid) return [];
  return jobs
    .filter(isPipelineJob)
    .filter((j) => j.noteUid === noteUid)
    .filter((j) => (kind ? j.kind === kind : true))
    .filter((j) => isActiveJobState(j.state))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * 同上，只取一条。
 *
 * 取**最新创建**的那一条：用户刚点下去的那个动作就是他正在等的那个。
 * （不是"取正在 running 的那条" —— 那会让刚点完、还在 `queued` 的任务在界面上
 * 输给一个早就卡在 `blocked` 的旧任务，表现为"我点了但什么都没变"。）
 */
export function pickActiveNoteJob(
  jobs: readonly AnyJob[],
  noteUid: string | undefined,
  kind?: PipelineJobKind,
): PipelineJob | undefined {
  return activeNoteJobs(jobs, noteUid, kind)[0];
}
