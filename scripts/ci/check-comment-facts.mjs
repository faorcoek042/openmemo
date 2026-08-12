#!/usr/bin/env node
/**
 * ★ 注释里**指向具体文件 / 符号**的那种断言，必须真的指得到。
 *
 * ## 它治的病
 *
 * 这一周人肉抓到十几处「注释声称一件事，而它从没发生过」。它们的共同点是
 * **编译得过、跑得过、测得绿** —— 现有的门一道都不管这一段：
 * `check:orphans` 管导出没人用、`check:contract-fields` 管契约字段没人读、
 * `check:test-ratchet` 管测试被静默删、`check:locale` 管两份词条不对称。
 * 一句假注释不改变任何字节的行为，所以**只有读的人会付代价** ——
 * 而他付代价的方式是照着那句话建立一个错误的系统模型。
 *
 * 最贵的一例：`source.ts` 的注入点注释把读者支去一个叫 `mockSource.ts` 的文件，
 * 那个文件**从第一天起就不存在**（`9ea52e8` 引入，两个月无人发现）。
 *
 * ## 🔴 范围：**只做「指路」这一档**，不做通用过期谓词
 *
 * 判据是**「这句话指向的东西存在吗」**，不是「这句话说得对吗」。后者要把任意事实
 * 断言写成可执行谓词，工程量大、方向未定，**刻意不做**。
 *
 * 这道门只认三种形态，每一种都量过误报率（数字见下）：
 *
 *   ① 「见 <文件>」——  指路语 + 文件名 ⇒ 那个文件必须在册
 *   ② `{@link X}`   ——  TSDoc 链接 ⇒ 那个符号必须在仓里找得到
 *   ③ `queue.block()` 发出的码 ⇒ 必须在 `PIPELINE_ERROR_CODES` 里（#104）
 *
 * ## ⚠️ 它**抓不到**什么（诚实边界，别以为装了这个就不会再有假注释）
 *
 * 拿这周 8 条真实例校准过，**8 条里它只抓得到 1 条**：
 *
 * | # | 实例 | 抓到吗 | 为什么 |
 * |---|---|---|---|
 * | 1 | 0–1 乘成 0–100 那行头上的「只有类型检查才拦得住」 | ✘ | 句子里**没有任何文件/符号 token**，纯散文断言 |
 * | 2 | D-11 §1003「软件适配器被 `SOFTWARE_ADAPTER_NAMES` 过滤」 | ✘ | 那个符号**存在**（`detect/gpu.ts:86`），存在性检查恒绿；假的是「被过滤」这个**行为**断言 |
 * | 3 | `0001_init.sql` 「`job_events` 是 UI 时间线的主线」 | ✘ | 两张表**确实存在**；假的是「是主线」（实测零 INSERT 零 SELECT）—— 那是可数断言，不是指路 |
 * | 4 | `source.ts` 「降级为轮询（约 15s）」 | ✘（**且不该抓**） | 已在 `e590e06` 实现，现在是真话。反例：这道门必须对它保持绿 |
 * | 5 | 指向 `mockSource.ts` 的那句指路语 | **✔** | 正是 ① |
 * | 6 | `RetranscribeButton` 「后端只解析 `language`」 | ✘（**且不该抓**） | 已改成「曾经为真／现在不成立」。反例 |
 * | 7 | `content.ts` 「重跑一次用户改过的字就没了」 | ✘（**且不该抓**） | 已修。反例 |
 * | 8 | `runtime/sse.ts` 「自检失败必须显性告知」 | ✘ | 那段 `emit` 已在 `3fe1aa0` 删掉；剩下的是**叙述**，不是指路 |
 *
 * **1/8。** 写在这里不是自谦，是这道门的规格：它换掉的是「靠人读出来」的那一档里
 * **最机械的一小块**，剩下 7 条仍然只有人能发现。谁要是因为这道门绿了就以为
 * 注释是可信的，他会比没有这道门时错得更远。
 *
 * ## 误报率（`f0b0ad3` 实测，先量后做）
 *
 * 中间尝试过三个更宽的版本，都因为误报率被否掉 —— 记在这里免得下一个人重走：
 *
 * | 版本 | 扫到 | 报红 | 真阳 | 结论 |
 * |---|---|---|---|---|
 * | 反引号里任何像文件名的 token | 614 | 57 | ~8 | **否**（`active.json`/`secrets.json` 等运行时产物、`dist/*.js` 构建产物、`sqlite3.c` 等子模块，全是误报） |
 * | 收窄到源码后缀 + basename 兜底 | 507 | 8 | ~4 | **否**（`adapters/markmap.ts` 那 5 处是**正确的历史叙述** ——「此前有两份」「整块摘掉了」。把正确注释判红比没有门更坏） |
 * | 反引号里的 `SCREAMING_SNAKE` 符号存在性 | 188 | 10 | 1 | **否**（`FILE_SHARE_DELETE`/`ERROR_ACCESS_DENIED`/`LC_CODE_SIGNATURE`/`GCC_7` 是**别人家的**常量，形状上分不出来） |
 * | **① 指路语 + 文件名（本版）** | **210** | **2** | **2** | ✔ |
 * | **② `{@link X}`（本版）** | **57** | **0** | — | ✔（今天全绿；它是 TSDoc 的形状，不会撞上外部常量） |
 *
 * 「指路语」这一层是关键：**「见 X」是一句指令**（去读 X），
 * 而「此前 X 里有两份」是叙述。前者失效会把读者送到不存在的地方，后者不会。
 *
 * ## ⚠️ 原始那句话**没有反引号**
 *
 * `9ea52e8` 那行里的文件名是**裸的**：一个「见」字后面直接跟 `mockSource.ts`。
 * 所以 token 匹配**不能**要求反引号，否则这道门连它的头号病例都抓不到
 * （第一版就是这么写的，selftest 当场证伪）。
 *
 * ## 叙述型引用（`NARRATION` 词表）
 *
 * 「这里原来写着『见 <某文件>』——**那个文件不存在**」这类句子里，指路语是被**引用**的，
 * 不是被断言的。同一行出现「不存在 / 已删 / 此前 / 曾经…」就归到「叙述，不判」，
 * 并且**照样打印出来**（见输出末尾那一节）—— 跳过什么必须看得见，
 * 否则这个词表会变成一个人人都会用的后门。
 *
 * ## 怎么加豁免
 *
 * `WAIVERS` 里加一条 `{ file, token, reason }`。⚠️ **豁免会过期**：
 * 被豁免的那条如果修好了（文件真的出现了），这道门**报红说豁免过期** ——
 * 与 `check-pending-claims` 同一招：断言自己会发现，不需要谁来汇报。
 *
 * 跑：`node scripts/ci/check-comment-facts.mjs`（`pnpm test:ci-scripts` 会调）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/* ─────────────────────────── 豁免（会过期，见文件头） ─────────────────────── */

