/**
 * 三种导出格式（Markdown / OPML / FreeMind）的往返测试。
 *
 * 覆盖点（任务要求）：
 *   - 三种格式各自的往返（层级 + 文本）
 *   - 敌意文本（XML/Markdown 特殊字符 + 中文）不失真
 *   - 深树（depth 10）/ 宽树（50 子节点）
 *   - FreeMind 自由连线（edges）往返
 *   - 所有产出的 doc 都要 validate() 通过
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { walk, MINDMAP_SCHEMA_VERSION, type MindMapDoc, type MindMapNode } from '../types.js';
import { validate } from '../validate.js';
import { toFreeMind, fromFreeMind } from './freemind.js';
import { toMarkdown, fromMarkdown } from './markdown.js';
import { toOpml, fromOpml } from './opml.js';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

function buildDoc(nodes: Record<string, MindMapNode>, rootKey: string): MindMapDoc {
  return {
    schemaVersion: MINDMAP_SCHEMA_VERSION,
    uid: 'test-uid',
    title: (nodes[rootKey] as MindMapNode).text,
    rootKey,
    revision: 0,
    nodes,
  };
}

function simpleDoc(): MindMapDoc {
  const nodes: Record<string, MindMapNode> = {
    root: { key: 'root', text: 'Root', children: ['c1', 'c2'] },
    c1: { key: 'c1', text: 'Child 1', children: ['g1'] },
    c2: { key: 'c2', text: 'Child 2', children: [], noteMd: 'a plain note' },
    g1: { key: 'g1', text: 'Grandchild 1', children: [] },
  };
  return buildDoc(nodes, 'root');
}

/** depth 层链条：root -> d1 -> d2 -> ... -> d{depth} */
function deepDoc(depth: number): MindMapDoc {
  const nodes: Record<string, MindMapNode> = {
    root: { key: 'root', text: 'Root', children: depth >= 1 ? ['d1'] : [] },
  };
  for (let i = 1; i <= depth; i++) {
    const key = `d${i}`;
    const child = i < depth ? [`d${i + 1}`] : [];
    nodes[key] = { key, text: `Level ${i}`, children: child };
  }
  return buildDoc(nodes, 'root');
}

/** 宽树：root 直接挂 n 个子节点 */
function wideDoc(count: number): MindMapDoc {
  const children: string[] = [];
  const nodes: Record<string, MindMapNode> = {
    root: { key: 'root', text: 'Root', children },
  };
  for (let i = 0; i < count; i++) {
    const key = `w${i}`;
    children.push(key);
    nodes[key] = { key, text: `Sibling ${i}`, children: [] };
  }
  nodes['root'] = { key: 'root', text: 'Root', children };
  return buildDoc(nodes, 'root');
}

/** DFS 先序遍历签名：(depth, text, noteMd)，用来在 key 不保证一致的往返里比较结构。 */
function signature(doc: MindMapDoc): Array<{ depth: number; text: string; noteMd: string | null }> {
  return [...walk(doc)].map(({ node, depth }) => ({
    depth,
    text: node.text,
    noteMd: node.noteMd ?? null,
  }));
}

