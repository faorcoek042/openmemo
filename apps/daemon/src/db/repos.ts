/**
 * 领域仓储：notes / media_sources / media_assets / transcripts / transcript_segments。
 *
 * 只做 SQL，不含业务编排。表结构见 D-02 §1.3–§1.5（迁移在 `packages/db/migrations/0001_init.sql`）。
 *
 * **双 ID 约定**（D-02 §1.1）：内部 `id INTEGER PRIMARY KEY`（FTS5 `content_rowid` 与
 * sqlite-vec 都要求整数），对外只暴露 `uid`（ULID）。仓储层负责两者之间的翻译。
 */
import type { DatabaseHandle, SqlValue } from '@openmemo/db';
import type { WordTimestamp } from '@openmemo/pipeline';
import { ulid } from '@openmemo/shared';

export interface NoteRow {
  id: number;
  uid: string;
  folder_id: number | null;
  kind: string;
  title: string;
  /**
   * TipTap 文档 JSON（**字符串**，`content.ts` 的 PATCH 用 `JSON.stringify` 落的）。
   *
   * ⚠️ 这一列存在于 `0001_init.sql` 与 `SELECT *` 的结果里，但**此前不在这个接口上** ——
   * 于是 `GET /api/notes/:uid` 的序列化里也没有它：正文 PATCH 真落库、GET 一个字都不回，
   * 用户刷新一次编辑器就空了（T-139 A1b，⑤C「写得进读不回」第七例）。
   * 类型少一个字段不会报错，只会让人以为"没有这个东西可发"。
   */
  body_json: string | null;
  body_text: string;
  summary_md: string | null;
  status: string;
  language: string | null;
  duration_ms: number | null;
  starred: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface AssetRow {
  id: number;
  uid: string;
  note_id: number | null;
  role: string;
  rel_path: string;
  display_name: string | null;
  mime: string | null;
  bytes: number | null;
  duration_ms: number | null;
  sample_rate: number | null;
  channels: number | null;
  state: string;
  /**
   * 盘上这份文件**上一次被一份新副本覆盖**的时刻（`0003_media_assets_replaced_at.sql`）。
   *
   * `null` = 从导入到现在没被换过。**不是**"这一行上次被 UPDATE 的时间"——
   * 见 {@link Repos.createAsset} 里那段：只有调用方明说"我刚把盘上那份换掉了"才会写它。
   */
  replaced_at: number | null;
}

export interface TranscriptRow {
  id: number;
  uid: string;
  note_id: number;
  kind: string;
  is_active: number;
  engine_id: string;
  model_id: string | null;
  backend: string | null;
  language: string | null;
  status: string;
  progress: number;
  duration_ms: number | null;
  rtf: number | null;
  segment_count: number;
  created_at: number;
  updated_at: number;
}

export interface SegmentRow {
  id: number;
  transcript_id: number;
  seq: number;
  start_ms: number;
  end_ms: number;
  text: string;
  text_raw: string | null;
  edited_at: number | null;
  confidence: number | null;
  no_speech_prob: number | null;
  words_json: string | null;
  chunk_idx: number | null;
  flags: number;
}

/**
 * `transcript_segments.words_json` → 词级时间戳数组。**唯一的一份读法**（T-164 ④）。
 *
 * ## 为什么它必须在这里，而不是各处一份
 *
 * 这一列此前有**两个读取方，行为相反**：
 * `http/rest/notes.ts` 真解析（所以 whisper 的逐字高亮在第一次转写后是好的），
 * 而 `jobs/runners/transcribe.ts` 的两处合并映射**直接写死 `words: null`** ——
 * 于是走一遍「重新转写」或任何 F3 离线重跑，`replaceSegments` 整表覆盖，
 * **全稿的词级时间戳被抹成 NULL**。用户看到的是：逐字高亮突然退化成整句高亮，
 * 而 `WordLevelBadge` 还会告诉他"这个引擎只有句级"—— 他会以为是引擎不行。
 *
 * 触发的是两个**常规**动作，不是边角情形。而且它不可逆：源里的 words 已经没了。
 *
 * ## 解析不出来一律 `null`
 *
 * 与 `body_json` 同一条约定：**绝不把坏数据当有效结果发出去**。
 * 词级高亮是渐进增强，退回整句是安全的；把半截数组交给 `findActiveWord` 不是。
 */
export function parseWordsJson(raw: string | null): WordTimestamp[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as WordTimestamp[]) : null;
  } catch {
    return null;
  }
}

export interface SettingRow {
  key: string;
  value_json: string;
  updated_at: number;
}

/** `PATCH /api/settings` 的单条写入项；`value_json` 已由调用方 JSON.stringify 过。 */
export interface SettingInput {
  readonly key: string;
  readonly valueJson: string;
}

export interface TagRow {
  id: number;
  uid: string;
  name: string;
  name_norm: string;
  color: string | null;
  parent_id: number | null;
  usage_count: number;
  created_at: number;
}

