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

/** 服务端目前**没有**保存编辑的端点（只有 GET 与 POST 生成）。 */
export const MINDMAP_SAVE_SUPPORTED = false;

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
