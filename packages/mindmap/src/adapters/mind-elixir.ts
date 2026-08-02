/**
 * MindMapDoc ⇄ mind-elixir 适配器（主编辑器，**双向**）。
 *
 * 依据 D-02 §2.3 的字段映射表（已核实 mind-elixir v5.14.0 的 `src/types/index.ts`）。
 *
 * ⚠️ 本文件**不 import mind-elixir**，只按其数据形状做结构转换。
 *    理由：`packages/mindmap` 必须保持库无关（ADR-002 决策 3）；
 *    真正 `new MindElixir()` 的地方在 `apps/web`（归 architect）。
 *    这里只做纯数据映射 —— 可以在 Node 里单测，不需要 DOM。
 */
import {
  MINDMAP_SCHEMA_VERSION,
  type MindMapDoc,
  type MindMapNode,
  type NodeKey,
} from '../types.js';

/** mind-elixir 的 `NodeObj`（我们用到的子集）。 */
export interface MeNodeObj {
  id: string;
  topic: string;
  children?: MeNodeObj[];
  /** ⚠️ 与我们的 `collapsed` **布尔取反**，这是最容易写反的一处。 */
  expanded?: boolean;
  /** ⚠️ **枚举是数字不是字符串**：0=Left, 1=Right。 */
  direction?: 0 | 1;
  style?: {
    fontSize?: string;
    color?: string;
    background?: string;
    fontWeight?: string;
  };
  icons?: string[];
  tags?: string[];
  /** ⚠️ 注意大写 L。 */
  hyperLink?: string;
  note?: string;
  image?: { url: string; width?: number; height?: number };
  branchColor?: string;
  /** 上游提供的泛型扩展位 —— 正好承载我们的 refs/meta/ext，无需 hack。 */
  metadata?: Record<string, unknown>;
}

export interface MeArrow {
  id: string;
  label?: string;
  from: string;
  to: string;
}

export interface MeSummary {
  id: string;
  parent: string;
  start: number;
  end: number;
  label: string;
}

/** `MindElixirData`。**已核实：没有 `linkData` 字段**，自由连线只有 `arrows`。 */
export interface MindElixirData {
  nodeData: MeNodeObj;
  arrows?: MeArrow[];
  summaries?: MeSummary[];
  direction?: 0 | 1 | 2 | 3;
  theme?: unknown;
}

const DIRECTION_TO_ME: Record<string, 0 | 1 | undefined> = {
  left: 0,
  right: 1,
  auto: undefined,
};

function toMeNode(doc: MindMapDoc, key: NodeKey, seen: Set<NodeKey>): MeNodeObj {
  const n = doc.nodes[key] as MindMapNode;
  seen.add(key);

  const out: MeNodeObj = { id: n.key, topic: n.text };

  // collapsed → expanded 是**取反**关系
  if (n.collapsed !== undefined) out.expanded = !n.collapsed;

  const dir = DIRECTION_TO_ME[n.side ?? 'auto'];
  if (dir !== undefined) out.direction = dir;

  if (n.style) {
    const s: NonNullable<MeNodeObj['style']> = {};
    if (n.style.fontSize !== undefined) s.fontSize = String(n.style.fontSize);
    if (n.style.color !== undefined) s.color = n.style.color;
    if (n.style.background !== undefined) s.background = n.style.background;
    if (n.style.bold) s.fontWeight = 'bold';
    out.style = s;
  }
  if (n.icons?.length) out.icons = [...n.icons];
  if (n.tags?.length) out.tags = [...n.tags];
  if (n.hyperlink) out.hyperLink = n.hyperlink;
  if (n.noteMd) out.note = n.noteMd;
  if (n.imageAssetUid) out.image = { url: `/media/asset/${n.imageAssetUid}` };

  // refs / meta / richMd / ext 一律塞进 metadata，往返保真
  const metadata: Record<string, unknown> = { ...(n.ext ?? {}) };
  if (n.refs?.length) metadata['openmemoRefs'] = n.refs;
  if (n.meta && Object.keys(n.meta).length) metadata['openmemoMeta'] = n.meta;
  if (n.richMd) metadata['openmemoRichMd'] = n.richMd;
  if (Object.keys(metadata).length) out.metadata = metadata;

  const kids = n.children.filter((c) => doc.nodes[c] && !seen.has(c));
  if (kids.length) out.children = kids.map((c) => toMeNode(doc, c, seen));

  return out;
}

