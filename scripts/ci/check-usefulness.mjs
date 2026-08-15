#!/usr/bin/env node
/**
 * ★ 「按钮和提示语一定要有用处」—— 这条要求的**第一道会红的门**。
 *
 * ## 它治的病
 *
 * 这条要求我们照着做过一次**人工审计**（#90：真浏览器、50 张截图、逐个点），
 * 它当场抓到了那一程最显眼的用户可见 bug（每条正在跑的任务都显示 100%）。
 * 但那次跑完就没了：判据留下一份文档（`docs/design/D-21-third-state-audit-spec.md`），
 * **零脚本引用**，执行全靠下一个人想起来。这和 #103 那句「没有任何一道门在管
 * 注释里断言的事实还成不成立」是同一个形状 —— **判据存在，执行靠人。**
 *
 * CI 里已经有的是**逐颗按钮的活点检查**（`scripts/ci/e2e-browser-audit.mjs` 的
 * 「立即测速点下去有反应」「移动到文件夹有入口且点得开」，都带证伪腿）。
 * 那一层管「这一颗按钮今天还活着吗」。这道门补的是**规则**那一层：
 * 有些写法只要出现，就必然产生一个用户读不到的解释 —— 那是静态判得了的。
 *
 * ## 🔴 范围：只做三条机器判得了的，其余明说判不了
 *
 * 「用户读完知不知道该做什么」机器判不了，这道门**不假装能判**。它只判三件事：
 *
 *   ① 一个禁用控件的「为什么灰」，是不是只挂在 `title` 上（⇒ 三条路都到不了）
 *   ② 用 `{{action}}` 点名控件的词条，调用点有没有把那颗按钮自己的名字喂进去
 *   ③ 「空」那一支有没有给出下一步（或第二句话）
 *
 * ## ① 为什么「只有 `title` 不算」
 *
 * `apps/web/src/components/common/Button.tsx` 的基类带 `disabled:pointer-events-none`：
 *
 * - **鼠标**：`pointer-events: none` 的元素收不到 `mouseover`，原生 tooltip
 *   **根本不弹** —— 不是"要悬停久一点"，是永远不弹。
 * - **键盘**：`disabled` 把它移出 tab 序列，聚焦不到，没有任何触发方式。
 * - **读屏**：`title` 在多数读屏配置下不播报。
 *
 * 三条路都不通 ⇒ daemon 认真算出来的那条原因，到了界面上等于没有。
 * 这不是推理：v0.7.1 与 v0.7.3 的已知边界里**两次**公开承认过它。
 * `apps/web/src/features/notes/RetranscribeButton.tsx` 里那颗是修好的样板
 * （可见横幅 `RetranscribeBlockedNotice` + `aria-describedby` 指过去）。
 *
 * ### 判据（定版）与它为什么不是更宽的那几版
 *
 * 判红一个元素要求它满足 (A) 或 (B)，且没有 `aria-label` / `aria-labelledby` /
 * `aria-describedby` 任何一个：
 *
 *   (A) 有**动态** `disabled`，且 `title` 表达式里出现了 `disabled` 表达式里的
 *       标识符 —— 那说明这句 `title` 讲的是**「为什么灰」**，不是"我是谁"；
 *   (B) `aria-disabled` 是**常量真** —— 这种元素只在"已禁用"那一支里渲染，
 *       它的 `title` 必然是理由。
 *
 * `[实测 a83be41]` 扫到 43 个带 `disabled`/`aria-disabled` 的 JSX 元素：
 *
 * | 版本 | 判红 | 真阳 | 结论 |
 * |---|---|---|---|
 * | 只要 `disabled` 就要求解释 | 43 | 5 | **否** —— `disabled={saving}` 这类瞬时禁用不需要理由 |
 * | 无 aria 且子节点无文本 | 0 | 0 | **否** —— 今天一条都抓不到（那 20 颗说不出话的按钮 v0.7.2 已整档不渲染） |
 * | 有 `title` 且无 aria | 8 | 5 | **否** —— MindmapView 的 undo/redo、BackendPackCard 的「更新」，`title` 是**名字**不是理由 |
 * | **定版 (A)+(B)** | **5** | **5** | 取 |
 *
 * ⚠️ **绕得过去**，而且很便宜：把三元拆掉、让 `title` 变成无条件的，这道门就闭嘴。
 * 绕过去的人至少得先把那句话改成一句**对所有状态都成立**的话（那时它就不再是
 * "为什么灰"了），但**它确实绕得过去**。所以 CLI 每一轮都会把这条绕法打出来 ——
 * 一个只有读源码的人才知道的绕法，等于没写。
 *
 * ## ② 为什么只守 `{{action}}`，不去抓硬编码的控件名
 *
 * #44 立过一个正确形状：`notes.cancelledHint` 用 `{{action}}`
 * **从按钮自己的词条取值**（`t('detail.retranscribe.open')`）——
 * 按钮改名时那句话跟着改，而不是指向一个屏幕上不存在的控件。
 *
 * 推广它的自然想法是「引号里点名的东西必须等于某条词条的值」。`[实测]` 否掉：
 * zh 侧 59 个引号片段判红 25，**真阳 0** —— 引号里全是概念、专名、以及
 * **我们特意要否定的那种说法**（`runtime.hw.reasonNotInstalled` 引
 * 「你的机器不支持」正是为了说"这不是"）。加"指路语"收窄后仍 10 红、仍 0 真阳；
 * en 侧 33 片段 16 红同理。**一道把「我们特意写下来否定的话」判成违例的门，
 * 会逼着人把对的东西改坏。**
 *
 * 所以这一条只守住**已经用了这个写法的地方**：带 `{{action}}` 的词条，它的
 * 每一个调用点都必须传 `action`，且值取自另一条 `t('<存在的 key>')`。
 * 🔴 **它今天零命中，是回归守卫，不是覆盖面。**
 *
 * ## ③ 「空」那一支
 *
 * 两种：`<EmptyState>` 必须给 `hint` 或 `action`；**组件早返回**的空分支
 * （`x.length === 0` 一族）如果渲染了文案，子树里必须有动作或第二句话。
 *
 * `[实测]` 更宽的两版都否掉：算上三元分支是 14 判点 8 红，其中
 * `runtime.noPacks`（「CPU 后端始终可用」—— 它自己就说了没什么可做的）、
 * `runtime.hw.noGpu`（「探过了 ——」那半句正是 #43 特意加的）、
 * `runtime.hw.avx2Unknown`（芯片碎片）**是正确形态**；三元的兄弟节点里
 * 常常就摆着那个动作，静态看不见。再把 `!x` / `== null` 算成"空"是 29 判点 16 红，
 * 多出来的全是 loading 分支和状态芯片。定版 11 判点 1 红。
 *
 * ## 🔴 它抓不到什么
 *
 * 见 `BOUNDARY` 那张表 —— 它**每一轮都打印到 CI 输出里**，绿的时候也打印。
 * 理由是 #103 那道门自己栽过的跟头：它把一条 ⓘ 挂在"有欠账才打印"的条件上，
 * 而那个条件恰好永远不成立，于是**一次都没打印过**。
 * 「写在脚本里」和「CI 日志里看得见」是两件事。
 *
 * 跑：`node scripts/ci/check-usefulness.mjs`（`pnpm test:ci-scripts` 会调）
 * 自检：`node scripts/ci/selftest-usefulness.mjs`
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 只扫前端源码；测试与夹具不是产品界面。 */
export const SCAN_DIR = 'apps/web/src';
export const LOCALE_DIR = 'apps/web/src/app/i18n/locales';