export interface FolderRow {
  id: number;
  uid: string;
  parent_id: number | null;
  name: string;
  sort_order: number;
  color: string | null;
  icon: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/**
 * 标签判重键（D-02 §1.3 `tags.name_norm` 注释：NFKC + casefold + trim）。
 *
 * JS 没有真正的 Unicode casefold，`toLowerCase()` 是最接近的可用近似；
 * 关键是**写入与查询必须用同一个函数**，所以收口在这里，不许各处各写一遍。
 */
export function normalizeTagName(name: string): string {
  return name.normalize('NFKC').toLowerCase().trim();
}

/** 落库用的段落（与 `packages/pipeline` 的 `TranscriptSegment` 对齐）。 */
export interface SegmentInput {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  noSpeechProb: number | null;
  words: unknown[] | null;
  chunkIdx: number;
  flags: number;
  /**
   * 编辑时间戳。**合并写回时必须带上**，否则"这段是用户改过的"这个事实会丢。
   *
   * 丢了的后果很隐蔽：第一次重跑编辑还在（合并逻辑保住了文本），
   * 但写回时 `edited_at` 变 null，于是**第二次重跑就把它当成没人编辑过而覆盖掉**。
   * 实测过：改 → 重跑 → 还在；再重跑 → 没了。
   * 只测一次重跑会以为已经修好，这正是最难发现的那类数据丢失。
   */
  editedAt?: number | null;
}

/**
 * 文件夹的**传递闭包**：`anc` = 祖先（含自身），`node` = 它管辖的每一个文件夹。
 *
 * ★ 这段 SQL 是「一个文件夹包含哪些笔记」的**唯一定义**。
 * 侧栏计数（`folderNoteCounts`）与 `?folder=` 筛选（`listNotes`）都从它来 ——
 * 两处各写一份就必然分叉，而分叉的表现是**侧栏写 2、点进去 3，且永远对不上**。
 * 那种缺陷没有任何一处会报错：两个数字各自都"算对了"，
 * 只有用户会觉得这软件有点怪。所以定义只准有一份。
 *
 * `UNION`（不是 `UNION ALL`）自带去重：万一库里已有脏环，递归也会停下来而不是打死进程
 * （`folderSubtreeIds` 的注释里记着同一条理由）。
 * 已软删的文件夹不进闭包 —— 它在树上已经不存在，不该再"管辖"任何笔记。
 */
const FOLDER_CLOSURE_CTE = `WITH RECURSIVE folder_closure(anc, node) AS (
           SELECT id, id FROM folders WHERE deleted_at IS NULL
           UNION
           SELECT c.anc, f.id FROM folders f
             JOIN folder_closure c ON f.parent_id = c.node
            WHERE f.deleted_at IS NULL
         )`;

/**
 * 笔记列表的**排序** —— 分页的前提。
 *
 * `created_at` 是毫秒，同一毫秒建两条笔记是可能的（批量导入就会）。只按它排序时，
 * 相同键的相对顺序由 SQLite 自己定，两次查询可以不一样 ——
 * 于是 `LIMIT/OFFSET` 翻页会**重复一条、漏掉另一条**，而两页各自看起来都正常。
 * 补一个唯一的次级键（`id`）把全序钉死，翻页才成立。
 */
const NOTES_ORDER = 'ORDER BY n.created_at DESC, n.id DESC';

/**
 * 列表与计数**共用的一份筛选定义**。
 *
 * 两处各写一份必然分叉，而分叉的表现是"总数说 12、翻到底只有 11 条"——
 * 与 `FOLDER_CLOSURE_CTE` 的注释同一条判据：一个含义只准有一个实现。
 */
function notesFilter(opts: { starredOnly?: boolean; folderId?: number }): {
  cte: string;
  where: string;
  params: Record<string, number>;
} {
  const conds = ['n.deleted_at IS NULL'];
  if (opts.starredOnly) conds.push('n.starred = 1');
  if (opts.folderId !== undefined) {
    conds.push('n.folder_id IN (SELECT node FROM folder_closure WHERE anc = :folderId)');
  }
  return {
    // 只有真的要按文件夹筛时才挂 CTE —— 其余查询不该为一个用不上的递归付钱
    cte: opts.folderId === undefined ? '' : `${FOLDER_CLOSURE_CTE}\n`,
    where: conds.join(' AND '),
    params: opts.folderId === undefined ? {} : { folderId: opts.folderId },
  };
}

export class Repos {
  constructor(private readonly db: DatabaseHandle) {}

  // -------------------------------------------------------------------------
  // folders / notes
  // -------------------------------------------------------------------------

  /** 保证有一个默认文件夹（首次启动时建）。 */
  ensureDefaultFolder(now = Date.now()): number {
    const existing = this.db
      .prepare<{ id: number }>(`SELECT id FROM folders ORDER BY id LIMIT 1`)
      .get();
    if (existing) return existing.id;
    const r = this.db
      .prepare(
        `INSERT INTO folders(uid, parent_id, name, sort_order, created_at, updated_at)
         VALUES (:uid, NULL, '全部笔记', 1.0, :now, :now)`,
      )
      .run({ uid: ulid(now), now });
    return r.lastInsertRowid;
  }

  createNote(p: {
    title: string;
    kind?: string;
    folderId?: number | null;
    language?: string | null;
    now?: number;
  }): NoteRow {
    const now = p.now ?? Date.now();
    const r = this.db
      .prepare(
        `INSERT INTO notes(uid, folder_id, kind, title, status, language, created_at, updated_at)
         VALUES (:uid, :folder, :kind, :title, 'processing', :lang, :now, :now)`,
      )
      .run({
        uid: ulid(now),
        folder: p.folderId ?? this.ensureDefaultFolder(now),
        kind: p.kind ?? 'media',
        title: p.title,
        lang: p.language ?? null,
        now,
      });
    return this.noteById(r.lastInsertRowid) as NoteRow;
  }

  /*
   * ══ 软删除的读取契约（T-e2e-notes）══════════════════════════════════════════════
   *
   * **`uid` 是对外标识，`id` 是内部 rowid —— 两者的删除语义刻意不同：**
   *
   *   · `*ByUid()`  → **只看未删的**。uid 是 HTTP 上唯一能被外界说出来的名字，
   *                    所以凡是从 uid 进来的请求，"已删"就必须等于"不存在"。
   *   · `*ById()`   → **包含已删的**。id 只有已经握着引用的内部代码才拿得到
   *                    （job payload、刚 INSERT 的 rowid、闭包查询的结果），
   *                    它们要的是"那一行还在不在库里"，不是"用户还看不看得见它"。
   *
   * 为什么必须写下来：这两个函数以前**都不过滤**，于是同一份 API 对
   * 「这条笔记还存不存在」给出了两个答案 —— 列表和搜索当它不存在
   * （`listNotes` 的 `n.deleted_at IS NULL`、`search.ts` 的同名条件），
   * 而任何 `/api/notes/:uid` 路径照常 200 + 全文返回。
   *
   * `[CI 实测 run 31247533926]` 三平台复现：删掉之后 `GET /api/notes/:uid` 仍回
   * **200 + 完整正文**，旧链接 / 书签 / `?t=` 深链照样打得开。
   * 而且**不止 GET** —— `noteByUid` 有 10 个调用点，全是 API 入口：
   * 改标题、改正文、锚点、重新转写、导图、导出、打星标、改标签、移动文件夹。
   * 也就是说一条"已删除"的笔记，此前**还能被继续编辑和重新转写**。
   *
   * Manager 2026-08-08 裁决 **404，不是 410**：软删在语义上是可逆的，
   * 410 Gone 隐含"永久移除"，会让"可恢复"在协议层说不通；
   * 而"不存在"在这个产品里已经有一个既定表达（列表与搜索），
   * **同一个事实不该有两种表达**。将来真做回收站/恢复，
   * 那条路径应当**显式**带一个 include-deleted 参数，
   * 而不是靠"裸 GET 也能读到"这个副作用 —— 今天这个行为不是回收站的地基，它只是一个漏。
   *
   * ⚠️ 改这两行时请一并看 `repos.softDelete.test.ts`：那里把
   * 「uid 读不到、id 读得到」两侧都钉死了。只钉一侧的话，
   * 哪天有人"顺手统一"成两边都过滤，job 中心里那些笔记已被删的任务就会集体失去标题，
   * 而**没有任何测试会红**。
   */

