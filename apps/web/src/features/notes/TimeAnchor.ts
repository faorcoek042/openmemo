import { Node, mergeAttributes } from '@tiptap/core';

import { timecode } from '../../lib/format/time';

/**
 * M-7「引用此刻」时间锚点 —— TipTap 自定义 inline node。
 *
 * ## 它解决什么
 *
 * 用户在听转写稿时想写一句自己的话，并且要**指回音频的那一秒**。
 * D-02 §1.10 的 `note_anchors` 表早就为此建好了，但正文里一直没有能承载它的东西。
 *
 * ## 为什么是自定义 node 而不是纯文本 `[12:34]`
 *
 * 纯文本会被用户误编辑成 `[12:3 4]`、会被复制粘贴打散、也无法携带 `transcriptUid`。
 * 做成 atom node（原子、不可分割、不可编辑内部）之后：
 * - 它要么完整存在、要么整体被删，不会half-broken；
 * - `attrs` 里能带 `startMs` / `transcriptUid`，点击即可精确 seek；
 * - 序列化进 `body_json` 保真，而 `body_text` 投影里退化成 `[12:34]` 供全文检索。
 */

export interface TimeAnchorAttrs {
  /** 锚点在 `note_anchors` 表里的 key，正文与表通过它对齐 */
  anchorKey: string;
  startMs: number;
  transcriptUid: string | null;
  /** 引用的原文片段。重新转写后靠它做相似度重定位（D-02 §3.5 第 2 层） */
  quote: string | null;
}

/*
 * ★ 这里原本有一个逐字重写的 `formatTimecode()` —— `lib/format/time.ts` 的
 *   `timecode()` 的第二份实现（两者对所有输入等价：非有限/负数都归 0，只是
 *   一个先 `Math.max(0, Math.floor(ms))`、一个先把 `ms` 归零，然后同样地整除 1000）。
 *
 * ⚠️ **这一份漂了的话，坏掉的是搜索，而且是静默的。**
 * 下面 `renderText()` 产出的 `[12:34]` **就是被写进 `body_text`、被 FTS5 索引的那个字符串**，
 * 而 `renderHTML()` 画在屏幕上的是另一次调用。两份实现一旦对不齐（哪怕只是补零规则），
 * 用户看到的时间码和索引里的时间码就不是同一个东西：
 * **他照着屏幕上的字搜，搜不到自己刚写的那条锚点，而没有任何一处报错。**
 *
 * 收敛之后 `padStart(2` 在 `apps/web/src` 里只剩 `lib/format/` 那一处 ——
 * 这条性质由 `lib/format/singleSource.test.ts` 钉着。
 */

export const TimeAnchor = Node.create({
  name: 'timeAnchor',
  group: 'inline',
  inline: true,
  // atom：整体作为一个不可分割的单位，用户改不坏它的内部结构
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      anchorKey: { default: '' },
      startMs: { default: 0 },
      transcriptUid: { default: null },
      quote: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-time-anchor]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const ms = Number(HTMLAttributes.startMs ?? 0);
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-time-anchor': '',
        class:
          'inline-flex items-center rounded bg-info-tint px-1 text-xs text-info align-baseline cursor-pointer select-none',
        role: 'button',
        tabindex: '0',
      }),
      timecode(ms),
    ];
  },

  /**
   * 纯文本投影：`body_text` 供 FTS5 索引，锚点退化成 `[12:34]`。
   * 不实现这个方法的话，`editor.getText()` 会把锚点整个吞掉 ——
   * 用户搜"12:34"搜不到，而他明明在正文里看到了。
   */
  renderText({ node }) {
    return `[${timecode(Number(node.attrs.startMs ?? 0))}]`;
  },
});

/** 从正文 JSON 里抽出全部锚点，用于同步 `note_anchors` 表（D-02 §1.10）。 */
export function collectAnchors(doc: unknown): TimeAnchorAttrs[] {
  const out: TimeAnchorAttrs[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    if (node.type === 'timeAnchor' && node.attrs) {
      out.push({
        anchorKey: String(node.attrs.anchorKey ?? ''),
        startMs: Number(node.attrs.startMs ?? 0),
        transcriptUid: (node.attrs.transcriptUid as string | null) ?? null,
        quote: (node.attrs.quote as string | null) ?? null,
      });
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return out;
}
