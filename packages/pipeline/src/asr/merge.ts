/**
 * Two-phase transcript merge. D-01 §5 F3, D-05 §4.3.
 *
 * F3 records with a fast streaming model, then re-runs the audio offline with an
 * accurate one. The re-run must NOT silently destroy anything the user typed:
 *
 *     ✅ 已更新 47 段转写 · 你编辑过的 3 段已保留 · [查看改动] [撤销这次更新]
 *
 * That UI string is a promise, and this file is what makes it true.
 *
 * THE RULE
 *   A draft segment the user EDITED is authoritative and survives the re-run.
 *   A draft segment the user did not touch is replaced by the re-run's output.
 *
 * WHY MATCHING IS BY TIME, NOT BY INDEX
 *   The two passes use different models with different segmentation. The streaming
 *   engine ends utterances on silence endpoints; whisper ends them on its own decoding
 *   boundaries. Segment counts and boundaries genuinely differ — in the measured F3 run
 *   the streaming pass produced a different count from the offline pass over identical
 *   audio. Index-based matching would therefore misalign and hand the user someone
 *   else's sentence, which is worse than not merging at all. Audio time is the only
 *   thing both passes agree on.
 */

import type { TranscriptSegment } from './types.js';
import { SEGMENT_FLAG } from './types.js';

/** A draft segment plus the edit state the DB tracks (D-02 §1.5). */
export interface MergeableSegment extends TranscriptSegment {
  /**
   * Stable row identity, so the caller can map the decision back to a DB row.
   * The pipeline never invents these; they come from the store.
   */
  id?: string | number;
  /**
   * Epoch ms of the user's last edit, or null when never edited.
   * D-02 §1.5 stores this as `edited_at`; `text_raw` holds the pre-edit ASR output.
   */
  editedAt?: number | null;
}

export type MergeDecision =
  /** User-edited: kept verbatim, re-run output for this span discarded. */
  | { action: 'preserved'; segment: MergeableSegment; reason: 'user_edited' }
  /** Untouched draft replaced by the more accurate re-run. */
  | { action: 'updated'; segment: TranscriptSegment; replaced: MergeableSegment }
  /** Re-run found speech the draft missed entirely. */
  | { action: 'added'; segment: TranscriptSegment }
  /** Draft segment with no counterpart in the re-run, and not edited. */
  | { action: 'removed'; segment: MergeableSegment };

export interface MergeResult {
  segments: TranscriptSegment[];
  decisions: MergeDecision[];
  stats: {
    updated: number;
    preserved: number;
    added: number;
    removed: number;
  };
}

export interface MergeOptions {
  /**
   * Minimum fraction of an edited segment's duration that a re-run segment must cover
   * before it is considered "the same speech" and suppressed.
   *
   * 0.3 is deliberately loose: the cost of being wrong in one direction (dropping a
   * user's edit) is far higher than in the other (leaving one slightly redundant line).
   */
  overlapThreshold?: number;
}

/** Overlap of two spans as a fraction of the first span's duration. */
export function overlapFraction(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): number {
  const span = Math.max(1, a.endMs - a.startMs);
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  return Math.max(0, overlap) / span;
}

export function isEdited(seg: MergeableSegment): boolean {
  return seg.editedAt !== null && seg.editedAt !== undefined;
}

/**
 * Merge an offline re-run over a streaming draft.
 *
 * Result ordering is by `startMs`, so the caller can renumber `seq` directly.
 * The old transcript is NOT deleted — D-02 §1.5 keeps it with `is_active = 0`, which is
 * what makes D-05's `[撤销这次更新]` possible. Undo is a data-model property, not
 * something this function has to implement.
 */