  /**
   * 按内部 rowid 取笔记。**不含已软删的行**（与 `noteByUid` 同口径）。
   *
   * 要连已删的一起读，用 `noteByIdIncludingDeleted()` —— **那个意图必须在函数名里说出来**。
   */
  noteById(id: number): NoteRow | undefined {
    return this.db
      .prepare<NoteRow>(`SELECT * FROM notes WHERE id = :id AND deleted_at IS NULL`)
      .get({ id });
  }

  /**
   * 按内部 rowid 取笔记，**连已软删的一起返回**。
   *
   * ## 为什么这个名字这么长
   *
   * 这里原本只有一个 `noteById()`，它"碰巧"能读到已删行，而**理由写在注释里**。
   * 本仓刚被同一个形状咬过：`folderById` 的注释声称「由调用方决定"已删"算不算 404」，
   * 而**五个调用方没有一个真去检查** —— 一条描述了从不存在的分工的注释。
   *
   * > **注释不执行任何东西。** 名字执行。
   *
   * 所以"我要连已删的一起读"从注释挪进了函数名：写下这个名字的人必须先想一遍
   * 自己为什么需要它，而读到它的人一眼就知道这里可能拿到一条用户已经删掉的笔记。
   *
   * ## 唯一的合法消费者，及其理由
   *
   * **`main.ts` 把 job 列表里的 `note_id` 翻成标题。** 理由不是"历史如此"，是：
   * **job 的生命期比笔记长** —— 用户可以在一条转写/导图 job 还排着队时删掉那条笔记，
   * 而那条 job 仍然存在于任务中心。此时标题**不该因此变成空白**：
   * 一条没有标题的失败任务，用户根本认不出它是哪来的。
   *
   * ⚠️ 别"顺手统一"把这里也改成过滤 —— 那会**静默抽掉任务中心的标题**，
   * 而不会有任何东西报错。`repos.softDelete.test.ts` 里有一条用例专门钉这个。
   */
  noteByIdIncludingDeleted(id: number): NoteRow | undefined {
    return this.db.prepare<NoteRow>(`SELECT * FROM notes WHERE id = :id`).get({ id });
  }

  /**
   * 按对外 uid 取笔记。**已软删的一律当作不存在**（返回 `undefined` → 调用方回 404）。
   *
   * 这一个条件同时关掉 10 个 API 入口的同一个漏，所以修在仓储层，
   * 而不是在每个处理器里补一句 `if (note.deleted_at)`——那种修法漏一个就等于没修，
   * 而且下一个新增的路由不会知道有这回事。
   */
  noteByUid(uid: string): NoteRow | undefined {
    return this.db
      .prepare<NoteRow>(`SELECT * FROM notes WHERE uid = :uid AND deleted_at IS NULL`)
      .get({ uid });
  }

  /**
   * 列出笔记。
   *
   * `starredOnly` / `folderId` **必须在 SQL 里筛，不能让调用方拿到一页再过滤**（T-138 ③/④）。
   * 此前 `/notes?starred=1` 是前端对 `limit=50` 的那一页做 `filter(n => n.starred)` ——
   * 笔记超过 50 条之后，第 51 条之外的星标笔记**不会出现，而且不会有任何提示**：
   * 页面显示的内容是对的，只是不全，用户无从知道自己少看了什么。
   * "显示得不全且不说" 与 "显示错的" 在用户那里是同一件事。
   *
   * 放在 WHERE 里之后，`limit` 限的是**筛完之后**的条数，语义才对得上。
   *
   * `folderId` 按裁决**含子孙**（文件夹是树，用户点父级期待的是"这个主题下的全部"；
   * 而"父级空、子级有货"是更难理解的失败）。子孙用 `FOLDER_CLOSURE_CTE` 在 SQL 里递归，
   * **不在 Node 里拉全表再过滤** —— 那会让 `limit` 又一次形同虚设。
   */
  listNotes(
    limit = 50,
    opts: { starredOnly?: boolean; folderId?: number; offset?: number } = {},
  ): NoteRow[] {
    const { cte, where, params } = notesFilter(opts);
    return this.db
      .prepare<NoteRow>(
        `${cte}SELECT n.* FROM notes n
         WHERE ${where}
         ${NOTES_ORDER} LIMIT :limit OFFSET :offset`,
      )
      .all({ ...params, limit, offset: opts.offset ?? 0 });
  }

  /**
   * 同一批筛选条件下**一共有多少条**。
   *
   * ★ 存在的理由不是"顺便给个数字"，是 T-157 ③：`GET /api/notes` 只有 `limit`（默认 50），
   * 于是第 51 条起在界面上**永远看不到，而且没有任何提示**。
   * "显示得不全且不说" 与 "显示错的" 在用户那里是同一件事
   * —— `listNotes` 上面那段注释为 `starred` 写过一模一样的话，只是当时没有人把它套到总量上。
   *
   * ⚠️ 它与 `listNotes` **必须走同一份 WHERE**（`notesFilter`），否则会出现
   * "说还有 3 条、翻过去是空的"这种两个数字各自都算对了、只有用户觉得这软件有点怪的缺陷
   * —— 与 `FOLDER_CLOSURE_CTE` 那条注释是同一条判据。
   */
  countNotes(opts: { starredOnly?: boolean; folderId?: number } = {}): number {
    const { cte, where, params } = notesFilter(opts);
    const row = this.db
      .prepare<{ n: number }>(`${cte}SELECT COUNT(*) AS n FROM notes n WHERE ${where}`)
      .get(params);
    return row?.n ?? 0;
  }

