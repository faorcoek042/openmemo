#!/usr/bin/env node
/**
 * GitHub Actions **表达式求值器** + **job 调度模拟器** —— 零依赖，本机能跑，不需要 GitHub。
 *
 * ## 为什么要手写这个东西
 *
 * 本机没有 `act`、没有 `actionlint`、没有 docker（`which` 全空）。
 * 而「只读一遍 YAML 就说修好了」正是本仓那一族假绿的成因：一个 `if:` 写错的
 * 后果**不是报错**，是那一步**静默地不跑**，而 skipped 在结论页上和 passed
 * 长得一模一样。`lint-workflows.mjs` 治的是**结构**（键名对不对、needs 指向谁），
 * 治不了**语义** —— 「这个 `if:` 在 `inputs.m = false` 时到底会不会跑」这种问题，
 * 光看 YAML 是答不出来的，只能算。
 *
 * 所以这里把 GitHub 那套**有文档的**表达式语义逐条实现出来，让判断从
 * 「我读了一遍，觉得对」变成「跑一遍，它是 true 还是 false」。
 *
 * ## 它能判定什么
 *
 * 1. **真假值口径**：`'false'` 是**真**、`''` 是假、空数组空对象是**真**。
 *    这一条单独就够写坏一道门禁 —— 见 `selftest-gha-expr.mjs` A 组。
 * 2. **`&&` / `||` 返回的是操作数、不是布尔**。`X && '--flag' || ''` 这个到处
 *    都在用的惯用法完全建立在这条上；把它当成 JS 的 `Boolean` 运算来读，
 *    结论就会反过来。
 * 3. **`==` 的类型转换陷阱**：两边类型不同时 GitHub 把**两边都转成数字**再比。
 *    净效果是 `'' == false` 为**真**，而 `'' == 'false'` 为**假**；
 *    `true == 'true'` 也是**假**（1 vs NaN）。一个 `workflow_dispatch` 的
 *    boolean 输入在没填时到底等于什么，答案就藏在这几条里。
 * 4. **隐式 `success()`**：没写状态函数的 `if:` 会被自动加上 `success() &&`。
 *    文档原话（docs.github.com,「Evaluate expressions in workflows and actions」）：
 *    `A default status check of success() is applied unless you include one of these functions.`
 *    这条是「一条红关掉后面 7 道守卫」那个事故的语义根源 —— 现在它可以被算出来，
 *    不用等下一次 CI 红了才知道。
 * 5. **skip 的传播**：`simulateJobs()` 按拓扑序把整张 job 图跑一遍，
 *    回答「B 被跳过时 C 还跑不跑」这种只有真跑一次才看得见的问题。
 *
 * ## 它查不了什么（明写，别拿它当保证）
 *
 * - **它不验证 GitHub 的语义本身**，它只是把**文档写下来的**那套语义编码了一遍。
 *   文档错了、或者 GitHub 改了行为，这里会跟着一起错，而且**照样报绿**。
 *   凡是文档没写死的角落（对象/数组转字符串的确切形态、超大数字的渲染、
 *   属性名大小写敏感性），本文件都按最合理的读法实现并在注释里标了出来 ——
 *   **标注本身就是结论的一部分**，别把它删了。
 * - runner label 存不存在、`uses:` 的 action 有没有那个输入、shell 脚本在
 *   Windows 上会不会跑、`hashFiles()` 的真实哈希（这里返回一个固定假值，
 *   **绝不能**用它去推断缓存命中）—— 全部不在范围内。
 * - `needs` 之外的运行时上下文（`steps.*.outcome` 的真实值、`env` 的真实内容）
 *   由调用方喂进来。喂错了它就算错，而且不会有任何提示。
 * - 表达式里的 `*` 通配符（`a.*.b`）**没实现**，遇到直接抛错，不静默当成别的东西。
 *
 * ## 用法
 *
 *   import { evaluateExpression, interpolate, evaluateIf, simulateJobs } from './gha-expr.mjs';
 *   evaluateExpression("inputs.a == 'b'", { inputs: { a: 'b' } });   // → true
 *   interpolate("x${{ true && '--y' || '' }}", {});                   // → 'x--y'
 *   evaluateIf('!cancelled() && steps.build.outcome == \'success\'', ctx);
 *
 * 自检：`node scripts/ci/selftest-gha-expr.mjs`
 */

