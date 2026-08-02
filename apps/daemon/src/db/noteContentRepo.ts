/**
 * 笔记正文写入（F5 / TipTap 的落点）。
 *
 * 独立成文件而不是加进 `Repos`：`repos.ts` 正被并行工作编辑，拆开避免写冲突。
 *
 * **`body_text` 是 `body_json` 的纯文本投影，专供 FTS5**（D-02 §1.3）。
 * 两者必须一起更新，否则搜索会搜不到刚编辑的内容 —— 而这不会有任何报错。
 */
import type { DatabaseHandle } from '@openmemo/db';

export interface NoteContentPatch {
  title?: string;
  /** 已序列化的 TipTap JSON；`null` 表示清空。 */
  bodyJson?: string | null;
  bodyText?: string;
  summaryMd?: string | null;
  language?: string | null;
}

/** 返回实际改动的字段名，供 SSE 的 `note.updated.changed` 用。 */
export function updateNoteContent(
  db: DatabaseHandle,
  noteId: number,
  patch: NoteContentPatch,
  now = Date.now(),
): string[] {
  const sets: string[] = ['updated_at = :now'];
  const params: Record<string, string | number | null> = { id: noteId, now };
  const changed: string[] = [];

  if (patch.title !== undefined) {
    sets.push('title = :title');
    params['title'] = patch.title;
    changed.push('title');
  }
  if (patch.bodyJson !== undefined) {
    sets.push('body_json = :bodyJson');
    params['bodyJson'] = patch.bodyJson;
    changed.push('body');
  }
  if (patch.bodyText !== undefined) {
    // FTS5 外部内容表靠触发器同步，所以这一列一变，索引就会跟着变
    sets.push('body_text = :bodyText');
    params['bodyText'] = patch.bodyText;
    if (!changed.includes('body')) changed.push('body');
  }
  if (patch.summaryMd !== undefined) {
    sets.push('summary_md = :summaryMd');
    params['summaryMd'] = patch.summaryMd;
    changed.push('body');
  }
  if (patch.language !== undefined) {
    sets.push('language = :language');
    params['language'] = patch.language;
  }

  if (sets.length === 1) return []; // 只有 updated_at，等于没改
  db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = :id`).run(params);
  return [...new Set(changed)];
}