export const WAIVERS = [
  {
    file: 'apps/daemon/src/main.ts',
    token: 'startup-banner.test.ts',
    reason:
      '真阳性，**这道门上线第一天抓到的**：全仓没有 startup-banner.test.ts，' +
      '真名是 apps/daemon/src/bootstrap/ready-banner.test.ts。' +
      '本 PR 的改动面被卡死在 scripts/ci + packages/shared/src/jobs.ts，' +
      'apps/daemon 不在里面 —— 改一个词就能修，已单独报 Manager。',
  },
];

/* ───────────────────────────── ① 指路语 + 文件名 ──────────────────────────── */

/**
 * 指路语。**必须紧挨在 token 前面**（中间只允许引号/括号/星号/空白）。
 *
 * 「紧挨」这个约束是误报率从 8 掉到 2 的原因：`markdown.ts:55` 那句
 * 「与 `adapters/markmap.ts` 那份…输出不同」里也有个文件名，但它前面是「与」，不是「见」。
 */
const POINTER =
  /(?:见|参见|详见|另见|见于|位于|定义在|实现在|写在|移到|搬到|挪到|放在|see|See|cf\.|defined in|lives in|documented in|described in)\s*(?:[（(【「"'’“`]|\*\*)*\s*$/;

/**
 * 文件名 token。**反引号可有可无**（原始病例是裸的，见文件头）。
 *
 * ⚠️ `tsx` 必须排在 `ts` 前面：写成 `ts|tsx` 时 `JobToaster.tsx` 会被截成
 * `JobToaster.ts` 而**判成不存在** —— 第一版实测报出 14 条假红，全是这个原因。
 * 后面的 `(?![\w])` 是第二道保险。
 */
const FILE_TOKEN = /`?((?:\.{0,2}\/)?(?:[\w.@-]+\/)*\w[\w.@-]*\.(?:tsx|ts|mjs|sql|md))(?![\w])`?/g;

/** 叙述而非指路的信号，见文件头。 */
const NARRATION =
  /(不存在|没有这个文件|已删|删掉|删除|摘掉|摘除|零命中|从来没有|原来写着|曾经|曾有|此前|旧的|旧版|~~|不再|已改名|改名|重命名|以前|原本)/;

/* ───────────────────────────── ② `{@link X}` ─────────────────────────────── */

const LINK = /\{@link\s+([^}|\s]+)\s*(?:\|[^}]*)?\}/g;

/* ───────────────────────────── ③ queue.block() ───────────────────────────── */

/** `queue.block(id, 'CODE', …)` 的第二个实参，只认字面量。 */
const BLOCK_LITERAL = /\bqueue\.block\(\s*[^,()]+,\s*(['"`])([A-Za-z0-9_]+)\1/g;
/** 所有 `queue.block(` 调用点 —— 用来发现「有调用点但第二个实参不是字面量」。 */
const BLOCK_ANY = /\bqueue\.block\(/g;

/* ──────────────────────────────── 扫描器本体 ──────────────────────────────── */

/**
 * 一个位置是不是落在字符串字面量里 —— 数它前面**没被转义的**引号个数，奇数就是在里面。
 *
 * ## 为什么需要这一步（不是洁癖，是这道门自己的 selftest 逼出来的）
 *
 * `selftest-comment-facts.mjs` 里存着**逐字的坏注释夹具** ——
 * 一个模板字符串，内容就是那句「见」+ 一个不存在的文件名。
 * 不认引号的话，这道门会把**自检夹具本身**当成一条真注释判红 ——
 * 于是「给它喂一条坏注释」这条用例一加进来，主检查就永远红了。
 *
 * ⚠️ 这个判断**只会漏检、不会误判**：数错时的结果是「这行不当注释看」，
 * 也就是少查一条，而不是把写对的人拦下来。方向选对了才敢用近似 ——
 * 一道会误伤的门，两周内就会被所有人学会绕过去。
 */
function inStringLiteral(line, index) {
  let quotes = 0;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quotes++;
  }
  return quotes % 2 === 1;
}

/**
 * 把一个文件里的**注释行**抠出来（`[行号, 该行注释部分]`）。
 *
 * 刻意用行级近似而不是真正的词法分析：这道门只读散文，
 * 而近似的每一处偏差都被摆到「少查一条」那一侧（见 `inStringLiteral`）。
 */
export function commentSpans(text, rel) {
  const out = [];
  const lines = text.split('\n');
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      out.push([i + 1, line]);
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    let block = line.indexOf('/*');
    if (block >= 0 && inStringLiteral(line, block)) block = -1;
    let eol = line.indexOf('//');
    if (eol >= 0 && inStringLiteral(line, eol)) eol = -1;
    if (block >= 0 && (eol < 0 || block < eol)) {
      out.push([i + 1, line.slice(block)]);
      if (!line.slice(block).includes('*/')) inBlock = true;
      continue;
    }
    if (eol >= 0) out.push([i + 1, line.slice(eol)]);
    else if (rel.endsWith('.sql')) {
      const dash = line.indexOf('--');
      if (dash >= 0 && !inStringLiteral(line, dash)) out.push([i + 1, line.slice(dash)]);
    }
  }
  return out;
}

/**
 * 三条规则的**唯一实现**。CLI 和 selftest 都调它 ——
 * selftest 里**不许**再写一份"等价"的扫描逻辑，那样量的就不是这道门了。
 *
 * @param files    `{ rel, text }[]`  参与扫描的源码（注释部分才会被读）
 * @param docs     `{ rel, text }[]`  Markdown（整篇正文都算"注释"）
 * @param tracked  仓库里在册的全部路径（判「这个文件存在吗」用）
 */
export function scanCommentFacts({ files, docs = [], tracked }) {
  const basenames = new Set(tracked.map((f) => f.slice(f.lastIndexOf('/') + 1)));
  const violations = [];
  const narrated = [];
  let pointerRefs = 0;
  let linkRefs = 0;

  const eachPointer = (rel, spans) => {
    for (const [line, span] of spans) {
      for (const m of span.matchAll(FILE_TOKEN)) {
        const token = m[1];
        // 绝对路径（`/tmp/…`）和构建产物（`dist/…`）不是仓库里的源文件，不判。
        if (token.startsWith('/') || token.includes('/dist/')) continue;
        if (!POINTER.test(span.slice(0, m.index))) continue;
        pointerRefs++;
        if (basenames.has(token.slice(token.lastIndexOf('/') + 1))) continue;
        const where = { rel, line, token, context: span.trim() };
        if (NARRATION.test(span)) narrated.push(where);
        else violations.push({ rule: 'pointer', ...where });
      }
    }
  };

  for (const f of files) eachPointer(f.rel, commentSpans(f.text, f.rel));
  for (const d of docs)
    eachPointer(
      d.rel,
      d.text.split('\n').map((l, i) => [i + 1, l]),
    );

  /* ② `{@link X}` —— 符号必须在源码里出现过（`{@link}` 自身不算数）。 */
  const codeText = files
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f.rel))
    .map((f) => f.text)
    .join('\n')
    .replace(LINK, ' ');
  for (const f of files) {
    for (const [line, span] of commentSpans(f.text, f.rel)) {
      for (const m of span.matchAll(LINK)) {
        linkRefs++;
        const target = m[1];
        const name = target.split(/[.#]/).pop().replace(/\(\)$/, '');
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
          violations.push({
            rule: 'link',
            rel: f.rel,
            line,
            token: target,
            context: span.trim(),
            detail: '认不出这是个标识符',
          });
          continue;
        }
        if (!new RegExp(`(?:^|[^\\w$.])${name}\\b`).test(codeText)) {
          violations.push({
            rule: 'link',
            rel: f.rel,
            line,
            token: target,
            context: span.trim(),
            detail: '全仓源码里找不到这个符号',
          });
        }
      }
    }
  }

  return { violations, narrated, pointerRefs, linkRefs };
}

/** 从 `packages/shared/src/jobs.ts` 的**源码文本**里读出那份契约。 */
export function pipelineErrorCodesFrom(text) {
  const m = /export const PIPELINE_ERROR_CODES = \[([\s\S]*?)\] as const;/.exec(text);
  if (!m) return null;
  return [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
}

/**
 * 把注释挖掉，只留下**真会执行的那些字节**。
 *
 * ⚠️ 这一步是必须的：本仓有 8 处注释在**举例说明** `queue.block()` 的行为
 * （`blockedReason.ts` 的文件头就写了好几遍）。不挖掉的话，
 * 「有几个调用点」会把散文数进去 —— 一道**把注释当代码数**的门，
 * 恰恰是这一整批要治的病本身。
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join('\n');
}

/**
 * `queue.block()` 真的发出去的码 + 静态判不了的调用点。
 *
 * ⚠️ **只喂产品代码**（`apps/**` + `packages/**`），不喂 `scripts/**`。
 * 理由不是洁癖：`queue.block()` 是 daemon 的 API，调用点只可能在产品里；
 * 而 `scripts/ci` 下**存着这条规则自己的反向夹具**
 * （一句写在模板字符串里的假调用，专门用来证明"漏配会红"）。
 * 不划这条线的话，那个夹具会被当成真调用点 —— 这道门就会为了自己的自检而永远红。
 * `[实测]` 这一条是「先提交再验一遍」才暴露出来的：没提交时 `git ls-files` 看不见新脚本。
 */
export function blockedCodesFrom(files) {
  const codes = new Map();
  let callSites = 0;
  let literal = 0;
  for (const raw of files) {
    const f = { rel: raw.rel, text: stripComments(raw.text) };
    callSites += (f.text.match(BLOCK_ANY) ?? []).length;
    for (const m of f.text.matchAll(BLOCK_LITERAL)) {
      literal++;
      if (!codes.has(m[2])) codes.set(m[2], []);
      codes.get(m[2]).push(f.rel);
    }
  }
  return { codes, callSites, undecidable: callSites - literal };
}

/* ──────────────────────────────────── CLI ─────────────────────────────────── */

/**
 * 地板值。**这是防「扫描器悄悄什么都不匹配了」的那道保险。**
 *
 * 本仓在 `check-locale-ratchet` 上写过同一句话：「零命中不是错误，但这里零命中意味着
 * 扫描坏了」。一个正则打错一个字就会让这道门**永远绿** —— 那正是这一周抓到的
 * 第一种失效形态（空转守卫）。`f0b0ad3` 实测：指路 211、`{@link}` 82。
 * 地板取得远低于实测值，是为了别让"删了几条注释"变成一次假红。
 */
const FLOOR_POINTER = 100;
const FLOOR_LINK = 20;

function gitFiles(...patterns) {
  return execFileSync('git', ['-C', REPO, 'ls-files', ...patterns], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean);
}

function main() {
  const tracked = gitFiles();
  const load = (rels) =>
    rels.map((rel) => ({ rel, text: readFileSync(resolve(REPO, rel), 'utf8') }));

  const sourceRels = gitFiles('*.ts', '*.tsx', '*.mjs', '*.js', '*.sql').filter(
    (f) => !f.startsWith('vendor/') && !f.startsWith('dist/'),
  );
  const docRels = gitFiles('docs/*.md', 'docs/**/*.md');
  const files = load(sourceRels);
  const docs = load(docRels);

  console.log('注释里的指路 · 对账\n');

  const { violations, narrated, pointerRefs, linkRefs } = scanCommentFacts({
    files,
    docs,
    tracked,
  });

  let failed = 0;

  /* ③ #104：`queue.block()` 发的码必须在契约里。 */
  const jobsRel = 'packages/shared/src/jobs.ts';
  const jobsText = readFileSync(resolve(REPO, jobsRel), 'utf8');
  const contract = pipelineErrorCodesFrom(jobsText);
  const { codes, callSites, undecidable } = blockedCodesFrom(
    files.filter((f) => f.rel.startsWith('apps/') || f.rel.startsWith('packages/')),
  );

  if (contract === null) {
    console.log(`✘ 在 ${jobsRel} 里找不到 PIPELINE_ERROR_CODES —— 是不是被改写/改名了？`);
    console.log('   这条对账靠那个常量存在；改写它就等于把这道门拆了。');
    failed++;
  } else if (callSites === 0) {
    console.log('✘ 全仓一个 `queue.block(` 都没扫到 —— 扫描坏了，不是"没有调用点"。');
    failed++;
  } else {
    const missing = [...codes.keys()].filter((c) => !contract.includes(c));
    if (missing.length > 0) {
      console.log('✘ #104 · `queue.block()` 发得出、而契约里没有的码：');
      for (const c of missing)
        console.log(`     ${c}   ← ${[...new Set(codes.get(c))].join(', ')}`);
      console.log('');
      console.log(`   ${jobsRel} 的 PIPELINE_ERROR_CODES 自称是流水线发出的码，`);
      console.log('   照它写一张「这条任务在等什么」的表，上面这些真实状态会**永远落兜底**。');
      console.log('   要做的：把上面的码补进 PIPELINE_ERROR_CODES，并给它写一条界面文案。');
      failed++;
    } else {
      console.log(
        `✔ #104 · queue.block() 的 ${codes.size} 个码全在 PIPELINE_ERROR_CODES 里` +
          `（${callSites} 个调用点）`,
      );
    }
    if (undecidable > 0) {
      console.log(
        `   ⚠️ 另有 ${undecidable} 个 queue.block() 调用点第二个实参不是字面量 —— ` +
          '这道门看不见它们发的是什么码。',
      );
    }
    const unemitted = contract.filter((c) => !codes.has(c));
    if (unemitted.length > 0) {
      console.log(`   ⓘ 契约里今天没有任何 queue.block() 发出的码：${unemitted.join(' / ')}`);
      console.log('     （不判红：契约可以先于实现。但别照它建界面分支 —— 那些分支走不到。）');
    }
  }

  /* ①② 指路 / `{@link}` */
  const waived = [];
  const real = [];
  for (const v of violations) {
    const w = WAIVERS.find((x) => x.file === v.rel && x.token === v.token);
    if (w) waived.push({ v, w });
    else real.push(v);
  }

  console.log('');
  if (real.length === 0) {
    console.log(`✔ 指路 ${pointerRefs} 处、{@link} ${linkRefs} 处，全都指得到。`);
  } else {
    console.log(`✘ ${real.length} 处指向了不存在的东西：`);
    for (const v of real) {
      console.log(`     ${v.rel}:${v.line}   ${v.token}${v.detail ? `  —— ${v.detail}` : ''}`);
      console.log(`        ${v.context.slice(0, 140)}`);
    }
    console.log('');
    console.log('   这不是风格问题：一句「见 X」在 X 不存在时，把读的人送去一个空地址，');
    console.log('   而**没有任何构建/测试会因此变红** —— 这道门就是为这一段造的。');
    console.log('   要做的：改成真名；或者如果它在讲一段已经删掉的历史，');
    console.log('   把句子写成叙述（「此前 X 里…」「X 已删」），别用「见 X」。');
    failed++;
  }

  /* 地板：扫描器还活着吗。 */
  if (pointerRefs < FLOOR_POINTER || linkRefs < FLOOR_LINK) {
    console.log('');
    console.log(
      `✘ 扫到的引用掉到地板以下（指路 ${pointerRefs} < ${FLOOR_POINTER} 或 ` +
        `{@link} ${linkRefs} < ${FLOOR_LINK}）。`,
    );
    console.log('   这几乎一定是正则打错了字，而不是"注释真的少了这么多"。');
    console.log('   一道匹配不到任何东西的门永远是绿的 —— 那比没有门更坏。');
    failed++;
  }

  /* 豁免：用没用上、过没过期。 */
  if (waived.length > 0) {
    console.log('');
    console.log(`⚠️ 已知失实、豁免中（${waived.length} 条）——「记着」不是「修好了」：`);
    for (const { v, w } of waived) {
      console.log(`     ${v.rel}:${v.line}   ${v.token}`);
      console.log(`        ${w.reason}`);
    }
  }
  const stale = WAIVERS.filter((w) => !waived.some(({ w: hit }) => hit === w));
  if (stale.length > 0) {
    console.log('');
    console.log('✘ 豁免过期 —— 这条已经不再违规了，把它从 WAIVERS 里删掉：');
    for (const w of stale) console.log(`     ${w.file}   ${w.token}`);
    console.log('   （留着过期豁免，下一次真的坏了就会被它悄悄放行。）');
    failed++;
  }

  if (narrated.length > 0) {
    console.log('');
    console.log(`ⓘ 叙述型引用，不判（${narrated.length} 条）—— 跳过什么必须看得见：`);
    for (const n of narrated) {
      console.log(`     ${n.rel}:${n.line}   ${n.token}`);
      console.log(`        ${n.context.slice(0, 120)}`);
    }
  }

  console.log('');
  if (failed > 0) {
    console.log(`${failed} 组对不上。`);
    process.exit(1);
  }
  console.log('全部对得上。');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