/** 表达式层面的错误一律用它，好让调用方能把「表达式写错了」与别的异常分开。 */
export class GhaExprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GhaExprError';
  }
}

/**
 * GitHub 认识的顶层 context 名。不在这张表里的裸标识符，GitHub 会报
 * `Unrecognized named-value` —— 这里照抄这个行为，因为把打错的 context 名
 * 静默当成 undefined，正是「`if:` 永远为假、那一步永远不跑」的经典成因。
 * 来源：docs.github.com「Contexts」。
 */
const KNOWN_CONTEXTS = new Set([
  'github',
  'env',
  'vars',
  'job',
  'jobs',
  'steps',
  'runner',
  'secrets',
  'strategy',
  'matrix',
  'needs',
  'inputs',
]);

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 一、值语义：真假、转数字、转字符串
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/**
 * GHA 的真假值口径。
 *
 * ⚠️ 与 JS **不完全一致**的地方只有一处，但那一处最要命：
 * 空数组 `[]`、空对象 `{}` 在两边都是真，字符串 `'false'` 在两边也都是真 ——
 * 真正会咬人的是**人的直觉**：`workflow_dispatch` 的 boolean 输入在 YAML 里
 * 长得像 `false`，一旦被字符串化就变成 `'false'`，于是「假」变成了「真」。
 */
export function ghaTruthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return !(v === 0 || Number.isNaN(v)); // -0 === 0 → 假
  if (typeof v === 'string') return v !== '';
  return true; // 数组/对象一律为真，哪怕是空的
}

/**
 * GHA 的「转成数字」规则（比较运算里两边类型不同时用）。
 * 来源：docs.github.com「Operators」下的类型转换表。
 */
function ghaNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0;
    return Number(s); // 解析不动 → NaN，而 NaN 与谁比都是假
  }
  return NaN; // 数组 / 对象
}

/**
 * GHA 的「转成字符串」规则（`format()` 的参数、`${{ }}` 的插值结果都走这里）。
 *
 * ⚠️ 数组/对象这一格是本文件里**最没把握**的一条：这里按任务口径序列化成 JSON。
 *    真实 runner 在把复杂对象插进字符串时可能给的是别的形态（比如 `Object`）。
 *    好在正经 workflow 里没人会去插一个裸对象 —— 真要插会写 `toJSON()`。
 *    **别依赖这一格做判断。**
 */
export function ghaString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    return String(v); // 1.0 → '1'，与 GitHub 的规范形态一致
  }
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** 两个值是不是「同一类」—— null/undefined 归成一类，数组与对象归成一类。 */
function kindOf(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  return 'object';
}

/**
 * GHA 的 `==`。
 *
 * 判据（docs.github.com「Operators」）：
 *   · 两边类型相同 → 直接比；字符串**大小写不敏感**。
 *   · 两边类型不同 → **两边都转成数字**再比。
 *   · NaN 与谁都不等（包括它自己）。
 *
 * 这条规则最反直觉的两个后果，本仓的自检里各钉了一条：
 *   `'' == false` → **true**（string vs boolean → 0 vs 0）
 *   `'' == 'false'` → **false**（都是字符串，按字符串比）
 */
function looseEquals(a, b) {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka === kb) {
    if (ka === 'null') return true;
    if (ka === 'string') return a.toLowerCase() === b.toLowerCase();
    if (ka === 'object') return a === b; // 对象按引用比（GitHub 同）
    return a === b; // boolean / number；NaN === NaN 为假，正是要的
  }
  const na = ghaNumber(a);
  const nb = ghaNumber(b);
  return na === nb; // 任一边 NaN → false
}

