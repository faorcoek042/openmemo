#!/usr/bin/env node
/**
 * 递增产品版本号。**这条命令就是"发布"这个动作本身。**
 *
 * ```bash
 * pnpm version:bump "把版本号做成有意义的"      # 0.2.0 → 0.3.0（又一个可用的东西）
 * pnpm version:bump --fix "修好了启动崩溃"      # 0.3.0 → 0.3.1（0.3.0 已经交出去了，但它坏了）
 * ```
 *
 * ## 为什么版本号和 CHANGELOG 必须由同一条命令写
 *
 * 因为**分两步做的事情，迟早只做第一步**。本仓的历史全是这个：
 * `%APPDATA%` vs `%LOCALAPPDATA%`、`libsimple.dll` vs `simple.dll`、`'CPU' !== 'cpu'` ——
 * 都是"同一件事要在两个地方各写一遍"，然后只写了一遍。
 *
 * 一起写之后，`check-version-sync.mjs` 的 ⑥「CHANGELOG 最新条目 == package.json version」
 * 就是一条**平时永远绿、只有人手改坏了才红**的守卫。
 * 反过来，如果去守"你是不是该 bump 了"，那条守卫会在每一次日常提交上变红 ——
 * 而一条永远红的守卫等于一条被删掉的守卫。
 *
 * ## 为什么不是 CI 自动、也不是 commit 钩子
 *
 * - **commit 钩子**：单位错了。它数的是 commit，而 commit 号已经在回答"跑的是哪一份代码"，
 *   再加一个跟着 commit 走的数字什么新信息都没有。而且钩子不进克隆，换台机器就静默消失。
 * - **CI 自动**：CI 在每次 push 上跑，单位还是 commit，不是"交付"。
 *   而且 CI 往主干回写 commit 会和正在干活的人抢树。
 * - **人**：因为"这东西现在能交给用户了吗"是个判断，机器没有依据去做。
 *   风险是"人会忘" —— 而这个风险被结构消掉了：bump 就是发布，没发布就不需要 bump。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, VERSION_RE, productTag, readRootPackageJson } from './lib/version.mjs';

const argv = process.argv.slice(2);
const isFix = argv.includes('--fix');
const summary = argv
  .filter((a) => a !== '--fix')
  .join(' ')
  .trim();

if (!summary) {
  console.error(
    `用法: pnpm version:bump [--fix] "这一版交付了什么"\n\n` +
      `  摘要是**必填**的。版本号只给出"第几个"，摘要才让那个序号有含义 ——\n` +
      `  没有摘要的 0.7.0 和 0.6.0 之间，用户看不出发生过什么。\n\n` +
      `  --fix  针对**已经交付出去**的那个 N 的修补（0.N.P → 0.N.P+1）。\n` +
      `         判据是事实不是价值：N 已经给用户了吗？给了就是 --fix，没给就直接改 N。`,
  );
  process.exit(1);
}

const { path: pkgPath, text: pkgText, json: pkg } = readRootPackageJson();
const cur = pkg.version;
const m = VERSION_RE.exec(cur ?? '');
if (!m) {
  console.error(
    `✘ 当前 version = ${JSON.stringify(cur)}，不符合 0.N.P，不敢自动递增。先手工修好。`,
  );
  process.exit(1);
}

const [n, p] = [Number(m[1]), Number(m[2])];
const next = isFix ? `0.${n}.${p + 1}` : `0.${n + 1}.0`;

/*
 * 只替换 version 那一行，不做 JSON.stringify 回写 —— 后者会把根 package.json 里
 * 那些长长的 `_comment:*` 的键序和格式重排一遍，制造无关 diff。
 * 用锚定到行首的正则，且**断言恰好命中一次**。
 */
const RE = /^(\s*"version":\s*")[^"]*(",)$/m;
if (!RE.test(pkgText)) {
  console.error(`✘ 在 ${pkgPath} 里找不到可替换的 version 行`);
  process.exit(1);
}
const nextPkgText = pkgText.replace(RE, `$1${next}$2`);
if (JSON.parse(nextPkgText).version !== next) {
  console.error('✘ 回写后的 version 不是预期值 —— 替换命中了错误的位置，已中止');
  process.exit(1);
}

const clPath = join(REPO_ROOT, 'CHANGELOG.md');
const clText = readFileSync(clPath, 'utf8');
const MARK = '---\n';
const at = clText.indexOf(MARK);
if (at < 0) {
  console.error(`✘ ${clPath} 里找不到分隔线 \`---\`，不知道该把新条目插在哪`);
  process.exit(1);
}
/*
 * **本地日期**，不是 `toISOString().slice(0,10)`。
 * `[实测]` 本机 UTC+8，当地 2026-08-08 00:52 时 `toISOString()` 给出 `2026-08-07` ——
 * CHANGELOG 上的日期会比用户以为的早一天，每天有 8 小时会踩中。
 * 这个日期是给人看的（"这一版是哪天交付的"），所以要跟人所在的时区走。
 */
const now = new Date();
const pad = (x) => String(x).padStart(2, '0');
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const head = clText.slice(0, at + MARK.length);
const rest = clText.slice(at + MARK.length);
const entry = `\n## ${next} — ${today}\n\n${isFix ? '' : `**第 ${n + 1} 个可用版本。**\n\n`}- ${summary}\n`;

// 两个文件一起写。中间没有"只写了一半"的稳定状态可言 —— 真要在这两行之间被 kill，
// 下一次 `pnpm check:version` 会当场红并指出是哪两个数不一致（这正是 ⑥ 存在的意义）。
writeFileSync(pkgPath, nextPkgText);
writeFileSync(clPath, head + entry + rest);

console.log(`✔ ${cur} → ${next}`);
console.log(`  已更新: package.json, CHANGELOG.md`);
console.log(`\n下一步（本脚本**不替你做**，因为打 tag / push 是不可撤销的）：`);
console.log(
  `  git add package.json CHANGELOG.md && git commit -m "release: ${next} —— ${summary}"`,
);
console.log(`  git tag ${productTag(next)}`);
console.log(
  `\n  tag 用 \`v\` 前缀，和 Releases 页上 \`backend-packs-*\` / \`model-mirror-*\` 刻意分开：\n` +
    `  那两类是产品运行时自己去取的后端包与模型镜像（README 第 12 行说了不是给用户下的），\n` +
    `  产品版本是唯一给人看的那类。注意 tag ≠ GitHub Release，打 tag 不会往 Releases 页加东西。`,
);
