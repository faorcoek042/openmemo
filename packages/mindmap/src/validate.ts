/**
 * `MindMapDoc` 校验（D-02 §2.2 约束 5）。
 *
 * **写库前必调。** 理由很具体：LLM 会生成环和悬空引用，
 * 不校验就等着渲染器栈溢出 —— 而且是在用户面前崩，不是在测试里。
 */
import {
  LIMITS,
  type MindMapDoc,
  type MindMapNode,
  type NodeKey,
  MINDMAP_SCHEMA_VERSION,
} from './types.js';

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly nodeKey?: NodeKey;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

export class MindMapValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(`思维导图校验失败（${issues.length} 项）：${issues.map((i) => i.code).join(', ')}`);
    this.name = 'MindMapValidationError';
  }
}

/**
 * 全量校验。**不抛异常**，返回问题清单 —— 调用方（尤其 LLM 生成路径）
 * 需要拿到具体问题来决定"重试还是修复"。
 */
export function validate(doc: MindMapDoc): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (code: string, message: string, nodeKey?: NodeKey): void => {
    issues.push(nodeKey === undefined ? { code, message } : { code, message, nodeKey });
  };

  if (doc.schemaVersion !== MINDMAP_SCHEMA_VERSION) {
    add(
      'SCHEMA_VERSION',
      `schemaVersion 应为 ${MINDMAP_SCHEMA_VERSION}，实际 ${doc.schemaVersion}`,
    );
  }
  if (!doc.nodes || typeof doc.nodes !== 'object') {
    add('NO_NODES', 'nodes 缺失或不是对象');
    return { ok: false, issues };
  }

  const keys = Object.keys(doc.nodes);
  if (keys.length === 0) {
    add('EMPTY', 'nodes 为空');
    return { ok: false, issues };
  }
  if (keys.length > LIMITS.maxNodes) {
    add('TOO_MANY_NODES', `节点数 ${keys.length} 超过上限 ${LIMITS.maxNodes}`);
  }

  // ---- 单根 ----
  if (!doc.nodes[doc.rootKey]) {
    add('MISSING_ROOT', `rootKey=${doc.rootKey} 在 nodes 中不存在`);
    return { ok: false, issues };
  }

  // ---- 逐节点基础校验 + 悬空引用 ----
  const childCount = new Map<NodeKey, number>();
  for (const key of keys) {
    const node = doc.nodes[key] as MindMapNode;
    if (node.key !== key) {
      add('KEY_MISMATCH', `nodes["${key}"].key = "${node.key}"，与索引键不一致`, key);
    }
    if (typeof node.text !== 'string') {
      add('TEXT_TYPE', 'text 必须是字符串', key);
    } else if (node.text.length > LIMITS.maxTextLength) {
      add('TEXT_TOO_LONG', `text 长度 ${node.text.length} 超过 ${LIMITS.maxTextLength}`, key);
    }
    if (!Array.isArray(node.children)) {
      add('CHILDREN_TYPE', 'children 必须是数组', key);
      continue;
    }
    const seenChild = new Set<NodeKey>();
    for (const c of node.children) {
      if (!doc.nodes[c]) add('DANGLING_CHILD', `children 引用了不存在的节点 "${c}"`, key);
      if (seenChild.has(c)) add('DUPLICATE_CHILD', `children 中重复引用 "${c}"`, key);
      seenChild.add(c);
      childCount.set(c, (childCount.get(c) ?? 0) + 1);
    }
    // refs 的 quote 是必填（D-02 §3.5：没有它重转写必然丢链接）
    for (const ref of node.refs ?? []) {
      if (!ref.quote || ref.quote.trim().length === 0) {
        add('REF_MISSING_QUOTE', 'refs[].quote 必填，否则重转写后无法重定位', key);
      } else if (ref.quote.length > LIMITS.maxQuoteLength) {
        add('REF_QUOTE_TOO_LONG', `quote 超过 ${LIMITS.maxQuoteLength} 字`, key);
      }
      if (!Number.isFinite(ref.startMs) || !Number.isFinite(ref.endMs)) {
        add('REF_BAD_TIME', 'refs[].startMs/endMs 必须是有限数字', key);
      } else if (ref.endMs < ref.startMs) {
        add('REF_TIME_INVERTED', `refs[] 时间倒置：${ref.startMs} > ${ref.endMs}`, key);
      }
    }
  }

  // ---- 多父 / 非根却无父 ----
  for (const key of keys) {
    const parents = childCount.get(key) ?? 0;
    if (key === doc.rootKey && parents > 0) {
      add('ROOT_HAS_PARENT', '根节点不应被任何节点引用为 child', key);
    }
    if (key !== doc.rootKey && parents === 0) {
      add('ORPHAN', '非根节点没有父节点（不可达）', key);
    }
    if (parents > 1) {
      add('MULTI_PARENT', `节点被 ${parents} 个父节点引用（导图必须是树）`, key);
    }
  }

  // ---- 环检测 + 深度（迭代实现，避免深图把校验器自己爆栈）----
  const state = new Map<NodeKey, 0 | 1 | 2>(); // 0=未访问 1=在栈上 2=已完成
  let maxDepth = 0;
  const stack: Array<{ key: NodeKey; depth: number; childIndex: number }> = [
    { key: doc.rootKey, depth: 0, childIndex: 0 },
  ];
  state.set(doc.rootKey, 1);
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (!top) break;
    const node = doc.nodes[top.key];
    maxDepth = Math.max(maxDepth, top.depth);
    if (!node || top.childIndex >= node.children.length) {
      state.set(top.key, 2);
      stack.pop();
      continue;
    }
    const childKey = node.children[top.childIndex++] as NodeKey;
    if (!doc.nodes[childKey]) continue; // 悬空已在上面报过
    const st = state.get(childKey) ?? 0;
    if (st === 1) {
      add('CYCLE', `检测到环：${top.key} → ${childKey}`, childKey);
      continue;
    }
    if (st === 2) continue; // 已完成（多父场景，上面已报）
    state.set(childKey, 1);
    stack.push({ key: childKey, depth: top.depth + 1, childIndex: 0 });
  }

  if (maxDepth > LIMITS.maxDepth) {
    add('TOO_DEEP', `深度 ${maxDepth} 超过上限 ${LIMITS.maxDepth}`);
  }

  // ---- edges / summaries 引用完整性 ----
  for (const e of doc.edges ?? []) {
    if (!doc.nodes[e.from]) add('EDGE_DANGLING', `edge ${e.key} 的 from="${e.from}" 不存在`);
    if (!doc.nodes[e.to]) add('EDGE_DANGLING', `edge ${e.key} 的 to="${e.to}" 不存在`);
  }
  for (const s of doc.summaries ?? []) {
    const parent = doc.nodes[s.parent];
    if (!parent) {
      add('SUMMARY_DANGLING', `summary ${s.key} 的 parent="${s.parent}" 不存在`);
      continue;
    }
    if (s.fromIndex < 0 || s.toIndex >= parent.children.length || s.fromIndex > s.toIndex) {
      add('SUMMARY_RANGE', `summary ${s.key} 的下标区间越界`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/** 校验并抛出。写库前用这个。 */
export function assertValid(doc: MindMapDoc): void {
  const r = validate(doc);
  if (!r.ok) throw new MindMapValidationError(r.issues);
}

/**
 * 尽力修复 LLM 生成的坏文档 —— **只做无损修复**，修不了的留给调用方重试。
 *
 * 修复项：删悬空 child 引用、去重 child、断环（保留首次出现的边）、
 * 摘掉多父节点的重复引用、丢弃不可达节点。
 * **不修**：缺 root、text 超长、缺 quote —— 那些属于语义问题，应该重新生成。
 */
export function repair(doc: MindMapDoc): MindMapDoc {
  const nodes: Record<NodeKey, MindMapNode> = {};
  for (const [k, v] of Object.entries(doc.nodes)) nodes[k] = { ...v, key: k };

  const claimed = new Set<NodeKey>([doc.rootKey]);
  const visited = new Set<NodeKey>();
  const queue: NodeKey[] = [doc.rootKey];

  while (queue.length > 0) {
    const key = queue.shift() as NodeKey;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = nodes[key];
    if (!node) continue;

    const kept: NodeKey[] = [];
    for (const c of node.children) {
      if (!nodes[c]) continue; // 悬空
      if (c === key) continue; // 自环
      if (claimed.has(c)) continue; // 已被别人认领（多父 / 环）
      claimed.add(c);
      kept.push(c);
      queue.push(c);
    }
    nodes[key] = { ...node, children: kept };
  }

  // 丢弃不可达节点
  for (const k of Object.keys(nodes)) {
    if (!visited.has(k)) delete nodes[k];
  }

  const edges = (doc.edges ?? []).filter((e) => nodes[e.from] && nodes[e.to]);
  const summaries = (doc.summaries ?? []).filter((s) => {
    const p = nodes[s.parent];
    return p && s.fromIndex >= 0 && s.toIndex < p.children.length && s.fromIndex <= s.toIndex;
  });

  return {
    ...doc,
    schemaVersion: MINDMAP_SCHEMA_VERSION,
    nodes,
    ...(edges.length ? { edges } : {}),
    ...(summaries.length ? { summaries } : {}),
  };
}