function assertValid(doc: MindMapDoc, label: string): void {
  const result = validate(doc);
  assert.equal(result.ok, true, `${label} 未通过 validate(): ${JSON.stringify(result.issues)}`);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

describe('markdown 序列化', () => {
  it('list 风格（默认）往返保持层级与文本', () => {
    const doc = simpleDoc();
    assertValid(doc, 'simpleDoc');
    const md = toMarkdown(doc);
    const back = fromMarkdown(md);
    assertValid(back, 'markdown list 往返结果');
    assert.deepEqual(signature(back), signature(doc));
    assert.equal(back.title, doc.title);
    assert.equal(back.rootKey, 'n0');
  });

  it('headings 风格往返保持层级与文本', () => {
    const doc = simpleDoc();
    const md = toMarkdown(doc, { style: 'headings' });
    assert.match(md, /^# Root/);
    assert.match(md, /## Child 1/);
    const back = fromMarkdown(md);
    assertValid(back, 'markdown headings 往返结果');
    assert.deepEqual(signature(back), signature(doc));
  });

  it('headings 风格深度超过 6 级自动降级为嵌套列表，仍可往返', () => {
    const doc = deepDoc(10);
    assertValid(doc, 'deepDoc(10)');
    const md = toMarkdown(doc, { style: 'headings' });
    // depth 0..5 -> level1..6 (# .. ######)；depth 6+ 降级为列表
    assert.match(md, /^# Root/m);
    assert.match(md, /^###### Level 5/m);
    assert.doesNotMatch(md, /^#######/m); // 不存在 7 个 # 的行
    assert.match(md, /^- Level 6/m);
    const back = fromMarkdown(md);
    assertValid(back, 'markdown headings 深树往返结果');
    assert.deepEqual(signature(back), signature(doc));
  });

  it('note 渲染为缩进 blockquote 行，往返保留', () => {
    const doc = simpleDoc();
    const md = toMarkdown(doc);
    assert.match(md, /^\s*> a plain note$/m);
    const back = fromMarkdown(md);
    assert.deepEqual(signature(back), signature(doc));
  });

  it('includeTimestamps 附加 [mm:ss] / [h:mm:ss]', () => {
    const nodes: Record<string, MindMapNode> = {
      root: { key: 'root', text: 'Root', children: ['a', 'b'] },
      a: {
        key: 'a',
        text: 'A',
        children: [],
        refs: [{ transcriptUid: 't1', startMs: 83000, endMs: 84000, quote: 'x' }], // 83s = 1:23
      },
      b: {
        key: 'b',
        text: 'B',
        children: [],
        refs: [{ transcriptUid: 't1', startMs: 3723000, endMs: 3724000, quote: 'y' }], // 1h2m3s
      },
    };
    const doc = buildDoc(nodes, 'root');
    assertValid(doc, 'timestamp doc');
    const md = toMarkdown(doc, { includeTimestamps: true });
    assert.match(md, /A \[01:23\]/);
    assert.match(md, /B \[1:02:03\]/);

    const mdWithout = toMarkdown(doc);
    assert.doesNotMatch(mdWithout, /\[01:23\]/);
  });

  it('宽树（50 子节点）往返保持顺序与数量', () => {
    const doc = wideDoc(50);
    assertValid(doc, 'wideDoc(50)');
    const back = fromMarkdown(toMarkdown(doc));
    assertValid(back, 'markdown 宽树往返结果');
    assert.deepEqual(signature(back), signature(doc));
    const rootChildren = back.nodes[back.rootKey]?.children ?? [];
    assert.equal(rootChildren.length, 50);
  });
});

// ---------------------------------------------------------------------------
// OPML
// ---------------------------------------------------------------------------

describe('OPML 序列化', () => {
  it('往返保持层级、文本、note、title', () => {
    const doc = simpleDoc();
    const xml = toOpml(doc);
    assert.match(xml, /<opml version="2.0">/);
    const back = fromOpml(xml);
    assertValid(back, 'opml 往返结果');
    assert.deepEqual(signature(back), signature(doc));
    assert.equal(back.title, doc.title);
  });

  it('collapsed 往返为 _collapsed="true"', () => {
    const nodes: Record<string, MindMapNode> = {
      root: { key: 'root', text: 'Root', children: ['c1'] },
      c1: { key: 'c1', text: 'Child', children: [], collapsed: true },
    };
    const doc = buildDoc(nodes, 'root');
    const xml = toOpml(doc);
    assert.match(xml, /_collapsed="true"/);
    const back = fromOpml(xml);
    const c1Key = back.nodes[back.rootKey]?.children[0] as string;
    assert.equal(back.nodes[c1Key]?.collapsed, true);
  });

  it('深树（depth 10）与宽树（50 子节点）往返保持结构', () => {
    for (const doc of [deepDoc(10), wideDoc(50)]) {
      assertValid(doc, 'opml 压力 doc');
      const back = fromOpml(toOpml(doc));
      assertValid(back, 'opml 压力往返结果');
      assert.deepEqual(signature(back), signature(doc));
    }
  });
});

// ---------------------------------------------------------------------------
// FreeMind
// ---------------------------------------------------------------------------

describe('FreeMind 序列化', () => {
  it('往返保持层级、文本、note', () => {
    const doc = simpleDoc();
    const xml = toFreeMind(doc);
    assert.match(xml, /<map version="1.0.1">/);
    const back = fromFreeMind(xml);
    assertValid(back, 'freemind 往返结果');
    assert.deepEqual(signature(back), signature(doc));
  });

  it('key 通过 ID 属性原样往返（导出用 doc 自己的 key 做 ID）', () => {
    const doc = simpleDoc();
    const back = fromFreeMind(toFreeMind(doc));
    assert.equal(back.rootKey, 'root');
    assert.deepEqual([...back.nodes[back.rootKey]!.children].sort(), ['c1', 'c2']);
  });

  it('FOLDED="true" 往返为 collapsed', () => {
    const nodes: Record<string, MindMapNode> = {
      root: { key: 'root', text: 'Root', children: ['c1'] },
      c1: { key: 'c1', text: 'Child', children: [], collapsed: true },
    };
    const doc = buildDoc(nodes, 'root');
    const xml = toFreeMind(doc);
    assert.match(xml, /FOLDED="true"/);
    const back = fromFreeMind(xml);
    assert.equal(back.nodes['c1']?.collapsed, true);
  });

  it('自由连线（edges）往返进 arrowlink 再还原', () => {
    const nodes: Record<string, MindMapNode> = {
      root: { key: 'root', text: 'Root', children: ['c1', 'c2', 'c3'] },
      c1: { key: 'c1', text: 'A', children: [] },
      c2: { key: 'c2', text: 'B', children: [] },
      c3: { key: 'c3', text: 'C', children: [] },
    };
    const doc: MindMapDoc = {
      ...buildDoc(nodes, 'root'),
      edges: [
        { key: 'e1', from: 'c1', to: 'c2' },
        { key: 'e2', from: 'c2', to: 'c3', label: 'depends on' },
      ],
    };
    assertValid(doc, 'edges doc');
    const xml = toFreeMind(doc);
    assert.match(xml, /<arrowlink DESTINATION="c2" STARTARROW="None" ENDARROW="Default"\/>/);
    assert.match(xml, /<arrowlink DESTINATION="c3" STARTARROW="None" ENDARROW="Default"\/>/);

    const back = fromFreeMind(xml);
    assertValid(back, 'freemind edges 往返结果');
    assert.equal(back.edges?.length, 2);
    const pairs = (back.edges ?? []).map((e) => `${e.from}->${e.to}`).sort();
    assert.deepEqual(pairs, ['c1->c2', 'c2->c3']);
  });

  it('深树（depth 10）与宽树（50 子节点）往返保持结构', () => {
    for (const doc of [deepDoc(10), wideDoc(50)]) {
      assertValid(doc, 'freemind 压力 doc');
      const back = fromFreeMind(toFreeMind(doc));
      assertValid(back, 'freemind 压力往返结果');
      assert.deepEqual(signature(back), signature(doc));
    }
  });
});

// ---------------------------------------------------------------------------
// 敌意文本：XML/Markdown 特殊字符 + 中文，三种格式都不能失真
// ---------------------------------------------------------------------------

describe('敌意文本往返', () => {
  const hostile = 'A & B <tag> "quoted" \'single\' \n';
  const chinese = '思维导图 & 转写稿 <重点>';

  function hostileDoc(): MindMapDoc {
    const nodes: Record<string, MindMapNode> = {
      root: { key: 'root', text: hostile, children: ['c1'] },
      c1: { key: 'c1', text: chinese, children: [], noteMd: hostile },
    };
    return buildDoc(nodes, 'root');
  }

  it('markdown 往返保留敌意文本与中文（含字面换行）', () => {
    const doc = hostileDoc();
    assertValid(doc, 'hostileDoc');
    const back = fromMarkdown(toMarkdown(doc));
    assertValid(back, 'markdown 敌意文本往返结果');
    assert.deepEqual(signature(back), signature(doc));
  });

  it('OPML 往返保留敌意文本与中文（含字面换行）', () => {
    const doc = hostileDoc();
    const back = fromOpml(toOpml(doc));
    assertValid(back, 'opml 敌意文本往返结果');
    assert.deepEqual(signature(back), signature(doc));
  });

  it('FreeMind 往返保留敌意文本与中文（含字面换行）', () => {
    const doc = hostileDoc();
    const back = fromFreeMind(toFreeMind(doc));
    assertValid(back, 'freemind 敌意文本往返结果');
    assert.deepEqual(signature(back), signature(doc));
  });

  it('XML 输出里特殊字符确实被转义了（不是裸露的 & < >）', () => {
    const doc = hostileDoc();
    const opmlXml = toOpml(doc);
    const mmXml = toFreeMind(doc);
    for (const xml of [opmlXml, mmXml]) {
      // 属性值里不应该出现未转义的裸 & < "（单引号属性值本身用双引号包裹，允许裸 '）
      assert.doesNotMatch(xml.replace(/&(amp|lt|gt|quot|apos);/g, ''), /&/);
    }
  });
});
