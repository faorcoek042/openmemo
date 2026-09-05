import { Node, mergeAttributes } from '@tiptap/core';
import { TIME_ANCHOR_NODE_TYPE, timeAnchorText } from '@openmemo/shared';

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
 * ⚠️⚠️ **订正：上一版这段注释在这里写了一句假话，而且是本仓最贵的那一类。**
 *
 * 它写的是：「下面 `renderText()` 产出的 `[12:34]` **就是被写进 `body_text`、
 * 被 FTS5 索引的那个字符串**」。**在真实链路上不是。** 逐段核过的链路是：
 *
 *   `NoteEditor.tsx` 的自动保存把 `bodyText: ed.getText()`（走本文件的 `renderText()`）
 *   连同 `bodyJson` 一起 PATCH 上去
 *        ↓
 *   `apps/daemon/src/http/rest/content.ts` —— **有 `bodyJson` 时 `body_text` 一律由
 *   服务端推导，客户端传的 `bodyText` 被直接覆盖、不报错**（那条规则本身是对的：
 *   两个字段各自推导必然漂移）。而 `bodyJson` 是**每次**都传的。
 *        ↓
 *   `apps/daemon/src/db/richText.ts` 的 `extractPlainText()` —— **它**的输出才是
 *   写进 `notes.body_text`、被 `notes_fts` 触发器索引的那个字符串。
 *
 * ⇒ `renderText()` 的产物在到达索引之前**每一次都被丢掉**。而那个真正管事的提取器
 *   当时只收 `text` 节点和 `alt`/`title`/`label` 三个 attr —— 时间锚点这三样都没有，
 *   于是它对索引的贡献是**零**：`[实测]` 浏览器审计里，屏幕上的 `0:04` 搜出 0 条，
 *   同一段里的普通文字搜出 1 条，把 `0:04` 当纯文本再打一遍也搜出 1 条。
 *
 * **这条假注释正是这个缺陷活了这么久的原因**：它宣布这条链子已经接上了，
 * 于是没有人再去看另一端。假注释不是文档问题，是"守卫失效的第四种形态"
 *（注释型断言：读起来像不变式，但没有任何东西让它成真）。
 *
 * ── 现在这条链子靠什么成立 ──────────────────────────────────────────────
 *
 * 两端**调同一个函数**：`@openmemo/shared` 的 `timeAnchorText()`。
 * 下面的 `renderText()` 一处，daemon 的 `extractPlainText()` 一处，没有第三份实现，
 * 也没有"两边各写一遍再拿测试比对"。
 *
 * 覆盖它的守卫（先问"把修法退回去它会红吗"，逐条验过，会）：
 *   · `apps/daemon/src/db/richText.test.ts` —— 拿审计现场那条笔记的 `body_json` 原样
 *     断言投影里必须出现 `[0:04]`。删掉 daemon 那个口子 ⇒ 当场红。
 *   · `packages/shared/src/timecode.test.ts` —— 基准向量 + 「全仓只许有一份实现」的
 *     结构扫描。有人再抄一份 ⇒ 复制粘贴的那一刻就红。
 *   · `lib/format/singleSource.test.ts` —— `apps/web/src` 里不许再出现补零逻辑。
 */

export const TimeAnchor = Node.create({
  // 节点类型名是**跨进程契约**：daemon 的纯文本投影按这个字符串认它（见 shared）
  name: TIME_ANCHOR_NODE_TYPE,
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
   * 纯文本投影：锚点退化成 `[12:34]`。
   *
   * ⚠️ **它管的是 `editor.getText()`，不是 FTS 索引**（索引那份由 daemon 推导，
   * 见上面那段订正）。真正走它的是：复制正文、以及 `NoteEditor` 那个"可选提示"
   * 字段 `bodyText`（daemon 没起、走 mock 时它就是唯一那份）。
   * 不实现这个方法的话，`editor.getText()` 会把锚点整个吞掉。
   *
   * 产出的字符串必须与 daemon 投影出来的**逐字节相同**，所以这里不许自己拼 ——
   * 调 `timeAnchorText()`，daemon 那边调的是同一个。
   */
  renderText({ node }) {
    return timeAnchorText(Number(node.attrs.startMs ?? 0));
  },
});

/** 从正文 JSON 里抽出全部锚点，用于同步 `note_anchors` 表（D-02 §1.10）。 */
export function collectAnchors(doc: unknown): TimeAnchorAttrs[] {
  const out: TimeAnchorAttrs[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    if (node.type === TIME_ANCHOR_NODE_TYPE && node.attrs) {
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
