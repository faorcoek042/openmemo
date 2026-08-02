import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import { qk } from '../../app/query';
import type {
  AcceptedJob,
  ImportUrlRequest,
  NoteDetail,
  NoteSummary,
  ProbeResult,
  TranscriptDto,
} from '../../lib/api/types';

export function useNotesQuery() {
  return useQuery({
    queryKey: qk.notes.list(),
    queryFn: () => api<{ notes: NoteSummary[] }>('notes', '/notes'),
    select: (d) => d.notes,
  });
}

export function useNoteQuery(uid: string | undefined) {
  return useQuery({
    queryKey: qk.notes.detail(uid ?? ''),
    queryFn: () => api<NoteDetail>('notes', `/notes/${uid}`),
    enabled: Boolean(uid),
  });
}

export function useTranscriptQuery(uid: string | undefined) {
  return useQuery({
    queryKey: qk.transcript(uid ?? ''),
    queryFn: () => api<TranscriptDto | null>('transcript', `/notes/${uid}/transcript`),
    enabled: Boolean(uid),
  });
}

/** probe：秒级返回，**先于下载**。让"认对了没有"和"需要登录"都提前暴露（D-01 §5 F1）。 */
export function useProbeMutation() {
  return useMutation({
    mutationFn: (url: string) => api<ProbeResult>('import', '/import/probe', { method: 'POST', body: { url } }),
  });
}

/**
 * D-01 §3.2 规则 2：写操作一律异步化 —— 返回 202 + jobId，进度走 SSE。
 * 因此 `onSuccess` **只把 job 塞进缓存，不做乐观业务更新**（D-05 §2.5：
 * 触发转写/下载绝不乐观，它们会失败、会 blocked、会排队，假装成功是欺骗）。
 */
export function useImportUrlMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ImportUrlRequest) =>
      api<AcceptedJob>('import', '/import/url', {
        method: 'POST',
        body: req,
        // SSE 断线重连后前端可能重发；用户也会狂点按钮
        idempotencyKey: `import:${req.url}`,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.notes.all });
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
    },
  });
}

/* ────────────────── 标签 / 星标 / 文件夹的写入路径 ────────────────── */

/**
 * 这三个此前**只读**：星标只显示不能点、标签只显示不能加删。
 * DB 表（`notes.starred` / `tags` / `note_tags`）和 API 形状早就在，缺的是 UI 写入口 ——
 * 典型的"后端做完了但用户摸不到"。
 *
 * 全部走**乐观更新**：本地操作、毫秒级、几乎必然成功，等往返会显得很卡（D-05 §2.5）。
 */
export function useToggleStarMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { noteUid: string; starred: boolean }) =>
      api<{ ok: true }>('notes', `/notes/${v.noteUid}/star`, {
        method: 'POST',
        body: { starred: v.starred },
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.notes.all });
      const prev = qc.getQueryData<{ notes: NoteSummary[] }>(qk.notes.list());
      qc.setQueryData<{ notes: NoteSummary[] }>(qk.notes.list(), (old) =>
        old
          ? { notes: old.notes.map((n) => (n.uid === v.noteUid ? { ...n, starred: v.starred } : n)) }
          : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.notes.list(), ctx.prev);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.notes.all }),
  });
}

export function useAddTagMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { noteUid: string; name: string }) =>
      api<{ uid: string; name: string; color: string | null }>('notes', `/notes/${v.noteUid}/tags`, {
        method: 'POST',
        body: { name: v.name },
      }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: qk.notes.detail(v.noteUid) });
      void qc.invalidateQueries({ queryKey: qk.notes.all });
      void qc.invalidateQueries({ queryKey: qk.tags });
    },
  });
}

export function useRemoveTagMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { noteUid: string; tagUid: string }) =>
      api<{ ok: true }>('notes', `/notes/${v.noteUid}/tags/${v.tagUid}`, { method: 'DELETE' }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: qk.notes.detail(v.noteUid) });
      void qc.invalidateQueries({ queryKey: qk.notes.all });
    },
  });
}

/** 软删除（D-02：`deleted_at`），配合 Toast 的「撤销」。 */
export function useDeleteNoteMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noteUid: string) =>
      api<{ ok: true }>('notes', `/notes/${noteUid}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.notes.all }),
  });
}

export function useRenameNoteMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { noteUid: string; title: string }) =>
      api<{ ok: true }>('notes', `/notes/${v.noteUid}`, {
        method: 'PATCH',
        body: { title: v.title },
      }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: qk.notes.detail(v.noteUid) });
      void qc.invalidateQueries({ queryKey: qk.notes.all });
    },
  });
}

/**
 * 保存笔记正文（TipTap）。
 *
 * **两份一起送**：`bodyJson` 保真、`bodyText` 供 FTS5 索引（D-02 §1.3）。
 * 投影在前端做 —— 服务端不该为了建索引去装一个 TipTap。
 */
export function useSaveNoteBodyMutation(noteUid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { bodyJson: unknown; bodyText: string; anchors?: unknown[] }) =>
      api<{ ok: true }>('notes', `/notes/${noteUid}`, {
        method: 'PATCH',
        body: { bodyJson: v.bodyJson, bodyText: v.bodyText, anchors: v.anchors ?? [] },
      }),
    onSuccess: () => {
      // 只失效详情，不动列表：正文改动不影响列表展示，省一次全量重拉
      void qc.invalidateQueries({ queryKey: qk.notes.detail(noteUid) });
    },
  });
}
