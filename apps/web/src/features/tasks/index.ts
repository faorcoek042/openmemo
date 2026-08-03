/**
 * 任务域对外出口（D-05 §3.1）。
 *
 * 其它 feature 只能从这里 import（`../tasks` 放行，`../tasks/api` 会被 eslint 拦下）。
 * 目前对外只开一个口子：**「这条笔记上现在有没有任务在跑」** ——
 * 笔记页的进度行与导图的「生成中」都读它，两处共用同一个事实来源。
 */
export { useActiveNoteJob, type ActiveNoteJob } from './api';
export { tasksRoutes } from './Tasks.routes';
export { tasksSse } from './sse';
