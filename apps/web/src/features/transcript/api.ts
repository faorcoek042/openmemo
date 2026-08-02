import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';
import type { TranscriptDto } from '../../lib/api/types';
import type { TranscriptSegmentDto } from '../../lib/events/types';

/**
 * 编辑单个转写段落（M-4）。
 *
 * ## 为什么这个 UI 是必需的而不是锦上添花
 *
 * `packages/pipeline` 的两阶段合并已经实测跑通（用户改「动能」→「动荡」，重跑后保留），
 * 而它判定"用户编辑过"的**唯一依据**是 `transcript_segments.edited_at`（D-06 §15.2 冻结契约）。
 * 在这个入口出现之前，`edited_at` 永远是 NULL —— **那条被验证过的保留逻辑在真实使用中永远走不到**。
 * 后端做对了，缺的是让用户够得着的把手。
 *
 * 编辑走**乐观更新**：本地毫秒级、几乎必然成功，等往返会让打字体验很差（D-05 §2.5）。
 */
export function useEditSegmentMutation(noteUid: string | undefined) {
  const qc = useQueryClient();
  const key = qk.transcript(noteUid ?? '');

  return useMutation({
    mutationFn: (v: { transcriptUid: string; seq: number; text: string }) =>
      api<{ editedAt: number }>('transcript', `/transcripts/${v.transcriptUid}/segments/${v.seq}`, {
        method: 'PATCH',
        body: { text: v.text },
      }),

    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TranscriptDto | null>(key);
      qc.setQueryData<TranscriptDto | null>(key, (old) =>
        old
          ? {
              ...old,
              segments: old.segments.map((s) =>
                s.seq === v.seq
                  ? {
                      ...s,
                      // 首次编辑时把 ASR 原文留在 textRaw —— 这是"还原"和"查看改动"的依据
                      textRaw: s.textRaw ?? s.text,
                      text: v.text,
                      editedAt: Date.now(),
                    }
                  : s,
              ),
            }
          : old,
      );
      return { prev };
    },

    onError: (_e, _v, ctx) => {
      // 失败回滚：不能让用户以为改成功了
      if (ctx?.prev !== undefined) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

/** 还原到 ASR 原文（清除 `edited_at`，重新纳入重跑覆盖范围）。 */
export function useRevertSegmentMutation(noteUid: string | undefined) {
  const qc = useQueryClient();
  const key = qk.transcript(noteUid ?? '');

  return useMutation({
    mutationFn: (v: { transcriptUid: string; seq: number }) =>
      api<{ ok: true }>('transcript', `/transcripts/${v.transcriptUid}/segments/${v.seq}/revert`, {
        method: 'POST',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

export function isEdited(s: TranscriptSegmentDto): boolean {
  return s.editedAt != null;
}
