/**
 * FreeMind `.mm` 序列化（D-02 §2.4）。
 *
 * 这是三种通用格式里**唯一**能带自由连线（`doc.edges`）的——FreeMind 的
 * `<arrowlink DESTINATION="…"/>` 天然对应"从当前 node 指向另一个 node"，
 * 所以 `edges` 在这里挂在 `from` 节点内部，`to` 走 `DESTINATION` 属性。
 *
 * XML 解析/转义复用 `opml.ts` 里手写的极简实现，不重复造轮子。
 */
import {
  MINDMAP_SCHEMA_VERSION,
  type MindMapDoc,
  type MindMapEdge,
  type MindMapNode,
  type NodeKey,
} from '../types.js';
import { escapeXml, findChild, findChildren, parseXml, type XmlElement } from './opml.js';

/**
 * 导出为 FreeMind 1.0.1。
 *
 * 节点 `ID` 直接用 `MindMapDoc` 自己的 `key`（不重新生成）—— 这样和 `doc.edges`
 * 的 `from`/`to` 天然一致，也让"导出再导入"时 key 恰好能原样保留（见 `fromFreeMind`）。
 */
export function toFreeMind(doc: MindMapDoc): string {
  const lines = ['<map version="1.0.1">', renderNode(doc, doc.rootKey, 1, new Set()), '</map>'];
  return lines.join('\n') + '\n';
}

function renderNode(doc: MindMapDoc, key: NodeKey, indent: number, seen: Set<NodeKey>): string {
  if (seen.has(key)) return ''; // 防环兜底；正常文档已由 validate() 保证是树
  seen.add(key);
  const node = doc.nodes[key];
  if (!node) return '';
  const pad = '  '.repeat(indent);
  const attrs = [`ID="${escapeXml(key)}"`, `TEXT="${escapeXml(node.text)}"`];
  if (node.collapsed) attrs.push('FOLDED="true"');

  const inner: string[] = [];
  if (node.noteMd) {
    inner.push(
      `${pad}  <richcontent TYPE="NOTE"><html><body><p>${escapeXml(node.noteMd)}</p></body></html></richcontent>`,
    );
  }
  for (const c of node.children) {
    const childXml = renderNode(doc, c, indent + 1, seen);
    if (childXml) inner.push(childXml);
  }
  for (const edge of doc.edges ?? []) {
    if (edge.from !== key) continue;
    inner.push(
      `${pad}  <arrowlink DESTINATION="${escapeXml(edge.to)}" STARTARROW="None" ENDARROW="Default"/>`,
    );
  }

  if (inner.length === 0) {
    return `${pad}<node ${attrs.join(' ')}/>`;
  }
  return `${pad}<node ${attrs.join(' ')}>\n${inner.join('\n')}\n${pad}</node>`;
}

/** 从 `<richcontent TYPE="NOTE">` 里挖出纯文本（走 html/body/p，找不到就退到能找到的最深层）。 */
function extractRichText(richcontent: XmlElement): string {
  const html = findChild(richcontent, 'html');
  const body = html ? findChild(html, 'body') : undefined;
  const p = body ? findChild(body, 'p') : undefined;
  return (p ?? body ?? html ?? richcontent).text;
}

/**
 * 从 FreeMind XML 反解析，包括把 `<arrowlink>` 还原进 `doc.edges`。
 *
 * key 优先复用源文件的 `ID` 属性（我们自己导出的文件必有此属性，往返即可保留原 key）；
 * 缺失时（外部/手写的 .mm）才退化生成 `n0`、`n1`……
 */
export function fromFreeMind(xml: string, opts?: { readonly uid?: string }): MindMapDoc {
  const uid = opts?.uid ?? 'freemind-import';
  const root = parseXml(xml);
  const rootNodeEl = root.tag === 'node' ? root : findChild(root, 'node');

  const nodes: Record<NodeKey, MindMapNode> = {};
  const edges: MindMapEdge[] = [];
  const usedKeys = new Set<NodeKey>();
  let counter = 0;
  let edgeCounter = 0;
  const nextSyntheticKey = (): NodeKey => {
    let k = `n${counter++}`;
    while (usedKeys.has(k)) k = `n${counter++}`;
    return k;
  };

  function buildNode(el: XmlElement): NodeKey {
    const rawId = el.attrs['ID'];
    const key = rawId && rawId.length > 0 ? rawId : nextSyntheticKey();
    usedKeys.add(key);
    const text = el.attrs['TEXT'] ?? '';
    const collapsed = el.attrs['FOLDED'] === 'true';
    const children = findChildren(el, 'node').map((c) => buildNode(c));
    const richcontent = findChildren(el, 'richcontent').find((c) => c.attrs['TYPE'] === 'NOTE');
    const noteMd = richcontent ? extractRichText(richcontent) : undefined;

    for (const arrow of findChildren(el, 'arrowlink')) {
      const dest = arrow.attrs['DESTINATION'];
      if (dest) edges.push({ key: `e${edgeCounter++}`, from: key, to: dest });
    }

    nodes[key] = {
      key,
      text,
      children,
      ...(noteMd !== undefined ? { noteMd } : {}),
      ...(collapsed ? { collapsed: true } : {}),
    };
    return key;
  }

  let rootKey: NodeKey;
  if (rootNodeEl) {
    rootKey = buildNode(rootNodeEl);
  } else {
    rootKey = nextSyntheticKey();
    nodes[rootKey] = { key: rootKey, text: '', children: [] };
  }

  return {
    schemaVersion: MINDMAP_SCHEMA_VERSION,
    uid,
    title: nodes[rootKey]?.text ?? '',
    rootKey,
    revision: 0,
    nodes,
    ...(edges.length ? { edges } : {}),
  };
}
