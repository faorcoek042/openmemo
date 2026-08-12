/**
 * 任务域对外出口（D-05 §3.1）。
 *
 * 其它 feature 只能从这里 import（`../tasks` 放行，`../tasks/api` 会被 eslint 拦下）。
 *
 * 对外两个口子，都遵同一条规矩：**同一个事实 / 同一个动作只准有一份**。
 *   · `useActiveNoteJob` —— 「这条笔记上现在有没有任务在跑」。
 *     笔记页的进度行与导图的「生成中」都读它。
 *   · `useJobActions` —— 对一条任务的四个动作（暂停 / 继续 / **重试** / 取消）。
 *     笔记页的失败告知条（#98）要给「重试」出口，而它的落点必须与任务中心那颗
 *     按钮**逐字相同**（`POST /api/jobs/:uid/retry`）。在笔记域另写一份 mutation
 *     就是给"同一个问题两个答案"再开一扇门 —— 本仓已经在两张 remediation 路由表上
 *     吃过一次（同一个 action，点错误块和点任务提示去了不同的地方）。
 */
export { useActiveNoteJob, useJobActions, type ActiveNoteJob } from './api';
export { tasksRoutes } from './Tasks.routes';
export { tasksSse } from './sse';
