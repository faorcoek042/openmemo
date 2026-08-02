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
}
