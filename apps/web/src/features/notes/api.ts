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

/**
 * probe（解析链接元数据，先于下载）。
 *
 * ⚠️ **daemon 目前没有独立的 probe 端点**（读 `rest/notes.ts` 确认：只有
 * `POST /api/notes/import`，它直接建 note + 排 job）。
 * 在端点落地之前，这里会 404 → 端点级记账把这一条标为缺失、回落 mock（读操作可以回落），
 * UI 上有 MockNotice 标着。**不再假装它接通了。**
 */
export function useProbeMutation() {
  return useMutation({
    mutationFn: (url: string) =>
      api<ProbeResult>('import', '/notes/probe', { method: 'POST', body: { input: url } }),
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
      /**
       * ⚠️ **契约订正**：路径是 `/api/notes/import`（不是我原来写的 `/api/import/url`），
       * 入参键是 **`input`**（可为 URL 或服务端绝对路径），不是 `url`。
       * 响应 `202 {noteUid, jobUid, status}`。
       * 我原来那条路径 daemon **根本不存在** —— 这是 D-08 §5 "import 面整面 404" 的确切来源。
       */
      api<AcceptedJob>('import', '/notes/import', {
        method: 'POST',
        /**
         * `language` 必须真的发出去（T-075）。
         *
         * 之前这里只有 `{input}`，页面上选的一切都到不了后端。
         * 而 language 恰恰是最不能丢的那个：whisper.cpp 拿不到 `-l` 时
         * 会把中文**翻译成英文**返回，用户拿到的不是转写而是译文。
         *
         * 空串不发 —— daemon 用 `typeof body.language === 'string'` 判断，
         * 空串会被当成"用户指定了空语言"存进 note.language，
         * 之后重新转写又会把这个空串当默认值继续用下去。
         */
        body: req.language ? { input: req.url, language: req.language } : { input: req.url },
        // SSE 断线重连后前端可能重发；用户也会狂点按钮
        // 语言参与 key：改了语言重导入是**另一次任务**，不该被幂等去重掉
        idempotencyKey: `import:${req.url}:${req.language ?? ''}`,
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
      // ⚠️ 动词是 **PUT**（读 `organize.ts` 的 STAR_RE 分支确认，非 PUT 一律 405）。
      // 之前写成 POST：405 既不是 404 也不是 501，不触发"未实现"回落，直接抛错回滚 —— 点了必弹错。
      api<{ uid: string; starred: boolean }>('notes', `/notes/${v.noteUid}/star`, {
        method: 'PUT',
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

/**
 * 加标签。
 *
 * ⚠️ 服务端不是"追加一个标签名"，而是**整表替换 tagUids**（读 `organize.ts` 的
 * TAGS_OF_NOTE_RE 分支确认：body 要 `{tagUids: string[]}`，传空数组表示清空）。
 * 所以要两步：
 *   1. `POST /api/tags {name}` —— 建标签或取回同名的（服务端按归一化名判重）
 *   2. `POST /api/notes/:uid/tags {tagUids: [...已有, 新的]}` —— 整表替换
 *
 * 之前我按 `{name}` 单步发，服务端一律 400。**这是第三次栽在"没读实现就按设计猜形状"。**
 */
export function useAddTagMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { noteUid: string; name: string; existingTagUids: readonly string[] }) => {
      const tag = await api<{ uid: string; name: string; color: string | null }>('notes', '/tags', {
        method: 'POST',
        body: { name: v.name },
      });
      // 已经挂上了就不重复提交（服务端会整表替换，重复 uid 没有意义）
      if (v.existingTagUids.includes(tag.uid)) return tag;
      await api<unknown>('notes', `/notes/${v.noteUid}/tags`, {
        method: 'POST',
        body: { tagUids: [...v.existingTagUids, tag.uid] },
      });
      return tag;
    },
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
