#!/usr/bin/env node
/**
 * 防线：**一个包里有测试文件，却没有 `test` 脚本** —— `pnpm -r test` 对这件事
 * 从头到尾不说一个字，它只是把那个包**跳过**，然后照常报绿。
 *
 * ## 起因（同一个坑的第四、第五次）
 *
 * 「一批测试从来没有被执行过」在本项目已经以四种不同机制发生过：
 *
 * 1. `apps/daemon`：`node --test dist/**\/*.test.js` 没加引号，sh 不认 `**`，
 *    （那个反斜杠是为了不让星号加斜杠提前结束本块注释，不是命令的一部分）
 *    13 个测试文件只跑到 9 个 —— `116 pass` 与 `177 pass` **两个数字都报绿**（HANDOFF ⑤A-19）。
 * 2. `packages/pipeline`：同一行写法，10 个文件只跑到 1 个（132 条只报 6 条，exit 0）。
 * 3. `packages/db`：当时是绿的，但**正确的原因是巧合** —— 文件恰好都在一层，
 *    sh 匹配不到就把 pattern 原样透传给 node，是 node 自己的 glob 救了它。
 * 4. `packages/runtime`：**压根没有 `test` 脚本**。它 391 行的自检测试
 *    （含被写进 HANDOFF 当作"验证标杆"的四段反向验证）从写下来那天起一次没跑过。
 * 5. `packages/llm`(18) + `packages/mindmap`(42)：同样是**没有脚本**，共 60 条。
 *    其中 `llm/src/structured.test.ts` 正是「`extractJson` 修反了顺序」那次事故补的护栏 ——
 *    它改坏了不会让 `pnpm -r test` 变红一格。
 *
 * 前三次修的是**脚本写法**（`node --test` 默认发现 + 发现守卫，见各包的 `_comment:test`）。
 * 但那条守卫只能守**已经有脚本的包**：它跑在包内部，包被跳过时它自己也被跳过。
 * 第四、第五次证明了**"哪些包有测试却没脚本"没有任何东西在盯**，全靠有人恰好想起来数一遍。
 * 这个脚本就是那个"盯着的人"。
 *
 * ## 为什么它挂在包的 `test` 脚本里，而不是根目录
 *
 * 事实上的门禁命令是 `pnpm -r test`，而 **`pnpm -r` 默认不包含 workspace root** ——
 * 挂在根 `test` 脚本上的守卫，在真正被跑的那条命令里根本不会执行。
 * 所以它被前置进 db / pipeline / runtime / llm / mindmap / daemon **共用的那一行**：
 * 挂六份是刻意的冗余 —— 删掉任何一个包的 `test` 脚本，守卫都还在，
 * 而"六个包同时被删"这件事本身就已经不是静默失败了。
 *
 * **判据不是"要记得给新包加 test 脚本"，是"忘了加会当场红"。**
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['apps', 'packages'];
const TEST_FILE = /\.test\.tsx?$/;

/** 递归数一个目录里的 `*.test.ts(x)`，跳过产物目录。 */
function countTestFiles(dir) {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) n += countTestFiles(p);
    else if (e.isFile() && TEST_FILE.test(e.name)) n += 1;
  }
  return n;
}

/**
 * ★ T-169：**「一个测试文件都没有」本身就是可疑信号，不是豁免理由。**
 *
 * 上面那条守卫的判据是「**有**测试文件 却 没有 test 脚本」。`closure-audit` 🟡-6 指出：
 * 这个判据有个前提 —— 包里得先有测试文件。`packages/shared` 有 **0 个**，
 * 于是它**永远不触发**；`pnpm -r test` 也永远跳过它；CI 日志那句
 * 「8 个含测试的包都有 test 脚本」里从来没有它。**两边都不出声。**
 *
 * 而 `packages/shared` 恰恰是**跨进程契约的那一份**（`schemas.ts` 的 zod、`CONTRACT_VERSION`、
 * daemon 与 web 的唯一事实来源）。本项目已知的多起事故形状都是
 * 「发送方与接收方对同一个字段理解不同」—— 守着那条线的包，
 * 是唯一一个**没有任何测试、且没有任何门禁会为之出声**的包。
 *
 * 这与 T-157 棘轮「从来没在 CI 里跑」、以及棘轮判据「不剥字符串字面量」是**同一个形状**：
 * **判据的前提没被满足，于是守卫静默失效。** 所以判据要反过来写：
 * 有源码却零测试 → 必须**明确表态**（补测试，或登记进下面这张表并写清理由）。
 *
 * 这张表**刻意留空**。要往里加之前先想清楚：一个跨进程契约包"不需要测试"是什么意思。
 */
const NO_TEST_EXEMPT = Object.freeze({
  // 'packages/foo': '为什么这个包不需要任何测试',
});

/** 递归数一个目录里的非测试源文件（`.d.ts` 不算）。 */
function countSourceFiles(dir) {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) n += countSourceFiles(p);
    else if (
      e.isFile() &&
      /\.tsx?$/.test(e.name) &&
      !TEST_FILE.test(e.name) &&
      !e.name.endsWith('.d.ts')
    )
      n += 1;
  }
  return n;
}