  updateNote(
    id: number,
    p: { status?: string; durationMs?: number | null; title?: string; language?: string | null },
  ): void {
    const now = Date.now();
    const sets: string[] = ['updated_at = :now'];
    const params: Record<string, string | number | null> = { id, now };
    if (p.status !== undefined) {
      sets.push('status = :status');
      params['status'] = p.status;
    }
    if (p.durationMs !== undefined) {
      sets.push('duration_ms = :dur');
      params['dur'] = p.durationMs;
    }
    if (p.title !== undefined) {
      sets.push('title = :title');
      params['title'] = p.title;
    }
    if (p.language !== undefined) {
      sets.push('language = :lang');
      params['lang'] = p.language;
    }
    this.db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = :id`).run(params);
  }

  softDeleteNote(id: number): void {
    this.db
      .prepare(`UPDATE notes SET deleted_at = :now, updated_at = :now WHERE id = :id`)
      .run({ id, now: Date.now() });
  }

  /**
   * 撤销软删除 —— **「软删除」这个词的另一半**。
   *
   * ## 为什么这个函数必须存在
   *
   * 在它之前，全 daemon **零 restore 路径**（`[实测 2026-08-08]` 全仓 grep
   * `deleted_at = NULL` / `restore`，唯一命中是组件回滚，与笔记无关）。
   * 于是：数据**永远留在盘上**，用户**永远拿不回来**，而且**看不出它还在** ——
   * 三件事同时成立，是最坏的一种组合：
   *
   * - 对用户：**「删除」实际不可逆**，而 UI 用的是一个听起来可逆的词；
   * - 对隐私：他以为删掉了，其实那行还在库里。
   *
   * Manager 2026-08-08 裁定：**软删除之所以叫"软"，就是因为它可逆** ——
   * 要么给出恢复路径，要么如实改名叫永久删除。**不许维持"看起来可逆、实际不可逆"。**
   *
   * 选恢复而不是改名的依据：**数据事实上还在盘上**，
   * 把它叫作"永久删除"会是一句**新的假话**（而且是隐私方向的假话）。
   *
   * `uid` 而不是 `id`：调用方此刻手里只有 uid，而 `noteByUid()` **按设计查不到已删的**
   * （那条过滤是对的，不改）—— 所以这里直接按 uid 更新，不绕回去查一次。
   * 返回是否真的改动了一行：调用方据此区分「恢复成功」与「本来就没删过 / 不存在」。
   */
  restoreNote(uid: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE notes SET deleted_at = NULL, updated_at = :now
           WHERE uid = :uid AND deleted_at IS NOT NULL`,
      )
      .run({ uid, now: Date.now() });
    return r.changes > 0;
  }

  // -------------------------------------------------------------------------
  // media
  // -------------------------------------------------------------------------

  createSource(p: {
    noteId: number;
    kind: string;
    adapterId?: string | null;
    originalUrl?: string | null;
    title?: string | null;
    now?: number;
  }): number {
    const now = p.now ?? Date.now();
    const r = this.db
      .prepare(
        `INSERT INTO media_sources(uid, note_id, kind, adapter_id, input_url, title, created_at, updated_at)
         VALUES (:uid, :note, :kind, :adapter, :url, :title, :now, :now)`,
      )
      .run({
        uid: ulid(now),
        note: p.noteId,
        kind: p.kind,
        adapter: p.adapterId ?? null,
        url: p.originalUrl ?? null,
        title: p.title ?? null,
        now,
      });
    return r.lastInsertRowid;
  }

  /** 取该笔记的主媒体源（重跑/续跑要用它的原始输入）。 */
  primarySourceOf(
    noteId: number,
  ): { id: number; kind: string; input_url: string | null } | undefined {
    return this.db
      .prepare<{ id: number; kind: string; input_url: string | null }>(
        `SELECT id, kind, input_url FROM media_sources WHERE note_id = :n ORDER BY id LIMIT 1`,
      )
      .get({ n: noteId });
  }

  createAsset(p: {
    noteId: number;
    sourceId?: number | null;
    role: string;
    relPath: string;
    displayName?: string | null;
    mime?: string | null;
    bytes?: number | null;
    durationMs?: number | null;
    sampleRate?: number | null;
    channels?: number | null;
    /**
     * **"我刚把盘上这个路径上的文件换成了另一份"** —— 覆盖发生的时刻，没覆盖就别传。
     *
     * 传了它，下面那条幂等分支才会把本次实测的数字写回旧行；不传就和以前逐字一样，
     * 旧行原样返回、一个字节不动（`archiveIntoMedia` 提前返回的那几条路
     * —— 录音、本地导入、上传 —— 走的就是这一支）。
     */
    replacedAt?: number | null;
    now?: number;
  }): AssetRow {
    const now = p.now ?? Date.now();
    /*
     * **幂等**：同一个 rel_path 就是同一份资产，已存在就直接返回它。
     *
     * 不做这一步会让「重新转写」整条通道死掉：重跑会把媒体归一化到**完全相同的路径**，
     * 于是第二次插入撞 `UNIQUE constraint failed: media_assets.rel_path`，
     * 整个 job 以 RUNNER_ERROR 失败 —— 而失败发生在转写**跑完之后**，
     * 用户看到的是"转了半天最后报错，稿子还是旧的"。
     * 实测：REST 重跑 100% 失败在这里（`error_detail` 就是这条约束）。
     */
    const existing = this.db
      .prepare<AssetRow>(`SELECT * FROM media_assets WHERE rel_path = :rel`)
      .get({ rel: p.relPath });
    if (existing) {
      /*
       * ★ #96②：**行的身份不变，描述那个文件的数字必须跟着文件走。**
       *
       * 旧写法是无条件 `return existing` —— 它对"重跑不该长出第二条资产"是对的，
       * 但它顺手把**这一次真的量到的数**（`stat()` 出来的 `bytes`、ffprobe 出来的
       * `duration_ms`）全丢了。网络导入重转会重新下载一次源、覆盖掉同名文件，
       * 于是行里留着**上一份文件**的大小与时长：
       *   · `GET /api/notes/:uid` 的 `assets[].bytes` / `.durationMs` 从此是错的；
       *   · 而 `/media/asset/:uid` 用 `stat()` 现取真实大小，**播放完全不受影响** ——
       *     正因为播放不受影响，这个错数才会一直没人发现。
       *   · 同一次重转里 `notes.duration_ms` 与 `transcripts.duration_ms` **是刷新的**，
       *     所以错的那一份还会和自己家的另外两份对不上。
       *
       * 判据是**盘上那份文件有没有真的被换掉**（调用方传 `replacedAt`），
       * 不是"这次调用有没有带新数字"：文件没动的时候（`archiveIntoMedia` 提前返回，
       * 录音/本地导入/上传都走那一支）重新量出来的数即使不同也不该覆盖 ——
       * 那是**同一份文件的两种量法**（录音记的是墙上时钟，重转量的是 ffprobe），
       * 悄悄换掉一个不是修复，是另一种漂移。
       */
      if (p.replacedAt == null) return existing;

      /* 只改「描述这个文件」的那几列，且**只改调用方这次给了的**。
       * 没给（`undefined`）= 这次没量，不是量到 0 —— 不许拿"没量"去覆盖一个量过的数。 */
      const sets = ['replaced_at = :replacedAt'];
      const params: Record<string, SqlValue> = { id: existing.id, replacedAt: p.replacedAt };
      if (p.bytes !== undefined) {
        sets.push('bytes = :bytes');
        params['bytes'] = p.bytes;
      }
      if (p.durationMs !== undefined) {
        sets.push('duration_ms = :dur');
        params['dur'] = p.durationMs;
      }
      if (p.sampleRate !== undefined) {
        sets.push('sample_rate = :sr');
        params['sr'] = p.sampleRate;
      }
      if (p.channels !== undefined) {
        sets.push('channels = :ch');
        params['ch'] = p.channels;
      }
      this.db.prepare(`UPDATE media_assets SET ${sets.join(', ')} WHERE id = :id`).run(params);
      return this.assetById(existing.id) as AssetRow;
    }

    const r = this.db
      .prepare(
        `INSERT INTO media_assets(uid, note_id, source_id, role, rel_path, display_name, mime,
                                  bytes, duration_ms, sample_rate, channels, state, created_at)
         VALUES (:uid, :note, :src, :role, :rel, :name, :mime, :bytes, :dur, :sr, :ch, 'ready', :now)`,
      )
      .run({
        uid: ulid(now),
        note: p.noteId,
        src: p.sourceId ?? null,
        role: p.role,
        rel: p.relPath,
        name: p.displayName ?? null,
        mime: p.mime ?? null,
        bytes: p.bytes ?? null,
        dur: p.durationMs ?? null,
        sr: p.sampleRate ?? null,
        ch: p.channels ?? null,
        now,
      });
    return this.assetById(r.lastInsertRowid) as AssetRow;
  }

