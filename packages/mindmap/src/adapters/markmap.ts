/**
 * MindMapDoc → markmap 适配器（**只读视图**）。
 *
 * **关键实现决策**（D-02 §2.3，architect 已核实上游源码）：
 * `markmap-lib.transform()` 只接受 **Markdown 字符串**，但 `markmap-view` 的
 * `Markmap.create()` 接受 **`IPureNode` 对象**。
 *
 * → 我们**绕过 `transform()`，由 MindMapDoc 直接构造 `IPureNode`**，
 *   避免 "doc → Markdown → markdown-it → HTML → buildTree" 这条**四段有损**链路。
 *   `toMarkdown()` 只用于导出与"编辑 Markdown 源"入口，**不在渲染路径上**。
 */
import type { MindMapDoc, MindMapNode, NodeKey } from '../types.js';

/**
 * markmap 的 `IPureNode`。
 * ⚠️ `content` 是 **HTML 字符串**，不是 Markdown —— 所以必须做 HTML 转义。
 */
export interface IPureNode {
  content: string;
  children: IPureNode[];
  payload?: Record<string, unknown>;
}

/**
 * HTML 转义。`content` 会被 markmap 当 HTML 插进 DOM，
 * 不转义 = 用户的转写稿里一个 `<script>` 就能 XSS 自己。
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ToMarkmapOptions {
  /**
   * 是否把节点备注降级为一个子节点（markmap 没有 note 概念）。
   * 默认 true —— 宁可多一个子节点，也好过静默丢信息。
   */
  readonly noteAsChild?: boolean;
  /** 是否把 `refs[0]` 的时间戳渲染进 content。默认 true（F5 联动的可见入口）。 */
  readonly showTimestamps?: boolean;
}

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

function build(
  doc: MindMapDoc,
  key: NodeKey,
  opts: Required<ToMarkmapOptions>,
  seen: Set<NodeKey>,
): IPureNode {
  const n = doc.nodes[key] as MindMapNode;
  seen.add(key);

  let content = escapeHtml(n.text);
  const ref = n.refs?.[0];
  if (opts.showTimestamps && ref) {
    // 时间戳用 <small> 包一层，视觉上弱化
    content += ` <small>[${formatTimestamp(ref.startMs)}]</small>`;
  }

  const children: IPureNode[] = [];
  if (opts.noteAsChild && n.noteMd) {
    children.push({ content: `<em>${escapeHtml(n.noteMd)}</em>`, children: [] });
  }
  for (const c of n.children) {
    if (!doc.nodes[c] || seen.has(c)) continue;
    children.push(build(doc, c, opts, seen));
  }

  const payload: Record<string, unknown> = {};
  // markmap 用 payload.fold（非 0 即折叠）
  if (n.collapsed) payload['fold'] = 1;
  // refs/meta 原样塞进 payload —— markmap 会保留，前端点击时用来 seek 音频
  if (n.refs?.length) payload['openmemoRefs'] = n.refs;
  payload['openmemoKey'] = n.key;

  return { content, children, payload };
}

/**
 * MindMapDoc → markmap `IPureNode` 树。
 *
 * **损失**（UI 切到 markmap 视图时必须明示，D-02 §2.3 损失矩阵）：
 * `edges`（自由连线）/ `summaries`（概要）/ 逐节点样式 / 图标标签 —— markmap 全部无对应。
 */
export function toMarkmap(doc: MindMapDoc, options: ToMarkmapOptions = {}): IPureNode {
  const opts: Required<ToMarkmapOptions> = {
    noteAsChild: options.noteAsChild ?? true,
    showTimestamps: options.showTimestamps ?? true,
  };
  return build(doc, doc.rootKey, opts, new Set());
}

/** 切换到 markmap 视图时会丢失哪些东西 —— 供 UI 提示用。 */
export interface MarkmapLossReport {
  readonly edges: number;
  readonly summaries: number;
  readonly styledNodes: number;
  readonly iconsOrTags: number;
  readonly images: number;
  readonly lossy: boolean;
}

export function markmapLoss(doc: MindMapDoc): MarkmapLossReport {
  let styledNodes = 0;
  let iconsOrTags = 0;
  let images = 0;
  for (const n of Object.values(doc.nodes)) {
    if (n.style) styledNodes++;
    if (n.icons?.length || n.tags?.length) iconsOrTags++;
    if (n.imageAssetUid) images++;
  }
  const edges = doc.edges?.length ?? 0;
  const summaries = doc.summaries?.length ?? 0;
  return {
    edges,
    summaries,
    styledNodes,
    iconsOrTags,
    images,
    lossy: edges + summaries + styledNodes + iconsOrTags + images > 0,
  };
}
