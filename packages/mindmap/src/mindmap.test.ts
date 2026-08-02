/**
 * `packages/mindmap` 的核心测试：校验器、修复器、两个适配器、F4 生成流水线。
 *
 * 生成流水线用 **mock provider** 测 —— 这样才能**确定性地**证明
 * "LLM 无法注入时间戳" 这个安全性质（真模型每次输出不同，证不了）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatRequest, ChatResult, LlmProvider, ProviderCapabilities } from '@openmemo/llm';

import { fromMindElixir, toMindElixir } from './adapters/mind-elixir.js';
import { escapeHtml, markmapLoss, toMarkmap } from './adapters/markmap.js';
import { generateMindMap, planWindows, type TranscriptSegment } from './generate.js';
import { emptyDoc, type MindMapDoc, type MindMapNode } from './types.js';
import { repair, validate } from './validate.js';

function doc(
  nodes: Record<string, Partial<MindMapNode> & { key: string }>,
  rootKey = 'r',
): MindMapDoc {
  const full: Record<string, MindMapNode> = {};
  for (const [k, v] of Object.entries(nodes)) {
    full[k] = { text: k, children: [], ...v, key: k } as MindMapNode;
  }
  return { schemaVersion: 1, uid: 'u', title: 't', rootKey, revision: 0, nodes: full };
}

describe('validate', () => {
  it('接受一棵合法的树', () => {
    const d = doc({ r: { key: 'r', children: ['a', 'b'] }, a: { key: 'a' }, b: { key: 'b' } });
    assert.equal(validate(d).ok, true);
  });

  it('检出悬空 child 引用', () => {
    const d = doc({ r: { key: 'r', children: ['ghost'] } });
    const codes = validate(d).issues.map((i) => i.code);
    assert.ok(codes.includes('DANGLING_CHILD'), codes.join(','));
  });

  it('**检出环**（LLM 最常见的坏输出，不拦会让渲染器爆栈）', () => {
    const d = doc({
      r: { key: 'r', children: ['a'] },
      a: { key: 'a', children: ['b'] },
      b: { key: 'b', children: ['a'] },
    });
    const codes = validate(d).issues.map((i) => i.code);
    assert.ok(codes.includes('CYCLE'), codes.join(','));
  });

  it('检出多父（导图必须是树）', () => {
    const d = doc({
      r: { key: 'r', children: ['a', 'b'] },
      a: { key: 'a', children: ['c'] },
      b: { key: 'b', children: ['c'] },
      c: { key: 'c' },
    });
    const codes = validate(d).issues.map((i) => i.code);
    assert.ok(codes.includes('MULTI_PARENT'), codes.join(','));
  });

  it('检出孤儿节点', () => {
    const d = doc({ r: { key: 'r', children: [] }, lonely: { key: 'lonely' } });
    assert.ok(validate(d).issues.some((i) => i.code === 'ORPHAN'));
  });

  it('**refs 缺 quote 必须报错**（D-02 §3.5：没有它重转写就丢链接）', () => {
    const d = doc({
      r: {
        key: 'r',
        refs: [{ transcriptUid: 't', startMs: 0, endMs: 10, quote: '  ' }],
      },
    });
    assert.ok(validate(d).issues.some((i) => i.code === 'REF_MISSING_QUOTE'));
  });

  it('检出 refs 时间倒置', () => {
    const d = doc({
      r: { key: 'r', refs: [{ transcriptUid: 't', startMs: 99, endMs: 1, quote: 'x' }] },
    });
    assert.ok(validate(d).issues.some((i) => i.code === 'REF_TIME_INVERTED'));
  });

  it('深度超限被检出（迭代实现，深图不会把校验器自己爆栈）', () => {
    const nodes: Record<string, Partial<MindMapNode> & { key: string }> = {};
    for (let i = 0; i < 40; i++) {
      nodes[`n${i}`] = { key: `n${i}`, children: i < 39 ? [`n${i + 1}`] : [] };
    }
    const d = doc(nodes, 'n0');
    assert.ok(validate(d).issues.some((i) => i.code === 'TOO_DEEP'));
  });

  it('极深的图（5000 层）不会栈溢出', () => {
    const nodes: Record<string, Partial<MindMapNode> & { key: string }> = {};
    for (let i = 0; i < 5000; i++) {
      nodes[`n${i}`] = { key: `n${i}`, children: i < 4999 ? [`n${i + 1}`] : [] };
    }
    const d = doc(nodes, 'n0');
    assert.doesNotThrow(() => validate(d));
  });
});

describe('repair', () => {
  it('断环 + 删悬空 + 摘多父，修完必然合法', () => {
    const d = doc({
      r: { key: 'r', children: ['a', 'b', 'ghost'] },
      a: { key: 'a', children: ['c'] },
      b: { key: 'b', children: ['c'] },
      c: { key: 'c', children: ['a'] }, // 环
      unreachable: { key: 'unreachable' },
    });
    assert.equal(validate(d).ok, false);
    const fixed = repair(d);
    const v = validate(fixed);
    assert.equal(v.ok, true, JSON.stringify(v.issues));
    assert.equal(fixed.nodes['unreachable'], undefined, '不可达节点应被丢弃');
  });

  it('对本来就合法的文档是幂等的', () => {
    const d = doc({ r: { key: 'r', children: ['a'] }, a: { key: 'a' } });
    assert.deepEqual(repair(repair(d)).nodes, repair(d).nodes);
  });
});

describe('mind-elixir 适配器', () => {
  it('往返保真（含 collapsed↔expanded 取反、direction 数字枚举）', () => {
    const d: MindMapDoc = {
      schemaVersion: 1,
      uid: 'u',
      title: '根',
      rootKey: 'r',
      revision: 3,
      nodes: {
        r: { key: 'r', text: '根', children: ['a'] },
        a: {
          key: 'a',
          text: '子',
          children: [],
          collapsed: true,
          side: 'left',
          noteMd: '备注',
          hyperlink: 'https://example.com',
          icons: ['🔥'],
          tags: ['重要'],
          refs: [{ transcriptUid: 't1', startMs: 1000, endMs: 2000, quote: '原文' }],
        },
      },
      edges: [{ key: 'e1', from: 'r', to: 'a', label: '导致' }],
    };

    const me = toMindElixir(d);
    // collapsed:true → expanded:false（取反，最易写错的一处）
    assert.equal(me.nodeData.children?.[0]?.expanded, false);
    // side:'left' → direction:0（数字枚举不是字符串）
    assert.equal(me.nodeData.children?.[0]?.direction, 0);
    assert.equal(me.arrows?.[0]?.label, '导致');
    // refs 走 metadata（上游提供的泛型扩展位）
    assert.ok(me.nodeData.children?.[0]?.metadata?.['openmemoRefs']);

    const back = fromMindElixir(me, { uid: 'u', title: '根', revision: 3 });
    assert.equal(validate(back).ok, true);
    const a = back.nodes['a'] as MindMapNode;
    assert.equal(a.collapsed, true);
    assert.equal(a.side, 'left');
    assert.equal(a.noteMd, '备注');
    assert.equal(a.hyperlink, 'https://example.com');
    assert.deepEqual(a.icons, ['🔥']);
    assert.equal(a.refs?.[0]?.quote, '原文');
    assert.equal(back.edges?.[0]?.label, '导致');
  });

  it('中文与特殊字符往返不失真', () => {
    const d = doc({ r: { key: 'r', text: '思维导图 & 转写稿 <重点> "引号"', children: [] } });
    const back = fromMindElixir(toMindElixir(d), { uid: 'u' });
    assert.equal((back.nodes['r'] as MindMapNode).text, '思维导图 & 转写稿 <重点> "引号"');
  });
});

describe('markmap 适配器', () => {
  it('**HTML 转义**（content 是 HTML，不转义就是自己给自己开 XSS）', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    const d = doc({ r: { key: 'r', text: '<img src=x onerror=alert(1)>', children: [] } });
    const node = toMarkmap(d);
    assert.ok(!node.content.includes('<img'), `未转义: ${node.content}`);
    assert.ok(node.content.includes('&lt;img'));
  });

  it('collapsed → payload.fold；refs 塞进 payload 供前端 seek', () => {
    const d = doc({
      r: {
        key: 'r',
        children: [],
        collapsed: true,
        refs: [{ transcriptUid: 't', startMs: 65000, endMs: 70000, quote: 'q' }],
      },
    });
    const node = toMarkmap(d);
    assert.equal(node.payload?.['fold'], 1);
    assert.ok(node.payload?.['openmemoRefs']);
    // 时间戳渲染成 1:05
    assert.match(node.content, /1:05/);
  });

  it('损失报告如实反映 markmap 不支持的特性', () => {
    const d: MindMapDoc = {
      ...doc({ r: { key: 'r', children: ['a'] }, a: { key: 'a', style: { color: 'red' } } }),
      edges: [{ key: 'e', from: 'r', to: 'a' }],
    };
    const loss = markmapLoss(d);
    assert.equal(loss.lossy, true);
    assert.equal(loss.edges, 1);
    assert.equal(loss.styledNodes, 1);
  });
});

// ---------------------------------------------------------------------------
// F4 生成：用 mock provider 确定性地验证安全性质
// ---------------------------------------------------------------------------

function mockProvider(replies: string[]): LlmProvider & { calls: ChatRequest[] } {
  let i = 0;
  const calls: ChatRequest[] = [];
  return {
    id: 'mock',
    kind: 'openai-compatible',
    label: 'mock',
    isLocal: true,
    calls,
    capabilities: (): Promise<ProviderCapabilities> =>
      Promise.resolve({
        streaming: false,
        structuredOutput: 'json_schema',
        toolUse: false,
        contextWindow: 8192,
        vision: false,
      }),
    listModels: (): Promise<string[]> => Promise.resolve(['mock']),
    chat: (req: ChatRequest): Promise<ChatResult> => {
      calls.push(req);
      const text = replies[Math.min(i++, replies.length - 1)] ?? '{}';
      return Promise.resolve({ text, model: 'mock', elapsedMs: 1 });
    },
  };
}

const SEGMENTS: TranscriptSegment[] = [
  { startMs: 0, endMs: 5000, text: '第一段：介绍组织的宗旨。' },
  { startMs: 5000, endMs: 11000, text: '第二段：讲团结四亿人。' },
  { startMs: 11000, endMs: 18000, text: '第三段：谈非洲的未来。' },
];

describe('F4 生成流水线', () => {
  it('planWindows 不跨段切，且单段超预算也能自成一窗', () => {
    const wins = planWindows(SEGMENTS, 12);
    assert.ok(wins.length >= 2);
    assert.equal(wins[0]?.start, 0);
    assert.equal(wins.at(-1)?.end, SEGMENTS.length);
    // 覆盖完整、无空洞
    let cursor = 0;
    for (const w of wins) {
      assert.equal(w.start, cursor);
      cursor = w.end;
    }
    assert.equal(cursor, SEGMENTS.length);
  });

  it('**LLM 无法注入时间戳** —— 即使它在输出里编造时间也会被忽略', async () => {
    // 模型故意返回编造的 startMs/endMs/quote，外加合法的 seg 编号
    const evil = JSON.stringify({
      topics: [
        {
          title: '被污染的主题',
          seg: [0, 1],
          startMs: 999_999_999,
          endMs: 999_999_999,
          quote: '这是模型编造的引文，不存在于转写稿中',
          points: [{ text: '要点', seg: [1], startMs: 123456 }],
        },
      ],
    });
    const provider = mockProvider([evil]);
    const res = await generateMindMap(provider, SEGMENTS, {
      transcriptUid: 'tr1',
      uid: 'mm1',
      title: '标题',
      windowChars: 10_000,
    });

    assert.equal(validate(res.doc).ok, true);
    const topic = Object.values(res.doc.nodes).find((n) => n.text === '被污染的主题');
    assert.ok(topic, '主题应存在');
    const ref = topic?.refs?.[0];
    assert.ok(ref);
    // 时间来自真实段落 0..1，不是模型编造的 999999999
    assert.equal(ref?.startMs, 0);
    assert.equal(ref?.endMs, 11000);
    // quote 必须是原文逐字拼接，不是模型编的那句
    assert.ok(ref?.quote.includes('第一段'), `quote=${ref?.quote}`);
    assert.ok(!ref?.quote.includes('编造'), 'quote 绝不能来自模型自由文本');
  });

  it('越界/非法的段落编号被丢弃', async () => {
    const reply = JSON.stringify({
      topics: [
        { title: '好主题', seg: [0, 99, -1, 2.5, 'x'] },
        { title: '全是坏编号', seg: [500, 600] },
      ],
    });
    const provider = mockProvider([reply]);
    const res = await generateMindMap(provider, SEGMENTS, {
      transcriptUid: 'tr1',
      uid: 'mm1',
      title: '标题',
      windowChars: 10_000,
    });
    const titles = Object.values(res.doc.nodes).map((n) => n.text);
    assert.ok(titles.includes('好主题'));
    // 引用不到任何真实段落的主题 = 凭空捏造，必须被丢弃
    assert.ok(!titles.includes('全是坏编号'), '无有效 seg 的主题应被丢弃');
    const good = Object.values(res.doc.nodes).find((n) => n.text === '好主题');
    assert.equal(good?.refs?.[0]?.startMs, 0);
  });

  it('坏 JSON 触发重试，并把具体错误回灌给模型', async () => {
    const provider = mockProvider([
      '这不是 JSON，只是一段废话',
      JSON.stringify({ topics: [{ title: '第二次就对了', seg: [0] }] }),
    ]);
    const res = await generateMindMap(provider, SEGMENTS, {
      transcriptUid: 'tr1',
      uid: 'mm1',
      title: '标题',
      windowChars: 10_000,
    });
    assert.equal(res.attempts[0], 2, '应该重试了一次');
    // 重试时把上一轮输出 + 错误一起回灌
    const retryMessages = provider.calls[1]?.messages ?? [];
    assert.ok(retryMessages.length > 2, '重试请求应携带修复上下文');
    assert.ok(
      retryMessages.some((m) => m.role === 'user' && m.content.includes('无法使用')),
      '应把具体错误回灌给模型',
    );
    assert.ok(Object.values(res.doc.nodes).some((n) => n.text === '第二次就对了'));
  });

  it('剥 markdown 围栏（json_object 模式下的典型坏输出）', async () => {
    const fenced =
      '```json\n' + JSON.stringify({ topics: [{ title: '围栏里的', seg: [0] }] }) + '\n```';
    const provider = mockProvider([fenced]);
    const res = await generateMindMap(provider, SEGMENTS, {
      transcriptUid: 'tr1',
      uid: 'mm1',
      title: '标题',
      windowChars: 10_000,
    });
    assert.equal(res.attempts[0], 1, '围栏应被直接剥掉，不该触发重试');
    assert.ok(Object.values(res.doc.nodes).some((n) => n.text === '围栏里的'));
  });

  it('多窗口时把上一窗的主题标题作为上下文传下去（避免主题被切两半）', async () => {
    // windowChars=25 时切成两窗：[0,2) 与 [2,3)。
    // mock 的每条回复必须引用**该窗口内**的编号，否则会被 sanitizeIndices 正确地丢掉。
    const windows = planWindows(SEGMENTS, 25);
    assert.deepEqual(
      windows,
      [
        { start: 0, end: 2 },
        { start: 2, end: 3 },
      ],
      '窗口划分与预期不符，后面的断言就没有意义了',
    );

    const provider = mockProvider([
      JSON.stringify({ topics: [{ title: '窗口一主题', seg: [0] }] }),
      JSON.stringify({ topics: [{ title: '窗口二主题', seg: [2] }] }),
    ]);
    await generateMindMap(provider, SEGMENTS, {
      transcriptUid: 'tr1',
      uid: 'mm1',
      title: '标题',
      windowChars: 25,
    });
    const secondPrompt = provider.calls[1]?.messages.at(-1)?.content ?? '';
    assert.ok(secondPrompt.includes('窗口一主题'), '第二个窗口应看到第一个窗口的主题');
    // 第二窗的段落编号必须从 2 开始（编号是全局的，不是窗口内相对的）
    assert.ok(secondPrompt.includes('[2]'), '编号必须是全局下标');
  });

  it('生成的文档一定通过校验（生成 → repair → validate 闭环）', async () => {
    const provider = mockProvider([
      JSON.stringify({
        topics: [
          { title: 'A', seg: [0], points: [{ text: 'a1', seg: [0] }] },
          { title: 'B', seg: [1, 2], points: [{ text: 'b1', seg: [2] }] },
        ],
      }),
    ]);
    const res = await generateMindMap(provider, SEGMENTS, {
      transcriptUid: 'tr1',
      uid: 'mm1',
      title: '标题',
      windowChars: 10_000,
    });
    const v = validate(res.doc);
    assert.equal(v.ok, true, JSON.stringify(v.issues));
    // 每个非根节点都带 refs，且 quote 非空
    for (const n of Object.values(res.doc.nodes)) {
      if (n.key === res.doc.rootKey) continue;
      assert.ok(n.refs?.[0]?.quote, `${n.key} 缺 quote`);
    }
  });

  it('emptyDoc 是合法的', () => {
    assert.equal(validate(emptyDoc('u', '标题')).ok, true);
  });
});
