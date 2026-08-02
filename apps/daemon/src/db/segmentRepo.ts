/**
 * 转写段落编辑（M-4）与笔记锚点（M-7）。
 *
 * ## 为什么这个文件是 P0
 *
 * `gpu-runtime` 的两阶段合并（用户改「动能」→「动荡」→ 重跑后保留）**实测跑通过**，
 * 它的判定依据是 D-06 §15.2 冻结契约里的 `transcript_segments.edited_at`。
 *
 * 但 `edited_at` **全仓只被读、从没有任何 UPDATE** —— 它永远是 NULL，
 * 于是那条被真实验证过的合并逻辑，在产品里**永远走不到**。
 * 一个验证过的功能，没有写入口就等于不存在。
 *
 * 本文件提供那个写入口。
 *
 * ## 冻结契约（D-06 §15.2，不得擅改语义）
 * | 列 | 语义 |
 * |---|---|
 * | `edited_at` | 判定"用户编辑过"的**唯一依据**。NULL = 未编辑 |
 * | `text_raw`  | 编辑前的 ASR 原文，**仅当被编辑过才非空**（省空间），供"查看改动"与"还原" |
 */
import type { DatabaseHandle } from '@openmemo/db';
import { ulid } from '@openmemo/shared';

export interface EditSegmentResult {
  readonly seq: number;
  readonly text: string;
  readonly textRaw: string | null;
  readonly editedAt: number | null;
  readonly changed: boolean;
}

/**
 * 编辑一个段落的文本。
 *
 * **首次编辑时把 ASR 原文存进 `text_raw`**（之后再编辑不再覆盖它 ——
 * `text_raw` 的语义是"ASR 原来说的是什么"，不是"上一次改之前是什么"）。
 */
export function editSegment(
  db: DatabaseHandle,
  transcriptId: number,
  seq: number,
  newText: string,
  now = Date.now(),
): EditSegmentResult | undefined {
  return db.transaction(() => {
    const row = db
      .prepare<{ id: number; text: string; text_raw: string | null; edited_at: number | null }>(
        `SELECT id, text, text_raw, edited_at FROM transcript_segments
         WHERE transcript_id = :t AND seq = :s`,
      )
      .get({ t: transcriptId, s: seq });
    if (!row) return undefined;

    if (row.text === newText) {
      // 文本没变就不要打编辑标记 —— 否则重跑时会白白保护一条其实没改过的段落
      return {
        seq,
        text: row.text,
        textRaw: row.text_raw,
        editedAt: row.edited_at,
        changed: false,
      };
    }

    // 仅首次编辑时落 text_raw
    const textRaw = row.text_raw ?? row.text;
    db.prepare(
      `UPDATE transcript_segments
         SET text = :text, text_raw = :raw, edited_at = :now,
             flags = flags | 4          -- SEGMENT_FLAG.HUMAN_CONFIRMED (bit2)
       WHERE id = :id`,
    ).run({ id: row.id, text: newText, raw: textRaw, now });

    return { seq, text: newText, textRaw, editedAt: now, changed: true };
  });
}

/** 还原到 ASR 原文：清掉编辑标记，让重跑重新接管这一段。 */
export function revertSegment(
  db: DatabaseHandle,
  transcriptId: number,
  seq: number,
): EditSegmentResult | undefined {
  return db.transaction(() => {
    const row = db
      .prepare<{ id: number; text: string; text_raw: string | null }>(
        `SELECT id, text, text_raw FROM transcript_segments WHERE transcript_id = :t AND seq = :s`,
      )
      .get({ t: transcriptId, s: seq });
    if (!row) return undefined;
    if (row.text_raw === null) {
      return { seq, text: row.text, textRaw: null, editedAt: null, changed: false };
    }
    db.prepare(
      `UPDATE transcript_segments
         SET text = :raw, text_raw = NULL, edited_at = NULL, flags = flags & ~4
       WHERE id = :id`,
    ).run({ id: row.id, raw: row.text_raw });
    return { seq, text: row.text_raw, textRaw: null, editedAt: null, changed: true };
  });
}

/** 统计"用户编辑过 N 段" —— 合并结果条要显示它。 */
export function countEdited(db: DatabaseHandle, transcriptId: number): number {
  return (
    db
      .prepare<{ c: number }>(
        `SELECT COUNT(*) c FROM transcript_segments WHERE transcript_id = :t AND edited_at IS NOT NULL`,
      )
      .get({ t: transcriptId })?.c ?? 0
  );
}

// ---------------------------------------------------------------------------
// M-7 笔记锚点（D-02 §1.10）
// ---------------------------------------------------------------------------

export interface AnchorInput {
  readonly startMs: number;
  readonly endMs?: number | null;
  readonly quote: string;
  readonly transcriptUid?: string | null;
}

export interface AnchorRow {
  uid: string;
  start_ms: number;
  end_ms: number | null;
  quote: string | null;
}

/**
 * 整体替换一条笔记的锚点。
 *
 * D-02 §1.10：正文里的锚点是**内联富文本节点**（真相在 `body_json`），
 * 本表是为了反向查询（"这一秒有哪些笔记提到？"）而维护的**规范化索引**。
 * 所以保存时"先删该 note 的全部锚点再重插"，一个事务内完成。
 */
export function replaceAnchors(
  db: DatabaseHandle,
  noteId: number,
  anchors: readonly AnchorInput[],
  now = Date.now(),
): number {
  return db.transaction(() => {
    db.prepare(`DELETE FROM note_anchors WHERE note_id = :n`).run({ n: noteId });
    if (anchors.length === 0) return 0;
    const stmt = db.prepare(
      `INSERT INTO note_anchors(uid, note_id, transcript_id, start_ms, end_ms, quote, created_at)
       VALUES (:uid, :n, NULL, :s, :e, :q, :now)`,
    );
    let n = 0;
    for (const a of anchors) {
      if (!Number.isFinite(a.startMs)) continue;
      // quote 必填是 D-02 §3.5 的硬要求：没有它，重转写后就没法重定位
      if (!a.quote || !a.quote.trim()) continue;
      stmt.run({
        uid: ulid(now),
        n: noteId,
        s: Math.max(0, Math.round(a.startMs)),
        e: a.endMs === undefined || a.endMs === null ? null : Math.round(a.endMs),
        q: a.quote.slice(0, 200),
        now,
      });
      n++;
    }
    return n;
  });
}

export function listAnchors(db: DatabaseHandle, noteId: number): AnchorRow[] {
  return db
    .prepare<AnchorRow>(
      `SELECT uid, start_ms, end_ms, quote FROM note_anchors WHERE note_id = :n ORDER BY start_ms`,
    )
    .all({ n: noteId });
}
