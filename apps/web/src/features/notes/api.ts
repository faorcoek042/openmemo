import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import { applyStarToPages, type NotesPage, type NotesPages } from '../../lib/api/notesCache';
import { qk } from '../../app/query';
import type {
  AcceptedJob,
  ImportUrlRequest,
  NoteDetail,
  NoteSummary,
  ProbeResult,
  TranscriptDto,
} from '../../lib/api/types';

/**
 * 笔记列表。
 *
 * `starredOnly` **走查询串交给 daemon 筛**，不在前端过滤（T-138 ③）。
 * 前端过滤只能筛"已经取回的那一页"（`limit=50`）：笔记超过 50 条之后，
 * 第 51 条之外的星标笔记不会出现，**而且页面上没有任何迹象**。
 * `GET /api/notes?starred=1` 现在在 SQL 的 WHERE 里筛，`limit` 限的才是星标笔记的条数。
 *
 * 两种筛选是**两条缓存**（filter 参与 queryKey），否则点一次「星标」
 * 会把「全部笔记」的缓存也换成筛过的那一份。
 */
export function useNotesQuery(opts: { starredOnly?: boolean; folderUid?: string } = {}) {
  const starredOnly = opts.starredOnly === true;
  const folderUid = opts.folderUid;

  /*
   * 筛选条件既进查询串、又进 queryKey，**从同一个对象来** ——
   * 两边各拼一次的话，缓存键与实际请求会在某个组合上错开，
   * 表现是"切了筛选但内容没变"（缓存命中了另一条件的结果）。
   */
  const filter: Record<string, unknown> = {};
  if (starredOnly) filter['starred'] = true;
  if (folderUid) filter['folder'] = folderUid;

  /*
   * ★ T-157 ③：翻页。
   *
   * 在这之前这里**连 `limit` 都不传**，而端点默认 50、上限 200、没有 offset ——
   * 于是列表恒定只有前 50 条，**第 51 条起在界面上永远不存在**：
   * 没有翻页、没有"加载更多"、没有总数、一个字的提示都没有。
   * 这与 `?starred=1` / `?folder=` 是同一族（那两条已经做对了：过滤发生在 limit 之前）
   * —— **但如果总量就取不全，过滤对了也没用。**
   *
   * `hasMore` **由服务端算**（`offset + notes.length < total`），前端不自己推：
   * 推错一次的表现是"加载更多"永远不出现，而那正是这条缺陷本来的样子。
   *
   * ★ 两个刻意的取舍：
   *
   * 1. **不发 `limit`。** 每页多少条是 daemon 的事（`rest/notes.ts` 默认 50 / 上限 200），
   *    前端再写一个数就有了第二个出处，而两处一旦分叉没有任何东西会报错。
   *    下面 `getNextPageParam` 按**这一页真实返回的条数**推进，所以 daemon 改默认值也不会错位
   *    —— 换成 `offset + PAGE_SIZE` 就会在改默认值的那天开始跳着漏笔记。
   * 2. **第一页不发 `offset=0`。** 请求与筛选那两条（`?starred=1` / `?folder=`）逐字保持原样，
   *    翻页这件事只往后追加参数。
   */
  return useInfiniteQuery({
    queryKey: qk.notes.list(filter),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (starredOnly) qs.set('starred', '1');
      if (folderUid) qs.set('folder', folderUid);
      if (pageParam > 0) qs.set('offset', String(pageParam));
      return api<NotesPage>('notes', `/notes${qs.size > 0 ? `?${qs.toString()}` : ''}`);
    },
    getNextPageParam: (last: NotesPage) =>
      last.hasMore ? last.offset + last.notes.length : undefined,
  });
}

/** 把翻页缓存拍平成一条列表 —— 消费方不该关心它是从几页拼出来的。 */
export function flattenNotes(pages: NotesPage[] | undefined): NoteSummary[] {
  return (pages ?? []).flatMap((p) => p.notes);
}

export function useNoteQuery(uid: string | undefined) {
  return useQuery({
    queryKey: qk.notes.detail(uid ?? ''),
    queryFn: () => api<NoteDetail>('notes', `/notes/${uid}`),
    enabled: Boolean(uid),
  });
}