/**
 * 🔴 这道门的**诚实边界**，每一轮无条件打印。
 *
 * 校准集是这一程真实撞到的 6 条违例（不是我编的），逐条标「抓不抓得到」。
 */
export const BOUNDARY = {
  coverage: '2/6',
  caught: [
    '① 理由只挂在 title 上的禁用控件（v0.7.1 / v0.7.3 两次公开承认过的那一批）',
    '③ 组件早返回的空分支只有一句光秃秃的文案（转写稿面板「尚无转写稿」）',
  ],
  missed: [
    '组件页折叠区那 20 颗说不出话的按钮 —— 没有 title 可查，「旁边有没有可见文本」静态判不了',
    'jobBlocked.UNKNOWN 把人指向一个更空的房间 —— 「那一页说得够不够多」不是机器判据',
    '取消提示指向「重新转写」—— 已被 #44 的写法消灭；这道门只守住"别退回硬编码"那一侧',
    'partial「部分完成」说不出缺了哪一半 —— 那是状态芯片，不是空态分支',
  ],
  evasion:
    '① 绕得过去：把 title 的三元拆掉、让它对所有状态说同一句话，这道门就闭嘴（那时它也不再是「为什么灰」）',
  regressionOnly:
    '② {{action}} 那条**今天零命中**：它是回归守卫，不是覆盖面 —— 三条判据全绿≠三个方向都守住了',
};

