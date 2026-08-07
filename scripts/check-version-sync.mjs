#!/usr/bin/env node
/**
 * 守卫：**版本号不许在第二个地方被写下来。**
 *
 * ## 它守的是什么
 *
 * 用户的原话是「版本号一直都是 0.1.0 没更新」。实情比这更糟：界面上的 `v0.1.0` 来自
 * `apps/daemon/src/main.ts` 里手写的 `export const VERSION = '0.1.0'`，
 * 而所有 `package.json` 写的是 `0.0.0`。**两个数字互不知道对方存在** ——
 * 它们不是"drift 了"，是从来就没连上过。所以谁也不会变，也没有任何东西会报错。
 *
 * 这是本仓吃过好几次亏的同一个形状：`%APPDATA%` vs `%LOCALAPPDATA%`、
 * `libsimple.dll` vs `simple.dll`、`'CPU' !== 'cpu'` —— **同一个事实写在两个地方**。
 *
 * ## 它**不**守什么（这一条比上一条重要）
 *
 * 它**不检查"你是不是该 bump 了"**。
 *
 * 那种检查（例如"距上次 bump 已有 N 个 commit"）会在**每一次**日常提交上变红，
 * 而 PROTOCOL 已经吃过这个亏：**一条永远红的守卫等于一条被删掉的守卫**。
 * 而且它守不住任何东西 —— "该不该发一个版本"是人的判断，机器没有依据。
 *
 * 递增靠的是**结构**而不是守卫：`pnpm version:bump` 把版本号和 CHANGELOG 一次写完，
 * 而"发布"这个动作本身就是跑那条命令。**没跑 = 没发布 = 本来就不该 bump。**
 * 于是"忘了 bump"这件事在结构上不存在，不需要守卫去追。
 *
 * 守卫只守**一致性** —— 一个今天就是绿的、只有真的分叉了才会红的性质。
 *
 * ## 自检先行
 *
 * 照 `check-orphan-exports.mjs` 的规矩：**在报告任何结论之前**先证明自己没瞎。
 * 一个扫不到文件的扫描器会安静地报绿，那比没有守卫更糟。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, productTag, readProductVersion, readRootPackageJson } from './lib/version.mjs';

/** 工作区里所有包（不含根）。写死一份清单是**故意**的 —— 见下面 ③ 的非空自检。 */
const WORKSPACE_PKGS = [
  'apps/daemon',
  'apps/web',
  'packages/db',
  'packages/downloader',
  'packages/llm',
  'packages/mindmap',
  'packages/pipeline',
  'packages/runtime',
  'packages/shared',
];

const problems = [];
const fail = (msg) => problems.push(msg);

/* ─────────────────────────────────────────────────────────────
 * ① 自检：我读的是我以为的那个文件吗
 * ───────────────────────────────────────────────────────────── */
try {
  readRootPackageJson(); // name !== 'openmemo' 会在这里抛
} catch (err) {
  console.error(`✘ 自检未通过 —— **在报告任何结论之前**先停下：\n  ${err.message}`);
  process.exit(1);
}

/* ─────────────────────────────────────────────────────────────
 * ② 自检：清单里的包必须真的存在
 *    包被改名/移动而清单没跟上时，下面 ③ 会对着一堆不存在的路径报绿。
 * ───────────────────────────────────────────────────────────── */
{
  const missing = WORKSPACE_PKGS.filter((p) => !existsSync(join(REPO_ROOT, p, 'package.json')));
  if (missing.length > 0) {
    console.error(
      `✘ 自检未通过 —— **在报告任何结论之前**先停下：\n` +
        `  本脚本的 WORKSPACE_PKGS 清单里有 ${missing.length} 个包不存在：\n` +
        missing.map((p) => `    ${p}/package.json`).join('\n') +
        `\n  包被改名或移走了。先更新 scripts/check-version-sync.mjs 的清单，` +
        `否则这条守卫在对着不存在的文件报绿。`,
    );
    process.exit(1);
  }
  if (WORKSPACE_PKGS.length < 8) {
    console.error(`✘ 自检未通过：清单只剩 ${WORKSPACE_PKGS.length} 个包，实在太少，八成是被误删了`);
    process.exit(1);
  }
}

/* ─────────────────────────────────────────────────────────────
 * ③ 唯一事实来源：只有根 package.json 可以有 version 字段
 *
 * 注意这里断言的是"**没有这个字段**"，不是"这个字段的值和根一样"。
 * 后者要靠一个同步脚本去维持 10 份拷贝，而**拷贝存在本身就是分叉的前提**。
 * 字段不存在，就没有东西可以分叉 —— 这是结构上的解决，不是纪律上的。
 *
 * `[实测 2026-08-08]` pnpm 10.15.0 对 private 工作区包缺 `version` 字段无异议：
 * 在 /tmp 的最小工作区里 `pnpm install` 与 `pnpm -r build` 均 exit 0。
 * ───────────────────────────────────────────────────────────── */
