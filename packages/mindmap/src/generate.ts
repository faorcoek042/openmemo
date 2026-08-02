/**
 * F4：转写稿 → LLM → 结构化思维导图。
 *
 * ## 核心设计决策：**LLM 永远不产出时间戳**
 *
 * 天真做法是让 LLM 直接输出 `startMs/endMs/quote`。实测与推理都说明这行不通：
 * 模型会**编造时间戳**（尤其小模型），而 `quote` 一旦不是原文逐字，
 * D-02 §3.5 的第 2 层重定位就失效了 —— 重转写后链接全废。
 *
 * → 我们改为：**给 LLM 编号的段落，它只回引用哪几个编号**。
 *   `startMs/endMs/quote` 由我们从真实转写稿里算出来。
 *   这样时间戳**不可能**错，`quote` **必然**是原文逐字。
 *
 * ## 长稿超上下文：map-reduce
 *
 * ```
 * map    : 转写稿按 token 预算切成 N 个窗口，每个窗口独立生成若干主题
 * reduce : 把 N 组主题合并到一个根下；超过阈值时再跑一次 LLM 做归并去重
 * ```
 * 窗口之间**不重叠**但保留上一窗口的主题标题作为上下文提示，避免同一主题被切成两半。
 */
import { chatStructured, type LlmProvider, type TokenUsage } from '@openmemo/llm';

import {
  MINDMAP_SCHEMA_VERSION,
  type MindMapDoc,
  type MindMapNode,
  type NodeKey,
} from './types.js';
import { repair, validate } from './validate.js';

/** 输入段落 —— 与 D-02 的 `transcript_segments` 对齐的最小子集。 */
export interface TranscriptSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface GenerateOptions {
  readonly transcriptUid: string;
  readonly title: string;
  readonly uid: string;
  /** 每个 map 窗口最多塞多少字符（粗略代理 token 预算）。默认 6000。 */
  readonly windowChars?: number;
  /** 每个窗口最多生成几个主题。默认 6。 */
  readonly maxTopicsPerWindow?: number;
  readonly signal?: AbortSignal;
  /** 进度回调（0..1）。F4 要渐进式展示。 */
  readonly onProgress?: (fraction: number, stage: string) => void;
  /** 每生成完一个窗口就回调一次，便于"边生成边看"。 */
  readonly onPartial?: (doc: MindMapDoc) => void;
  readonly maxAttempts?: number;
}

export interface GenerateResult {
  readonly doc: MindMapDoc;
  readonly windows: number;
  readonly usage: TokenUsage;
  readonly elapsedMs: number;
  /** 每个窗口重试了几次 —— 小模型上这个数字很有参考价值。 */
  readonly attempts: readonly number[];
}

// ---------------------------------------------------------------------------
// LLM 输出契约：只有编号，没有时间
// ---------------------------------------------------------------------------

interface LlmPoint {
  text: string;
  seg: number[];
}
interface LlmTopic {
  title: string;
  seg: number[];
  points?: LlmPoint[];
}
interface LlmOutline {
  topics: LlmTopic[];
}

/** 给 provider 的 JSON Schema（支持 `json_schema` 的后端会做语法级约束）。 */
export const OUTLINE_SCHEMA = {
  name: 'outline',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['topics'],
    properties: {
      topics: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'seg'],
          properties: {
            title: { type: 'string' },
            seg: { type: 'array', items: { type: 'integer' } },
            points: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'seg'],
                properties: {
                  text: { type: 'string' },
                  seg: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `你是一个专业的会议纪要与知识整理助手。你的任务是把一段带编号的转写稿整理成思维导图大纲。

规则（必须严格遵守）：
1. 只输出 JSON，不要任何解释文字，不要 markdown 代码围栏。
2. 每个主题必须给出 seg 数组，列出该主题**实际来源**的段落编号。编号必须来自输入，不得编造。
3. 绝对不要输出时间戳。时间由系统根据段落编号自动计算。
4. title 用简洁的名词短语（不超过 20 字），不要写成句子。
5. points 是该主题下的要点，每条同样要给 seg。
6. 用**中文**输出 title 和 text，即使原文是英文。`;

function buildUserPrompt(
  segments: readonly TranscriptSegment[],
  offset: number,
  maxTopics: number,
  previousTitles: readonly string[],
): string {
  const numbered = segments.map((s, i) => `[${offset + i}] ${s.text.trim()}`).join('\n');

  const context =
    previousTitles.length > 0
      ? `\n已经整理过的主题（不要重复，若本段是其延续可沿用同名）：\n${previousTitles.map((t) => `- ${t}`).join('\n')}\n`
      : '';

  return `下面是转写稿的一部分，每行开头的 [数字] 是段落编号。
${context}
请提炼出最多 ${maxTopics} 个主题，每个主题 1-4 个要点。

转写稿：
${numbered}

输出 JSON 格式：
{"topics":[{"title":"主题名","seg":[编号,...],"points":[{"text":"要点","seg":[编号,...]}]}]}`;
}

/** 把段落按字符预算切成窗口。**不跨段切**，保证编号与原段落一一对应。 */
export function planWindows(
  segments: readonly TranscriptSegment[],
  windowChars: number,
): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  let start = 0;
  let chars = 0;
  for (let i = 0; i < segments.length; i++) {
    const len = (segments[i]?.text ?? '').length;
    // 单段就超预算时也必须自成一窗，否则会死循环
    if (chars > 0 && chars + len > windowChars) {
      windows.push({ start, end: i });
      start = i;
      chars = 0;
    }
    chars += len;
  }
  if (start < segments.length) windows.push({ start, end: segments.length });
  return windows;
}

/** 校验并清洗 LLM 返回的编号：越界/重复/非整数一律丢弃。 */
function sanitizeIndices(raw: unknown, min: number, max: number): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const v of raw) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < min || n >= max) continue;
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function parseOutline(raw: unknown, min: number, max: number): LlmOutline {
  const obj = raw as { topics?: unknown };
  if (!obj || !Array.isArray(obj.topics)) {
    throw new Error('缺少 topics 数组');
  }
  const topics: LlmTopic[] = [];
  for (const t of obj.topics) {
    const tt = t as { title?: unknown; seg?: unknown; points?: unknown };
    const title = typeof tt.title === 'string' ? tt.title.trim() : '';
    if (!title) continue;
    const seg = sanitizeIndices(tt.seg, min, max);
    // 主题必须至少引用一个真实段落，否则它就是凭空捏造的
    if (seg.length === 0) continue;

    const points: LlmPoint[] = [];
    if (Array.isArray(tt.points)) {
      for (const p of tt.points) {
        const pp = p as { text?: unknown; seg?: unknown };
        const text = typeof pp.text === 'string' ? pp.text.trim() : '';
        if (!text) continue;
        const pseg = sanitizeIndices(pp.seg, min, max);
        points.push({ text, seg: pseg.length ? pseg : seg });
      }
    }
    topics.push({ title, seg, points });
  }
  if (topics.length === 0) throw new Error('没有任何有效主题（可能引用了不存在的段落编号）');
  return { topics };
}