  assetById(id: number): AssetRow | undefined {
    return this.db.prepare<AssetRow>(`SELECT * FROM media_assets WHERE id = :id`).get({ id });
  }

  /** `/media/asset/<uid>` 的寻址入口（D-01 §3.1：绝不接受文件系统路径）。 */
  assetByUid(uid: string): AssetRow | undefined {
    return this.db.prepare<AssetRow>(`SELECT * FROM media_assets WHERE uid = :uid`).get({ uid });
  }

  assetsOfNote(noteId: number): AssetRow[] {
    return this.db
      .prepare<AssetRow>(`SELECT * FROM media_assets WHERE note_id = :n ORDER BY id`)
      .all({ n: noteId });
  }

  // -------------------------------------------------------------------------
  // transcripts
  // -------------------------------------------------------------------------

  createTranscript(p: {
    noteId: number;
    assetId?: number | null;
    engineId: string;
    modelId?: string | null;
    backend?: string | null;
    language?: string | null;
    kind?: 'streaming' | 'final';
    now?: number;
  }): TranscriptRow {
    const now = p.now ?? Date.now();
    // 新稿激活时，同 note 的旧稿一律置为非激活（D-02 §1.5 多版本）
    this.db.prepare(`UPDATE transcripts SET is_active = 0 WHERE note_id = :n`).run({ n: p.noteId });
    const r = this.db
      .prepare(
        `INSERT INTO transcripts(uid, note_id, asset_id, kind, is_active, engine_id, model_id,
                                 backend, language, status, created_at, updated_at)
         VALUES (:uid, :note, :asset, :kind, 1, :engine, :model, :backend, :lang, 'running', :now, :now)`,
      )
      .run({
        uid: ulid(now),
        note: p.noteId,
        asset: p.assetId ?? null,
        kind: p.kind ?? 'final',
        engine: p.engineId,
        model: p.modelId ?? null,
        backend: p.backend ?? null,
        lang: p.language ?? null,
        now,
      });
    return this.transcriptById(r.lastInsertRowid) as TranscriptRow;
  }

  transcriptById(id: number): TranscriptRow | undefined {
    return this.db.prepare<TranscriptRow>(`SELECT * FROM transcripts WHERE id = :id`).get({ id });
  }

  /**
   * 找一份**可续跑**的转写稿：同 note、同引擎、同模型，且还没跑完。
   *
   * 没有这个查询，runner 每次都会新建一份 transcript，再去空表里查
   * `completedChunks` —— 于是"续跑"永远从第 0 块重来，**而且旧稿会被置
   * `is_active=0`，用户已经看到的内容还会消失**。D-01 §4.5 的分块续跑设计
   * 是对的，但实现走了另一条路。
   */
  resumableTranscript(
    noteId: number,
    engineId: string,
    modelId: string | null,
  ): TranscriptRow | undefined {
    return this.db
      .prepare<TranscriptRow>(
        `SELECT * FROM transcripts
          WHERE note_id = :n AND engine_id = :e
            AND (model_id IS :m OR model_id = :m)
            AND status IN ('running','partial','pending')
          ORDER BY id DESC LIMIT 1`,
      )
      .get({ n: noteId, e: engineId, m: modelId });
  }

  activeTranscriptOfNote(noteId: number): TranscriptRow | undefined {
    return this.db
      .prepare<TranscriptRow>(
        `SELECT * FROM transcripts WHERE note_id = :n AND is_active = 1 ORDER BY id DESC LIMIT 1`,
      )
      .get({ n: noteId });
  }

  updateTranscript(
    id: number,
    p: {
      status?: string;
      progress?: number;
      durationMs?: number | null;
      rtf?: number | null;
      language?: string | null;
    },
  ): void {
    const now = Date.now();
    const sets = ['updated_at = :now'];
    const params: Record<string, string | number | null> = { id, now };
    if (p.status !== undefined) {
      sets.push('status = :status');
      params['status'] = p.status;
    }
    if (p.progress !== undefined) {
      sets.push('progress = :prog');
      params['prog'] = p.progress;
    }
    if (p.durationMs !== undefined) {
      sets.push('duration_ms = :dur');
      params['dur'] = p.durationMs;
    }
    if (p.rtf !== undefined) {
      sets.push('rtf = :rtf');
      params['rtf'] = p.rtf;
    }
    if (p.language !== undefined) {
      sets.push('language = :lang');
      params['lang'] = p.language;
    }
    this.db.prepare(`UPDATE transcripts SET ${sets.join(', ')} WHERE id = :id`).run(params);
  }

