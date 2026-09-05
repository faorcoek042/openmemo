#!/usr/bin/env node
/**
 * 防线：**写好了、但从来没被接上**的导出。
 *
 * ## 为什么值得一条门禁
 *
 * `backlog-sweep`（T-155）把 35 份 inbox 扫了一遍，15 条"用户能撞上"的缺陷里
 * **有 6 条是这个扫描直接查出来的，而这 6 条在 35 份回执的文本里一个字都没提**。
 * 原因很朴素：**没人认为自己写的东西没被接上**。
 * 这类缺陷不会有人主动报告，只能靠机器扫 —— 与 `check-tracked-sources.mjs` 同一条理由。
 *
 * 它的典型形态不是"死代码"，是**功能只做了一半**：
 *   · `ERROR_MESSAGES_ZH` 零调用方 → 中文界面显示英文错误（T-155 修）
 *   · `useDeleteNoteMutation` 零调用方 → 笔记建出来就永远删不掉（T-155 修）
 *   · `useModelsSourcesQuery` 零调用方 → 下载源界面整块不存在（T-157 ④ 修）
 *   · `stashForRollback` 零调用方 → 回滚按钮恒不渲染，而 UI 承诺了它（T-157 ② 修）
 *
 * ## 判据：**只准变少**
 *
 * 全仓现存的零引用导出有几十个，其中一部分是有意留的（契约类型、公开 API 形状、
 * 刻意保留的兜底）。所以门禁不是"必须为 0"，而是一条棘轮：
 *
 *   · 出现**基线之外**的新条目 → 红。要么接上它，要么删掉它，要么登记进基线并写清理由。
 *   · 基线里的条目**已经有人用了** → 也红。基线只准变短，不许留过期条目 ——
 *     一份不会缩水的豁免名单，几轮之后就没人相信它了。
 *
 * ## 三个"我可能自己瞎掉"的自检（写在检查之前，不是之后）
 *
 * 第一版这个扫描用 `git ls-files` 配一条 `apps/<包>/src/[两个星]/[星].ts` 形状的 glob 取文件，
 * **漏掉了 `src/` 第一层**（`main.ts` 就在那儿），于是报出 251 个假阳性，
 * 连 `createNoteRoutes` 都成了"零调用方"。它没有报错，只是安静地少看了一批文件。
 * → **工具返回空集/残缺集 ≠ 没有。先证明探针能看见你已知存在的东西。**
 *
 * 所以每次运行先过三关，任何一关不过就当场退出：
 *   ① 文件清单非空，且**包含 `src/` 第一层的文件**（就是当年漏掉的那一类）；
 *   ② 扫出的导出总数不能少得离谱（结构变了/正则失效会表现为"突然很干净"）；
 *   ③ 一个**已知一定有调用方**的名字（`createNoteRoutes`）必须**不**出现在结果里。
 *
 * ## 其它两个踩过的坑
 *
 * · **不用 `grep`**：它对含裸控制字节的文件会**整文件静默跳过**（无输出、exit 1，
 *   长得和"0 命中"一模一样，`path-guard` T-143 §4.1 实测过）。这里一律用 Node 读。
 * · **先剥注释再统计引用**：否则一句「`stashForRollback` 见下」的注释就足以让它
 *   看起来"有调用方"。
 *
 * ## 刻意不管的一类
 *
 * "只有测试引用"的导出**只打印、不判红**。测试专用出口（`stubApi`、`__testing`、
 * `pinAuthMode`）本来就该只有测试引用，把它们卷进棘轮只会逼人往基线里灌水。
 * 它们仍然打出来 —— 里面确实藏着真缺陷（导图的三个 `from*` 解析器没有产品入口），
 * 但那是**人看**的清单，不是机器判据。
 *
 * ## ★ 第三档：**只被再导出**（T-160 补回）
 *
 * 这个扫描固化进 `scripts/` 时**丢了一档**。`backlog-sweep §7` 的 `/tmp` 原型区分三档：
 * 「零引用」/「只有测试引用」/**「只有 index 再导出」**，第三档没跟过来。
 *
 * 后果是**门禁绿着，而它该抓的东西从名单里消失**：下面统计 `prod` 命中时，
 * barrel `index.ts` 里的一句 `export { X } from './api'` 也算一次真引用，
 * 于是任何被 barrel 转出去的导出，哪怕真实消费方为 0，也**永远进不了红名单**。
 * `progress-audit` 按同口径重扫的量化结果：**28 个导出只被再导出、零真实产品调用方，
 * 其中 18 个连测试都没有** —— 里面就有 `useMoveNoteMutation`（笔记移动到文件夹）
 * 与 `useRenameFolderMutation`（文件夹改名），形状与门禁修好过的
 * `useDeleteNoteMutation` **一模一样**。
 *
 * ### 判据钉的是**语句**，不是文件名
 *
 * 原型说的是"只有 index 再导出"，但"叫不叫 index.ts"是**命名约定**，不是事实。
 * 这里改成：把每个文件里的 `export … from '…'` / `export * from '…'` 语句**整段挖掉**，
 * 再数一次命中。命中归零 = 这个文件对它的引用**只是一次转发**。
 * 于是放在任何文件里的再导出都算数，改名 barrel 也骗不过它。
 *
 * ### 为什么只打印不判红
 *
 * 28 条一次性判红会逼人往基线里灌水，而灌过水的名单没人再信。
 * 更要紧的是：**这一档与 `orphans` 的口径必须彼此独立** —— `orphans` 仍然按
 * 「含再导出在内的 `prod === 0`」算，所以本次改动**不会挪动棘轮基线一个字**
 * （两档在定义上不相交：`orphans` 要求 `prod === 0`，本档要求 `prod > 0`）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { prepare, REPO, scanSource, sourceFiles, stripCommentsOnly } from './lib/ts-lexer.mjs';

const BASELINE_PATH = join(REPO, 'scripts', 'orphan-exports-baseline.json');

/** 一定要能看见的文件 —— 当年那个残缺 glob 恰好漏掉的就是它。 */
const PROBE_FILE = 'apps/daemon/src/main.ts';
/** 一定有调用方的导出 —— 它出现在结果里就说明扫描本身瞎了。 */
const PROBE_EXPORT = 'createNoteRoutes';
/** 导出总数的下限。远低于现状（约 1000+），只用来抓"突然什么都扫不到"。 */
const MIN_EXPORTS = 200;