/** `< <= > >=`：两边都是字符串就按字符串（大小写不敏感）比，否则转数字。 */
function relational(op, a, b) {
  let x;
  let y;
  if (kindOf(a) === 'string' && kindOf(b) === 'string') {
    x = a.toLowerCase();
    y = b.toLowerCase();
  } else {
    x = ghaNumber(a);
    y = ghaNumber(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return false; // NaN 与谁比都是假
  }
  switch (op) {
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    case '>=':
      return x >= y;
    default:
      throw new GhaExprError(`内部错误：未知的比较运算符 \`${op}\``);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 二、词法
 * ═══════════════════════════════════════════════════════════════════════════════════ */

const TWO_CHAR_OPS = new Set(['&&', '||', '==', '!=', '<=', '>=']);
const ONE_CHAR_OPS = new Set(['!', '<', '>', '(', ')', '[', ']', '.', ',']);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*/;
const HEX_RE = /^0[xX][0-9a-fA-F]+/;
const DEC_RE = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const at = (n) => src.slice(n);
  /** 前缀位置 = 上一个 token 是运算符（且不是 `)` / `]`），此时的 `-` 属于数字字面量。 */
  const inPrefixPosition = () => {
    const t = tokens[tokens.length - 1];
    if (!t) return true;
    return t.type === 'op' && t.value !== ')' && t.value !== ']';
  };

  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }

    /* ── 单引号字符串，`''` 是转义后的单引号 ── */
    if (c === "'") {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= src.length) {
          throw new GhaExprError(
            `表达式里有没闭合的字符串字面量（从第 ${i + 1} 个字符起）：${src}`,
          );
        }
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            out += "'";
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        out += src[j];
        j += 1;
      }
      tokens.push({ type: 'str', value: out });
      i = j;
      continue;
    }

    /* ── 数字（含十六进制、指数、前缀负号） ── */
    const numStart = c === '-' && inPrefixPosition() && /[0-9]/.test(src[i + 1] ?? '');
    if (/[0-9]/.test(c) || numStart) {
      const sign = numStart ? -1 : 1;
      const rest = at(numStart ? i + 1 : i);
      const hex = HEX_RE.exec(rest);
      if (hex) {
        tokens.push({ type: 'num', value: sign * Number.parseInt(hex[0].slice(2), 16) });
        i += (numStart ? 1 : 0) + hex[0].length;
        continue;
      }
      const dec = DEC_RE.exec(rest);
      if (dec) {
        tokens.push({ type: 'num', value: sign * Number(dec[0]) });
        i += (numStart ? 1 : 0) + dec[0].length;
        continue;
      }
      throw new GhaExprError(`表达式里有认不出来的数字（第 ${i + 1} 个字符起）：${src}`);
    }

    /* ── 标识符（属性名允许连字符，例如 steps.my-step.outputs.x） ── */
    const id = IDENT_RE.exec(at(i));
    if (id) {
      tokens.push({ type: 'ident', value: id[0] });
      i += id[0].length;
      continue;
    }

    /* ── `*` 通配符：明确不支持，当场抛错，绝不静默当成别的东西 ── */
    if (c === '*') {
      throw new GhaExprError(
        `不支持通配符 \`*\`（如 \`a.*.b\` / \`a[*]\`）—— 本求值器没实现它，` +
          `与其猜一个答案不如当场停下：${src}`,
      );
    }

    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if (c === '&' || c === '|' || c === '=') {
      throw new GhaExprError(
        `表达式里有孤立的 \`${c}\`（GHA 只有 \`&&\` \`||\` \`==\`，没有单个的）：${src}`,
      );
    }
    if (ONE_CHAR_OPS.has(c)) {
      tokens.push({ type: 'op', value: c });
      i += 1;
      continue;
    }
    throw new GhaExprError(`表达式里有认不出来的字符 \`${c}\`（第 ${i + 1} 个）：${src}`);
  }
  return tokens;
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 三、语法
 *
 * 优先级（低 → 高）照 docs.github.com「Operators」那张表：
 *   ||  <  &&  <  == !=  <  < <= > >=  <  !  <  () [] .
 * 注意 **关系运算符比相等运算符结合得更紧**（`a == b < c` 是 `a == (b < c)`）——
 * 任务描述里把这两档并成了一档，这里按 GitHub 的原表实现。正常写法两者无差别。
 * ═══════════════════════════════════════════════════════════════════════════════════ */