/**
 * `GET /api/notes/:uid/transcript` 的**真实响应形状**。
 *
 * ⚠️ 它是**嵌套**的 `{transcript: {...} | null, segments: [...]}`，
 * 而前端的 `TranscriptDto` 是**扁平**的（`uid` / `language` / `status` 与 `segments` 平级）。
 *
 * 这个错位不会让任何东西报错，只会让 `transcript.data?.language`、
 * `transcript.data?.uid` 这类读取**恒为 `undefined`` —— `segments` 恰好在顶层，
 * 于是"列表能显示"造成一切正常的假象，而所有元信息静默失踪。
 * 和刚修掉的 `edited` / `editedAt` 是同一类：**字段名对不上，测试不会红，功能悄悄没了。**
 *
 * 在这里一次性拍平，而不是让每个消费方各写一遍 `?.transcript?.` ——
 * 漏一处就少一处，且下一个人无从知道该写哪种。
 */
interface TranscriptEnvelope {
  transcript: Omit<TranscriptDto, 'segments' | 'noteUid' | 'backend' | 'speakers'> | null;
  segments: TranscriptDto['segments'];
}

export function useTranscriptQuery(uid: string | undefined) {
  return useQuery({
    queryKey: qk.transcript(uid ?? ''),
    queryFn: async (): Promise<TranscriptDto | null> => {
      const raw = await api<TranscriptEnvelope | null>('transcript', `/notes/${uid}/transcript`);
      if (!raw?.transcript) return null;
      return {
        ...raw.transcript,
        noteUid: uid ?? '',
        backend: null,
        // 说话人分离尚未接线：daemon 逐段发 speakerLabel: null，且不发 speakers 表。
        // 给 [] 而不是 undefined —— 消费方 `arr()` 之后行为一致，也不必判断"字段在不在"。
        speakers: [],
        segments: raw.segments ?? [],
      };
    },
    enabled: Boolean(uid),
  });
}

/**
 * probe（解析链接元数据，先于下载）。
 *
 * ✅ **端点是真的**：`POST /api/notes/probe`（`apps/daemon/src/http/rest/notes.ts`，
 * 走 `registry.probeWithSource()` 的完整回退链，只读、不建 note、不排 job）。
 *
 * ⚠️ 这里此前的注释写着「daemon 目前没有独立的 probe 端点…会 404 → 回落 mock」——
 * **三句话没有一句成立**（`progress-audit §4⑫`）：端点在、它是 POST，
 * 而 `lib/api/client.ts` 明写「写操作**永不**静默回落 mock」。
 * 留着它的代价是具体的：读到的人会以为这条链没接通，于是不去查真正的失败原因。
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
    /*
     * 乐观更新要打到**每一条列表缓存**（`qk.notes.lists` 前缀）。
     * 自 T-138 起「全部笔记」与「星标」是两个 filter、两条缓存 ——
     * 只写 `list()` 的话，在星标页上点星星会一动不动，直到 onSettled 的 invalidate 才补上，
     * 而"点了没反应"正是用户会连点第二次的那种反馈。
     *
     * ⚠️ 星标那条缓存还要**把取消了星标的那条移出去**：它是服务端按 `starred=1` 筛过的一页，
     * 那条笔记已经不属于这一页了。这不是"前端又筛了一遍"——
     * 它是对**服务端下一次会返回什么**的预测，紧接着就会被 onSettled 的 invalidate 纠正。
     * （筛选本身仍然只有一个实现，在 daemon 的 SQL 里。）
     */
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.notes.all });
      const prev = qc.getQueriesData<NotesPages>({ queryKey: qk.notes.lists });
      for (const [key, old] of prev) {
        const filter = key[2] as Record<string, unknown> | undefined;
        qc.setQueryData<NotesPages>(key, applyStarToPages(old, filter, v.noteUid, v.starred));
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      for (const [key, data] of ctx?.prev ?? []) qc.setQueryData(key, data);
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