/*
 * ★ 词法扫描器与源文件清单搬到了 `scripts/lib/ts-lexer.mjs`（本轮）。
 *
 * 搬家的理由和这条门禁本身要抓的东西是同一件事：`check-duplicate-declarations.mjs`
 * 需要同一个扫描器，而抄第二份必然抄成**少了几条实测分支**的那种残缺 ——
 * 那种残缺表现成「探针安静地少看了一批文件」，不报错、还像好消息。
 * 搬的是代码，**判据一个字没动**：下面的三关自检、`classify()` 与基线全部照旧。
 */

const DECL_RE =
  /export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

/**
 * 再导出语句 —— `export { … } from '…'`、`export type { … } from '…'`、
 * `export * from '…'`、`export * as ns from '…'`。
 *
 * **不含**本地 `export { X }`（没有 `from`）：那是"把本文件里的东西导出去"，
 * 不是转发别人的，且它出现在声明所在文件里，本来就会被算进 `self`。
 */
const REEXPORT_RE =
  /export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?)\s+from\s*(['"])[^'"]*\1\s*;?/g;

/** 把再导出语句整段挖成空白，保留其余代码。用于区分"真引用"与"只是转发"。 */
function stripReexports(body) {
  REEXPORT_RE.lastIndex = 0;
  return body.replace(REEXPORT_RE, ' ');
}

const isTestFile = (p) => p.includes('.test.') || p.includes('/__tests__/') || p.includes('/test/');

/* ─────────────── 重名遮蔽：模块解析（T-183） ───────────────
 *
 * ## 它修的是「守卫量错了东西」
 *
 * 这个扫描判「有没有人引用 X」用的是**裸标识符名跨全仓正则**
 * （`new RegExp('\\b' + n + '\\b')`），**没有任何模块解析**。
 * 于是**同名导出互相证明对方活着**：
 *
 *   `apps/web/src/lib/api/auth-mode.ts :: authRequired`   ← 真的零调用方
 *   `apps/daemon/src/http/auth.ts     :: authRequired`    ← daemon 三处在用
 *
 * daemon 那三处命中被算进了 **web 那个**的 `prod`，于是 web 的 `authRequired`
 * **永远进不了任何一档名单** —— 门禁绿着，而它该抓的东西从名单里消失。
 * `[实测]` 全仓共 **41 个重名导出（37 个跨包）**对旧口径全部隐形，
 * `PACKAGE_NAME` 更是在 7 个包里互相"证明"了一圈（`debt-cleanup §4.1` 记过同一个坑，
 * 那是它的第三次现身）。
 *
 * ## 判据：只对**重名**做模块解析，其余一个字不动
 *
 * 全量模块解析会挪动整条棘轮基线（那本身就是一次没人复核过的大改口径）。
 * 所以作用域限定**只在名字重复时生效**：
 *
 *   · 名字全仓唯一（1864/1905）→ 走原来的裸名统计，**基线逐字不变**；
 *   · 名字重复（41 个）→ 一次命中只有在**该文件真的从解析得到本声明的模块里
 *     绑定了这个名字**时才计数。
 *
 * ## 解析不了的时候：判「判不了」，**不判「有引用」**
 *
 * 旧实现在拿不准时一律偏向"有引用"（因为它根本没在拿捏）——
 * 那正是遮蔽的成因。这里反过来：绑定存在、但 specifier 解析不到本仓文件时，
 * 该条目落进 `undecidable` 一档单独列出，既不混进 `orphans`（会误伤），
 * 也不静默算成"有人用"（会遮蔽）。
 */

/** `import … from '…'` / `export … from '…'`。分组：1=关键字 2=子句 3=引号 4=模块名。 */
const MODULE_STMT_RE =
  /\b(import|export)\s+(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|[A-Za-z_$][\w$]*(?:\s*,\s*\{[^}]*\})?)\s*from\s*(['"])([^'"]*)\3/g;

/** 本地再导出 `export { a, b as c }`（**没有** `from`）—— barrel 的另一种写法。 */
const LOCAL_EXPORT_RE = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*(?!from\b)(?:;|\n|$)/g;

/** 拆 `{ a, b as c, type D }` 里的每一项，给出 `{ orig, local }`。 */
function splitSpecifiers(inner) {
  const out = [];
  for (const part of inner.split(',')) {
    const t = part.trim().replace(/^type\s+/, '');
    if (!t) continue;
    const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
    if (as) out.push({ orig: as[1], local: as[2] });
    else if (/^[A-Za-z_$][\w$]*$/.test(t)) out.push({ orig: t, local: t });
  }
  return out;
}

/**
 * 一个文件的模块绑定。
 *
 * ⚠️ **必须喂"只剥了注释、字符串还在"的源码**：`prepare()` 会把字符串内容抹空，
 * 而模块名就住在字符串里 —— 喂错了这里会一条 specifier 都取不到，
 * 表现为"全仓都解析不了"，和"本来就没有 import"长得一模一样。
 * 下面 `bindingSpecs` 那条自检就是为了抓这个。
 */
function moduleBindings(src) {
  /** 具名绑定：`kw==='import'` 是消费，`kw==='export'` 是转发。两者都算"绑定了这个名字"。 */
  const named = [];
  /** `import * as ns from` 与 `export * from`。 */
  const stars = [];
  /** `export { X }`（无 from）里出现的名字 —— 转发，但来源要回头看本文件的 import。 */
  const localReexports = new Set();

  MODULE_STMT_RE.lastIndex = 0;
  let m;
  while ((m = MODULE_STMT_RE.exec(src))) {
    const [, kw, clause, , spec] = m;
    if (clause.startsWith('*')) {
      stars.push({ kw, spec });
      continue;
    }
    const brace = /\{([^}]*)\}/.exec(clause);
    if (!brace) continue; // 纯默认导入：具名导出不经由它
    for (const s of splitSpecifiers(brace[1])) named.push({ ...s, kw, spec });
  }

  LOCAL_EXPORT_RE.lastIndex = 0;
  while ((m = LOCAL_EXPORT_RE.exec(src))) {
    for (const s of splitSpecifiers(m[1])) localReexports.add(s.orig);
  }
  return { named, stars, localReexports };
}

/**
 * 「这条模块名指向本仓外面」的判定结果。
 *
 * ⚠️ 三态是**必须的**，不能只有「解析到了 / 没解析到」：
 * `node:os`、`react` 这类外部模块**在结构上不可能**导出本仓的声明，
 * 把它们算进"判不了"会让每个带 `import * as os from 'node:os'` 的文件
 * 把它引用的每一个重名导出都拖进"判不了" —— 那一档会淹掉，
 * 于是「判不了」和「有引用」一样成为遮蔽的新去处。
 * `[实测]` 第一版正是如此：`BreakerVerdict` / `ProbeResult` 被
 * `apps/daemon/src/runtime/setup.ts` 的两条 `node:` 命名空间导入拖成"判不了"。
 */
const EXTERNAL = Symbol('external-module');

/**
 * 模块解析器。**只认扫描集合里的文件** —— 不碰磁盘，于是自检可以拿写死的
 * 假路径样本跑同一段代码（与 `classify()` 同一条讲究）。
 *
 * 返回：文件路径（解析到了）/ `EXTERNAL`（本仓外，结构上不可能是它）/ `null`（判不了）。
 */
function makeResolver(fileSet) {
  /** 工作区包入口：`<scope>/<dir>` → `(apps|packages)/<dir>/src/index.ts`。 */
  const pkgEntry = new Map();
  for (const f of fileSet) {
    const m = /^(?:apps|packages)\/([^/]+)\/src\/index\.tsx?$/.exec(f);
    if (m) pkgEntry.set(m[1], f);
  }

  const pick = (base) => {
    const tries = [];
    if (/\.jsx?$/.test(base))
      tries.push(base.replace(/\.jsx?$/, '.ts'), base.replace(/\.jsx?$/, '.tsx'));
    tries.push(base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`);
    for (const t of tries) if (fileSet.has(t)) return t;
    return null;
  };

  const cache = new Map();
  return function resolveSpec(spec, fromFile) {
    const k = `${fromFile}\0${spec}`;
    if (cache.has(k)) return cache.get(k);
    let out;
    if (spec.startsWith('.')) {
      // `./x.css` / `./logo.svg` 之类：不是 TS 模块，不可能有我们的声明
      out = /\.(?:css|svg|png|jpe?g|webp|json|wasm)$/.test(spec)
        ? EXTERNAL
        : (pick(join(dirname(fromFile), spec)) ?? null);
    } else if (spec.startsWith('node:')) {
      out = EXTERNAL;
    } else {
      const bare = /^(?:@[^/]+\/)?([^/]+)$/.exec(spec);
      if (bare) {
        // 工作区包 → 入口文件；否则是 npm 依赖 → 本仓外
        out = pkgEntry.get(bare[1]) ?? EXTERNAL;
      } else {
        // 带子路径：`@openmemo/shared/foo` 我们不解析子路径 → 判不了；
        // `lodash/merge` 之类第一段不是工作区包的 → 本仓外
        const head = /^(?:@[^/]+\/)?([^/]+)\//.exec(spec);
        out = head && pkgEntry.has(head[1]) ? null : EXTERNAL;
      }
    }
    cache.set(k, out);
    return out;
  };
}

/**
 * 分档。**参数是文件内容表**，不是从磁盘读 —— 这样自检可以拿一段写死的样本
 * 跑**同一段代码**，而不是复述一遍它的逻辑（复述出来的对照组只能证明复述本身）。
 *
 * @param bodies  剥了注释**与字符串内容**的源码（引用统计用）
 * @param sources 只剥了注释、**字符串还在**的源码（模块解析用；缺省退回 `bodies`，
 *                那样解析不出任何 specifier —— 所以调用方必须传，`bindingSpecs` 自检钉着）
 */
function classify(bodies, sources = bodies) {
  /** 同一份 body，但再导出语句被挖空 —— 用来分辨"真引用"与"只是转发"。 */
  const bodiesNoReexport = new Map();
  let reexportStatements = 0;
  for (const [f, body] of bodies) {
    REEXPORT_RE.lastIndex = 0;
    reexportStatements += (body.match(REEXPORT_RE) || []).length;
    bodiesNoReexport.set(f, stripReexports(body));
  }

  /**
   * 有几个文件的"挖空版"**真的和原文不同**。
   *
   * ⚠️ 判据必须读**存进 map 的那个值**，不能读 `stripReexports()` 的返回值 ——
   * 两者看起来等价，但要抓的回归恰恰是"算对了、存错了"：
   * `[实测]` 反向验证时把 `bodiesNoReexport.set(f, stripReexports(body))` 改成
   * `set(f, body)`，这一档从 21 条变成 0 条，而按返回值计数的那版自检**一格都没响** ——
   * 它证明的是"剥离函数还活着"，不是"剥离结果被用上了"。
   */
  let strippedFiles = 0;
  for (const [f, body] of bodies) {
    if (bodiesNoReexport.get(f) !== body) strippedFiles += 1;
  }

  /* ── 谁声明了什么（含测试文件：重名的另一半可能就住在那儿） ── */
  const declsOf = new Map();
  /** 名字 → 声明它的**非测试**文件集合。size > 1 就是重名。 */
  const declaringFiles = new Map();
  for (const [f, body] of bodies) {
    const s = new Set();
    DECL_RE.lastIndex = 0;
    let m;
    while ((m = DECL_RE.exec(body))) s.add(m[1]);
    declsOf.set(f, s);
    if (isTestFile(f)) continue;
    for (const n of s) {
      if (!declaringFiles.has(n)) declaringFiles.set(n, new Set());
      declaringFiles.get(n).add(f);
    }
  }
  const ambiguous = new Set([...declaringFiles].filter(([, fs]) => fs.size > 1).map(([n]) => n));

  /* ── 模块绑定与解析 ── */
  const bindings = new Map();
  let bindingSpecs = 0;
  for (const [f] of bodies) {
    const b = moduleBindings(sources.get(f) ?? '');
    bindings.set(f, b);
    bindingSpecs += b.named.length + b.stars.length;
  }
  const resolveSpec = makeResolver(new Set(bodies.keys()));

  /*
   * 有几条模块名**真的解析到了本仓的一个源文件**。
   *
   * ⚠️ 判据必须是"解析到了"，不能只数"取到了几条绑定"。
   * `[实测]` 把 `classify(bodies, commentsOnly)` 写成 `classify(bodies, bodies)`
   * （字符串内容被抹空，模块名变成空串）之后：`bindingSpecs` 仍是 5408 ——
   * 因为 `prepare()` 只抹内容、**引号还在**，`from ''` 照样被正则匹配到。
   * 于是按 `bindingSpecs` 写的那版自检**一格都没响**，而零引用导出
   * 从 74 个暴涨到 89 个（15 个凭空冒出来的假阳性）。
   * 换成数"解析到文件的条数"才抓得住：空模块名一条也解析不到。
   */
  let resolvedSpecs = 0;
  for (const [f, b] of bindings) {
    for (const e of [...b.named, ...b.stars]) {
      const t = resolveSpec(e.spec, f);
      if (t && t !== EXTERNAL) resolvedSpecs += 1;
    }
  }

  /** 「模块 `file` 对外叫 `name` 的那个导出，声明在哪个文件？」barrel 逐跳跟到底。 */
  const originMemo = new Map();
  function origin(file, name, depth = 0) {
    if (!file || file === EXTERNAL || depth > 16) return null;
    const k = `${file}\0${name}`;
    if (originMemo.has(k)) return originMemo.get(k);
    originMemo.set(k, null); // 环保护：barrel 互引不至于爆栈
    let out = null;
    if (declsOf.get(file)?.has(name)) out = file;
    else {
      const b = bindings.get(file);
      if (b) {
        for (const e of b.named) {
          if (out) break;
          if (e.kw !== 'export' || e.local !== name) continue;
          out = origin(resolveSpec(e.spec, file), e.orig, depth + 1);
        }
        // `export { X }`（无 from）：来源要回头看本文件的 import
        if (!out && b.localReexports.has(name)) {
          for (const e of b.named) {
            if (out) break;
            if (e.kw !== 'import' || e.local !== name) continue;
            out = origin(resolveSpec(e.spec, file), e.orig, depth + 1);
          }
        }
        if (!out) {
          for (const s of b.stars) {
            if (out) break;
            if (s.kw !== 'export') continue;
            out = origin(resolveSpec(s.spec, file), name, depth + 1);
          }
        }
      }
    }
    originMemo.set(k, out);
    return out;
  }

  /**
   * 文件 `g` 里出现的 `n`，是不是**真的**指向声明在 `f` 的那一个？
   *
   * 返回 `bound`（是）/ `unresolved`（有同名绑定，但模块名解析不到本仓文件 → 判不了）。
   * 两者都不成立 = 这次文本命中与 `f` 无关（局部同名变量、属性名、另一个包的同名导出）。
   */
  function bindsTo(g, n, f) {
    const b = bindings.get(g);
    if (!b) return { bound: false, unresolved: false };
    let unresolved = false;
    for (const e of b.named) {
      if (e.local !== n) continue;
      const t = resolveSpec(e.spec, g);
      if (t === EXTERNAL) continue; // 本仓外，结构上不可能是 f
      if (!t) {
        unresolved = true;
        continue;
      }
      if (origin(t, e.orig) === f) return { bound: true, unresolved: false };
    }
    for (const s of b.stars) {
      const t = resolveSpec(s.spec, g);
      if (t === EXTERNAL) continue;
      if (!t) {
        unresolved = true;
        continue;
      }
      // `import * as ns` 下用法是 `ns.n`，裸名正则照样命中 —— 这里刻意从宽，
      // 宁可少报一个孤儿，也不要把"其实有人用"报成零引用。
      if (origin(t, n) === f) return { bound: true, unresolved: false };
    }
    return { bound: false, unresolved };
  }

  const orphans = [];
  const testOnly = [];
  const reexportOnly = [];
  /** 重名 + 解析不到模块 → 既不敢判孤儿，也不许静默算成"有人用"。 */
  const undecidable = [];
  let declCount = 0;
  /** 真的走了作用域限定的 (文件, 名字) 对数 —— 用来证明这一步接上了。 */
  let scopedPairs = 0;

  for (const [f, body] of bodies) {
    if (isTestFile(f)) continue;
    const names = declsOf.get(f) ?? new Set();
    declCount += names.size;
    void body;

    for (const n of names) {
      const scoped = ambiguous.has(n);
      if (scoped) scopedPairs += 1;
      const re = new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`, 'g');
      let prod = 0;
      let test = 0;
      let self = 0;
      /** 剔掉再导出语句之后，产品代码里还剩几次命中。 */
      let prodReal = 0;
      /** 哪些文件只是把它转发出去。 */
      const forwarders = [];
      /** 重名且解析不了的那些文件。 */
      const blind = [];
      for (const [g, gb] of bodies) {
        const hits = (gb.match(re) || []).length;
        if (!hits) continue;
        if (g === f) {
          self += hits - 1; // 减掉声明本身
          continue;
        }
        if (scoped) {
          const b = bindsTo(g, n, f);
          if (b.unresolved) blind.push(g);
          if (!b.bound) continue; // 这次命中不是在说 f 里的那个 n
        }
        if (isTestFile(g)) {
          test += hits;
          continue;
        }
        prod += hits;
        const real = ((bodiesNoReexport.get(g) ?? gb).match(re) || []).length;
        prodReal += real;
        if (real === 0) forwarders.push(g);
      }
      if (prod === 0 && self === 0 && blind.length > 0) {
        undecidable.push({ file: f, name: n, test, blind: blind.sort() });
      } else if (prod === 0 && self === 0) {
        (test === 0 ? orphans : testOnly).push({ file: f, name: n, test });
      } else if (prod > 0 && prodReal === 0 && self === 0) {
        /*
         * 产品代码里对它的**每一次**命中都发生在再导出语句里 —— 也就是说
         * 「有人把它转出去了，但没有任何人接」。`orphans` 看不到这一档，
         * 因为它的 `prod` 把转发也算成了引用（这正是丢掉的那一档）。
         */
        reexportOnly.push({ file: f, name: n, test, forwarders: forwarders.sort() });
      }
    }
  }

  const cmp = (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
  return {
    orphans: orphans.sort(cmp),
    testOnly: testOnly.sort(cmp),
    reexportOnly: reexportOnly.sort(cmp),
    undecidable: undecidable.sort(cmp),
    declCount,
    reexportStatements,
    strippedFiles,
    ambiguousNames: ambiguous.size,
    bindingSpecs,
    resolvedSpecs,
    scopedPairs,
  };
}

function scan() {
  const files = sourceFiles();
  const bodies = new Map();
  /** 只剥了注释、还没剥字符串的版本 —— 只用来证明"剥字符串"这一步真的接上了。 */
  const commentsOnly = new Map();
  /** 扫描器在这些文件上失步了（扫到文件尾还停在字符串/模板里）。 */
  const desynced = [];
  /** 剥字符串**改变了导出声明清单**的文件 —— 声明不可能长在字符串里，所以这一定是失步。 */
  const declDrift = [];

  const declNames = (body) => {
    const s = new Set();
    DECL_RE.lastIndex = 0;
    let m;
    while ((m = DECL_RE.exec(body))) s.add(m[1]);
    return s;
  };

  for (const f of files) {
    try {
      const raw = readFileSync(join(REPO, f), 'utf8');
      const src = stripCommentsOnly(raw);
      commentsOnly.set(f, src);
      // ★ 这里走 `prepare()`，**不是**直接调 `scanSource()` —— 自检跑的也是 `prepare()`，
      //   两边必须是同一个入口。否则"把预处理拆掉"这类变异只会让自检红、真实扫描照跑，
      //   或者反过来。（实测：第一版 `scan()` 直接调 `scanSource()`，把 `prepare` 改坏
      //   只有自检响，真实路径一格没动 —— 那说明自检守的不是真实路径。）
      bodies.set(f, prepare(raw));
      const r = scanSource(raw);
      if (r.endMode !== 'code' || r.tplDepth !== 0) {
        desynced.push(
          `${f}（收尾停在 ${r.endMode === 'code' ? `${r.tplDepth} 层未闭合的 \${}` : `${r.endMode} 字符串里`}）`,
        );
      }
      /*
       * ⚠️ 测试文件不参与这条不变量，**这不是为了让它变绿，是因为它在测试文件上本来就不成立**：
       * lint 类测试的夹具会把源码**当字符串**喂进去 ——
       *   `packages/pipeline/src/subprocess/__tests__/childProcessAllowlist.test.ts:76`
       *   const CHILD_PROCESS_IMPORT = "… export const x = spawn;\n";
       * 那三个 `export const x/ok/y` 本来就该被剥掉，剥掉才是对的。
       * 而且 `classify()` 本来就跳过测试文件里的声明（`if (isTestFile(f)) continue`），
       * 它们一个都进不了孤儿判定。
       * 测试文件仍然受下面 `desynced`（收尾模式）那条不变量约束 ——
       * 那条不依赖"声明不在字符串里"这个前提。
       */
      if (!isTestFile(f)) {
        const before = declNames(src);
        const after = declNames(bodies.get(f));
        const lost = [...before].filter((n) => !after.has(n));
        const gained = [...after].filter((n) => !before.has(n));
        if (lost.length || gained.length) {
          declDrift.push(`${f}（少了 ${JSON.stringify(lost)}，多了 ${JSON.stringify(gained)}）`);
        }
      }
    } catch {
      /* 读不了就跳过；非空守卫会兜住"全都读不了"这种情况 */
    }
  }

  /**
   * 有几个文件在"剥掉字符串"之后**真的和剥字符串前不同**。
   *
   * ⚠️ 与下面 `strippedFiles` 同一个讲究：判据读的是**存进 map 的那个值**，
   * 不是 `stripStrings()` 的返回值。要抓的回归是"算对了、存错了" ——
   * 把 `bodies.set(f, prepare(…))` 顺手简化回 `stripComments(…)` 时，
   * 按返回值计数的自检**一格都不会响**。
   */
  let stringStrippedFiles = 0;
  for (const [f, src] of commentsOnly) {
    if (bodies.get(f) !== src) stringStrippedFiles += 1;
  }

  /*
   * ★ 第二个参数是 `commentsOnly`（**字符串还在**）。模块名住在字符串里，
   *   传 `bodies` 会让 specifier 全部变成空串 —— 那样作用域限定静默退化回
   *   旧的裸名口径，而门禁照常绿。`bindingSpecs === 0` 那条自检守的就是这一步。
   */
  return { files, stringStrippedFiles, desynced, declDrift, ...classify(bodies, commentsOnly) };
}

/**
 * 自检夹具的唯一入口：把一份写死的样本按**与 `scan()` 完全相同的两条预处理**
 * 喂进 `classify()`（引用统计用剥了字符串的，模块解析用只剥注释的）。
 * 两边共用同一个入口，才不会出现"自检跑的和真实路径不是同一段代码"。
 */
const classifySample = (sample) =>
  classify(
    new Map([...sample].map(([f, s]) => [f, prepare(s)])),
    new Map([...sample].map(([f, s]) => [f, stripCommentsOnly(s)])),
  );

/**
 * ★ 重名遮蔽的正反向对照（T-183）。**这是这条修法唯一的判据。**
 *
 * 夹具照抄真实形状：`authRequired` 在两个包里各有一个同名导出，
 * 只有 daemon 那个有调用方。
 *
 *   旧口径（裸名跨全仓正则）：`server.ts` 里那两次命中同时算进**两个**声明的
 *   `prod`，于是 web 那个 `prod = 2 > 0` → 既不是孤儿、也不是"只被再导出" ——
 *   **一档都进不去，门禁看不见它**。
 *   `[实测]` 把本文件的作用域限定拆掉（`const scoped = false`）后跑这个夹具：
 *   `orphans` 从 `['authRequired']` 变成 `[]`，即阳性对照当场失灵。
 *
 *   新口径：`server.ts` 的 `authRequired` 绑定解析到 `daemon/http/auth.ts`，
 *   与 web 那个不是同一个模块 → web 那个 `prod = 0` → **判红**。
 *
 * 阴性对照同样重要：daemon 那个**不许**被判成孤儿（否则就是从"全遮蔽"
 * 翻车成"全误报"，一样不能用）。
 */
function selfTestSameNameMasking() {
  const sample = new Map([
    ['apps/daemon/src/http/auth.ts', 'export function authRequired() { return true }'],
    [
      'apps/daemon/src/http/server.ts',
      "import { authRequired } from './auth.js';\nexport function route() { return authRequired() }",
    ],
    // 同名、跨包、零调用方 —— 就是被遮住的那个
    ['apps/web/src/lib/api/auth-mode.ts', 'export function authRequired() { return true }'],
    // barrel 跨包消费：证明作用域限定没有把"经由包名 + 再导出"的真引用误杀
    ['packages/shared/src/notes.ts', 'export function sharedThing() { return 1 }'],
    ['packages/shared/src/index.ts', "export { sharedThing } from './notes.js';"],
    [
      'apps/daemon/src/uses.ts',
      "import { sharedThing } from '@openmemo/shared';\nexport function go() { return sharedThing() }",
    ],
  ]);
  const r = classifySample(sample);
  const problems = [];
  const orphanKeys = r.orphans.map((o) => `${o.file} :: ${o.name}`);
  const WEB = 'apps/web/src/lib/api/auth-mode.ts :: authRequired';
  const DAEMON = 'apps/daemon/src/http/auth.ts :: authRequired';

  if (!orphanKeys.includes(WEB)) {
    problems.push(
      `阳性对照失败：跨包同名、零调用方的 ${WEB} 没被判成零引用导出（实际 ${JSON.stringify(orphanKeys)}）` +
        ' —— 作用域限定没生效，重名又开始互相遮蔽了（这正是它漏掉 authRequired 的形状）',
    );
  }
  if (orphanKeys.includes(DAEMON)) {
    problems.push(`阴性对照失败：真的有 import 的 ${DAEMON} 被误判成零引用导出`);
  }
  if (r.orphans.some((o) => o.name === 'sharedThing')) {
    problems.push(
      '阴性对照失败：经由包名 + barrel 再导出被真实消费的 sharedThing 被误判成零引用导出' +
        ' —— 工作区包解析或 barrel 逐跳跟踪断了',
    );
  }
  if (r.ambiguousNames < 1) {
    problems.push('重名检测本身没识别出样本里的 authRequired —— 作用域限定这条路根本没走到');
  }
  return problems;
}

/**
 * 探针的探针：拿一段**写死的**样本跑一遍 `classify()`，证明"只被再导出"这一档真的看得见。
 *
 * 两条设计上的讲究：
 *
 * · **跑的是 `classify()` 本身**，不是复述一遍它的规则。复述出来的对照组只能证明复述
 *   自己是对的 —— `[实测]` 第一版就是复述的，于是"把分档那个 else-if 整段删掉"这条变异
 *   照样全绿。
 * · **阳性对照是写死的样本，不是仓库里某个真实条目。** 真实条目随时会被人接上
 *   （那正是我们想要的结果），到那天自检会红在一件好事上，然后被顺手删掉。
 *   阳性对照必须是不会腐烂的。
 */
function selfTestReexportTier() {
  const sample = new Map([
    [
      'pkg/src/api.ts',
      'export function useThing() { return 1 }\nexport function useUsed() { return 2 }',
    ],
    ['pkg/src/index.ts', "export { useThing, useUsed } from './api';"],
    ['pkg/src/Page.tsx', "import { useUsed } from './index';\nuseUsed();"],
  ]);
  const r = classifySample(sample);
  const problems = [];
  const tier = r.reexportOnly.map((o) => o.name);
  if (!tier.includes('useThing')) {
    problems.push(
      `阳性对照失败：只被 index 再导出的 useThing 没有落进"只被再导出"这一档（实际 ${JSON.stringify(tier)}）` +
        ' —— 这一档已经丢过一次（固化进 scripts/ 时），所以它必须有人守',
    );
  }
  if (tier.includes('useUsed')) {
    problems.push('阴性对照失败：真的有人 import 的 useUsed 被误判成"只被再导出"');
  }
  if (r.orphans.length !== 0) {
    problems.push(`阴性对照失败：样本里不该有零引用导出，实际 ${JSON.stringify(r.orphans)}`);
  }
  return problems;
}

/**
 * 「剥字符串字面量」这一档的正反向对照。**样本是写死的**，理由同上：
 * 拿仓库里的真实条目当阳性对照，等哪天有人把它接上了，自检会红在一件好事上。
 *
 * 四条断言各自钉住一种**已经想清楚的错法**：
 *   ① 只在自己的错误信息里提到自己 → 必须判成孤儿（这就是遮住 `verifyCatalogSignature` 的形状）
 *   ② 只被别人的字符串提到 → 同样不算引用
 *   ③ 唯一的引用在模板字面量的 `${}` 里 → **不**准判成孤儿（`${}` 里是真代码）
 *   ④ 引用前面隔着一个含引号的正则字面量 → **不**准判成孤儿（扫描器不能在 `/['"]/` 上失步）
 *
 * ③④ 是有意设计成"错了就红"的：把 `${}` 保留那一段删掉，③ 当场红；
 * 把正则字面量识别删掉，扫描器会从 `/['"]/` 的那个 `'` 一路吞到下一个 `'`，
 * 正好吞掉 ④ 那一行，于是 ④ 红、②（被吞进代码区）也跟着红。
 */
function selfTestStringStripping() {
  const sample = new Map([
    [
      'pkg/src/sig.ts',
      [
        "export function verifyThing() { throw new Error('verifyThing: no key configured') }",
        'export function mentionedOnlyInText() { return 1 }',
        'export function usedInTemplate() { return 2 }',
        'export function usedAfterRegex() { return 3 }',
      ].join('\n'),
    ],
    [
      'pkg/src/consumer.ts',
      [
        'const msg = `结果 ${usedInTemplate()} 完成`;',
        'const quoted = /[\'"]/.test(msg);',
        'const n = usedAfterRegex();',
        "const doc = 'mentionedOnlyInText 见文档';",
      ].join('\n'),
    ],
  ]);
  const r = classifySample(sample);
  const orphans = r.orphans.map((o) => o.name);
  const problems = [];
  const want = (n, why) => {
    if (!orphans.includes(n)) problems.push(`阳性对照失败：${n} 没被判成零引用导出 —— ${why}`);
  };
  const wantNot = (n, why) => {
    if (orphans.includes(n)) problems.push(`阴性对照失败：${n} 被误判成零引用导出 —— ${why}`);
  };
  want('verifyThing', '它对自己的唯一一次提及在错误信息字符串里，字符串没被剥掉');
  want('mentionedOnlyInText', '另一个文件只在字符串里提到它，那不是引用');
  wantNot('usedInTemplate', '它唯一的引用在模板字面量的 `${}` 里，那是**真代码**，不该被剥掉');
  wantNot('usedAfterRegex', '扫描器在 /[\'"]/ 这个正则字面量上失步了，把后面的真引用一起吞掉了');
  return problems;
}

/* ────────────────────────────── 自检（先跑） ────────────────────────────── */

const {
  files,
  orphans,
  testOnly,
  reexportOnly,
  undecidable,
  declCount,
  reexportStatements,
  strippedFiles,
  stringStrippedFiles,
  desynced,
  declDrift,
  ambiguousNames,
  bindingSpecs,
  resolvedSpecs,
  scopedPairs,
} = scan();
const selfCheckFailures = [];
if (files.length === 0) selfCheckFailures.push('文件清单是空的');
if (stringStrippedFiles === 0) {
  selfCheckFailures.push(
    '没有任何一个文件在"剥掉字符串字面量"之后发生变化 —— 这个仓库到处是错误信息和字面量，' +
      '所以只可能是这一步没有真的接上（`bodies.set(f, …)` 被简化回 `stripComments(…)` 了？）。' +
      '它失效的样子和"本来就没有字符串"完全一样：门禁照常绿，而 5 条零调用方导出重新隐身。',
  );
}
if (declDrift.length > 0) {
  selfCheckFailures.push(
    '剥字符串**改变了导出声明清单** —— 声明不可能长在字符串里，所以扫描器一定在这些文件上失步了：\n' +
      declDrift.map((d) => `       ${d}`).join('\n') +
      '\n     （实测过一次：JSX 的 `/>` 被当成正则开头，把 `export function backendLabel` 整个吞了）',
  );
}
if (desynced.length > 0) {
  selfCheckFailures.push(
    '扫描器扫到文件尾还停在字符串里 —— 有个引号没配上，那之后的代码全被当字符串抹掉了：\n' +
      desynced.map((d) => `       ${d}`).join('\n'),
  );
}
if (reexportStatements === 0) {
  selfCheckFailures.push(
    '全仓一条 `export … from …` 都没扫到 —— 这个仓库满是 barrel，' +
      '所以只可能是再导出正则失效了（那样"只被再导出"这一档会永远是空的，' +
      '和"真的没有"长得一模一样）',
  );
}
if (reexportStatements > 0 && strippedFiles === 0) {
  selfCheckFailures.push(
    '扫到了再导出语句，却没有任何一个文件在"挖掉再导出"之后发生变化 —— ' +
      '说明这一步没有真的接上（`bodiesNoReexport` 被简化掉了？）。' +
      '这条变异实测会让"只被再导出"从 21 条变成 0 条，而其它每一格都照常绿。',
  );
}
if (reexportOnly.some((o) => o.name === PROBE_EXPORT)) {
  selfCheckFailures.push(`${PROBE_EXPORT} 被报成"只被再导出" —— 它有真实调用方，说明分档瞎了`);
}
/*
 * ★ 作用域限定这一步"真的接上了"的四格。每格各钉一种**静默退化**：
 *   ① 一条 `import … from` 都没扫到 → 语句正则失效。
 *   ② 扫到了却一条都解析不到本仓文件 → `classify()` 的第二个参数传错了
 *      （传了剥掉字符串的 `bodies`，模块名住在字符串里，全变成空串）。
 *   ③ 一个重名都没识别出来 → 重名检测失效，作用域限定形同不存在。
 *   ④ 识别出重名却一对都没走作用域路径 → 分支没接上。
 * 四条都是"改坏了却照常绿"的形状，所以必须自己有人守。
 * ⚠️ ② 的判据是「解析到几条」而不是「扫到几条」—— 理由见 `resolvedSpecs` 处的实测。
 */
if (bindingSpecs === 0) {
  selfCheckFailures.push(
    '一条 `import … from` / `export … from` 都没扫到 —— 这个仓库满是 barrel，' +
      '只可能是模块语句正则失效了。失效之后作用域限定对谁都不生效。',
  );
}
if (bindingSpecs > 0 && resolvedSpecs === 0) {
  selfCheckFailures.push(
    `扫到了 ${bindingSpecs} 条模块名，却一条都解析不到本仓源文件 —— ` +
      '多半是 `classify()` 的第二个参数传成了剥掉字符串的 `bodies`（模块名住在字符串里）。' +
      '实测这条变异会让零引用导出从 74 个涨到 89 个（15 个假阳性），' +
      '而只数"扫到几条"的自检一格都不响。',
  );
}
if (ambiguousNames === 0) {
  selfCheckFailures.push(
    '全仓一个重名导出都没识别出来 —— 实测有 41 个（37 个跨包），' +
      '所以只可能是重名检测坏了。坏了之后作用域限定对谁都不生效。',
  );
}
if (ambiguousNames > 0 && scopedPairs === 0) {
  selfCheckFailures.push(
    `识别出 ${ambiguousNames} 个重名，却没有任何一个导出走了作用域限定 —— 那个分支没接上`,
  );
}
selfCheckFailures.push(...selfTestReexportTier());
selfCheckFailures.push(...selfTestStringStripping());
selfCheckFailures.push(...selfTestSameNameMasking());
if (!files.includes(PROBE_FILE)) {
  selfCheckFailures.push(
    `文件清单里没有 ${PROBE_FILE} —— 这正是当年那个残缺 glob 漏掉的那一类（src/ 第一层）`,
  );
}
if (declCount < MIN_EXPORTS) {
  selfCheckFailures.push(`只扫到 ${declCount} 个导出（下限 ${MIN_EXPORTS}）—— 声明正则可能失效了`);
}
if (orphans.some((o) => o.name === PROBE_EXPORT)) {
  selfCheckFailures.push(`${PROBE_EXPORT} 被报成零调用方 —— 它一定有调用方，说明扫描本身瞎了`);
}
if (selfCheckFailures.length) {
  console.error('\n✘ 扫描器自检未通过 —— **在报告任何结论之前**先停下：\n');
  for (const f of selfCheckFailures) console.error(`   · ${f}`);
  console.error(
    '\n判据：工具静默返回空集/残缺集，和"真的没有"长得一模一样。\n' +
      '先证明探针能看见你已知存在的东西，再相信它说"没有"。\n',
  );
  process.exit(1);
}

/* ────────────────────────────── 与基线比对 ────────────────────────────── */

const key = (o) => `${o.file} :: ${o.name}`;
let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch (e) {
  console.error(`✘ 读不到基线 ${BASELINE_PATH}：${String(e)}`);
  process.exit(1);
}
const allowed = new Map((baseline.accepted ?? []).map((e) => [`${e.file} :: ${e.name}`, e]));
if (allowed.size === 0) {
  console.error('✘ 基线是空的 —— 那样下面的比对会把全部现存条目当成"新增"，等于一条永远红的门禁');
  process.exit(1);
}

const current = new Set(orphans.map(key));
const added = orphans.filter((o) => !allowed.has(key(o)));
const stale = [...allowed.keys()].filter((k) => !current.has(k));

console.log(
  `ℹ 扫描 ${files.length} 个源文件 / ${declCount} 个导出 / ${reexportStatements} 条再导出语句`,
);
console.log(
  `ℹ 零引用导出 ${orphans.length} 个（基线 ${allowed.size} 个）· 只有测试引用 ${testOnly.length} 个` +
    ` · 只被再导出 ${reexportOnly.length} 个 · 判不了 ${undecidable.length} 个`,
);
console.log(
  `ℹ 重名导出 ${ambiguousNames} 个走了模块作用域限定（其余按裸名统计，口径不变）；` +
    `扫到 ${bindingSpecs} 条模块名，其中 ${resolvedSpecs} 条解析到本仓源文件`,
);

if (undecidable.length) {
  console.log(
    `\nℹ 判不了（不判红，供人看）：${undecidable.length} 个。` +
      '这些名字全仓重名，而引用它的文件里有一条模块名解析不到本仓源文件\n' +
      '   （子路径导入 / 第三方同名包 / 别名）。**刻意不当成"有人用"** —— ' +
      '旧实现正是靠这一步偏向\n   把 `authRequired` 之类遮掉的。要它有结论，' +
      '就把那条 import 写成能解析的形状。',
  );
  for (const o of undecidable) {
    console.log(`   ${o.file} :: ${o.name}  (test=${o.test}, 解析不了: ${o.blind.join(', ')})`);
  }
}

if (testOnly.length) {
  console.log('\nℹ 只有测试引用（不判红，供人看 —— 里面确实藏过真缺陷）：');
  for (const o of testOnly) console.log(`   ${o.file} :: ${o.name}  (test=${o.test})`);
}

if (reexportOnly.length) {
  const noTest = reexportOnly.filter((o) => o.test === 0);
  console.log(
    `\nℹ 只被再导出、零真实产品调用方（不判红，供人看）：${reexportOnly.length} 个，` +
      `其中 ${noTest.length} 个**连测试都没有**`,
  );
  console.log(
    '   这一档是 T-160 补回来的。上面那份"零引用"名单看不见它们 —— barrel 的一句\n' +
      '   `export { X } from …` 被算成了一次真引用。形状与门禁修好过的\n' +
      '   `useDeleteNoteMutation`（笔记建出来就删不掉）完全相同：**功能只做了一半，\n' +
      '   出口开好了、没有人走进去**。带 ⚠ 的是连测试都没有的那些，优先看。',
  );
  for (const o of reexportOnly) {
    const mark = o.test === 0 ? '⚠ ' : '  ';
    console.log(
      `   ${mark}${o.file} :: ${o.name}  (test=${o.test}, 转发方: ${o.forwarders.join(', ')})`,
    );
  }
}

let failed = false;

if (added.length) {
  failed = true;
  console.error(`\n✘ ${added.length} 个**新的**零引用导出（基线里没有）：\n`);
  for (const o of added) console.error(`   ${o.file} :: ${o.name}`);
  console.error(
    '\n它多半不是"死代码"，是**功能只做了一半** —— 写好了、没有人调用它。\n' +
      '三条出路，选一条：\n' +
      '  1. **接上它**（大多数时候这才是本意，也是这条门禁真正想要的结果）；\n' +
      '  2. **删掉它**（确认这个功能不做了）；\n' +
      `  3. 确实该留（契约类型 / 公开 API 形状 / 刻意的兜底）→ 登记进\n` +
      `     ${BASELINE_PATH} 的 accepted 里，并在 note 里写清**为什么它没有调用方**。\n` +
      '     ⚠️ 别只为了让门禁变绿而登记：这份名单是给下一个人看的地图。\n',
  );
}

if (stale.length) {
  failed = true;
  console.error(`\n✘ 基线里有 ${stale.length} 个条目已经**不再是**零引用导出：\n`);
  for (const k of stale) console.error(`   ${k}`);
  console.error(
    '\n有人把它接上了（或者把它删了）—— 这是好事，但基线必须跟着变短。\n' +
      `请从 ${BASELINE_PATH} 里删掉这几行。\n` +
      '判据：**豁免名单只准变短。** 一份不会缩水的名单，几轮之后就没人相信它了。\n',
  );
}

if (failed) process.exit(1);
console.log('\n✔ 没有新的零引用导出，基线也没有过期条目');
