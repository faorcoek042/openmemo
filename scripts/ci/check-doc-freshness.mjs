#!/usr/bin/env node
/**
 * 文档里那些**依赖目录条数的实测值**，在目录变了之后必须重新测。
 *
 * ## 它防的是什么
 *
 * `docs/DEPLOYMENT.md` §1.3 的平台矩阵里有「目录共 N 个包，适用于本机 M 个」这类数字。
 * 它们是**实测值**，测的时候目录是 23 个包。`474c210` 之后目录变成 25 个 ——
 * **那一刻表里的数字就失效了，而没有任何东西会说话。**
 *
 * 这正是本仓 `PROTOCOL §13` 那张表的形状：
 * **结论产生了、被记下了，但让它失效的那个事件没有惊动任何人**，
 * 于是下一个读者拿到的是旧数字，**而且它看起来仍然是活的**（还标着 `[CI 实测]`）。
 *
 * ## ⚠️ 它**不是**"这格没测就红"
 *
 * 「Windows/macOS 那两格没测」在今天是**事实，不是故障** —— 我们刻意没有去推算它。
 * 一条为"没测"而常态红的守卫，会在两周内被所有人学会忽略，
 * 然后它连真正的回归也挡不住了（本仓在 `check-bundle-macos-floors` 上已经吃过这一课：
 * 一刀切的红既发不出包也说不清事实，最后换成了分层）。
 *
 * **它红的条件是：你刚刚改动了让那些数字失效的那个东西。**
 * 也就是「目录条数变了」这个**事件**本身。红给**改动的人**看，
 * 而不是让下一个读者被误导 —— 提醒要放在会触发失效的那只手边上。
 *
 * ## 怎么加新的一条
 *
 * 在 `CLAIMS` 里加一项：`{ 文件, 文档里声明的值, 实际值怎么算, 失效之后要做什么 }`。
 * **只登记"依赖某个可机器计算的输入"的实测值** —— 判断类、需要真机的结论不属于这里。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 数一个 manifest 里有多少个包。两种形状都认（`packs` / 顶层数组）。 */
function packCount(rel) {
  const j = JSON.parse(readFileSync(resolve(REPO, rel), 'utf8'));
  const list = j.packs ?? j.components ?? j.backends ?? j.extensions ?? j;
  if (!Array.isArray(list)) throw new Error(`${rel}: 认不出这个 manifest 的形状`);
  return list.length;
}

const CLAIMS = [
  {
    id: 'D-19 §1.3 迁入块 · 目录条数',
    doc: 'docs/design/D-19-user-doc-provenance.md',
    /**
     * 文档里声明的那个数。
     *
     * ★ 从**机器可读的标记**里取，不从正文散文里取。
     *   第一版用的是正则匹配正文（`今天目录是 **N** 个`），当场就被 prettier 的
     *   重排打断了 —— 而且人随手改一句措辞也会让它失灵。
     *   **一个靠散文措辞维系的守卫，是一个迟早会静默失效的守卫。**
     */
    declared: (text) => {
      const m = /<!--\s*doc-freshness:\s*catalogPacks=(\d+)\s*-->/.exec(text);
      return m ? Number(m[1]) : null;
    },
    actual: () =>
      packCount('vendor/manifests/backends.json') + packCount('vendor/manifests/sqlite-ext.json'),
    why: [
      '§1.3 的「目录共 N 个包，适用于本机 M 个」是实测值，测的时候目录是另一个条数。',
      '目录一变，那几格（尤其 Windows / macOS 的「适用的包」）就不再成立。',
      '',
      '要做的：',
      '  1. 跑一轮  gh workflow run cold-start-audit.yml   （三平台，约 6 分钟/平台，会真下载几百 MB）',
      '  2. 从三个 job 日志里抄「目录共 N 个包，适用于本机 M 个」，逐平台更新 §1.3 的表',
      '  3. 更新 §1.3 里 `[A]` 的 run id、正文里那句「今天目录是 N 个」，',
      '     以及 D-19 里那行对账标记  <!-- doc-freshness: catalogPacks=N -->',
      '',
      '⚠️ 不许用「目录多了 2 个包所以适用数 +1」这类推算填表 —— 推算出来的数不是实测值。',
    ],
  },
];

let failed = 0;
console.log('文档实测值 · 输入对账\n');

for (const c of CLAIMS) {
  const text = readFileSync(resolve(REPO, c.doc), 'utf8');
  const declared = c.declared(text);
  const actual = c.actual();

  if (declared === null) {
    console.log(`✘ ${c.id}`);
    console.log(`   在 ${c.doc} 里找不到声明值 —— 是不是被改写了？`);
    console.log(`   （这条对账靠正文里那句话存在；改写它就等于把这道提醒拆了。）`);
    failed++;
    continue;
  }

  if (declared !== actual) {
    console.log(`✘ ${c.id}`);
    console.log(`   ${c.doc} 声明：${declared}`);
    console.log(`   实际  ：${actual}   （vendor/manifests/ 现在的条数）`);
    console.log('');
    for (const line of c.why) console.log(`   ${line}`);
    failed++;
  } else {
    console.log(`✔ ${c.id}：文档 ${declared} = 实际 ${actual}`);
  }
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 条对不上。`);
  console.log('这不是"某个测量没做"，是"做过的那个测量的前提变了" —— 见上面每条的处置。');
  process.exit(1);
}
console.log('全部对得上。');
