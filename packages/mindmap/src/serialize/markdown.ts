/**
 * Markdown 序列化（D-02 §2.4）。mind-elixir/markmap 都不提供通用 Markdown 往返
 * （见 D-02 §2.3 已核实的结论），所以这里自己实现，且是与 markmap 的桥。
 *
 * 两种输出风格：
 *   - `list`（默认）：根节点渲染成 `# title`，其余全部是嵌套 `- item`（每层缩进 2 空格）。
 *   - `headings`：深度 1-6 用 `#`..`######`，超过 6 级（heading 已经封顶）自动降级成
 *     嵌套列表挂在最后一个 heading 下面。
 *
 * 往返关键决策：Markdown 本身没有"一行内嵌换行"的安全语法，而节点 text/noteMd
 * 可能包含真实换行（见 hostile-text 测试）。我们把 `\`/`\n`/`\r` 转成两字符转义序列
 * （`\\`/`\n`/`\r`），保证每个节点在源文件里始终是恰好一行——`fromMarkdown` 按行解析
 * 才可能成立。这是我们自己的私有转义，不是 CommonMark 语法的一部分。
 */
import {
  MINDMAP_SCHEMA_VERSION,
  walk,
  type MindMapDoc,
  type MindMapNode,
  type NodeKey,
} from '../types.js';

export interface ToMarkdownOptions {
  readonly style?: 'headings' | 'list';
  readonly includeTimestamps?: boolean;
}

export interface FromMarkdownOptions {
  readonly uid?: string;
}

const MAX_HEADING_DEPTH = 5; // depth 0..5 → level 1..6；depth 6+ 降级为列表

function escapeMdText(s: string): string {
  return s.replace(/\\|\n|\r/g, (m) => (m === '\\' ? '\\\\' : m === '\n' ? '\\n' : '\\r'));
}

function unescapeMdText(s: string): string {
  return s.replace(/\\(.)/g, (whole, c: string) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === '\\') return '\\';
    return whole; // 未知转义：原样保留（宽容处理手写 Markdown）
  });
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (v: number): string => String(v).padStart(2, '0');
  return h >= 1 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function timestampSuffix(node: MindMapNode, includeTimestamps: boolean): string {
  if (!includeTimestamps) return '';
  const ref = node.refs?.[0];
  if (!ref) return '';
  return ` [${formatTimestamp(ref.startMs)}]`;
}

/** `MindMapDoc` → Markdown。不经渲染器，纯从数据模型直出（D-02 §2.4）。 */
export function toMarkdown(doc: MindMapDoc, opts?: ToMarkdownOptions): string {
  const style = opts?.style ?? 'list';
  const includeTimestamps = opts?.includeTimestamps ?? false;
  const lines: string[] = [];

  for (const { node, depth } of walk(doc)) {
    const textLine = escapeMdText(node.text) + timestampSuffix(node, includeTimestamps);

    if (depth === 0) {
      lines.push(`# ${textLine}`);
    } else if (style === 'headings' && depth <= MAX_HEADING_DEPTH) {
      lines.push(`${'#'.repeat(depth + 1)} ${textLine}`);
    } else {
      const indentUnits = style === 'headings' ? depth - (MAX_HEADING_DEPTH + 1) : depth - 1;
      lines.push(`${' '.repeat(indentUnits * 2)}- ${textLine}`);
    }

    if (node.noteMd) {
      // note 缩进比节点自身深一级：无论节点是 heading 还是列表项，统一按 (depth+1)*2
      // 空格——note 的挂载在解析时靠"紧跟在节点后面"判定，不依赖精确缩进量。
      lines.push(`${' '.repeat((depth + 1) * 2)}> ${escapeMdText(node.noteMd)}`);
    }
  }

  return lines.join('\n') + '\n';
}