  /**
   * 批量落段落。**整批一个事务** —— pipeline 把 `onChunkComplete` 的 resolve
   * 当作"这一块已安全持久化"，所以这里必须真的落盘才返回（D-01 §4.5）。
   *
   * `seq` 由当前已有段数续接，保证同一 transcript 内单调。
   */
  insertSegments(transcriptId: number, segments: readonly SegmentInput[]): number {
    if (segments.length === 0) return 0;
    return this.db.transaction(() => {
      const start =
        this.db
          .prepare<{ n: number }>(
            `SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM transcript_segments WHERE transcript_id = :t`,
          )
          .get({ t: transcriptId })?.n ?? 0;

      const stmt = this.db.prepare(
        `INSERT INTO transcript_segments(transcript_id, seq, start_ms, end_ms, text, confidence,
                                         no_speech_prob, words_json, chunk_idx, flags, edited_at)
         VALUES (:t, :seq, :s, :e, :text, :conf, :nsp, :words, :chunk, :flags, :edited)`,
      );
      let seq = start;
      for (const s of segments) {
        stmt.run({
          t: transcriptId,
          seq: seq++,
          s: s.startMs,
          e: s.endMs,
          text: s.text,
          conf: s.confidence,
          nsp: s.noSpeechProb,
          words: s.words ? JSON.stringify(s.words) : null,
          chunk: s.chunkIdx,
          flags: s.flags,
          edited: s.editedAt ?? null,
        });
      }
      this.db
        .prepare(
          `UPDATE transcripts SET segment_count = (
             SELECT COUNT(*) FROM transcript_segments WHERE transcript_id = :t
           ), updated_at = :now WHERE id = :t`,
        )
        .run({ t: transcriptId, now: Date.now() });
      return seq - start;
    });
  }

