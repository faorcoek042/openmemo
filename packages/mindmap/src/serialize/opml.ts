/**
 * OPML 2.0 序列化（D-02 §2.4）。
 *
 * 顺带在这里实现一个极简的手写 XML 解析器/转义工具（`parseXml`/`escapeXml`/`unescapeXml`/
 * `findChild`），因为规格明确要求"不加 npm 依赖"。这些工具同时被 `freemind.ts` 复用，
 * 避免两处各写一份、行为漂移。
 *
 * 我们产出/消费的 XML 是一个**很窄的子集**：元素 + 属性 + 自闭合标签，没有 CDATA、
 * 没有命名空间、没有处理指令以外的杂项。因此解析器刻意不追求完整 XML 1.0 合规
 * （例如属性值里的字面换行按 XML 规范应做"属性值规整化"变成空格，我们**不做**这一步，
 * 因为往返保真比规范合规更重要——节点文本里的换行必须原样带回来）。
 */
import {
  MINDMAP_SCHEMA_VERSION,
  type MindMapDoc,
  type MindMapNode,
  type NodeKey,
} from '../types.js';

// ---------------------------------------------------------------------------
// 极简 XML：转义 / 反转义
// ---------------------------------------------------------------------------

/** 转义 XML 5 个预定义实体。用于属性值和文本节点。 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** 反转义：5 个命名实体 + 数字字符引用（十进制 `&#NN;` / 十六进制 `&#xHH;`）。 */
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    const named = NAMED_ENTITIES[ent];
    if (named !== undefined) return named;
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const code = Number.parseInt(ent.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (ent.startsWith('#')) {
      const code = Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole; // 未知实体：原样保留，不猜测
  });
}

// ---------------------------------------------------------------------------
// 极简 XML：解析
// ---------------------------------------------------------------------------

/** 解析出的元素节点。`text` 是该元素直接子文本节点拼接后的（已反转义）内容。 */
export interface XmlElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly text: string;
}

/** 在 `el` 的直接子元素中找第一个标签名匹配的。找不到返回 undefined。 */
export function findChild(el: XmlElement, tag: string): XmlElement | undefined {
  return el.children.find((c) => c.tag === tag);
}

/** 在 `el` 的直接子元素中找所有标签名匹配的。 */
export function findChildren(el: XmlElement, tag: string): readonly XmlElement[] {
  return el.children.filter((c) => c.tag === tag);
}

const WHITESPACE_RE = /\s/;
const NAME_STOP_RE = /[\s/>=]/;
const UNQUOTED_ATTR_STOP_RE = /[\s/>]/;

/**
 * 递归下降解析器。返回文档的根元素（跳过 `<?xml ...?>`、`<!DOCTYPE ...>`、注释）。
 * 约 100 行——够用，不追求通用 XML 合规。
 */
export function parseXml(xml: string): XmlElement {
  let i = 0;
  const n = xml.length;

  function skipWhitespace(): void {
    while (i < n && WHITESPACE_RE.test(xml[i] as string)) i++;
  }

  function skipPrologAndMisc(): void {
    for (;;) {
      skipWhitespace();
      if (xml.startsWith('<?', i)) {
        const end = xml.indexOf('?>', i);
        i = end === -1 ? n : end + 2;
        continue;
      }
      if (xml.startsWith('<!--', i)) {
        const end = xml.indexOf('-->', i);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml.startsWith('<!', i)) {
        const end = xml.indexOf('>', i);
        i = end === -1 ? n : end + 1;
        continue;
      }
      break;
    }
  }

  function parseName(): string {
    const start = i;
    while (i < n && !NAME_STOP_RE.test(xml[i] as string)) i++;
    return xml.slice(start, i);
  }

  function parseAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWhitespace();
      if (i >= n) break;
      const c = xml[i];
      if (c === '/' || c === '>') break;
      const name = parseName();
      if (name.length === 0) {
        // 卡住了（非法字符），前进一位避免死循环
        i++;
        continue;
      }
      skipWhitespace();
      if (xml[i] === '=') {
        i++;
        skipWhitespace();
        const quote = xml[i];
        if (quote === '"' || quote === "'") {
          i++;
          const start = i;
          while (i < n && xml[i] !== quote) i++;
          const raw = xml.slice(start, i);
          if (i < n) i++; // 跳过闭合引号
          attrs[name] = unescapeXml(raw);
        } else {
          const start = i;
          while (i < n && !UNQUOTED_ATTR_STOP_RE.test(xml[i] as string)) i++;
          attrs[name] = unescapeXml(xml.slice(start, i));
        }
      } else {
        attrs[name] = '';
      }
    }
    return attrs;
  }

  function parseElement(): XmlElement {
    // 前置条件：xml[i] === '<'
    i++; // 跳过 '<'
    const tag = parseName();
    const attrs = parseAttrs();
    skipWhitespace();
    if (xml[i] === '/' && xml[i + 1] === '>') {
      i += 2;
      return { tag, attrs, children: [], text: '' };
    }
    if (xml[i] === '>') i++;
    const children: XmlElement[] = [];
    let text = '';
    for (;;) {
      if (i >= n) break;
      if (xml.startsWith('</', i)) {
        const end = xml.indexOf('>', i);
        i = end === -1 ? n : end + 1;
        break;
      }
      if (xml.startsWith('<!--', i)) {
        const end = xml.indexOf('-->', i);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml[i] === '<') {
        children.push(parseElement());
      } else {
        const start = i;
        while (i < n && xml[i] !== '<') i++;
        text += unescapeXml(xml.slice(start, i));
      }
    }
    return { tag, attrs, children, text };
  }

  skipPrologAndMisc();
  skipWhitespace();
  return parseElement();
}