/**
 * `title` / `disabled` 两边都出现也不算"共享状态"的标识符：
 * `t` / `i18n` 是翻译函数本身，`undefined` 是空档 —— 它们同时出现纯属必然。
 */
const NEUTRAL_IDENTS = new Set(['t', 'i18n', 'undefined', 'String', 'Boolean']);

/** 一条「解释路径」。`title` **不在**这张表里，理由见文件头 ①。 */
const EXPLAIN_ATTRS = ['aria-label', 'aria-labelledby', 'aria-describedby'];

/** 「空」判据：只认数得出来的那种空，不认 `!x`（那多半是 loading / 缺数据）。 */
const EMPTY_COND = /(^|[^\w.])\w[\w.?[\]]*\.(length|size)\s*(===|==)\s*0(\s|$|\))|\.length\s*<\s*1/;

/** 「这一支里有没有下一步」。 */
const ACTION_TAGS = /^(button|a|Link|NavLink|EmptyState|\w*Button)$/;
const ACTION_ATTRS = new Set(['onClick', 'href', 'to', 'action']);

function parse(rel, text) {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** 表达式里的标识符；**跳过属性名**（`pack.applicable` 只算 `pack`）。 */
export function identsIn(node) {
  const out = new Set();
  const walk = (n) => {
    if (ts.isPropertyAccessExpression(n)) {
      walk(n.expression);
      return;
    }
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, walk);
  };
  if (node) walk(node);
  return out;
}

/**
 * `aria-describedby` **值位置**上的 id 引用。
 *
 * ⚠️ 不能拿 `identsIn` 顶：`aria-describedby={blocked ? SOME_ID : undefined}` 里
 * `blocked` 是**条件**、不是 id，把它当 id 找会凭空造出一条"指不到"的假红
 * （`RetranscribeButton` 那颗修好的按钮实测被误伤过一次）。
 * 只认得出值位置的三种形态；模板串 / 函数调用一律**放行**（宁可漏检不误伤）。
 */
function idRefsIn(node) {
  if (!node) return [];
  if (ts.isStringLiteral(node)) return node.text.split(/\s+/).filter(Boolean);
  if (ts.isIdentifier(node)) return node.text === 'undefined' ? [] : [node.text];
  if (ts.isConditionalExpression(node)) {
    return [...idRefsIn(node.whenTrue), ...idRefsIn(node.whenFalse)];
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...idRefsIn(node.left), ...idRefsIn(node.right)];
  }
  if (ts.isParenthesizedExpression(node)) return idRefsIn(node.expression);
  return [];
}

function attrMap(node, sf) {
  const m = new Map();
  for (const a of node.attributes.properties) {
    if (ts.isJsxAttribute(a)) m.set(a.name.getText(sf), a);
  }
  return m;
}

