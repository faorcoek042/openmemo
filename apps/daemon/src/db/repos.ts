/**
 * 领域仓储：notes / media_sources / media_assets / transcripts / transcript_segments。
 *
 * 只做 SQL，不含业务编排。表结构见 D-02 §1.3–§1.5（迁移在 `packages/db/migrations/0001_init.sql`）。
 *
 * **双 ID 约定**（D-02 §1.1）：内部 `id INTEGER PRIMARY KEY`（FTS5 `content_rowid` 与
 * sqlite-vec 都要求整数），对外只暴露 `uid`（ULID）。仓储层负责两者之间的翻译。
 */
import type { DatabaseHandle } from '@openmemo/db';
import { ulid } from '@openmemo/shared';

export interface NoteRow {
  id: number;
  uid: string;
  folder_id: number | null;
  kind: string;
  title: string;
  body_text: string;
  summary_md: string | null;
  status: string;
  language: string | null;
  duration_ms: number | null;
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

  noteById(id: number): NoteRow | undefined {
    return this.db.prepare<NoteRow>(`SELECT * FROM notes WHERE id = :id`).get({ id });
  }

  noteByUid(uid: string): NoteRow | undefined {
    return this.db.prepare<NoteRow>(`SELECT * FROM notes WHERE uid = :uid`).get({ uid });
  }

  listNotes(limit = 50): NoteRow[] {
    return this.db
      .prepare<NoteRow>(
        `SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT :limit`,
      )
      .all({ limit });
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
    now?: number;
  }): AssetRow {
    const now = p.now ?? Date.now();
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
                                         no_speech_prob, words_json, chunk_idx, flags)
         VALUES (:t, :seq, :s, :e, :text, :conf, :nsp, :words, :chunk, :flags)`,
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

  /** 不过滤 `deleted_at` —— 由调用方决定"已删"要回 404 还是照常处理。 */
  folderById(id: number): FolderRow | undefined {
    return this.db.prepare<FolderRow>(`SELECT * FROM folders WHERE id = :id`).get({ id });
  }

  folderByUid(uid: string): FolderRow | undefined {
    return this.db.prepare<FolderRow>(`SELECT * FROM folders WHERE uid = :uid`).get({ uid });
  }

  /** 每个文件夹的**直属**笔记数（不含子文件夹，不含已删笔记）。 */
  folderNoteCounts(): Map<number, number> {
    const rows = this.db
      .prepare<{ folder_id: number; n: number }>(
        `SELECT folder_id, COUNT(*) AS n FROM notes
         WHERE deleted_at IS NULL AND folder_id IS NOT NULL GROUP BY folder_id`,
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
    let cur = this.folderById(folderId)?.parent_id ?? null;
    while (cur !== null && out.length < maxDepth) {
      if (seen.has(cur)) break;
      seen.add(cur);
      out.push(cur);
      cur = this.folderById(cur)?.parent_id ?? null;
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