function parse(tokens, src) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (value) => {
    const t = tokens[pos];
    if (t && t.type === 'op' && t.value === value) {
      pos += 1;
      return true;
    }
    return false;
  };
  const expect = (value) => {
    if (!eat(value)) {
      const got = tokens[pos] ? JSON.stringify(tokens[pos].value) : '表达式结尾';
      throw new GhaExprError(`表达式里少了 \`${value}\`（实得 ${got}）：${src}`);
    }
  };

  function parseOr() {
    let left = parseAnd();
    while (eat('||')) left = { k: 'or', l: left, r: parseAnd() };
    return left;
  }
  function parseAnd() {
    let left = parseEquality();
    while (eat('&&')) left = { k: 'and', l: left, r: parseEquality() };
    return left;
  }
  function parseEquality() {
    let left = parseRelational();
    for (;;) {
      const t = peek();
      if (t && t.type === 'op' && (t.value === '==' || t.value === '!=')) {
        pos += 1;
        left = { k: 'bin', op: t.value, l: left, r: parseRelational() };
      } else return left;
    }
  }
  function parseRelational() {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t && t.type === 'op' && ['<', '<=', '>', '>='].includes(t.value)) {
        pos += 1;
        left = { k: 'bin', op: t.value, l: left, r: parseUnary() };
      } else return left;
    }
  }
  function parseUnary() {
    if (eat('!')) return { k: 'not', arg: parseUnary() };
    return parsePostfix();
  }
  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (eat('.')) {
        const t = peek();
        if (!t || t.type !== 'ident') {
          throw new GhaExprError(`\`.\` 后面应当是属性名：${src}`);
        }
        pos += 1;
        node = { k: 'prop', obj: node, name: t.value };
        continue;
      }
      if (eat('[')) {
        const idx = parseOr();
        expect(']');
        node = { k: 'index', obj: node, idx };
        continue;
      }
      return node;
    }
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new GhaExprError(`表达式在该有值的地方结束了：${src}`);
    if (t.type === 'num' || t.type === 'str') {
      pos += 1;
      return { k: 'lit', v: t.value };
    }
    if (t.type === 'ident') {
      pos += 1;
      const lower = t.value.toLowerCase();
      if (lower === 'true') return { k: 'lit', v: true };
      if (lower === 'false') return { k: 'lit', v: false };
      if (lower === 'null') return { k: 'lit', v: null };
      if (peek() && peek().type === 'op' && peek().value === '(') {
        pos += 1;
        const args = [];
        if (!eat(')')) {
          for (;;) {
            args.push(parseOr());
            if (eat(',')) continue;
            expect(')');
            break;
          }
        }
        return { k: 'call', name: t.value, args };
      }
      return { k: 'name', name: t.value };
    }
    if (t.type === 'op' && t.value === '(') {
      pos += 1;
      const inner = parseOr();
      expect(')');
      return inner;
    }
    throw new GhaExprError(`表达式里出现了意料之外的 \`${t.value}\`：${src}`);
  }

  const ast = parseOr();
  if (pos !== tokens.length) {
    throw new GhaExprError(
      `表达式尾巴上有多余的东西（第 ${pos + 1} 个 token 起：${JSON.stringify(tokens[pos].value)}）：${src}`,
    );
  }
  return ast;
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 四、求值
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/**
 * 取属性。
 *
 * · 对 null/undefined 取属性**不抛错**，得到 undefined —— GitHub 同（这也是
 *   `steps.没这个id.outputs.x` 会静默变成空串的原因，见 lint-workflows 第 4 条）。
 * · 只认对象**自有**的键：绝不让 `x.constructor` / `x.__proto__` 摸到原型链。
 * · 找不到时再按**大小写不敏感**找一次（GitHub 的 context 查找是大小写不敏感的）；
 *   只有恰好一个候选才用，两个以上宁可给 undefined 也不猜。
 */
function getProp(obj, name) {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== 'object') return undefined;
  if (Object.hasOwn(obj, name)) return obj[name];
  const lower = name.toLowerCase();
  const hits = Object.keys(obj).filter((k) => k.toLowerCase() === lower);
  return hits.length === 1 ? obj[hits[0]] : undefined;
}

const DUMMY_HASH = '0'.repeat(64);