/** `{expr}` → expr；`"literal"` → StringLiteral；`disabled`（光秃秃）→ null。 */
function attrValue(attr) {
  if (!attr || !attr.initializer) return null;
  if (ts.isJsxExpression(attr.initializer)) return attr.initializer.expression ?? null;
  return attr.initializer;
}

function isConstTrue(expr) {
  if (!expr) return true; // 光秃秃的 `disabled` = 常量真
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  return ts.isStringLiteral(expr) && expr.text === 'true';
}

/** 子树里有没有可交互的东西。 */
function hasAction(node, sf) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (ACTION_TAGS.test(n.tagName.getText(sf))) {
        found = true;
        return;
      }
      for (const a of n.attributes.properties) {
        if (ts.isJsxAttribute(a) && ACTION_ATTRS.has(a.name.getText(sf))) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** 第一实参可能是 `'a'`，也可能是 `cond ? 'a' : 'b'`。 */
function stringLiteralsIn(node) {
  const out = [];
  if (!node) return out;
  const walk = (n) => {
    if (ts.isStringLiteral(n)) out.push(n.text);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

function isTCall(n) {
  return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 't';
}

/** 子树里 `t('…')` 用到的 key。 */
function tKeysIn(node) {
  const keys = [];
  const walk = (n) => {
    if (isTCall(n)) keys.push(...stringLiteralsIn(n.arguments[0]));
    ts.forEachChild(n, walk);
  };
  walk(node);
  return keys;
}

function unwrapParens(e) {
  let cur = e;
  while (cur && ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function isJsx(n) {
  return Boolean(n) && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n));
}

/**
 * 扫一份 .tsx —— ① 与 ③。
 *
 * 跨文件才判得了的那半（`aria-describedby` 指的 id 到底有没有人渲染）
 * 这里只**收集**，由 `collect()` 汇总后判。
 */
export function scanSource(rel, text) {
  const sf = parse(rel, text);
  const findings = [];
  const ids = new Set();
  const describedBy = [];
  const stats = { disabledEls: 0, emptyStates: 0, emptyBranches: 0 };

  const visitJsx = (node) => {
    const tag = node.tagName.getText(sf);
    const attrs = attrMap(node, sf);
    const line = lineOf(sf, node);

    /* 收集：谁在渲染 id（给 aria-describedby 对账用） */
    const idExpr = attrValue(attrs.get('id'));
    if (idExpr) {
      if (ts.isStringLiteral(idExpr)) ids.add(idExpr.text);
      for (const i of identsIn(idExpr)) ids.add(i);
    }
    const dbExpr = attrValue(attrs.get('aria-describedby'));
    for (const r of idRefsIn(dbExpr)) {
      if (!NEUTRAL_IDENTS.has(r)) describedBy.push({ rel, line, tag, ref: r });
    }

    /* ── ① 禁用控件的解释路径 ─────────────────────────────── */
    const disAttr = attrs.get('disabled') ?? attrs.get('aria-disabled');
    if (disAttr) {
      stats.disabledEls++;
      const disExpr = attrValue(disAttr);
      const titleExpr = attrValue(attrs.get('title'));
      const explained = EXPLAIN_ATTRS.some((k) => attrs.has(k));
      if (titleExpr && !explained) {
        const constDisabled = isConstTrue(disExpr);
        const disIdents = identsIn(disExpr);
        const shared = [...identsIn(titleExpr)].filter(
          (i) => !NEUTRAL_IDENTS.has(i) && disIdents.has(i),
        );
        if (constDisabled || shared.length > 0) {
          findings.push({
            rule: 'disabled-reason-unreachable',
            rel,
            line,
            what: `<${tag}>`,
            detail: constDisabled
              ? '常量 aria-disabled + title：这个元素只在「已禁用」那一支里渲染，所以 title 说的就是理由'
              : `title 依赖 ${shared.join('/')}，而 disabled 也依赖它 ⇒ 这句 title 说的是「为什么灰」`,
          });
        }
      }
    }

    /* ── ③a EmptyState 的契约 ────────────────────────────── */
    if (tag === 'EmptyState') {
      stats.emptyStates++;
      if (!attrs.has('hint') && !attrs.has('action')) {
        findings.push({
          rule: 'empty-state-no-next-step',
          rel,
          line,
          what: '<EmptyState>',
          detail: '只有 title：既没给动作（action），也没给一句「没什么可做的」（hint）',
        });
      }
    }
  };

  /* ── ③b 组件早返回的空分支 ──────────────────────────────── */
  const emptyBranchReturns = (node) => {
    if (!ts.isIfStatement(node)) return [];
    if (!EMPTY_COND.test(node.expression.getText(sf))) return [];
    /*
     * 必须是组件体里的**直接** if。三元分支和嵌套分支刻意不判：
     * 它们的兄弟节点里常常就摆着那个动作，静态看不见 —— 实测那样会把
     * `runtime.noPacks` / `runtime.hw.noGpu` 这些**正确形态**判红。
     */
    const block = node.parent;
    const fn = block && ts.isBlock(block) ? block.parent : null;
    const inFnBody =
      Boolean(fn) &&
      (ts.isFunctionDeclaration(fn) ||
        ts.isArrowFunction(fn) ||
        ts.isFunctionExpression(fn) ||
        ts.isMethodDeclaration(fn));
    if (!inFnBody) return [];
    const then = node.thenStatement;
    const stmts = ts.isBlock(then) ? then.statements : [then];
    return stmts
      .filter((s) => ts.isReturnStatement(s) && s.expression)
      .map((s) => unwrapParens(s.expression))
      .filter(isJsx);
  };

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) visitJsx(node);
    for (const ret of emptyBranchReturns(node)) {
      const keys = tKeysIn(ret);
      if (keys.length === 0) continue; // 不渲染文案 = 数据回落，不是"空态"
      stats.emptyBranches++;
      if (!hasAction(ret, sf) && keys.length < 2) {
        findings.push({
          rule: 'empty-branch-no-next-step',
          rel,
          line: lineOf(sf, ret),
          what: keys[0],
          detail: '这一支是整个组件的全部输出：一句文案，没有动作，也没有第二句说「没什么可做的」',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { findings, ids, describedBy, stats };
}

/**
 * ② `{{action}}` 那个形状：调用点必须把**按钮自己的词条**喂进去。
 *
 * @param placeholders 带 `{{action}}` 的 locale key
 * @param sources `[{rel, text}]`
 * @param localeKeys 所有存在的 key（判"喂进去的那条词条真的有"）
 */
export function scanActionPlaceholders(placeholders, sources, localeKeys) {
  const findings = [];
  const supplied = new Map(placeholders.map((k) => [k, 0]));

  for (const { rel, text } of sources) {
    const sf = parse(rel, text);
    const visit = (node) => {
      if (isTCall(node)) {
        const keys = stringLiteralsIn(node.arguments[0]).filter((k) => placeholders.includes(k));
        if (keys.length > 0) {
          const line = lineOf(sf, node);
          for (const k of keys) supplied.set(k, (supplied.get(k) ?? 0) + 1);
          const opts = node.arguments[1];
          const prop =
            opts && ts.isObjectLiteralExpression(opts)
              ? opts.properties.find(
                  (p) =>
                    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                    p.name.getText(sf) === 'action',
                )
              : undefined;
          if (!prop) {
            findings.push({
              rule: 'action-placeholder-missing',
              rel,
              line,
              what: keys.join('/'),
              detail:
                '词条用 {{action}} 点名了控件，调用点却没传 action ⇒ 屏幕上会出现字面量 {{action}}',
            });
          } else {
            const val = ts.isPropertyAssignment(prop) ? prop.initializer : null;
            const inner = val && isTCall(val) ? stringLiteralsIn(val.arguments[0]) : null;
            if (!inner || inner.length === 0) {
              findings.push({
                rule: 'action-placeholder-hardcoded',
                rel,
                line,
                what: keys.join('/'),
                detail:
                  'action 的值不是 t(<按钮自己的词条>)：按钮改名之后这句话会指着一个屏幕上不存在的控件，而且不会有任何东西报错',
              });
            } else {
              for (const ik of inner) {
                if (!localeKeys.has(ik)) {
                  findings.push({
                    rule: 'action-placeholder-dangling',
                    rel,
                    line,
                    what: `${keys.join('/')} ← ${ik}`,
                    detail: '喂进去的那条词条不存在',
                  });
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  for (const [k, n] of supplied) {
    if (n === 0) {
      findings.push({
        rule: 'action-placeholder-unused',
        rel: LOCALE_DIR,
        line: 0,
        what: k,
        detail: '词条用 {{action}} 点名了控件，源码里却没有任何调用点 —— 要么接上，要么删掉',
      });
    }
  }
  return findings;
}

export function flattenLocale(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flattenLocale(v, key, out);
    else out.set(key, String(v));
  }
  return out;
}

/* ── 地板：一道扫不到东西的门永远是绿的，那比没有门更坏 ───────────── */
export const FLOORS = { disabledEls: 30, emptyStates: 6, emptyBranches: 2, localeKeys: 800 };

function walkDir(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else out.push(p);
  }
  return out;
}

function listSources(root) {
  const dir = join(root, SCAN_DIR);
  let rels;
  if (root === REPO) {
    rels = execFileSync('git', ['-C', root, 'ls-files', SCAN_DIR], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
      .split('\n')
      .filter(Boolean);
  } else {
    rels = walkDir(dir).map((p) => relative(root, p));
  }
  return rels
    .filter(
      (f) =>
        (f.endsWith('.tsx') || f.endsWith('.ts')) && !f.includes('/test/') && !f.includes('.test.'),
    )
    .map((rel) => ({ rel, text: readFileSync(resolve(root, rel), 'utf8') }));
}

/** 把三条判据跑完，返回 `{ findings, stats, ... }` —— 不打印、不 exit。 */
export function collect(root) {
  const sources = listSources(root);
  const findings = [];
  const ids = new Set();
  const describedBy = [];
  const stats = { disabledEls: 0, emptyStates: 0, emptyBranches: 0 };

  for (const { rel, text } of sources) {
    if (!rel.endsWith('.tsx')) continue;
    const r = scanSource(rel, text);
    findings.push(...r.findings);
    for (const i of r.ids) ids.add(i);
    describedBy.push(...r.describedBy);
    for (const k of Object.keys(stats)) stats[k] += r.stats[k];
  }

  /* `aria-describedby` 指向的 id 必须真的有人渲染 —— 指不到时它**静默失效**。 */
  for (const d of describedBy) {
    if (!ids.has(d.ref)) {
      findings.push({
        rule: 'describedby-dangling',
        rel: d.rel,
        line: d.line,
        what: `<${d.tag}> → ${d.ref}`,
        detail: 'aria-describedby 指向一个没有人渲染成 id= 的东西：不报错、静默失效',
      });
    }
  }

  const zh = flattenLocale(
    JSON.parse(readFileSync(resolve(root, LOCALE_DIR, 'zh-CN.json'), 'utf8')),
  );
  const en = flattenLocale(JSON.parse(readFileSync(resolve(root, LOCALE_DIR, 'en.json'), 'utf8')));
  const localeKeys = new Set([...zh.keys(), ...en.keys()]);
  const placeholders = [
    ...new Set([...zh, ...en].filter(([, v]) => /\{\{action\}\}/.test(v)).map(([k]) => k)),
  ];
  findings.push(...scanActionPlaceholders(placeholders, sources, localeKeys));

  return { findings, stats, sources, localeKeys, placeholders };
}

/**
 * 🔴 无条件打印的那一段。**不许挂条件** —— 见文件头最后一节。
 * 它自己被 `selftest-usefulness.mjs` 用 CLI 输出钉住（正反向都钉）。
 */
export function boundaryLines(redCount) {
  const l = [];
  l.push('─── 这道门抓得到什么 / 抓不到什么（每轮都打，绿的时候也打）───');
  l.push(
    `  本轮判红 ${redCount} 处。**覆盖面 ${BOUNDARY.coverage}** —— 拿这一程 6 条真实违例校准：`,
  );
  for (const c of BOUNDARY.caught) l.push(`    ✔ 抓得到：${c}`);
  for (const m of BOUNDARY.missed) l.push(`    ✘ 抓不到：${m}`);
  l.push(`  ⚠️ ${BOUNDARY.regressionOnly}`);
  l.push(`  ⚠️ ${BOUNDARY.evasion}`);
  l.push('  ⇒ 绿灯**不能**读成「按钮和提示语都有用」。「用户读完知不知道该做什么」');
  l.push('     机器判不了，仍然只有人能判 —— 该派的人照派（#90 那种真浏览器逐个点）。');
  return l;
}

function main(root) {
  const { findings, stats, sources, localeKeys, placeholders } = collect(root);

  console.log('「按钮和提示语要有用处」—— 三条机器判得了的判据');
  console.log(
    `  扫过：${sources.length} 份源码 · 禁用控件 ${stats.disabledEls} 个 · ` +
      `<EmptyState> ${stats.emptyStates} 处 · 空分支 ${stats.emptyBranches} 处 · ` +
      `{{action}} 词条 ${placeholders.length} 条 · locale key ${localeKeys.size}`,
  );

  let failed = 0;
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  if (findings.length === 0) {
    console.log('');
    console.log('✔ 三条判据都过。');
  } else {
    for (const [rule, list] of byRule) {
      console.log('');
      console.log(`✘ ${rule}（${list.length} 处）`);
      for (const f of list) {
        console.log(`     ${f.rel}:${f.line}  ${f.what}`);
        console.log(`        ${f.detail}`);
      }
    }
    console.log('');
    console.log('   怎么修：');
    console.log('     · disabled-reason-unreachable → 把理由渲染成**可见文本**并给它 id，');
    console.log('       控件上加 aria-describedby 指过去（样板：RetranscribeButton.tsx 与');
    console.log('       RetranscribeBlockedNotice）。只留 title 不算 —— 三条输入路都到不了。');
    console.log('     · empty-*-no-next-step → 给一个动作，**或者**明说一句「没什么可做的」。');
    console.log('     · action-placeholder-* → 按钮名从按钮自己的词条取（#44 的形状）。');
    failed += findings.length;
  }

  /*
   * 地板只对**真仓库**判：夹具根天生只有几份文件，拿真仓库的量级去卡它
   * 会让每一次自检都红成一片，那样地板就会被人调小到失去意义。
   * 夹具跑的是判据本身，地板由 `selftest-usefulness.mjs` 直接对着真仓库断言。
   */
  for (const [k, floor] of root === REPO ? Object.entries(FLOORS) : []) {
    const got = k === 'localeKeys' ? localeKeys.size : stats[k];
    if (got < floor) {
      console.log('');
      console.log(`✘ 扫到的 ${k} 掉到地板以下（${got} < ${floor}）。`);
      console.log('   这几乎一定是扫描器坏了，而不是"界面上真的少了这么多"。');
      failed++;
    }
  }

  console.log('');
  for (const line of boundaryLines(findings.length)) console.log(line);

  console.log('');
  if (failed > 0) {
    console.log(`${failed} 处。`);
    process.exit(1);
  }
  console.log('通过。');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv[2] ? resolve(process.argv[2]) : REPO);
}
