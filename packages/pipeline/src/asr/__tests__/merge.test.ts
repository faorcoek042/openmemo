/**
 * Two-phase merge: the re-run must never destroy a user's edit.
 *
 * D-05 §4.3 promises the user "已更新 47 段转写 · 你编辑过的 3 段已保留 · [撤销]".
 * These tests are what make that promise checkable.
 *
 * Run: node --test packages/pipeline/dist/asr/__tests__/merge.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDiff,
  formatMergeSummary,
  isEdited,
  mergeTranscripts,
  overlapFraction,
} from '../merge.js';
import type { MergeableSegment } from '../merge.js';
import type { TranscriptSegment } from '../types.js';
import { dedupeBoundarySegments } from '../../transcribe.js';
import { SEGMENT_FLAG } from '../types.js';

function seg(startMs: number, endMs: number, text: string): TranscriptSegment {
  return {
    startMs,
    endMs,
    text,
    confidence: null,
    noSpeechProb: null,
    words: null,
    chunkIdx: 0,
    flags: 0,
    speakerLabel: null,
  };
}

function draftSeg(
  startMs: number,
  endMs: number,
  text: string,
  editedAt: number | null = null,
): MergeableSegment {
  return { ...seg(startMs, endMs, text), id: `${String(startMs)}`, editedAt };
}

describe('overlapFraction', () => {
  it('measures overlap as a fraction of the FIRST span', () => {
    assert.equal(overlapFraction({ startMs: 0, endMs: 1000 }, { startMs: 0, endMs: 500 }), 0.5);
    assert.equal(overlapFraction({ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3000 }), 0);
    assert.equal(overlapFraction({ startMs: 0, endMs: 1000 }, { startMs: -500, endMs: 1500 }), 1);
  });
});

describe('mergeTranscripts — the core promise', () => {
  it('PRESERVES an edited segment and DISCARDS the re-run text for that span', () => {
    const draft = [
      draftSeg(0, 5_000, '第一段草稿'),
      draftSeg(5_000, 10_000, '用户改过的正确文本', 1_700_000_000_000),
      draftSeg(10_000, 15_000, '第三段草稿'),
    ];
    const rerun = [
      seg(0, 5_000, '第一段更准确的结果'),
      seg(5_000, 10_000, '机器重跑的结果会覆盖吗'),
      seg(10_000, 15_000, '第三段更准确的结果'),
    ];

    const result = mergeTranscripts(draft, rerun);
    const texts = result.segments.map((s) => s.text);

    assert.ok(texts.includes('用户改过的正确文本'), 'the user edit MUST survive');
    assert.ok(
      !texts.includes('机器重跑的结果会覆盖吗'),
      'the re-run text for an edited span must be discarded, not appended',
    );
    assert.ok(texts.includes('第一段更准确的结果'), 'untouched segments get the better text');
    assert.deepEqual(result.stats, { updated: 2, preserved: 1, added: 0, removed: 0 });
  });

  it('marks preserved segments HUMAN_CONFIRMED so the UI can badge them', () => {
    const draft = [draftSeg(0, 5_000, '我改过', 1_700_000_000_000)];
    const result = mergeTranscripts(draft, [seg(0, 5_000, '机器结果')]);
    assert.ok((result.segments[0]!.flags & SEGMENT_FLAG.HUMAN_CONFIRMED) !== 0);
  });

  it('matches by TIME, not by index — the two passes segment differently', () => {
    /*
     * The measured F3 run showed this is real: the streaming engine ends utterances on
     * silence endpoints, whisper on its own decoding boundaries, so counts differ over
     * identical audio. Index-based matching would hand the user someone else's sentence.
     */
    const draft = [
      draftSeg(0, 3_000, '短句一'),
      draftSeg(3_000, 6_000, '这段我改过了', 1_700_000_000_000),
      draftSeg(6_000, 9_000, '短句三'),
    ];
    // Re-run merged everything into two long segments — a different segmentation.
    const rerun = [seg(0, 4_500, '长句一覆盖前两段'), seg(4_500, 9_000, '长句二')];

    const result = mergeTranscripts(draft, rerun);
    const texts = result.segments.map((s) => s.text);
    assert.ok(texts.includes('这段我改过了'), 'the edit survives despite different segmentation');
    // The re-run segment overlapping the edit by >30% is suppressed.
    assert.ok(!texts.includes('长句一覆盖前两段'));
  });

  it('keeps a re-run segment that only slightly grazes an edit', () => {
    const draft = [draftSeg(0, 10_000, '我改过的长段落', 1_700_000_000_000)];
    // 10% overlap: adjacent speech, not the same sentence.
    const rerun = [seg(9_000, 19_000, '后面一段全新的话')];
    const result = mergeTranscripts(draft, rerun);
    assert.equal(result.segments.length, 2, 'both should survive');
    assert.equal(result.stats.preserved, 1);
    assert.equal(result.stats.added, 1);
  });

  it('adds speech the streaming draft missed entirely', () => {
    const draft = [draftSeg(0, 5_000, '草稿')];
    const rerun = [seg(0, 5_000, '重跑'), seg(20_000, 25_000, '流式漏掉的一段')];
    const result = mergeTranscripts(draft, rerun);
    assert.equal(result.stats.added, 1);
    assert.ok(result.segments.some((s) => s.text === '流式漏掉的一段'));
  });

  it('removes an unedited draft segment the re-run heard nothing at', () => {
    const draft = [draftSeg(0, 5_000, '草稿'), draftSeg(30_000, 35_000, '流式的幻觉')];
    const result = mergeTranscripts(draft, [seg(0, 5_000, '重跑')]);
    assert.equal(result.stats.removed, 1);
    assert.ok(!result.segments.some((s) => s.text === '流式的幻觉'));
  });

  it('NEVER removes an edited segment, even with no re-run counterpart', () => {
    // The strongest guarantee in this file: a user's words are not deleted because a
    // model disagreed that anything was said.
    const draft = [draftSeg(30_000, 35_000, '我手打的重要笔记', 1_700_000_000_000)];
    const result = mergeTranscripts(draft, [seg(0, 5_000, '完全不相干')]);
    assert.equal(result.stats.removed, 0);
    assert.ok(result.segments.some((s) => s.text === '我手打的重要笔记'));
  });

  it('returns segments sorted by start time', () => {
    const draft = [draftSeg(10_000, 15_000, 'c', 1)];
    const rerun = [seg(5_000, 9_000, 'b'), seg(0, 4_000, 'a')];
    const result = mergeTranscripts(draft, rerun);
    assert.deepEqual(
      result.segments.map((s) => s.text),
      ['a', 'b', 'c'],
    );
  });

  it('handles an empty draft (plain first transcription)', () => {
    const result = mergeTranscripts([], [seg(0, 5_000, 'x')]);
    assert.equal(result.stats.added, 1);
    assert.equal(result.segments.length, 1);
  });

  it('handles an empty re-run (offline pass found nothing) without losing edits', () => {
    const draft = [draftSeg(0, 5_000, '我改过', 1), draftSeg(5_000, 9_000, '没改过')];
    const result = mergeTranscripts(draft, []);
    assert.equal(result.stats.preserved, 1);
    assert.ok(result.segments.some((s) => s.text === '我改过'));
  });
});

