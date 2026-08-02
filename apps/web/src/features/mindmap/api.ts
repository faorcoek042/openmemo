import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MindMapDoc } from '@openmemo/mindmap';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';

export function useMindmapQuery(noteUid: string | undefined) {
  return useQuery({
    queryKey: qk.mindmap(noteUid ?? ''),
    queryFn: () => api<MindMapDoc | null>('notes', `/notes/${noteUid}/mindmap`),
    enabled: Boolean(noteUid),
  });
}

/**
 * 保存导图。
 *
 * D-05 §5 F4 定的是"发操作而非全量文档"（PATCH ops），但 mind-elixir 的
 * `operation` 事件给的是**操作后的完整树**，转回 MindMapDoc 也是完整文档。
 * 要发细粒度 op 就得自己做 diff —— 那是性能优化，按当前"功能优先"的排序**先不做**，
 * 但接口形状保持 PATCH，日后换成 ops 不影响调用方。
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