function callFunction(rawName, args, ctx) {
  const name = rawName.toLowerCase(); // GHA 的函数名大小写不敏感（toJSON / tojson 都行）
  const need = (n) => {
    if (args.length < n) {
      throw new GhaExprError(`\`${rawName}()\` 至少要 ${n} 个参数，实得 ${args.length} 个`);
    }
  };

  switch (name) {
    /* ── 状态函数 ── */
    case 'success':
      return ctx.__status === true;
    case 'failure':
      return ctx.__failure === true;
    case 'cancelled':
      return ctx.__cancelled === true;
    case 'always':
      return true;

    /* ── 字符串 / 集合 ── */
    case 'contains': {
      need(2);
      const [hay, needle] = args;
      if (Array.isArray(hay)) return hay.some((el) => looseEquals(el, needle));
      return ghaString(hay).toLowerCase().includes(ghaString(needle).toLowerCase());
    }
    case 'startswith': {
      need(2);
      return ghaString(args[0]).toLowerCase().startsWith(ghaString(args[1]).toLowerCase());
    }
    case 'endswith': {
      need(2);
      return ghaString(args[0]).toLowerCase().endsWith(ghaString(args[1]).toLowerCase());
    }
    case 'format': {
      need(1);
      return formatString(ghaString(args[0]), args.slice(1));
    }
    case 'join': {
      need(1);
      const sep = args.length > 1 ? ghaString(args[1]) : ',';
      const arr = args[0];
      if (!Array.isArray(arr)) return ghaString(arr);
      return arr.map((el) => ghaString(el)).join(sep);
    }
    case 'tojson': {
      need(1);
      const out = JSON.stringify(args[0] === undefined ? null : args[0], null, 2);
      return out === undefined ? 'null' : out;
    }
    case 'fromjson': {
      need(1);
      const text = ghaString(args[0]);
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new GhaExprError(`fromJSON() 的参数不是合法 JSON：${text}（${String(err)}）`);
      }
    }
    case 'hashfiles':
      /*
       * ⚠️ 固定假值。真实的 hashFiles 要读工作区文件算 SHA-256，本地没有那份工作区，
       *    也没有 GitHub 的 glob 语义。返回定值意味着：**任何依赖缓存命中与否的判断，
       *    在这里都是假的**。别拿它去论证 cache key 的行为。
       */
      return DUMMY_HASH;

    default:
      throw new GhaExprError(`不认识的函数 \`${rawName}()\`（GitHub 会直接拒绝整份 workflow）`);
  }
}

/**
 * `format('{0} {1}', a, b)`。`{{` / `}}` 是转义后的花括号。
 * 索引越界当场抛错 —— GitHub 也报错，而静默补空串会把「参数忘了传」变成看不见的缺陷。
 */
function formatString(fmt, args) {
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c === '{') {
      if (fmt[i + 1] === '{') {
        out += '{';
        i += 2;
        continue;
      }
      const close = fmt.indexOf('}', i + 1);
      if (close === -1) throw new GhaExprError(`format() 的格式串里有没闭合的 \`{\`：${fmt}`);
      const body = fmt.slice(i + 1, close);
      if (!/^[0-9]+$/.test(body)) {
        throw new GhaExprError(`format() 的占位符只能是数字下标，实得 \`{${body}}\`：${fmt}`);
      }
      const idx = Number(body);
      if (idx >= args.length) {
        throw new GhaExprError(`format() 用到了 {${idx}}，但只传了 ${args.length} 个参数：${fmt}`);
      }
      out += ghaString(args[idx]);
      i = close + 1;
      continue;
    }
    if (c === '}') {
      if (fmt[i + 1] === '}') {
        out += '}';
        i += 2;
        continue;
      }
      throw new GhaExprError(`format() 的格式串里有落单的 \`}\`（要字面量请写 \`}}\`）：${fmt}`);
    }
    out += c;
    i += 1;
  }
  return out;
}