describe('isEdited', () => {
  it('treats null and undefined as not edited', () => {
    assert.equal(isEdited(draftSeg(0, 1, 'x', null)), false);
    assert.equal(isEdited({ ...seg(0, 1, 'x') }), false);
    assert.equal(isEdited(draftSeg(0, 1, 'x', 1_700_000_000_000)), true);
  });
});

describe('formatMergeSummary — the D-05 banner', () => {
  it('always states the preserved count, even when zero', () => {
    // The number is the user's assurance their edits were considered at all.
    assert.equal(
      formatMergeSummary({ updated: 47, preserved: 0, added: 0, removed: 0 }),
      '已更新 47 段转写 · 你编辑过的 0 段已保留',
    );
  });

  it('reproduces the exact D-05 §4.3 wording', () => {
    assert.equal(
      formatMergeSummary({ updated: 47, preserved: 3, added: 0, removed: 0 }),
      '已更新 47 段转写 · 你编辑过的 3 段已保留',
    );
  });

  it('appends added/removed only when non-zero', () => {
    assert.match(
      formatMergeSummary({ updated: 1, preserved: 0, added: 2, removed: 3 }),
      /新增 2 段/,
    );
    assert.match(
      formatMergeSummary({ updated: 1, preserved: 0, added: 2, removed: 3 }),
      /移除 3 段/,
    );
  });
});

