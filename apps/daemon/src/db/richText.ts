/**
 * TipTap / ProseMirror JSON → 纯文本投影（`notes.body_text`，专供 FTS5，D-02 §1.3）。
 *
 * ## 为什么放在服务端
 *
 * 之前 `body_text` 由前端连同 `body_json` 一起 POST 上来。两个值来自同一次编辑，
 * 但走的是同一个请求体的两个字段 —— 只要前端某条路径漏更新其中一个（乐观更新回滚、
 * 离线队列重放、老版本客户端），两者就会漂移。而漂移**不会报错**：写入成功、
 * 正文显示正常，只有搜索悄悄返回过时或错误的结果。这种 bug 极难被发现。
 *
 * 所以改成**服务端自己推导**：`body_json` 是唯一事实来源，`body_text` 是它的函数。
 * 客户端仍可以传 `bodyText`，但那只是一个可选的优化提示，不再具有权威性。
 *
 * ## 为什么是"保守提取"而不是真的跑一遍 TipTap
 *
 * 反对意见很合理：服务端不该为了建索引就把整个 TipTap 运行时（prosemirror-model +
 * 全套 schema + 各扩展节点）搬进 daemon 进程。那意味着一大坨前端依赖、随前端
 * 扩展列表变化而变化的 schema、以及"schema 不匹配就抛异常"的新失败模式 ——
 * 代价远超收益，因为我们要的只是**一串给分词器吃的字**。
 *
 * 于是这里只做一件事：**递归收集 `text` 节点**，外加块级节点之间补换行。
 * 明确不做的事：
 *   - 不解释 marks（加粗/斜体/链接不改变文字本身）
 *   - 不渲染列表序号、表格边框、代码块围栏等装饰
 *   - 不校验 schema，不认识的节点类型一律"能拿文字就拿，拿不到就跳过"
 *
 * 这个取舍的方向是刻意选的：宁可索引里少一点装饰性字符，也不要因为看不懂某个
 * 自定义节点就让整篇笔记搜不到。提取器的失败模式必须是"降级"，不能是"抛异常"。
 */

/**
 * 块级节点：它们之间必须插换行。
 *
 * 不补换行的话，`<p>今天到此结束</p><p>开始下一节</p>` 会拼成 "今天到此结束开始下一节"，
 * 分词器会切出"结束开始"这种跨块的假词 —— 索引被污染，且无法通过重建修复
 * （因为投影本身就是错的）。这是本文件里唯一一处"解释语义"，值得。
 */
const BLOCK_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'codeBlock',
  'bulletList',
  'orderedList',
  'table',
  'tableRow',
]);

/**
 * 没有 `text` 时才看的、常见的"承载文字"的 attrs。
 * 图片的 alt 是正当的可搜索内容；`src` / `href` 之类的 URL 刻意**不收**——
 * 它们会往索引里灌 base64、blob: 和一堆无意义 token。
 */
const TEXT_ATTRS: readonly string[] = ['alt', 'title', 'label'];

/** 深度上限。超过就停止下钻（不抛异常，只是不再往下看）。 */
const DEFAULT_MAX_DEPTH = 100;

/** 总长度上限。FTS 索引不需要无限长的正文，而堆内存需要保护。 */
const DEFAULT_MAX_LENGTH = 1_000_000;

interface NodeFrame {
  readonly node: unknown;
  readonly depth: number;
}
interface EmitFrame {
  readonly emit: string;
}
type Frame = NodeFrame | EmitFrame;

export interface ExtractOptions {
  /** 输出上限（字符数），默认 1_000_000。≤ 0 直接返回空串。 */
  readonly maxLength?: number;
}

/**
 * 把任意 JSON（理想情况下是 TipTap 文档）压成一行行纯文本。
 *
 * **本函数永不抛异常。** 输入来自 HTTP 请求体，是完全不可信的：可能是 `null`、
 * 数字、字符串、超深嵌套、自引用，甚至是带 throwing getter 的对象。
 * 任何看不懂的东西都退化成 `''`，绝不能把 `PATCH /api/notes/:uid` 打成 500 ——
 * 索引投影失败的正确后果是"这条笔记搜不到"，不是"这条笔记存不下"。
 */
