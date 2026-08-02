import { Node, mergeAttributes } from '@tiptap/core';

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

function formatTimecode(ms: number): string {
  const t = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  const total = Math.floor(t / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

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
          'inline-flex items-center rounded bg-accent-track px-1 text-xs text-accent align-baseline cursor-pointer select-none',
        role: 'button',
        tabindex: '0',
      }),
      formatTimecode(ms),
    ];
  },

  /**
   * 纯文本投影：`body_text` 供 FTS5 索引，锚点退化成 `[12:34]`。
   * 不实现这个方法的话，`editor.getText()` 会把锚点整个吞掉 ——
   * 用户搜"12:34"搜不到，而他明明在正文里看到了。
   */
  renderText({ node }) {
    return `[${formatTimecode(Number(node.attrs.startMs ?? 0))}]`;
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