export function mergeTranscripts(
  draft: MergeableSegment[],
  rerun: TranscriptSegment[],
  options: MergeOptions = {},
): MergeResult {
  const { overlapThreshold = 0.3 } = options;

  const edited = draft.filter(isEdited).sort((a, b) => a.startMs - b.startMs);
  const untouched = draft.filter((s) => !isEdited(s));

  const decisions: MergeDecision[] = [];
  const output: TranscriptSegment[] = [];

  // 1. Every user edit is carried over untouched, and marks its span as spoken for.
  for (const seg of edited) {
    output.push({ ...seg, flags: seg.flags | SEGMENT_FLAG.HUMAN_CONFIRMED });
    decisions.push({ action: 'preserved', segment: seg, reason: 'user_edited' });
  }

  // 2. Re-run segments are accepted unless they collide with a preserved edit.
  const consumedUntouched = new Set<MergeableSegment>();

  for (const fresh of rerun) {
    const collides = edited.some((e) => overlapFraction(fresh, e) > overlapThreshold);
    if (collides) {
      // The user already rewrote this span; the machine does not get to overrule them.
      continue;
    }

    // Find the untouched draft segment this replaces, for the diff view.
    let best: MergeableSegment | null = null;
    let bestOverlap = 0;
    for (const old of untouched) {
      if (consumedUntouched.has(old)) continue;
      const o = overlapFraction(old, fresh);
      if (o > bestOverlap) {
        bestOverlap = o;
        best = old;
      }
    }

    output.push(fresh);
    if (best !== null && bestOverlap > overlapThreshold) {
      consumedUntouched.add(best);
      decisions.push({ action: 'updated', segment: fresh, replaced: best });
    } else {
      decisions.push({ action: 'added', segment: fresh });
    }
  }

  // 3. Untouched draft segments the re-run never covered. The re-run is the more
  //    accurate pass, so if it heard nothing there, the draft line was probably noise.
  for (const old of untouched) {
    if (consumedUntouched.has(old)) continue;
    const coveredByOutput = output.some((s) => overlapFraction(old, s) > overlapThreshold);
    if (!coveredByOutput) {
      decisions.push({ action: 'removed', segment: old });
    }
  }

  output.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  return {
    segments: output,
    decisions,
    stats: {
      updated: decisions.filter((d) => d.action === 'updated').length,
      preserved: decisions.filter((d) => d.action === 'preserved').length,
      added: decisions.filter((d) => d.action === 'added').length,
      removed: decisions.filter((d) => d.action === 'removed').length,
    },
  };
}

/**
 * Render D-05 §4.3's result banner.
 *
 * Says "0 preserved" rather than hiding the clause, because the number is the user's
 * assurance that their edits were considered at all.
 */
export function formatMergeSummary(stats: MergeResult['stats']): string {
  const parts = [`已更新 ${String(stats.updated)} 段转写`];
  parts.push(`你编辑过的 ${String(stats.preserved)} 段已保留`);
  if (stats.added > 0) parts.push(`新增 ${String(stats.added)} 段`);
  if (stats.removed > 0) parts.push(`移除 ${String(stats.removed)} 段`);
  return parts.join(' · ');
}

/** Per-segment diff for D-05's `[查看改动]` panel. */
export interface SegmentDiff {
  startMs: number;
  endMs: number;
  before: string | null;
  after: string | null;
  kind: 'updated' | 'added' | 'removed' | 'preserved';
}

export function buildDiff(result: MergeResult): SegmentDiff[] {
  const diffs: SegmentDiff[] = [];
  for (const d of result.decisions) {
    switch (d.action) {
      case 'updated':
        // Unchanged text is not a change; showing it as one buries the real edits.
        if (d.replaced.text.trim() !== d.segment.text.trim()) {
          diffs.push({
            startMs: d.segment.startMs,
            endMs: d.segment.endMs,
            before: d.replaced.text,
            after: d.segment.text,
            kind: 'updated',
          });
        }
        break;
      case 'added':
        diffs.push({
          startMs: d.segment.startMs,
          endMs: d.segment.endMs,
          before: null,
          after: d.segment.text,
          kind: 'added',
        });
        break;
      case 'removed':
        diffs.push({
          startMs: d.segment.startMs,
          endMs: d.segment.endMs,
          before: d.segment.text,
          after: null,
          kind: 'removed',
        });
        break;
      case 'preserved':
        diffs.push({
          startMs: d.segment.startMs,
          endMs: d.segment.endMs,
          before: d.segment.text,
          after: d.segment.text,
          kind: 'preserved',
        });
        break;
    }
  }
  return diffs.sort((a, b) => a.startMs - b.startMs);
}