interface StackEntry {
  readonly key: NodeKey;
  readonly depth: number;
  /** heading 行为 null；list 行记录前导空格数，用于判定列表内部嵌套关系。 */
  readonly listIndent: number | null;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const LIST_RE = /^( *)[-*][ \t]+(.*)$/;
const NOTE_RE = /^[ \t]*>[ \t]?(.*)$/;

/**
 * Markdown → `MindMapDoc`。同时识别 `headings` 与 `list` 两种风格（甚至混用）——
 * 判定逻辑不依赖"当前是哪种风格"，而是统一按每一行自身的深度信息（heading 用
 * `#` 个数，list 用缩进）做一个通用的栈式嵌套解析：list 行如果紧跟在 heading 后面
 * 且没有更浅缩进的 list 行，就挂在该 heading 下；否则挂在最近一个缩进更浅的 list 行下。
 * 这套逻辑对两种风格都成立，不需要预先探测风格。
 */
export function fromMarkdown(md: string, opts?: FromMarkdownOptions): MindMapDoc {
  const uid = opts?.uid ?? 'md-import';
  const rawLines = md.split(/\r\n|\n/);

  const nodes: Record<NodeKey, MindMapNode> = {};
  const childrenMap: Record<NodeKey, NodeKey[]> = {};
  let counter = 0;
  const nextKey = (): NodeKey => `n${counter++}`;

  function createNode(text: string): NodeKey {
    const key = nextKey();
    nodes[key] = { key, text, children: [] };
    childrenMap[key] = [];
    return key;
  }
  function addChild(parentKey: NodeKey, key: NodeKey): void {
    const arr = childrenMap[parentKey];
    if (arr) arr.push(key);
  }

  let rootKey: NodeKey | null = null;
  let title = '';
  const stack: StackEntry[] = [];
  let lastNodeKey: NodeKey | null = null;

  for (const line of rawLines) {
    if (line.trim().length === 0) continue;

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = (headingMatch[1] as string).length;
      const text = unescapeMdText(headingMatch[2] as string);
      const depth = level - 1;
      const key = createNode(text);
      if (rootKey === null) {
        rootKey = key;
        title = text;
      } else {
        while (stack.length > 0 && (stack[stack.length - 1] as StackEntry).depth >= depth) {
          stack.pop();
        }
        const parent = stack[stack.length - 1];
        if (parent) addChild(parent.key, key);
      }
      stack.push({ key, depth, listIndent: null });
      lastNodeKey = key;
      continue;
    }

    const listMatch = rootKey !== null ? LIST_RE.exec(line) : null;
    if (listMatch) {
      const indent = (listMatch[1] as string).length;
      const text = unescapeMdText(listMatch[2] as string);
      while (stack.length > 0) {
        const top = stack[stack.length - 1] as StackEntry;
        if (top.listIndent !== null && top.listIndent >= indent) {
          stack.pop();
        } else {
          break;
        }
      }
      const parent = stack[stack.length - 1];
      const depth = (parent?.depth ?? -1) + 1;
      const key = createNode(text);
      if (parent) addChild(parent.key, key);
      stack.push({ key, depth, listIndent: indent });
      lastNodeKey = key;
      continue;
    }

    const noteMatch = NOTE_RE.exec(line);
    if (noteMatch && lastNodeKey !== null) {
      const noteText = unescapeMdText(noteMatch[1] as string);
      const existing = nodes[lastNodeKey] as MindMapNode;
      nodes[lastNodeKey] = {
        ...existing,
        noteMd: existing.noteMd ? `${existing.noteMd}\n${noteText}` : noteText,
      };
      continue;
    }
    // 无法识别的行（既不是 heading/list/note）：宽容跳过，不抛异常
  }

  if (rootKey === null) {
    // 没识别出任何标题行——退化为空文档，避免异常打断批量导入调用方
    const key = nextKey();
    return {
      schemaVersion: MINDMAP_SCHEMA_VERSION,
      uid,
      title: '',
      rootKey: key,
      revision: 0,
      nodes: { [key]: { key, text: '', children: [] } },
    };
  }

  for (const key of Object.keys(nodes)) {
    nodes[key] = { ...(nodes[key] as MindMapNode), children: childrenMap[key] ?? [] };
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
