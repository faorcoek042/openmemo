#!/usr/bin/env node
/**
 * 把构建时的来源信息烘焙进 **产物**（`apps/daemon/dist/build-info.json`）。
 *
 * ## 为什么不在启动时读 git
 *
 * 启动时 `git log -1` 拿到的是**工作区当前的 commit**，而 daemon 跑的是 `dist/` 里
 * **上一次构建**出来的 JS。改完代码提交但没重建，两者就分叉了 ——
 * 页面会显示新 commit，**而实际跑的是旧代码**。
 *
 * 这正是本项目反复出现的那类"假信号"：一个看起来在报告真相的东西，
 * 报告的却是另一码事。版本号的唯一职责就是回答"我现在跑的是哪份代码"，
 * 它一旦会说谎，就比没有更糟 —— 用户会拿它来判断"我的改动生效了没有"。
 *
 * ## 所以：跟着产物走
 *
 * 这个文件由构建生成、和 `dist/` 同生共死。`tsc -b --clean` 会连它一起删，
 * 于是"没构建过"和"构建信息缺失"是同一个状态，daemon 显示 `unknown` —— 诚实。
 *
 * 不写进 `src/`：那样每次构建都会改动源码，而 commit 时间又要等提交之后才确定，
 * 形成死循环（提交→时间变→需再提交）。产物目录没有这个问题。
 *
 * ## 不进 .gitignore
 *
 * 它在 `dist/` 里，本就不跟踪。**不要**为它单独加 `.gitignore` 规则 ——
 * 本项目有过 `models/`（不带前导斜杠）意外匹配 `apps/web/src/features/models/`
 * 的事故，见 `scripts/check-tracked-sources.mjs`。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readProductVersion } from './lib/version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps', 'daemon', 'dist', 'build-info.json');

/** 读 git，失败返回 null —— 非 git 检出（如解包发行版）是合法场景，不该让构建挂掉。 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const commit = git(['rev-parse', '--short=8', 'HEAD']);
// %cI = committer date, 严格 ISO 8601 带时区 —— 不受 locale 影响
const commitTime = git(['log', '-1', '--format=%cI']);

// 工作区有未提交改动时，commit 号不足以说明"跑的是什么"。标出来，别让用户误以为
// 页面上那个 commit 就是全部真相。
const dirty = git(['status', '--porcelain']) ? true : false;

/*
 * 版本号也走这条路 —— 和 commit 同生共死，理由是同一条。
 *
 * daemon 跑的是 `dist/` 里上一次构建出来的 JS。如果它在**启动时**去读根
 * `package.json`，那读到的是工作区当前的值：版本号 bump 了但没重建，页面会显示新版本
 * 而实际跑的是旧代码 —— 与本文件开头批判的"启动时读 git"是同一个错误。
 *
 * 另外，预编译产物解包后 `dist/main.js` 旁边**不保证**有根 `package.json`
 * （`apps/daemon/package.json` 的 `files` 只列了 `dist`），运行时读它本来也不成立。
 *
 * 读不到 build-info.json 时 daemon 显示 `unknown` —— 和 commit 一样，诚实而不是猜。
 *
 * ⚠️ 这里**不允许**写成 `JSON.parse(readFileSync('package.json')).version`。
 * 读取点只有 `scripts/lib/version.mjs` 一个，见那里的注释。
 */
const version = readProductVersion();

const info = {
  version,
  commit: commit ?? 'unknown',
  commitTime: commitTime ?? null,
  dirty,
  builtAt: new Date().toISOString(),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
console.log(`✔ build-info: v${version} · ${info.commit}${dirty ? '+dirty' : ''} @ ${commitTime ?? '?'}`);