function evalNode(node, ctx) {
  switch (node.k) {
    case 'lit':
      return node.v;
    case 'name': {
      const lower = node.name.toLowerCase();
      if (!KNOWN_CONTEXTS.has(lower)) {
        throw new GhaExprError(
          `不认识的 context \`${node.name}\` —— GitHub 会报 Unrecognized named-value。` +
            `（认识的是：${[...KNOWN_CONTEXTS].join(', ')}）`,
        );
      }
      return getProp(ctx, lower); // getProp 自带大小写不敏感兜底
    }
    case 'prop':
      return getProp(evalNode(node.obj, ctx), node.name);
    case 'index': {
      const obj = evalNode(node.obj, ctx);
      const key = evalNode(node.idx, ctx);
      if (Array.isArray(obj)) {
        const n = ghaNumber(key);
        if (!Number.isInteger(n) || n < 0 || n >= obj.length) return undefined;
        return obj[n];
      }
      return getProp(obj, ghaString(key));
    }
    case 'not':
      return !ghaTruthy(evalNode(node.arg, ctx));
    /*
     * ★ `&&` / `||` 返回的是**操作数本身**，不是布尔。
     *   `X && '--flag' || ''` 这个惯用法的全部机制就在这两行里：
     *   X 为假 → `X && …` 得到 X（假）→ `|| ''` 得到 `''`；
     *   X 为真 → 得到 `'--flag'`。把它实现成布尔运算，插值结果就会变成
     *   `'true'` / `'false'` 这种字面量，而那**恰好都是非空字符串**（真）。
     */
    case 'and': {
      const l = evalNode(node.l, ctx);
      return ghaTruthy(l) ? evalNode(node.r, ctx) : l;
    }
    case 'or': {
      const l = evalNode(node.l, ctx);
      return ghaTruthy(l) ? l : evalNode(node.r, ctx);
    }
    case 'bin': {
      const l = evalNode(node.l, ctx);
      const r = evalNode(node.r, ctx);
      if (node.op === '==') return looseEquals(l, r);
      if (node.op === '!=') return !looseEquals(l, r);
      return relational(node.op, l, r);
    }
    case 'call':
      return callFunction(
        node.name,
        node.args.map((a) => evalNode(a, ctx)),
        ctx,
      );
    default:
      throw new GhaExprError(`内部错误：不认识的 AST 节点 \`${node.k}\``);
  }
}

/**
 * 求一条表达式的值。`src` 是**不带** `${{ }}` 的表达式体。
 * 返回的是 GHA 的**值**（可能是字符串/数字/布尔/null/对象），不是布尔 ——
 * 需要布尔请自己套 `ghaTruthy()`，或者用 `evaluateIf()`。
 */
export function evaluateExpression(src, ctx = {}) {
  if (typeof src !== 'string') {
    throw new GhaExprError(`evaluateExpression 的第一个参数应当是字符串，实得 ${typeof src}`);
  }
  if (src.trim() === '') throw new GhaExprError('空表达式 —— GitHub 也会拒绝它');
  const tokens = tokenize(src);
  const ast = parse(tokens, src);
  return evalNode(ast, ctx);
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 五、模板插值
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/**
 * 把一段文本拆成「字面量片段」与「`${{ }}` 表达式片段」。
 * 扫描时**认字符串字面量**：`${{ contains(x, '}}') }}` 里的那对 `}}` 不算结束符。
 */
function scanTemplate(text) {
  const parts = [];
  let i = 0;
  let plain = '';
  while (i < text.length) {
    if (text.startsWith('${{', i)) {
      let j = i + 3;
      let inStr = false;
      let end = -1;
      while (j < text.length) {
        const c = text[j];
        if (inStr) {
          if (c === "'") {
            if (text[j + 1] === "'") {
              j += 2;
              continue;
            }
            inStr = false;
          }
          j += 1;
          continue;
        }
        if (c === "'") {
          inStr = true;
          j += 1;
          continue;
        }
        if (c === '}' && text[j + 1] === '}') {
          end = j;
          break;
        }
        j += 1;
      }
      if (end === -1) {
        throw new GhaExprError(`模板里有没闭合的 \`\${{\`（从第 ${i + 1} 个字符起）：${text}`);
      }
      if (plain !== '') {
        parts.push({ type: 'text', value: plain });
        plain = '';
      }
      parts.push({ type: 'expr', body: text.slice(i + 3, end) });
      i = end + 2;
      continue;
    }
    plain += text[i];
    i += 1;
  }
  if (plain !== '') parts.push({ type: 'text', value: plain });
  return parts;
}

/** `${{ }}` 外的字符原样抄，每个 `${{ }}` 换成它的 GHA 字符串形态。 */
export function interpolate(text, ctx = {}) {
  if (typeof text !== 'string') {
    throw new GhaExprError(`interpolate 的第一个参数应当是字符串，实得 ${typeof text}`);
  }
  return scanTemplate(text)
    .map((p) => (p.type === 'text' ? p.value : ghaString(evaluateExpression(p.body, ctx))))
    .join('');
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 六、`if:` 的完整语义
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** 把单引号字符串**之外**的连续空白压成一个空格（YAML 折叠式 `>-` 的多行 if 靠这个）。 */
function collapseWhitespaceOutsideStrings(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  let pendingSpace = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        inStr = false;
      }
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      pendingSpace = true;
      i += 1;
      continue;
    }
    if (pendingSpace) {
      if (out !== '') out += ' ';
      pendingSpace = false;
    }
    if (c === "'") inStr = true;
    out += c;
    i += 1;
  }
  return out;
}

