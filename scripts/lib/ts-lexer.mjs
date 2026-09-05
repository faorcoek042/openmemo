/**
 * ★ TypeScript/TSX 的**词法扫描器 + 源文件清单** —— 守卫脚本共用的那一份。
 *
 * ## 为什么它在 `scripts/lib/` 而不是各写一遍
 *
 * 这个扫描器原本长在 `scripts/check-orphan-exports.mjs` 里面。它现在有**两个**消费者
 * （孤儿门禁 + `scripts/ci/check-duplicate-declarations.mjs`），而这个仓库对
 * 「同一件事两处各写一遍」的账已经算得很清楚了 —— 见 `scripts/lib/version.mjs` 的文件头。
 *
 * 它尤其不能抄：下面那些分支**每一条都是实测撞出来的**（模板字面量里的 `${}`、
 * 正则字面量里的引号、TS 的非空断言 `!` 与前缀取反 `!` 撞车、`.tsx` 里的 `/>`）。
 * 抄第二份 = 抄一份**少了其中几条**的，而那种残缺表现成探针安静地少看了一批文件，
 * 不报错、看起来还像好消息。
 *
 * ⚠️ **本文件是纯函数 + 一次 `git ls-files`，不许长出判据。** 判据归各自的门禁 ——
 * 两道门共用扫描器是好事，共用判据就变成一处改口径、两处一起瞎。
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根。本文件在 `scripts/lib/`，往上两级。 */
export const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
/**
 * 源文件清单。
 *
 * `git ls-files -z` + 在 Node 里过滤：
 * 不用 shell 管道（Windows 上没有 `grep`，`check-tracked-sources.mjs` 的 T-147
 * 记着 `find` 在 windows-2025 上解析到 `C:\Windows\System32\find.exe` 那次），
 * 也不用花哨的 pathspec（`**` 的层级语义正是第一版出错的地方）。
 */
