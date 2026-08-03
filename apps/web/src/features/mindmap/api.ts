import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MindMapDoc } from '@openmemo/mindmap';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';

/** 服务端的信封（读 `content.ts` 的 mindmap GET 分支确认，**不是**裸 doc）。 */
export interface MindmapEnvelope {
  mindmap: { uid: string; title: string; revision: number; generatedBy: string | null; nodeCount: number } | null;
  doc?: MindMapDoc | null;
}

/**
 * ⚠️ **契约订正**：GET 返回 `{mindmap, doc}` 信封，我原来按裸 `MindMapDoc` 解。
 * 后果是把整个信封当 doc 传给渲染器 → `toMindElixir()` 里 `Object.keys(doc.nodes)`
 * 拿到 undefined → **`Cannot convert undefined or null to object`，导图页整页崩**。
 */
export function useMindmapQuery(noteUid: string | undefined) {
  return useQuery({
    queryKey: qk.mindmap(noteUid ?? ''),
    queryFn: () => api<MindmapEnvelope>('notes', `/notes/${noteUid}/mindmap`),
    enabled: Boolean(noteUid),
    // 只有形状完整的 doc 才交给渲染器；其余一律当"还没有导图"
    select: (d) => (d?.doc && typeof d.doc === 'object' && d.doc.nodes ? d.doc : null),
  });
}

/**
 * F4 生成思维导图 —— **`POST /api/notes/:uid/mindmap`**。
 *
 * ## 为什么这个 hook 到今天才出现（T-138 ①）
 *
 * daemon 侧整条链路早就通了：端点在 `http/rest/content.ts:310`，
 * runner 在 `jobs/runners/mindmap.ts`（LLM → 校验 → 落库 → `note.updated`），
 * `[实测]` 4.3 秒出图、`generated_by = llm:deepseek`。
 * 前端也有查看器（`MindmapView` / mind-elixir）与保存（PATCH）。
 * **唯独没有人调这个 POST** —— `features/mindmap/api.ts` 只有 GET 与 PATCH，
 * 导图空态只写着一句"还没有思维导图"。
 * 于是 F4（章程点名的五项之一）在产品里**根本点不出来**：
 * T-130 验证导图 `blocked` 时只能用 curl 直接打接口，回执里明写了这一点。
 *
 * ## 202 + jobUid，不是同步等结果
 *
 * 端点返回 `202 {jobUid, noteUid}`，真正的生成走任务队列（lane `gpu.llm`）。
 * 所以**不能**用 `isPending` 当"正在生成"—— 那只覆盖到 HTTP 往返的几毫秒，
 * 用户会看到按钮闪一下就恢复可点，然后开始重复点击。
 * 进行中状态由 `useActiveNoteJob(noteUid, 'mindmap')` 从任务流里读（T-130 的契约）。
 *
 * ★ `onSuccess` **返回** invalidate 的 promise 是有意的：react-query 会等它 resolve
 * 之后才把 mutation 判为 settled，于是 `isPending` 一直覆盖到"任务列表里已经能看见这条任务"，
 * 中间没有一帧按钮是可点的 —— 这就是"重复点击"那个窗口被关掉的地方。
 */
export interface MindmapAccepted {
  jobUid: string;
  noteUid: string;
}

export function useGenerateMindmapMutation(noteUid: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<MindmapAccepted>('notes', `/notes/${noteUid}/mindmap`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs.all }),
  });
}

/*
 * ⚠️ 这里原本有一个 `export const MINDMAP_SAVE_SUPPORTED = false`。**已删除，而不是改成 true。**
 *
 * 当时 daemon 确实没有 PATCH，关掉是对的；但 `content.ts:329` 早就把它做出来了
 * （带 validate + revision），**而没有人回来把常量翻开** ——
 * 于是渲染、拖拽、导出全好，只有保存零请求，还带着一条"编辑尚未持久化"的提示误导用户。
 *
 * 改成 `true` 只是把这次的债还了，**下一个功能还会重演**。
 * 真正的修法是让"后端有没有"**自己说话**：直接发请求，端点不存在时
 * `client.ts` 的端点级记账会 404 → 写操作**如实抛错**（写永不静默回落 mock），
 * UI 照常显示错误。既不需要有人记得回来开，也不会再毒化整个面。
 *
 * 这与我删掉 `App.tsx` 那个 `pending` 分支是同一条原则：
 * **没有这个开关，"忘了打开"就不可能再发生。**
 */

/**
 * 保存导图。
 *
 * D-05 §5 F4 定的是"发操作而非全量文档"（PATCH ops），但 mind-elixir 的
 * `operation` 事件给的是**操作后的完整树**，转回 MindMapDoc 也是完整文档。
 * 要发细粒度 op 就得自己做 diff —— 那是性能优化，按当前"功能优先"的排序**先不做**，
 * 但接口形状保持 PATCH，日后换成 ops 不影响调用方。
 */
/**
 * ⚠️ 保存导图编辑：**服务端尚无对应端点**。
 *
 * daemon 的 `/api/notes/:uid/mindmap` 只有 `GET`（读）与 `POST`（重新生成，排一个 job），
 * **没有 PATCH**。我原来按 PATCH 发，结果那条 404 把整个 `notes` 面毒化成 mock ——
 * 星标、标签、段落编辑跟着全部失效（见 `lib/api/client.ts` 的端点级记账）。
 *
 * 现在的处理：**不再对着不存在的路由发请求**。编辑仍然在渲染器内即时生效（用户手感不变），
 * 但不假装已保存 —— UI 上明确标注"编辑尚未持久化"。等端点落地把这里改回真调用即可。
 */
export function useSaveMindmapMutation(noteUid: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (doc: MindMapDoc) =>
      api<{ revision: number }>('notes', `/notes/${noteUid}/mindmap`, {
        method: 'PATCH',
        body: { doc },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.mindmap(noteUid ?? '') });
    },
  });
}