describe('buildDiff — the [查看改动] panel', () => {
  it('omits updates whose text did not actually change', () => {
    const draft = [draftSeg(0, 5_000, 'same text')];
    const result = mergeTranscripts(draft, [seg(0, 5_000, 'same text')]);
    // Listing unchanged lines as changes buries the real edits.
    assert.equal(buildDiff(result).filter((d) => d.kind === 'updated').length, 0);
  });

  it('reports before/after for real changes and is time-ordered', () => {
    const draft = [draftSeg(0, 5_000, 'old'), draftSeg(5_000, 9_000, 'kept', 1)];
    const result = mergeTranscripts(draft, [seg(0, 5_000, 'new')]);
    const diffs = buildDiff(result);
    const updated = diffs.find((d) => d.kind === 'updated');
    assert.equal(updated?.before, 'old');
    assert.equal(updated?.after, 'new');
    assert.ok(diffs.every((d, i, a) => i === 0 || d.startMs >= a[i - 1]!.startMs));
  });
});

describe('dedupeBoundarySegments — duplicated opening (T-037)', () => {
  const seg2 = (startMs: number, endMs: number, text: string): TranscriptSegment => ({
    startMs,
    endMs,
    text,
    confidence: null,
    noSpeechProb: null,
    words: null,
    chunkIdx: 0,
    flags: 0,
    speakerLabel: null,
  });

  it('strips a repeated opening the ratio test lets through', () => {
    // Verbatim from the real Chinese DB (T-035): seq5 is only 11% time-overlapped, so it
    // is correctly kept — but it opens by repeating seq4 word for word.
    const accepted = [seg2(28_480, 31_580, '输入最多140字的文字更新')];
    const incoming = [
      seg2(
        28_860,
        52_920,
        '输入最多140字的文字更新,Twitter在2006年3月成立于旧金山,由Upvirus公司开发',
      ),
    ];
    const kept = dedupeBoundarySegments(accepted, incoming);
    assert.equal(kept.length, 1, 'the segment is mostly new; it must survive');
    assert.ok(
      !kept[0]!.text.startsWith('输入最多140字的文字更新'),
      'the duplicated opening must be removed',
    );
    assert.ok(kept[0]!.text.startsWith('Twitter在2006年3月'), 'the new content must remain intact');
  });

  it('leaves a genuine spoken repetition alone when there is no time overlap', () => {
    // Same words, but the segments do not overlap — the speaker really said it twice.
    const accepted = [seg2(0, 5_000, '这一点非常重要请大家注意')];
    const incoming = [seg2(5_000, 10_000, '这一点非常重要请大家注意')];
    assert.equal(dedupeBoundarySegments(accepted, incoming).length, 1);
    assert.equal(dedupeBoundarySegments(accepted, incoming)[0]!.text, '这一点非常重要请大家注意');
  });

  it('drops the segment when the repeat is all there is', () => {
    const accepted = [seg2(0, 5_000, '输入最多140字的文字更新')];
    const incoming = [seg2(4_800, 9_000, '输入最多140字的文字更新')];
    assert.equal(dedupeBoundarySegments(accepted, incoming).length, 0);
  });

  it('ignores very short repeats — "好的" recurring is normal speech', () => {
    const accepted = [seg2(0, 2_000, '好的')];
    const incoming = [seg2(1_900, 8_000, '好的那么我们继续下一个话题')];
    const kept = dedupeBoundarySegments(accepted, incoming);
    assert.equal(kept[0]!.text, '好的那么我们继续下一个话题', 'too short to treat as duplication');
  });

  it('matches across differing punctuation between the two passes', () => {
    const accepted = [seg2(0, 5_000, '用户可以经由SMS、即时通讯、电邮')];
    const incoming = [seg2(4_500, 12_000, '用户可以经由SMS,即时通讯,电邮,Twitter网站获得更新')];
    const kept = dedupeBoundarySegments(accepted, incoming);
    assert.ok(kept[0]!.text.startsWith('Twitter网站'), `got: ${kept[0]!.text}`);
  });
});