export function sourceFiles() {
  const out = execFileSync('git', ['ls-files', '-z', 'apps', 'packages'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => /\.tsx?$/.test(p))
    .filter((p) => /^(apps|packages)\/[^/]+\/src\//.test(p))
    .filter((p) => !/\/(dist|dist-types|node_modules|\.test-out)\//.test(p));
}

/**
 * 词法扫描器：把**注释**和**字符串字面量的内容**一起抹掉，只留下真代码。
 *
 * ## 为什么要有这个东西（`closure-audit` 🟡-2 查出的第二个同形盲区）
 *
 * 老版本只剥注释、**不剥字符串字面量**。后果和 barrel 再导出那次（T-160）一模一样，
 * 只是换了个遮蔽物：一个导出只要**在自己的错误信息里写了自己的名字**，`self` 就 ≥ 1，
 * 于是它**永远不会被这条门禁看见** —— 哪怕它零调用方、零测试。
 *
 *     export async function verifyCatalogSignature(…) {
 *       throw new Error('verifyCatalogSignature: a signature was supplied but …')
 *     }                  ↑ 这一次自我提及就够了
 *
 * 而"在错误信息里写自己的名字"是**好的工程习惯**，本仓库到处都是。
 * 也就是说：这个盲区**专门遮蔽写得比较讲究的那部分代码**。
 *
 * ## ★ 为什么注释和字符串必须**同一遍**扫，不能分两步
 *
 * 这条是实测撞出来的，**而且它证明老的 `stripComments()` 本身一直是坏的**。
 *
 * 老写法是三条正则，其中一条是 `([^:"'`])\/\/[^\n]*` —— 用"`//` 前面那个字符不是 `:`"
 * 来避开 `https://`。这个近似在**模板字面量**上翻车：
 *
 *     return `${protocol}//${host}`;      // apps/web/src/lib/secure-context.ts
 *
 * 这里 `//` 前面是 `}`，不是 `:`，于是那条正则把 **`//${host}`;` 连同后面整行删掉**，
 * 留下一个**没有闭合的模板字面量**。老版本察觉不到（它不跟踪字符串状态），
 * 于是这个损坏一直安静地待在那儿；等我把字符串扫描接上，扫描器就从这里开始失步，
 * 把后面成片的真代码当成字符串抹掉。
 *
 * `[实测]` 全仓 15 个文件因此失步，其中 4 个连 `export` 声明都被吞掉了。
 * **两遍扫描在结构上就是错的**：第一遍不认识字符串，就必然会咬坏字符串；
 * 第二遍再想认字符串，读到的已经是被咬坏的文本了。
 *
 * ## 三处必须逐字符扫、正则做不到的地方
 *
 * 1. **模板字面量的 `${ … }` 里装的是真代码** —— `` `${describeSpeed(x)} 秒` `` 是一次真调用。
 *    一条 /`[^`]*`/ 式的正则会把它一起吞掉，那就从"看不见孤儿"变成"把活着的当孤儿"，
 *    由漏报变误报。所以遇到 `${` 要**回到代码模式**并跟踪花括号配平（可嵌套）。
 * 2. **正则字面量里的引号不是字符串开头**（`/['"]/`）。不认它，扫描器当场失步。
 * 3. **注释里的引号也不是字符串开头**（`// don't`）—— 这正是上面那条的另一面。
 *
 * @param {string} src
 * @param {{ strings?: boolean }} [opts]  `strings:false` = 只剥注释，保留字符串内容。
 *   留这个开关不是为了灵活，是为了让下面的不变量能拿"同一段代码、只差这一步"做对照。
 */
export function scanSource(src, opts = {}) {
  const stripStringContents = opts.strings !== false;
  const out = [];
  /** 模板字面量栈。每一项 = 当前这层 `${}` 里尚未配平的 `{` 数量。 */
  const tplBraces = [];
  /** 'code' | "'" | '"' | '`' | 'regex' | 'line' | 'block' */
  let mode = 'code';
  /** 正则字符类 `[…]` 内部，`/` 不结束正则。 */
  let inCharClass = false;
  /** 上一个吐出去的非空白字符 —— 用来分辨 `/` 是除号还是正则开头。 */
  let lastSignificant = '';
  /** 再上一个 —— 只为 TS 的非空断言 `!` 服务，见下面 `REGEX_CAN_START_AFTER` 处。 */
  let prevSignificant = '';

  const push = (ch) => {
    out.push(ch);
    if (!/\s/.test(ch)) {
      prevSignificant = lastSignificant;
      lastSignificant = ch;
    }
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (mode === 'code') {
      if (c === "'" || c === '"' || c === '`') {
        mode = c;
        // ★ 引号本身要留下，只把**内容**抹掉。
        //   因为 `REEXPORT_RE` 认的是 `from '…'` —— 连引号一起吞掉的话，
        //   全仓 163 条再导出会一起消失，"只被再导出"那一档当场归零。
        //   （这不是推演：第一版连引号一起吞了，脚本自己的
        //   「一条 `export … from …` 都没扫到」自检当场把我拦下来了。）
        push(c);
        i += 1;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        mode = 'line';
        out.push('  ');
        i += 2;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        mode = 'block';
        out.push('  ');
        i += 2;
        continue;
      }
      if (c === '/') {
        /*
         * 到这里只剩"正则字面量 vs 除号 vs **JSX**"（注释已在上面两个分支里处理掉了）。
         *
         * ★ 这里用的是**白名单**（只有这几个前驱字符才认正则），不是"非表达式结尾即正则"的
         *   黑名单写法。原因是 JSX —— 而这条是**实测撞出来的，不是推演**：
         *
         *     第一版用黑名单（`/[\w$)\]]/` 之外都算正则），全仓扫下来
         *     `BackendChip.tsx :: backendLabel` 与 `secure-context.ts :: httpsEquivalent`
         *     **从"零引用导出"名单里消失了**，脚本报的是"基线里有 2 个过期条目"。
         *
         *   成因：`.tsx` 里遍地是 `<Foo bar={a} />` 和 `</div>`。`/>` 前面那个 `}`、
         *   `</` 前面那个 `<` 都不是"表达式结尾"，于是黑名单把它们当成正则开头，
         *   一路吞到下一个 `/` —— **把中间的 `export function backendLabel` 整个吞掉了**。
         *   声明被吞掉的导出不会变成"新孤儿"，它会**从名单里安静消失**，
         *   表现成"基线过期"。这正是本仓库最怕的那种错法：**看起来像好消息**
         *   （"有人把它接上了！"），实际是探针瞎了。
         *
         *   → 抓住它的是脚本自己的"基线只准变短"那条守卫。留个记号：
         *     那条守卫的价值不止于催人删豁免，它同时是**扫描器失明的报警器**。
         *
         * 白名单里刻意**不含** `{` `}` `<` `>` `)` `]` 与标识符字符。代价是
         * `return /re/…` 这类位置认不出正则（前驱是 `n`）—— 那是**保守**的错法：
         * 认不出只会少剥，不会失步。下面的两条不变量守着真失步的情形。
         */
        const REGEX_CAN_START_AFTER = /[(,=:[!&|?;+\-*%^~]/;
        /*
         * ★ `!` 在 TypeScript 里有两种意思，恰好指向相反的结论：
         *     `if (!/re/.test(s))`      前缀取反 → 后面是**正则**
         *     `out[i] = pcm[i]! / 32768`  后缀非空断言 → 后面是**除号**
         * `[实测]` 后一种就在 `packages/pipeline/src/asr/sherpaOnnx.ts:404`，
         * 只看前一个字符会把它当成正则开头，一路吞到文件尾（扫描器收尾停在 regex 模式）。
         * 分辨靠再往前看一个字符：`!` 前面是值的结尾（标识符 / `)` / `]`）就是非空断言。
         */
        const bangIsNonNullAssertion = lastSignificant === '!' && /[\w$)\]]/.test(prevSignificant);
        if (
          !bangIsNonNullAssertion &&
          (lastSignificant === '' || REGEX_CAN_START_AFTER.test(lastSignificant))
        ) {
          mode = 'regex';
          inCharClass = false;
          push(c);
          i += 1;
          continue;
        }
        push(c);
        i += 1;
        continue;
      }
      if (tplBraces.length > 0 && (c === '{' || c === '}')) {
        const top = tplBraces.length - 1;
        if (c === '{') {
          tplBraces[top] += 1;
        } else if (tplBraces[top] === 0) {
          // 配平的 `}` —— 这一段 `${…}` 结束，回到模板字面量内部。
          tplBraces.pop();
          mode = '`';
          out.push(' ');
          i += 1;
          continue;
        } else {
          tplBraces[top] -= 1;
        }
        push(c);
        i += 1;
        continue;
      }
      push(c);
      i += 1;
      continue;
    }

    // ── 注释内部（`//` 到行尾；`/* */` 到配对的 `*/`）：整段抹成空白 ──
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out.push('\n');
      } else out.push(' ');
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && src[i + 1] === '/') {
        mode = 'code';
        out.push('  ');
        i += 2;
        continue;
      }
      out.push(c === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }

    // ── 字符串 / 正则内部：一律吐空格，只保留换行（不影响计数，但让残留物仍可读）──
    if (c === '\\') {
      out.push(stripStringContents ? ' ' : c);
      out.push(stripStringContents || src[i + 1] === undefined ? ' ' : src[i + 1]);
      i += 2; // 转义序列整个跳过，`\'` 不结束字符串
      continue;
    }
    if (c === '\n') {
      out.push('\n');
      i += 1;
      continue;
    }
    if (mode === 'regex') {
      if (c === '[') inCharClass = true;
      else if (c === ']') inCharClass = false;
      else if (c === '/' && !inCharClass) {
        mode = 'code';
        push(c);
        i += 1;
        continue;
      }
      out.push(' ');
      i += 1;
      continue;
    }
    if (mode === '`' && c === '$' && src[i + 1] === '{') {
      // ★ `${` 里是真代码，必须原样留下 —— 否则这一步会把真引用一起抹掉。
      tplBraces.push(0);
      mode = 'code';
      out.push('  ');
      i += 2;
      continue;
    }
    if (c === mode) {
      mode = 'code';
      push(c);
      i += 1;
      continue;
    }
    out.push(stripStringContents ? ' ' : c);
    i += 1;
  }
  // `endMode` / `tplDepth` 是给下面那条"失步"不变量用的：扫到文件尾还停在字符串里，
  // 说明有一个引号没配上 —— 那之后的东西全被当成字符串抹掉了。
  return { out: out.join(''), endMode: mode, tplDepth: tplBraces.length };
}
/** 注释 + 字符串内容一起抹掉 —— 统计标识符引用用。 */
export const prepare = (src) => scanSource(src).out;
/** 只剥注释、**保留字符串内容** —— 模块名与字面量值都住在字符串里，解析它们必须用这一版。 */
export const stripCommentsOnly = (src) => scanSource(src, { strings: false }).out;
