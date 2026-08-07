/**
 * 库无关的思维导图数据模型（D-02 §2，**ADR-002 决策 3 硬要求**）。
 *
 * mind-elixir 只是这个 schema 的一个**消费者**（T-165：markmap 适配器与依赖已整块摘除，
 * 产品里没有大纲视图 —— 见 `index.ts` 文件头）。
 * 本文件**禁止 import 任何渲染库** —— 一旦依赖了，"库无关"就名存实亡。
 */

export const MINDMAP_SCHEMA_VERSION = 1 as const;

/** 节点 key。稳定标识：渲染器往返、PATCH op、refs 外链都靠它。 */
export type NodeKey = string;

/**
 * F5 联动的**三层引用**（D-02 §3.5）。
 *
 * ```
 * 第 1 层  startMs/endMs  ← 权威。时间轴不变，重转写不影响
 * 第 2 层  quote          ← 在新稿中重定位（相似度匹配）
 * 第 3 层  segmentId      ← 仅缓存，不进 JSON
 * ```
 *
 * ⚠️ `quote` 是**必填**的：没有它就没有第 2 层，重转写必然丢链接。
 */
export interface TranscriptRef {
  readonly transcriptUid: string;
  readonly startMs: number;
  readonly endMs: number;
  /** 原文片段（≤200 字）。**必填** —— 重定位的唯一依据。 */
  readonly quote: string;
  /** 重定位相似度；首次生成时为 1。 */
  readonly matchScore?: number;
}

export interface NodeStyle {
  readonly color?: string;
  readonly background?: string;
  readonly fontSize?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export interface MindMapNode {
  readonly key: NodeKey;
  /** 【必填】纯文本 —— 最小公分母：所有序列化格式与渲染器都至少需要它。 */
  readonly text: string;
  /** 有序数组，顺序即显示顺序（不依赖对象键序）。 */
  readonly children: readonly NodeKey[];
  readonly richMd?: string | null;
  readonly noteMd?: string | null;
  readonly collapsed?: boolean;
  readonly side?: 'auto' | 'left' | 'right';
  readonly style?: NodeStyle | null;
  readonly icons?: readonly string[];
  readonly tags?: readonly string[];
  readonly hyperlink?: string | null;
  readonly imageAssetUid?: string | null;
  readonly refs?: readonly TranscriptRef[];
  readonly meta?: Readonly<Record<string, unknown>>;
  /** 节点级渲染器私有数据（往返保真用）。 */
  readonly ext?: Readonly<Record<string, unknown>>;
}

export interface MindMapEdge {
  readonly key: string;
  readonly from: NodeKey;
  readonly to: NodeKey;
  readonly label?: string;
  readonly style?: NodeStyle | null;
}

export interface MindMapSummary {
  readonly key: string;
  readonly parent: NodeKey;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly text: string;
}

export interface MindMapLayout {
  readonly direction?: 'right' | 'left' | 'both';
  readonly theme?: string;
}

/**
 * 思维导图文档。
 *
 * ★ `nodes` 是 **map-of-nodes 而不是嵌套树** ★（D-02 §2.2 约束 1）：
 * 稳定 key、O(1) 查找、易 diff/patch、避免递归类型爆炸。
 */
export interface MindMapDoc {
  readonly schemaVersion: number;
  readonly uid: string;
  readonly title: string;
  readonly rootKey: NodeKey;
  /** 乐观锁，PATCH 必带。 */
  readonly revision: number;
  readonly nodes: Readonly<Record<NodeKey, MindMapNode>>;
  readonly edges?: readonly MindMapEdge[];
  readonly summaries?: readonly MindMapSummary[];
  readonly layout?: MindMapLayout;
  /** 渲染器私有数据的隔离沙箱：核心 schema 保持干净，往返不丢信息。 */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 校验上限（D-02 §2.2 约束 5）。LLM 会生成环和悬空引用，不校验就等着渲染器栈溢出。
// ---------------------------------------------------------------------------
export const LIMITS = {
  maxDepth: 32,
  maxTextLength: 4096,
  maxNodes: 20_000,
  maxQuoteLength: 200,
} as const;

/** 构造一棵只有根节点的空导图。 */
export function emptyDoc(uid: string, title: string, rootKey: NodeKey = 'root'): MindMapDoc {
  return {
    schemaVersion: MINDMAP_SCHEMA_VERSION,
    uid,
    title,
    rootKey,
    revision: 0,
    nodes: { [rootKey]: { key: rootKey, text: title, children: [] } },
  };
}

/** 深度优先遍历（前序）。遇到悬空引用会跳过 —— 遍历不该因为数据坏而抛。 */
export function* walk(
  doc: MindMapDoc,
  from: NodeKey = doc.rootKey,
  depth = 0,
  seen: Set<NodeKey> = new Set(),
): Generator<{ node: MindMapNode; depth: number }> {
  if (seen.has(from)) return; // 防环
  seen.add(from);
  const node = doc.nodes[from];
  if (!node) return;
  yield { node, depth };
  for (const c of node.children) yield* walk(doc, c, depth + 1, seen);
}

/** 节点总数（按可达性算，不是 Object.keys 长度）。 */
export function reachableCount(doc: MindMapDoc): number {
  let n = 0;
  for (const _ of walk(doc)) n++;
  return n;
}