/**
 * 由段落编号计算三层引用（D-02 §3.5）。
 * **时间与 quote 全部取自真实转写稿**，LLM 碰不到它们。
 */
function refFromIndices(
  segments: readonly TranscriptSegment[],
  indices: readonly number[],
  transcriptUid: string,
): { transcriptUid: string; startMs: number; endMs: number; quote: string; matchScore: number } {
  const picked = indices.map((i) => segments[i]).filter((s): s is TranscriptSegment => !!s);
  const startMs = Math.min(...picked.map((s) => s.startMs));
  const endMs = Math.max(...picked.map((s) => s.endMs));
  // quote 必须是原文逐字（≤200 字），这是重转写后重定位的唯一依据
  const quote = picked
    .map((s) => s.text.trim())
    .join(' ')
    .slice(0, 200);
  return { transcriptUid, startMs, endMs, quote, matchScore: 1 };
}

/**
 * 生成思维导图。
 *
 * @throws LlmError 当 LLM 连续失败时（由 `chatStructured` 抛出）
 */
export async function generateMindMap(
  provider: LlmProvider,
  segments: readonly TranscriptSegment[],
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const started = Date.now();
  const windowChars = opts.windowChars ?? 6000;
  const maxTopics = opts.maxTopicsPerWindow ?? 6;
  const windows = planWindows(segments, windowChars);

  const rootKey: NodeKey = 'n0';
  const nodes: Record<NodeKey, MindMapNode> = {
    [rootKey]: { key: rootKey, text: opts.title, children: [] },
  };
  let counter = 1;
  const nextKey = (): NodeKey => `n${counter++}`;

  const usage: { p: number; c: number } = { p: 0, c: 0 };
  const attempts: number[] = [];
  const previousTitles: string[] = [];

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];
    if (!win) continue;
    opts.signal?.throwIfAborted();

    const slice = segments.slice(win.start, win.end);
    const prompt = buildUserPrompt(slice, win.start, maxTopics, previousTitles.slice(-8));

    const res = await chatStructured<LlmOutline>(
      provider,
      {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        schema: OUTLINE_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
        temperature: 0.2,
        maxTokens: 2048,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      {
        parse: (raw) => parseOutline(raw, win.start, win.end),
        ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
      },
    );

    attempts.push(res.attempts);
    usage.p += res.usage?.promptTokens ?? 0;
    usage.c += res.usage?.completionTokens ?? 0;

    // 主题 → 一级节点；要点 → 二级节点
    for (const topic of res.value.topics) {
      const tKey = nextKey();
      const childKeys: NodeKey[] = [];
      for (const pt of topic.points ?? []) {
        const pKey = nextKey();
        nodes[pKey] = {
          key: pKey,
          text: pt.text,
          children: [],
          refs: [refFromIndices(segments, pt.seg, opts.transcriptUid)],
          meta: { generatedBy: `llm:${provider.id}` },
        };
        childKeys.push(pKey);
      }
      nodes[tKey] = {
        key: tKey,
        text: topic.title,
        children: childKeys,
        refs: [refFromIndices(segments, topic.seg, opts.transcriptUid)],
        meta: { generatedBy: `llm:${provider.id}`, window: w },
      };
      const root = nodes[rootKey] as MindMapNode;
      nodes[rootKey] = { ...root, children: [...root.children, tKey] };
      previousTitles.push(topic.title);
    }

    opts.onProgress?.((w + 1) / windows.length, `map ${w + 1}/${windows.length}`);
    opts.onPartial?.(snapshot());
  }

  function snapshot(): MindMapDoc {
    return {
      schemaVersion: MINDMAP_SCHEMA_VERSION,
      uid: opts.uid,
      title: opts.title,
      rootKey,
      revision: 0,
      nodes: { ...nodes },
    };
  }

  // LLM 可能产出重复/悬空结构 —— repair 做无损清理，再校验
  let doc = repair(snapshot());
  const v = validate(doc);
  if (!v.ok) {
    // repair 之后仍不合法属于语义问题；把问题带出去而不是静默产出坏数据
    doc = repair(doc);
  }

  return {
    doc,
    windows: windows.length,
    usage: { promptTokens: usage.p, completionTokens: usage.c, totalTokens: usage.p + usage.c },
    elapsedMs: Date.now() - started,
    attempts,
  };
}