const offenders = [];
const discovery = [];
const covered = [];
const untested = [];
let wiring = 0;

for (const root of ROOTS) {
  let names;
  try {
    names = readdirSync(join(REPO, root));
  } catch {
    continue;
  }
  for (const name of names) {
    const pkgDir = join(REPO, root, name);
    let manifest;
    try {
      if (!statSync(pkgDir).isDirectory()) continue;
      manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const scripts = manifest.scripts ?? {};
    // 守卫自身的接线点数一下 —— 它靠冗余活着，冗余掉光了要说出来。
    // ⚠️ 必须跳过 `_comment:*`：那些注释里也写着本文件名，
    //    算进去的话「接线全被拆掉」这件事会被自己的说明文字掩盖住
    //    （反向验证第一次就是这么假绿的 —— 拆到只剩 1 处仍然 exit 0）。
    const wired = Object.entries(scripts).some(
      ([k, v]) => !k.startsWith('_') && String(v).includes('check-test-scripts.mjs'),
    );
    if (wired) wiring += 1;

    const n = countTestFiles(join(pkgDir, 'src'));
    const where = `${root}/${name}`;
    if (n === 0) {
      // 有源码、零测试 —— 这才是要抓的那一类（见上方 NO_TEST_EXEMPT 的说明）。
      const src = countSourceFiles(join(pkgDir, 'src'));
      if (src > 0 && !(where in NO_TEST_EXEMPT)) {
        untested.push(`${where} —— ${src} 个源文件，**0 个测试文件**`);
      }
      continue;
    }
    if (typeof scripts.test === 'string' && scripts.test.trim() !== '') {
      covered.push(`${where}(${n})`);
      // ★ T-145：`node --test` 的**发现范围**必须被钉死，不能交给 node 的默认规则。
      //   第一次真跑 GitHub CI 时（Node 22.23.1，ADR-006 决策 7 钉的基线）：
      //   光秃秃的 `node --test` 把 `src/**/*.test.ts` 也捞了进去 ——
      //     ERR_MODULE_NOT_FOUND: Cannot find module .../packages/llm/src/errors.js
      //   而本机 Node 24.18.0 不捞，所以本机 867 全绿、CI 当场红。
      //   → 现在要求带引号的 dist 位置参数。两种错法各自的后果都是「假绿」：
      //     · 掉引号 → sh 展开 `**` 成"恰好两层"，漏跑（T-135，daemon 13→9 个文件）
      //     · 写成 `node --test dist` → Node 24 当成一个文件，`tests 1 / pass 1` 绿灯（实测）
      //   所以判据不是"记得加引号"，是"没加会在这里当场红"。
      if (
        /node --test/.test(scripts.test) &&
        !/node --test "dist\/\*\*\/\*\.test\.js"/.test(scripts.test)
      ) {
        discovery.push(
          `${where} —— scripts.test 里的 \`node --test\` 没有跟着 "dist/**/*.test.js"（含双引号）` +
            `\n      实际写的是: ${scripts.test.slice(scripts.test.indexOf('node --test'))}`,
        );
      }
    } else offenders.push(`${where} —— ${n} 个 *.test.ts(x)，但 package.json 没有 test 脚本`);
  }
}

const problems = [];
if (offenders.length > 0) {
  problems.push(
    `有测试文件却没有 test 脚本的包（pnpm -r test 会静默跳过它们，然后报绿）：\n` +
      offenders.map((o) => `    - ${o}`).join('\n') +
      `\n  修法：照 packages/db 的 scripts.test 抄那一行（含前置发现守卫），别再发明第七种写法。`,
  );
}
if (discovery.length > 0) {
  problems.push(
    `\`node --test\` 的发现范围没被钉死（会漏跑或多跑，两种都以"绿灯"收场）：\n` +
      discovery.map((o) => `    - ${o}`).join('\n') +
      `\n  修法：结尾写成 \`&& node --test "dist/**/*.test.js"\`（**双引号不能掉**）。理由见上方注释。`,
  );
}
if (untested.length > 0) {
  problems.push(
    `有源码却**一个测试文件都没有**的包（这类包对 \`pnpm -r test\` 完全隐形 —— ` +
      `它不会被跳过并报绿，它压根不在名单上）：\n` +
      untested.map((o) => `    - ${o}`).join('\n') +
      `\n  判据：**"零测试"本身就是可疑信号，不是豁免理由。**` +
      `\n  修法：补测试（挑真会咬人的契约点，别为了让数字好看灌样板），` +
      `并照 packages/db 抄那一行 scripts.test；` +
      `\n        确有理由不测 → 登记进 ${'check-test-scripts.mjs'} 的 NO_TEST_EXEMPT 并写清为什么。`,
  );
}
if (wiring < 2) {
  problems.push(
    `本守卫只剩 ${wiring} 个接线点了 —— 它是靠"挂在多个包的 test 脚本上"活着的（见文件头）。` +
      `\n  少于 2 个接线点意味着再删一处它就彻底消失且无声。`,
  );
}

if (problems.length > 0) {
  console.error(`✘ check-test-scripts:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

console.log(
  `✔ check-test-scripts: ${covered.length} 个含测试的包都有 test 脚本 —— ${covered.join(' ')}`,
);