  /**
   * 用一批新段落**整体替换**某份转写稿（两阶段合并的落库路径）。
   *
   * 整体替换而不是 diff：合并结果已经是"最终应该长什么样"，
   * 再算一次 diff 只会多一处可能出错的地方。一个事务内完成。
   */
  replaceSegments(transcriptId: number, segments: readonly SegmentInput[]): number {
    return this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM transcript_segments WHERE transcript_id = :t`)
        .run({ t: transcriptId });
      return this.insertSegments(transcriptId, segments);
    });
  }

  segmentsOf(transcriptId: number): SegmentRow[] {
    return this.db
      .prepare<SegmentRow>(
        `SELECT * FROM transcript_segments WHERE transcript_id = :t ORDER BY seq`,
      )
      .all({ t: transcriptId });
  }

  /** 续跑用：已完成的 chunk 索引集合（D-01 §4.5 —— DB 里的段落才是真相）。 */
  completedChunks(transcriptId: number): Set<number> {
    const rows = this.db
      .prepare<{ chunk_idx: number | null }>(
        `SELECT DISTINCT chunk_idx FROM transcript_segments WHERE transcript_id = :t`,
      )
      .all({ t: transcriptId });
    const out = new Set<number>();
    for (const r of rows) if (r.chunk_idx !== null) out.add(r.chunk_idx);
    return out;
  }

  // -------------------------------------------------------------------------
  // settings（D-02 §1.2：点分命名空间的 key + value_json TEXT）
  // -------------------------------------------------------------------------

  listSettings(): SettingRow[] {
    return this.db
      .prepare<SettingRow>(`SELECT key, value_json, updated_at FROM settings ORDER BY key`)
      .all();
  }

  /**
   * 批量 upsert 设置项。**整批一个事务** —— 设置项之间常常互相依赖
   * （如 `runtime.selectedBackend` 与 `runtime.selectedGpuIndex`），
   * 只写进去一半比一条都没写更糟。
   */
  upsertSettings(entries: readonly SettingInput[], now = Date.now()): void {
    if (entries.length === 0) return;
    this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT INTO settings(key, value_json, updated_at) VALUES (:k, :v, :now)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = excluded.updated_at`,
      );
      for (const e of entries) stmt.run({ k: e.key, v: e.valueJson, now });
    });
  }

  // -------------------------------------------------------------------------
  // tags / note_tags
  //
  // ⚠️ 0001_init.sql **已经有** `tags_usage_ai` / `tags_usage_ad` 两个触发器在
  //    increment/decrement `usage_count`。但本层每次变更后仍显式 recompute：
  //    触发器是"增量"的，一旦历史数据漂移就永远错下去；COUNT(*) 重算是幂等的，
  //    与触发器叠加也不会算错（触发器先跑，重算把结果覆盖成真值）。
  // -------------------------------------------------------------------------

  listTags(): TagRow[] {
    return this.db.prepare<TagRow>(`SELECT * FROM tags ORDER BY usage_count DESC, name`).all();
  }

  tagById(id: number): TagRow | undefined {
    return this.db.prepare<TagRow>(`SELECT * FROM tags WHERE id = :id`).get({ id });
  }

  tagByUid(uid: string): TagRow | undefined {
    return this.db.prepare<TagRow>(`SELECT * FROM tags WHERE uid = :uid`).get({ uid });
  }

  /**
   * 批量取多条笔记的标签。
   *
   * 列表页逐条查会变成 N+1；一次 IN 查询拿回来再分组。
   * 返回的 Map **对每个传入的 noteId 都有条目**（没有标签就是空数组）——
   * 调用方拿到的永远是数组，不会是 undefined。
   */
  tagsOfNotes(noteIds: readonly number[]): Map<number, TagRow[]> {
    const out = new Map<number, TagRow[]>();
    for (const id of noteIds) out.set(id, []);
    if (noteIds.length === 0) return out;

    const placeholders = noteIds.map((_, i) => `:n${String(i)}`).join(',');
    const params: Record<string, number> = {};
    noteIds.forEach((id, i) => (params[`n${String(i)}`] = id));

    const rows = this.db
      .prepare<TagRow & { note_id: number }>(
        `SELECT nt.note_id, t.* FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id IN (${placeholders})
          ORDER BY t.name`,
      )
      .all(params);
    for (const r of rows) out.get(r.note_id)?.push(r);
    return out;
  }

  /** 取笔记所属文件夹的 uid（对外只暴露 uid，不暴露整数主键）。 */
  folderUidOf(folderId: number | null): string | null {
    if (folderId === null) return null;
    return (
      this.db
        .prepare<{ uid: string }>(`SELECT uid FROM folders WHERE id = :id`)
        .get({ id: folderId })?.uid ?? null
    );
  }

  tagsOfNote(noteId: number): TagRow[] {
    return this.db
      .prepare<TagRow>(
        `SELECT t.* FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
         WHERE nt.note_id = :n ORDER BY t.usage_count DESC, t.name`,
      )
      .all({ n: noteId });
  }

  /**
   * 按 `name_norm` 判重的"取或建"。`idx_tags_norm` 是 UNIQUE 索引，
   * 直接 INSERT 撞车会抛；先查后插并整体包事务，避免把约束异常漏给 HTTP 层。
   */
  findOrCreateTag(p: { name: string; color?: string | null; now?: number }): {
    tag: TagRow;
    created: boolean;
  } {
    const now = p.now ?? Date.now();
    const norm = normalizeTagName(p.name);
    return this.db.transaction(() => {
      const existing = this.db
        .prepare<TagRow>(`SELECT * FROM tags WHERE name_norm = :n`)
        .get({ n: norm });
      if (existing) return { tag: existing, created: false };
      const r = this.db
        .prepare(
          `INSERT INTO tags(uid, name, name_norm, color, usage_count, created_at)
           VALUES (:uid, :name, :norm, :color, 0, :now)`,
        )
        .run({ uid: ulid(now), name: p.name.trim(), norm, color: p.color ?? null, now });
      return { tag: this.tagById(r.lastInsertRowid) as TagRow, created: true };
    });
  }

  /** 删标签。显式先删关联再删主行 —— 不依赖 `PRAGMA foreign_keys` 是否开着。 */
  deleteTag(tagId: number): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM note_tags WHERE tag_id = :t`).run({ t: tagId });
      this.db.prepare(`DELETE FROM tags WHERE id = :t`).run({ t: tagId });
    });
  }

  recomputeTagUsage(tagId: number): void {
    this.db
      .prepare(
        `UPDATE tags SET usage_count = (SELECT COUNT(*) FROM note_tags WHERE tag_id = :t)
         WHERE id = :t`,
      )
      .run({ t: tagId });
  }

  /** 整表替换某笔记的标签集合。删+插+重算 usage 必须同一个事务，否则中途崩会留下空标签集。 */
  replaceNoteTags(noteId: number, tagIds: readonly number[], now = Date.now()): TagRow[] {
    return this.db.transaction(() => {
      const before = this.db
        .prepare<{ tag_id: number }>(`SELECT tag_id FROM note_tags WHERE note_id = :n`)
        .all({ n: noteId });
      // 旧标签也要重算 —— 被摘掉的那些 usage_count 同样变了
      const affected = new Set<number>(before.map((r) => r.tag_id));
      this.db.prepare(`DELETE FROM note_tags WHERE note_id = :n`).run({ n: noteId });
      const ins = this.db.prepare(
        `INSERT INTO note_tags(note_id, tag_id, source, created_at) VALUES (:n, :t, 'user', :now)`,
      );
      for (const t of new Set(tagIds)) {
        ins.run({ n: noteId, t, now });
        affected.add(t);
      }
      for (const t of affected) this.recomputeTagUsage(t);
      return this.tagsOfNote(noteId);
    });
  }

  detachNoteTag(noteId: number, tagId: number): boolean {
    return this.db.transaction(() => {
      const r = this.db
        .prepare(`DELETE FROM note_tags WHERE note_id = :n AND tag_id = :t`)
        .run({ n: noteId, t: tagId });
      this.recomputeTagUsage(tagId);
      return r.changes > 0;
    });
  }

  // -------------------------------------------------------------------------
  // star
  // -------------------------------------------------------------------------

  /** 置/取消星标，返回**落库后读回**的值（不回显入参，避免 UI 与库不一致）。 */
  setNoteStarred(noteId: number, starred: boolean): boolean {
    const now = Date.now();
    this.db
      .prepare(`UPDATE notes SET starred = :s, updated_at = :now WHERE id = :id`)
      .run({ s: starred ? 1 : 0, now, id: noteId });
    const row = this.db
      .prepare<{ starred: number }>(`SELECT starred FROM notes WHERE id = :id`)
      .get({ id: noteId });
    return (row?.starred ?? 0) === 1;
  }

  // -------------------------------------------------------------------------
  // folders
  // -------------------------------------------------------------------------

  listFolders(): FolderRow[] {
    return this.db
      .prepare<FolderRow>(
        `SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY sort_order, name`,
      )
      .all();
  }

  /**
   * 按内部 rowid 取文件夹。**不含已软删的行**（与 `folderByUid` 同口径）。
   *
   * ⚠️ 这里原来的注释是「不过滤 `deleted_at` —— 由调用方决定"已删"要回 404 还是照常处理」。
   * 那句话描述的是一个**不存在的分工**：`folderByUid` 的 5 个调用点**没有一个**
   * 检查过 `deleted_at`。一条把责任推给调用方、而调用方并不知情的注释，
   * 比没有注释更坏 —— 读到它的人会以为这件事已经有人管了，于是不去建。
   * **这一条正是本次把意图挪进函数名的直接理由。**
   *
   * 要连已删的一起读，用 `folderByIdIncludingDeleted()`。
   */
  folderById(id: number): FolderRow | undefined {
    return this.db
      .prepare<FolderRow>(`SELECT * FROM folders WHERE id = :id AND deleted_at IS NULL`)
      .get({ id });
  }

  /**
   * 按内部 rowid 取文件夹，**连已软删的一起返回**。
   *
   * ## 唯一的合法消费者，及其理由
   *
   * **`folderAncestorIds()` 的环检测。** 理由是：它要回答的是
   * 「**库里**这条 parent 链上有没有环」，而不是「用户看得见的树上有没有环」。
   * 被一个已删节点挡住就等于**提前停在链的中间**，于是一个真实存在的环
   * （脏数据、或删除与移动交错留下的）会被判成"没有环"——
   * 那正是这个函数存在的理由（D-02 §1.3 要求应用层做环检测）。
   * 换句话说：**这里读已删行不是宽容，是正确性。**
   *
   * ⚠️ `folderSubtreeIds()` / `softDeleteFolderTree()` 同样要看见已删行，
   * 但它们走的是自己的递归 SQL，不经过这个函数 —— 它们**就是删除路径本身**，
   * 必须能重扫一棵已删子树（`markDeleted` 带 `AND deleted_at IS NULL` 保证幂等）。
   */
  folderByIdIncludingDeleted(id: number): FolderRow | undefined {
    return this.db.prepare<FolderRow>(`SELECT * FROM folders WHERE id = :id`).get({ id });
  }

  /**
   * 按对外 uid 取文件夹。**已软删的一律当作不存在。**
   *
   * 这是本轮审计查出的**第二个**同形漏（第一个是 `noteByUid`），此前没有人撞到过。
   * 5 个调用点全是 API 入口：建子文件夹时认父、改名/改图标、删文件夹、
   * 把笔记移进某个文件夹、以及 `GET /api/notes?folder=<uid>` 的筛选。
   *
   * 最难看的一格是「把笔记移进一个已删的文件夹」：请求会成功（200），
   * 而侧栏的文件夹树来自 `listFolders()`（过滤已删）、计数来自
   * `folderNoteCounts()`（走 `FOLDER_CLOSURE_CTE`，同样过滤已删）——
   * 于是那条笔记挂在一个**界面上不存在的文件夹**下面。
   * 它仍然出现在「全部笔记」里，所以不是丢数据，但归属是错的，而且用户改不回来
   * （那个文件夹他根本点不到）。
   */
  folderByUid(uid: string): FolderRow | undefined {
    return this.db
      .prepare<FolderRow>(`SELECT * FROM folders WHERE uid = :uid AND deleted_at IS NULL`)
      .get({ uid });
  }

  /**
   * 每个文件夹的笔记数，**含子孙**（不含已删笔记）。
   *
   * ⚠️ 它与 `listNotes({folderId})` **必须走同一份定义**（`FOLDER_CLOSURE_CTE`）。
   * 这里原来是"只数直属"，而筛选按裁决是"含子孙" —— 两边各算各的，
   * 结果就是**侧栏写着 2、点进去列出 3，而且永远对不上**。
   * 那种缺陷最难查的地方在于：两个数字各自都"算对了"，
   * 没有任何一处会报错，只有用户会觉得"这软件有点怪"。
   * 所以闭包定义只有一份，两个查询都从它来。
   */
  folderNoteCounts(): Map<number, number> {
    const rows = this.db
      .prepare<{ folder_id: number; n: number }>(
        `${FOLDER_CLOSURE_CTE}
         SELECT c.anc AS folder_id, COUNT(n.id) AS n
         FROM folder_closure c
         JOIN notes n ON n.folder_id = c.node
         WHERE n.deleted_at IS NULL
         GROUP BY c.anc`,
      )
      .all();
    return new Map(rows.map((r) => [r.folder_id, r.n]));
  }

  /** 新建时排在同级末尾。`parent_id IS :p` 而不是 `=` —— 根级的 parent 是 NULL。 */
  nextFolderSortOrder(parentId: number | null): number {
    const row = this.db
      .prepare<{ n: number }>(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM folders
         WHERE parent_id IS :p AND deleted_at IS NULL`,
      )
      .get({ p: parentId });
    return row?.n ?? 1;
  }

  createFolder(p: {
    name: string;
    parentId?: number | null;
    color?: string | null;
    icon?: string | null;
    sortOrder?: number;
    now?: number;
  }): FolderRow {
    const now = p.now ?? Date.now();
    const parentId = p.parentId ?? null;
    const r = this.db
      .prepare(
        `INSERT INTO folders(uid, parent_id, name, sort_order, color, icon, created_at, updated_at)
         VALUES (:uid, :parent, :name, :sort, :color, :icon, :now, :now)`,
      )
      .run({
        uid: ulid(now),
        parent: parentId,
        name: p.name,
        sort: p.sortOrder ?? this.nextFolderSortOrder(parentId),
        color: p.color ?? null,
        icon: p.icon ?? null,
        now,
      });
    return this.folderById(r.lastInsertRowid) as FolderRow;
  }

  /** 局部更新；`undefined` = 不动该列，`null`（parentId/color/icon）= 显式清空。 */
  updateFolder(
    id: number,
    p: {
      name?: string;
      parentId?: number | null;
      color?: string | null;
      icon?: string | null;
      sortOrder?: number;
    },
  ): FolderRow | undefined {
    const now = Date.now();
    const sets: string[] = ['updated_at = :now'];
    const params: Record<string, string | number | null> = { id, now };
    if (p.name !== undefined) {
      sets.push('name = :name');
      params['name'] = p.name;
    }
    if (p.parentId !== undefined) {
      sets.push('parent_id = :parent');
      params['parent'] = p.parentId;
    }
    if (p.color !== undefined) {
      sets.push('color = :color');
      params['color'] = p.color;
    }
    if (p.icon !== undefined) {
      sets.push('icon = :icon');
      params['icon'] = p.icon;
    }
    if (p.sortOrder !== undefined) {
      sets.push('sort_order = :sort');
      params['sort'] = p.sortOrder;
    }
    this.db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = :id`).run(params);
    return this.folderById(id);
  }

  /**
   * 自底向上的祖先链（不含自身），用于**移动文件夹时的环检测**（D-02 §1.3 要求应用层做）。
   * `seen` + `maxDepth` 双保险：万一库里已有脏环，这里必须能停下来而不是死循环。
   */
  folderAncestorIds(folderId: number, maxDepth = 64): number[] {
    const out: number[] = [];
    const seen = new Set<number>([folderId]);
    let cur = this.folderByIdIncludingDeleted(folderId)?.parent_id ?? null;
    while (cur !== null && out.length < maxDepth) {
      if (seen.has(cur)) break;
      seen.add(cur);
      out.push(cur);
      cur = this.folderByIdIncludingDeleted(cur)?.parent_id ?? null;
    }
    return out;
  }

  /** 含自身的整棵子树 id。`UNION`（非 UNION ALL）自带去重，脏环也不会把 CTE 转成死循环。 */
  folderSubtreeIds(folderId: number): number[] {
    return this.db
      .prepare<{ id: number }>(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM folders WHERE id = :root
           UNION
           SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
         )
         SELECT id FROM sub`,
      )
      .all({ root: folderId })
      .map((r) => r.id);
  }

  /**
   * 软删整棵子树，并把其中的笔记移出到"无文件夹"。
   *
   * 为什么连子树一起删：`folders.parent_id` 的 `ON DELETE CASCADE` 只对**硬删**生效，
   * 软删不触发。只标记父节点会留下一批 parent 指向已删节点的孤儿——它们在树视图里
   * 既不是根也挂不上父，等于凭空消失。
   */
  softDeleteFolderTree(folderId: number, now = Date.now()): { folders: number; notes: number } {
    const ids = this.folderSubtreeIds(folderId);
    if (ids.length === 0) return { folders: 0, notes: 0 };
    return this.db.transaction(() => {
      const clearNotes = this.db.prepare(
        `UPDATE notes SET folder_id = NULL, updated_at = :now WHERE folder_id = :f`,
      );
      const markDeleted = this.db.prepare(
        `UPDATE folders SET deleted_at = :now, updated_at = :now WHERE id = :f AND deleted_at IS NULL`,
      );
      let notes = 0;
      let folders = 0;
      for (const id of ids) {
        notes += clearNotes.run({ now, f: id }).changes;
        folders += markDeleted.run({ now, f: id }).changes;
      }
      return { folders, notes };
    });
  }

  setNoteFolder(noteId: number, folderId: number | null): void {
    this.db
      .prepare(`UPDATE notes SET folder_id = :f, updated_at = :now WHERE id = :id`)
      .run({ f: folderId, now: Date.now(), id: noteId });
  }
}