/** MindMapDoc → mind-elixir。map 展开成嵌套树。 */
export function toMindElixir(doc: MindMapDoc): MindElixirData {
  const data: MindElixirData = { nodeData: toMeNode(doc, doc.rootKey, new Set()) };

  if (doc.edges?.length) {
    data.arrows = doc.edges.map((e) => ({
      id: e.key,
      from: e.from,
      to: e.to,
      ...(e.label === undefined ? {} : { label: e.label }),
    }));
  }
  if (doc.summaries?.length) {
    data.summaries = doc.summaries.map((s) => ({
      id: s.key,
      parent: s.parent,
      start: s.fromIndex,
      end: s.toIndex,
      label: s.text,
    }));
  }
  const dir = doc.layout?.direction;
  if (dir === 'left') data.direction = 0;
  else if (dir === 'right') data.direction = 1;
  else if (dir === 'both') data.direction = 2;

  // 渲染器私有沙箱回填
  const ext = doc.extensions?.['mind-elixir'];
  if (ext && typeof ext === 'object') Object.assign(data, ext);

  return data;
}

function fromMeNode(
  me: MeNodeObj,
  nodes: Record<NodeKey, MindMapNode>,
  parentDirection?: 0 | 1,
): NodeKey {
  const key = me.id;
  const children: NodeKey[] = [];
  for (const c of me.children ?? []) children.push(fromMeNode(c, nodes, me.direction));

  const metadata = { ...(me.metadata ?? {}) };
  const refs = metadata['openmemoRefs'];
  const meta = metadata['openmemoMeta'];
  const richMd = metadata['openmemoRichMd'];
  delete metadata['openmemoRefs'];
  delete metadata['openmemoMeta'];
  delete metadata['openmemoRichMd'];

  const node: {
    -readonly [K in keyof MindMapNode]: MindMapNode[K];
  } = { key, text: me.topic, children };

  if (me.expanded !== undefined) node.collapsed = !me.expanded;
  if (me.direction === 0) node.side = 'left';
  else if (me.direction === 1) node.side = 'right';
  else if (parentDirection !== undefined) node.side = 'auto';

  if (me.style) {
    const fs = me.style.fontSize === undefined ? undefined : Number(me.style.fontSize);
    node.style = {
      ...(me.style.color === undefined ? {} : { color: me.style.color }),
      ...(me.style.background === undefined ? {} : { background: me.style.background }),
      ...(fs === undefined || Number.isNaN(fs) ? {} : { fontSize: fs }),
      ...(me.style.fontWeight === 'bold' ? { bold: true } : {}),
    };
  }
  if (me.icons?.length) node.icons = me.icons;
  if (me.tags?.length) node.tags = me.tags;
  if (me.hyperLink) node.hyperlink = me.hyperLink;
  if (me.note) node.noteMd = me.note;
  if (typeof richMd === 'string') node.richMd = richMd;
  if (Array.isArray(refs)) node.refs = refs as MindMapNode['refs'];
  if (meta && typeof meta === 'object') node.meta = meta as Record<string, unknown>;
  if (Object.keys(metadata).length) node.ext = metadata;
  if (me.image?.url) {
    const m = /\/media\/asset\/([A-Za-z0-9]+)/.exec(me.image.url);
    if (m?.[1]) node.imageAssetUid = m[1];
  }

  nodes[key] = node as MindMapNode;
  return key;
}

/** mind-elixir → MindMapDoc。嵌套树摊平回 map。 */
export function fromMindElixir(
  data: MindElixirData,
  opts: { uid: string; title?: string; revision?: number },
): MindMapDoc {
  const nodes: Record<NodeKey, MindMapNode> = {};
  const rootKey = fromMeNode(data.nodeData, nodes);

  const doc: {
    -readonly [K in keyof MindMapDoc]: MindMapDoc[K];
  } = {
    schemaVersion: MINDMAP_SCHEMA_VERSION,
    uid: opts.uid,
    title: opts.title ?? data.nodeData.topic,
    rootKey,
    revision: opts.revision ?? 0,
    nodes,
  };

  if (data.arrows?.length) {
    doc.edges = data.arrows.map((a) => ({
      key: a.id,
      from: a.from,
      to: a.to,
      ...(a.label === undefined ? {} : { label: a.label }),
    }));
  }
  if (data.summaries?.length) {
    doc.summaries = data.summaries.map((s) => ({
      key: s.id,
      parent: s.parent,
      fromIndex: s.start,
      toIndex: s.end,
      text: s.label,
    }));
  }
  if (data.direction === 0) doc.layout = { direction: 'left' };
  else if (data.direction === 1) doc.layout = { direction: 'right' };
  else if (data.direction === 2) doc.layout = { direction: 'both' };

  return doc as MindMapDoc;
}