export function extractPlainText(doc: unknown, opts?: ExtractOptions): string {
  const maxLength = normalizeLimit(opts?.maxLength, DEFAULT_MAX_LENGTH);
  if (maxLength <= 0) return '';

  const out: string[] = [];
  try {
    traverse(doc, out, maxLength);
  } catch {
    /*
     * 兜底。上面的遍历已经逐项做了类型判断，理论上不该走到这里，但输入可以是
     * Proxy —— 一次属性读取就能抛。保留已经收集到的片段，继续走 finalize。
     */
  }
  return finalize(out.join(''), maxLength);
}

/**
 * 迭代式遍历（显式栈），**不用递归**。
 *
 * 递归写法在这里是一个真实的拒绝服务面：请求体里塞一个一万层深的
 * `{"content":[{"content":[...]}]}` 就能爆 V8 调用栈，而 `RangeError:
 * Maximum call stack size exceeded` 是同步抛出的，会直接掀掉这次请求。
 * 显式栈把"深度"从进程资源变成了一个可以随手 clamp 的数字。
 */
function traverse(root: unknown, out: string[], maxLength: number): void {
  let total = 0;
  const append = (s: string): void => {
    out.push(s);
    total += s.length;
  };

  /*
   * 环检测。`JSON.parse` 产出的对象不可能有环，但这个函数也会被内存里现成的
   * 对象调用（测试、以后可能出现的服务端合成文档），没有 WeakSet 就是死循环。
   * 代价：同一个对象在文档里被复用两次时，第二次会被跳过。TipTap 的输出不会
   * 共享节点，这个代价换"绝不挂死"是划算的。
   */
  const seen = new WeakSet<object>();
  const stack: Frame[] = [{ node: root, depth: 0 }];

  while (stack.length > 0) {
    if (total >= maxLength) return;
    const frame = stack.pop() as Frame;

    // 延迟片段：块级节点的"闭合换行"，在它全部子节点弹完之后才轮到
    if ('emit' in frame) {
      append(frame.emit);
      continue;
    }

    const { node, depth } = frame;
    if (node === null || typeof node !== 'object') continue;
    if (depth > DEFAULT_MAX_DEPTH) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    // 顶层可能直接是数组；`content` 里也可能套数组。数组不算一层深度。
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], depth });
      continue;
    }

    const rec = node as Record<string, unknown>;
    const type = typeof rec['type'] === 'string' ? (rec['type'] as string) : '';

    // 软换行是显式的排版意图，直接落成换行
    if (type === 'hardBreak' || type === 'hard_break') {
      append('\n');
      continue;
    }

    /*
     * 文字节点。规范里是 `type === 'text'`，但这里只要 `text` 是字符串就收 ——
     * 认字段比认类型名宽容，遇到自定义的类文本节点也不会漏。
     */
    const text = rec['text'];
    if (typeof text === 'string') {
      if (text.length > 0) append(text);
      continue;
    }

    const isBlock = BLOCK_TYPES.has(type);
    // 开合各补一个换行；连续多余的换行统一由 finalize 收敛成最多两个
    if (isBlock) append('\n');

    const attrs = rec['attrs'];
    if (attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs)) {
      const bag = attrs as Record<string, unknown>;
      for (const key of TEXT_ATTRS) {
        const v = bag[key];
        // 用换行包起来：attrs 文字和相邻的正文分属不同"词"，不能粘在一起
        if (typeof v === 'string' && v.length > 0) append(`\n${v}\n`);
      }
    }

    if (total >= maxLength) return;

    // LIFO：先压闭合片段，再逆序压子节点，弹出顺序才是文档顺序
    if (isBlock) stack.push({ emit: '\n' });
    const content = rec['content'];
    if (Array.isArray(content)) {
      for (let i = content.length - 1; i >= 0; i--) {
        stack.push({ node: content[i], depth: depth + 1 });
      }
    }
  }
}

/** 截断 → 归一换行 → 收敛空行 → 去首尾。截断在最前面，保证返回值长度不超上限。 */
function finalize(raw: string, maxLength: number): string {
  const capped = raw.length > maxLength ? raw.slice(0, maxLength) : raw;
  return capped
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeLimit(v: number | undefined, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.floor(v));
}