/** 把单引号字符串整段挖掉 —— 判断「有没有写状态函数」时不该被字面量里的文字骗到。 */
function stripStringLiterals(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === "'") {
      i += 1;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

const STATUS_FN_RE = /(^|[^A-Za-z0-9_-])(success|failure|always|cancelled)\s*\(\s*\)/i;

/**
 * 这段表达式文本里有没有写状态检查函数（`success()` / `failure()` / `always()` / `cancelled()`）。
 * 判断前先把字符串字面量挖掉：`contains(x, 'always()')` 里那个 `always()` 是数据，不是调用。
 */
export function usesStatusFunction(src) {
  if (typeof src !== 'string') return false;
  return STATUS_FN_RE.test(stripStringLiterals(src));
}

/**
 * 完整的 `if:` 语义。返回**严格布尔**。
 *
 * ★ 隐式 `success()` —— 本文件存在的头号理由。文档原话
 *   （docs.github.com,「Evaluate expressions in workflows and actions」）：
 *
 *     A default status check of success() is applied unless you include one of these functions.
 *
 *   也就是说 `if: inputs.a == 'b'` 实际跑的是 `success() && inputs.a == 'b'`。
 *   依赖里只要有一格没成功，这一整条就**静默变成 skipped** —— 而 skipped 不是 passed。
 *   想「前面挂了也照常出结论」，唯一的写法是自己带一个状态函数（推荐 `!cancelled() && …`，
 *   别用 `always()`：那个连被取消时也跑）。
 *
 * `ifValue` 的三种写法都接受，且必须给出一样的答案：
 *   1. 整条就是一个 `${{ … }}`；
 *   2. 裸表达式（GitHub 对 `if:` 自动按表达式解析）；
 *   3. YAML 折叠式多行（`>-`）。
 *
 * ⚠️ 第四种写法 —— **混着**字面量与 `${{ }}`（例如 `${{ a }} && ${{ b }}`）——
 *    这里按 GitHub 的实际行为处理：先插值成一个字符串，再看这个字符串的真假。
 *    于是 `${{ false }} && ${{ true }}` → `'false && true'` → **非空 → 真**。
 *    这是个著名的坑，本求值器**如实复现**它，不替 GitHub 修。
 */
export function evaluateIf(ifValue, ctx = {}) {
  const implicitSuccess = ctx.__status === undefined ? true : ctx.__status === true;

  if (ifValue === undefined || ifValue === null) return implicitSuccess;

  const text = collapseWhitespaceOutsideStrings(
    typeof ifValue === 'string' ? ifValue : ghaString(ifValue),
  );
  if (text === '') return implicitSuccess;

  const parts = scanTemplate(text);
  let value;
  if (parts.length === 1 && parts[0].type === 'expr') {
    value = evaluateExpression(parts[0].body, ctx);
  } else if (parts.some((p) => p.type === 'expr')) {
    value = interpolate(text, ctx); // 混合写法：结果是字符串，非空即真
  } else {
    value = evaluateExpression(text, ctx);
  }

  if (usesStatusFunction(text)) return ghaTruthy(value);
  return implicitSuccess && ghaTruthy(value);
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 七、job 调度模拟
 *
 * 「B 被跳过之后 C 还跑不跑」这种问题，光看 YAML 是答不出来的 —— 它取决于隐式
 * `success()`、取决于 skipped 算不算 success（不算）、取决于 `needs` 里每一格的
 * result。这里按拓扑序把整张图算一遍，把答案变成一个可以断言的对象。
 * ═══════════════════════════════════════════════════════════════════════════════════ */

const VALID_RESULTS = new Set(['success', 'failure', 'cancelled', 'skipped']);

function normalizeNeeds(needs, jobName) {
  if (needs === undefined || needs === null) return [];
  if (typeof needs === 'string') return [needs];
  if (Array.isArray(needs)) {
    for (const n of needs) {
      if (typeof n !== 'string') {
        throw new GhaExprError(
          `job \`${jobName}\` 的 needs 里有一项不是字符串：${JSON.stringify(n)}`,
        );
      }
    }
    return [...needs];
  }
  throw new GhaExprError(`job \`${jobName}\` 的 needs 只能是字符串或数组，实得 ${typeof needs}`);
}

/**
 * 按拓扑序模拟一整张 job 图。
 *
 * @param {object}   arg
 * @param {object}   arg.jobs    workflow 里 `jobs:` 那一段（jobName → { needs, if, … }）
 * @param {object}   arg.results 假设**跑起来**的话每个 job 会得到什么结果；缺省 'success'
 * @param {object}   arg.ctx     基础上下文（inputs / github / …）；
 *                               `ctx.__workflowCancelled === true` 表示整个 run 被取消
 * @returns {Record<string, 'success'|'failure'|'cancelled'|'skipped'>}
 *
 * 每个 job 的判定：
 *   · `needs` 上下文只放**直接依赖**（GitHub 同：needs 里只有直接依赖的 job）。
 *   · `__status`（即 `success()`）= 每个直接依赖的 result 都是 'success'。
 *   · `__failure`（即 `failure()`）= 至少有一个直接依赖是 'failure'。
 *   · `__cancelled` = 整个 run 被取消。
 *   · `if` 判为假 → 'skipped'；判为真 → 取 `results` 里给的结果（默认 'success'）。
 */
export function simulateJobs({ jobs, results = {}, ctx = {} } = {}) {
  if (jobs === null || typeof jobs !== 'object') {
    throw new GhaExprError('simulateJobs: `jobs` 必须是 jobName → job 的对象');
  }
  const names = Object.keys(jobs);
  if (names.length === 0) {
    throw new GhaExprError('simulateJobs: 一个 job 都没有 —— 这样的模拟不会有任何结论');
  }

  const needsOf = new Map();
  for (const name of names) {
    const list = normalizeNeeds(jobs[name]?.needs, name);
    for (const dep of list) {
      if (!Object.hasOwn(jobs, dep)) {
        throw new GhaExprError(
          `job \`${name}\` 的 needs 指向不存在的 job \`${dep}\` —— ` +
            `在真的 GitHub 上这会让整份 workflow 被拒绝`,
        );
      }
    }
    needsOf.set(name, list);
  }

  for (const [name, r] of Object.entries(results)) {
    if (!Object.hasOwn(jobs, name)) {
      throw new GhaExprError(
        `results 里有一个不存在的 job \`${name}\`（打错名字 = 这一格没被模拟到）`,
      );
    }
    if (!VALID_RESULTS.has(r)) {
      throw new GhaExprError(
        `results.${name} = ${JSON.stringify(r)} 不是合法结果，只能是 ${[...VALID_RESULTS].join(' / ')}`,
      );
    }
  }

  /* ── 拓扑排序（DFS，带环检测） ── */
  const order = [];
  const state = new Map(); // 'visiting' | 'done'
  const visit = (name, stack) => {
    const st = state.get(name);
    if (st === 'done') return;
    if (st === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(' → ');
      throw new GhaExprError(`needs 里有环：${cycle}`);
    }
    state.set(name, 'visiting');
    for (const dep of needsOf.get(name)) visit(dep, [...stack, name]);
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of names) visit(name, []);

  /* ── 按序判定 ── */
  const decided = {};
  for (const name of order) {
    const deps = needsOf.get(name);
    const needsCtx = {};
    for (const dep of deps) needsCtx[dep] = { result: decided[dep], outputs: {} };

    const jobCtx = {
      ...ctx,
      needs: needsCtx,
      __status: deps.every((d) => decided[d] === 'success'),
      __failure: deps.some((d) => decided[d] === 'failure'),
      __cancelled: ctx.__workflowCancelled === true,
    };

    decided[name] = evaluateIf(jobs[name]?.if, jobCtx) ? (results[name] ?? 'success') : 'skipped';
  }
  return decided;
}