// ---------------------------------------------------------------------------
// OPML 2.0
// ---------------------------------------------------------------------------

/**
 * 导出为 OPML 2.0。`<head><title>` 存 `doc.title`（与根节点 `text` 分开存，
 * 二者语义不同：前者是文档标题，后者是根节点的显示文本，二者往返都保真）。
 */
export function toOpml(doc: MindMapDoc): string {
  const body = renderOutline(doc, doc.rootKey, 2, new Set());
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXml(doc.title)}</title>`,
    '  </head>',
    '  <body>',
    body,
    '  </body>',
    '</opml>',
  ];
  return lines.join('\n') + '\n';
}

function renderOutline(doc: MindMapDoc, key: NodeKey, indent: number, seen: Set<NodeKey>): string {
  if (seen.has(key)) return ''; // 防环兜底；正常文档已由 validate() 保证是树
  seen.add(key);
  const node = doc.nodes[key];
  if (!node) return '';
  const pad = '  '.repeat(indent);
  const attrs = [`text="${escapeXml(node.text)}"`];
  if (node.noteMd) attrs.push(`_note="${escapeXml(node.noteMd)}"`);
  if (node.collapsed) attrs.push('_collapsed="true"');
  if (node.children.length === 0) {
    return `${pad}<outline ${attrs.join(' ')}/>`;
  }
  const childXml = node.children
    .map((c) => renderOutline(doc, c, indent + 1, seen))
    .filter((s) => s.length > 0)
    .join('\n');
  return `${pad}<outline ${attrs.join(' ')}>\n${childXml}\n${pad}</outline>`;
}

/** 从 OPML 反解析。生成稳定 key：`n0`、`n1`……按文档序（先序遍历）。 */
export function fromOpml(xml: string, opts?: { readonly uid?: string }): MindMapDoc {
  const uid = opts?.uid ?? 'opml-import';
  const root = parseXml(xml);
  const head = findChild(root, 'head');
  const titleEl = head ? findChild(head, 'title') : undefined;
  const title = titleEl?.text ?? '';
  const body = findChild(root, 'body');
  const outlines = body ? findChildren(body, 'outline') : [];

  const nodes: Record<NodeKey, MindMapNode> = {};
  let counter = 0;
  const nextKey = (): NodeKey => `n${counter++}`;

  function buildFromOutline(el: XmlElement): NodeKey {
    const key = nextKey();
    const text = el.attrs['text'] ?? '';
    const noteMd = el.attrs['_note'];
    const collapsed = el.attrs['_collapsed'] === 'true';
    const children = findChildren(el, 'outline').map((c) => buildFromOutline(c));
    nodes[key] = {
      key,
      text,
      children,
      ...(noteMd ? { noteMd } : {}),
      ...(collapsed ? { collapsed: true } : {}),
    };
    return key;
  }

  let rootKey: NodeKey;
  if (outlines.length === 1) {
    rootKey = buildFromOutline(outlines[0] as XmlElement);
  } else if (outlines.length > 1) {
    // OPML body 允许多个顶层 outline；我们的 schema 要求单根，合成一个虚拟根
    rootKey = nextKey();
    const children = outlines.map((o) => buildFromOutline(o));
    nodes[rootKey] = { key: rootKey, text: title, children };
  } else {
    rootKey = nextKey();
    nodes[rootKey] = { key: rootKey, text: title, children: [] };
  }

  return {
    schemaVersion: MINDMAP_SCHEMA_VERSION,
    uid,
    title,
    rootKey,
    revision: 0,
    nodes,
  };
}
