#!/usr/bin/env node
/**
 * 守卫：**四条 e2e 腿都必须从启动器起 daemon，绕回去直接起入口就当场红。**
 *
 * ## 它挡的是什么
 *
 * 完成度审计查出第四类「CI 结构上看不见」，而它是用户三条真机故障的共同根因：
 *
 * > CI 直接起 `app/daemon/dist/main.js`，而用户双击的是启动器脚本。
 * > **凡是只有启动器才做的事，CI 结构上都看不见。**
 *
 * `[grep 实测]` `OPENMEMO_BUNDLED_PROBE_DIR` 此前**四条腿一条都没引用过** ——
 * 于是探针进包那条修复在启动器路径上是 `[未验证]`，而"三平台全绿"
 * 在启动器那一段上**没有效力**。这是同一形状的第四次，而且它把前三次的修复
 * 也一起架空了。
 *
 * ## 为什么这条守卫不是"正则匹配散文"
 *
 * 上一位刚栽过「靠散文措辞撑着的守卫会静默停止工作」。所以这里**先剥注释**，
 * 只看**可执行的代码**，判据是两条没有判断空间的事实：
 *
 *   ① 腿的代码里**不许出现 daemon 入口路径**（`main.js`）。
 *      —— 之所以做得到，是因为源码树那条回退也被收进了共享模块，
 *         所以"这次是不是回退"这种需要判断的情形，在腿这一层根本不存在。
 *   ② 腿**必须 import 共享模块**并调用 `spawnDaemon(`。
 *
 * 两条都不涉及"这段话是怎么写的"，只涉及"这个符号在不在"。
 * 一条腿要绕过启动器，就必须重新写出入口路径 —— 而那会当场撞上 ①。
 *
 * ## 顺带钉住共享模块自己
 *
 * ③ 共享模块必须真的**执行启动器文件**（`start.cmd` / `OpenMemo.command` / `start.sh`），
 *    而不是自己去 spawn 包里的 node —— 否则 ①② 全都满足，却什么也没验到。
 * ④ 三个平台的启动器名字都要出现：**统一意图是对的，统一拼写是错的**。
 *
 * 用法：`node scripts/ci/selftest-launcher-path.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI = join(REPO, 'scripts', 'ci');

/** 四条 e2e 腿的执行脚本。加一条新腿就往这里加一行 —— 漏加会被 ⑤ 当场发现。 */
const LEGS = [
  'e2e-import-audit.mjs',
  'e2e-notes-audit.mjs',
  'e2e-record.mjs',
  'e2e-runtime-audit.mjs',
];
const HELPER = 'launcher-spawn.mjs';

/**
 * 剥掉注释与字符串字面量之外的干扰。
 *
 * ⚠️ **必须先剥注释**：这几个文件的注释里**大量**出现 `main.js`，
 *    因为它们正是在解释"为什么不再直接起它"。一条会把解释文字当成违规的守卫，
 *    会逼着人把解释删掉 —— 那是在惩罚说清楚的人。
 *    （同一处置见 `lint-workflows.mjs` 扫 release 脚本时的 `stripComments`。）
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const problems = [];
let checks = 0;
const must = (cond, msg) => {
  checks += 1;
  if (!cond) problems.push(msg);
};

console.log('─'.repeat(88));
console.log('── 守卫：四条 e2e 腿必须从启动器起 daemon');
console.log('─'.repeat(88));

/* ⑤ 前提自检：登记的腿必须真的存在，否则下面每条断言都会"因为没东西可查"而恒真。 */
for (const leg of LEGS) {
  must(existsSync(join(CI, leg)), `登记的腿不存在：scripts/ci/${leg}（改名了就同步这里）`);
}
must(existsSync(join(CI, HELPER)), `共享模块不存在：scripts/ci/${HELPER}`);

for (const leg of LEGS) {
  const full = join(CI, leg);
  if (!existsSync(full)) continue;
  const code = stripComments(readFileSync(full, 'utf8'));

  // ① 代码里不许出现 daemon 入口路径
  const hits = code.split('\n').filter((l) => /main\.js/.test(l));
  must(
    hits.length === 0,
    `${leg}: 代码里出现了 daemon 入口 main.js（${hits.length} 处）——\n` +
      `      这条腿又绕过启动器直接起 daemon 了。用户双击的是启动器，\n` +
      `      直接起入口就看不到 WEB_DIST / EXT_DIR / BUNDLED_PROBE_DIR / 工作目录。\n` +
      `      改法：走 scripts/ci/${HELPER} 的 spawnDaemon()。\n` +
      hits.map((l) => `        > ${l.trim().slice(0, 100)}`).join('\n'),
  );

  // ② 必须 import 共享模块并真的调用它
  must(
    new RegExp(`from\\s+['"]\\./${HELPER.replace('.', '\\.')}['"]`).test(code),
    `${leg}: 没有 import ./${HELPER} —— 它是起 daemon 的唯一入口`,
  );
  must(/spawnDaemon\s*\(/.test(code), `${leg}: 没有调用 spawnDaemon() —— 那它是怎么起的 daemon？`);
}

/* ③④ 共享模块必须真的执行启动器，且三个平台各按各的拼写 */
{
  const code = stripComments(readFileSync(join(CI, HELPER), 'utf8'));
  for (const name of ['start.cmd', 'OpenMemo.command', 'start.sh']) {
    must(
      code.includes(name),
      `${HELPER}: 代码里没有 ${name} —— 三个平台的启动器名字不一样，` +
        `少一个就等于那个平台没走启动器（统一意图对，统一拼写错）`,
    );
  }
  must(
    /OPENMEMO_BUNDLED_PROBE_DIR/.test(code),
    `${HELPER}: 没提到 OPENMEMO_BUNDLED_PROBE_DIR —— 它正是本轮盲区的现场，` +
      `共享模块必须把它列进"归启动器设、调用方不许预设"的名单`,
  );
}

console.log(`   登记的腿：${LEGS.join(', ')}`);
console.log(`   共享模块：${HELPER}`);
console.log('');
if (problems.length === 0) {
  console.log(`✔ selftest-launcher-path: ${checks} 条断言全部通过`);
  process.exit(0);
}
console.log(`✘ selftest-launcher-path: ${problems.length}/${checks} 条不通过：`);
for (const p of problems) console.log(`   · ${p}`);
process.exit(1);