for (const pkg of WORKSPACE_PKGS) {
  const rel = `${pkg}/package.json`;
  const json = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
  if ('version' in json) {
    fail(
      `${rel} 又有 version 字段了（= ${JSON.stringify(json.version)}）。\n` +
        `    这些包是 private、不发布、没有下游 —— 那个字段没有任何消费者，\n` +
        `    唯一的作用是给根 package.json 的权威值制造一个可以分叉的副本。删掉它。`,
    );
  }
}

/* ─────────────────────────────────────────────────────────────
 * ④ 根 version 的格式：0.N.P，且能进文件名
 *    预编译产物的包名要带版本号（`openmemo-<version>-<os>-<arch>.<ext>`），
 *    所以这不是审美要求，是下游会直接拼进文件路径的字符串。
 * ───────────────────────────────────────────────────────────── */
let version = null;
try {
  version = readProductVersion();
} catch (err) {
  fail(err.message);
}

/* ─────────────────────────────────────────────────────────────
 * ⑤ daemon 源码里不许再出现版本号字面量
 *    这正是 v0.1.0 的成因：一行 `export const VERSION = '0.1.0'`。
 * ───────────────────────────────────────────────────────────── */
{
  const rel = 'apps/daemon/src/main.ts';
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const m = /^\s*export const VERSION\s*=\s*(.+?);?\s*$/m.exec(src);
  if (!m) {
    fail(
      `${rel} 里找不到 \`export const VERSION = ...\`。\n` +
        `    它被改名或删掉了 —— 本条守卫已经守不住任何东西，请更新守卫或恢复该导出。`,
    );
  } else if (!m[1].startsWith('BUILD_INFO.version')) {
    fail(
      `${rel}: VERSION 的值是 \`${m[1]}\`，不是从 BUILD_INFO 来的。\n` +
        `    版本号一旦在这里被写成字面量，就和根 package.json 断开了 ——\n` +
        `    界面上那个 v0.1.0 从项目开始就没变过，成因一字不差就是这个。`,
    );
  }
}

/* ─────────────────────────────────────────────────────────────
 * ⑥ CHANGELOG 最新一条 == 根 version
 *
 * 这条让"版本号变了但没人说它变了什么"当场变红。
 * 两者由 `pnpm version:bump` 一次写入，所以正常路径下永远一致；
 * 只有人手改了其中一个才会红 —— 而那正是要抓的。
 * ───────────────────────────────────────────────────────────── */
if (version) {
  const rel = 'CHANGELOG.md';
  const path = join(REPO_ROOT, rel);
  if (!existsSync(path)) {
    fail(`${rel} 不存在。版本号没有对应的"这一版是什么"，"第几个可用的东西"就只是个数字。`);
  } else {
    const text = readFileSync(path, 'utf8');
    const heads = [...text.matchAll(/^##\s+(\S+)\s/gm)].map((x) => x[1]);
    if (heads.length === 0) {
      fail(`${rel} 里一条 \`## <版本号>\` 都没有 —— 格式坏了，本条守卫失效`);
    } else if (heads[0] !== version) {
      fail(
        `${rel} 最新一条是 \`## ${heads[0]}\`，但 package.json 的 version 是 ${version}。\n` +
          `    正常改版本号请用 \`pnpm version:bump\`（一次写两边）。`,
      );
    }
  }
}

/* ─────────────────────────────────────────────────────────────
 * ⑦ 产物里的版本号（构建过才有）
 *    CI 的门禁顺序是 build:safe → … → test:ci-scripts，所以在 CI 里这一条**一定**被执行到。
 *    本地没构建过时跳过并明说 —— 静默跳过等于假绿。
 * ───────────────────────────────────────────────────────────── */
let bakedNote = '';
if (version) {
  const rel = 'apps/daemon/dist/build-info.json';
  const path = join(REPO_ROOT, rel);
  if (!existsSync(path)) {
    bakedNote = `ℹ 跳过产物核对：${rel} 不存在（还没构建过）。CI 里 build:safe 先跑，这一条会被执行到。`;
  } else {
    const baked = JSON.parse(readFileSync(path, 'utf8'));
    if (baked.version !== version) {
      fail(
        `${rel} 里烘焙的 version 是 ${JSON.stringify(baked.version)}，` +
          `根 package.json 是 ${version}。\n` +
          `    改完版本号没重建 —— daemon 现在跑的、界面上显示的，还是旧那个。跑 \`pnpm build:safe\`。`,
      );
    } else {
      bakedNote = `✔ 产物核对：${rel} 的 version 与根一致`;
    }
  }
}

/* ───────────────────────────── 结论 ───────────────────────────── */
if (problems.length > 0) {
  console.error(`\n✘ ${problems.length} 处版本号不一致：\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\n  规则见 docs/design/D-12-versioning.md。` +
      `\n  唯一事实来源是根 package.json 的 version，改它请用 \`pnpm version:bump\`。\n`,
  );
  process.exit(1);
}

if (bakedNote) console.log(bakedNote);
console.log(
  `✔ 版本号单一事实来源：${version}（tag 形如 ${productTag(version)}）；` +
    `${WORKSPACE_PKGS.length} 个工作区包均无 version 字段；CHANGELOG 最新条目一致`,
);
