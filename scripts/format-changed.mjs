#!/usr/bin/env node
/**
 * `pnpm format:changed` —— **秒级**回答一个问题：**我要提交的那几个文件，格式化了吗。**
 *
 * ## 它为什么存在
 *
 * `pnpm format:check`（`prettier --check .`）是对的，但**没有人跑它** ——
 * 它挂在 `pnpm check` 里，而 `pnpm check` 含 `pnpm build:safe`，要几分钟。
 * `[实测 2026-08-10]` 结果是 `Format check` 连红五次、四个不同作者，
 * 其中一次是在别人正在清理前一批的**那二十分钟里**落地的。
 * **"慢"是它不被跑的全部原因**，所以这里的唯一设计目标是**快到没有借口**：
 * `[实测]` 直接跑 **0.54s**、经 pnpm 包装 **0.78s**（对照：`pnpm check` 几分钟）。
 *
 * ## ★ 作用域：**恰好等于你要提交的那些文件**，不多不少
 *
 * 这是本脚本唯一需要想清楚的事，因为选错了它就变成另一个坑。
 *
 * | 口径 | 为什么**不能**用 |
 * |---|---|
 * | `git diff --name-only HEAD`（工作树 vs HEAD） | 🔴 **这棵树是多路共享的**，它列出的是**所有人**未提交的改动。照它去格式化，就是去动别人没写完的文件 —— 与我们否掉 pre-commit hook 的理由**完全相同**（`.git/hooks`、`git stash`、`git checkout -- <file>` 都栽在同一件事上：**作用域比使用者以为的宽**） |
 * | `git diff --name-only origin/master`（工作树 vs 远端） | 🔴 同上，只是范围更大 |
 *
 * 所以口径是：
 *
 * 1. **给了路径参数 → 就查这几个。** 而且**照抄你 `git commit -- <pathspec>` 里的那几个**
 *    （PROTOCOL §12 本来就强制你把它们列出来）。
 *    **让"检查的范围"和"提交的范围"是同一份文本，它们就不可能漂移。**
 * 2. **没给参数 → 查 `origin/master..HEAD`**，也就是"我本地有、远端还没有"的那些提交里
 *    动过的文件 = **我即将 push 的东西**。它只看**已提交**内容，
 *    因此**结构上不可能**碰到任何人未提交的工作。
 *
 * ## ⚠️ 它**不替代** `pnpm format:check`
 *
 * 它只看你点名的那些文件。**"漏掉别人漏的"是它的设计，不是缺陷** ——
 * 全仓那一档由 CI 的 `Format check` 负责，两者分工不同，不要用这个的绿去推那个的绿。
 *
 * ## 用法
 *
 * ```bash
 * pnpm format:changed <照抄 git commit -- 后面的那几个路径>   # 提交前
 * pnpm format:changed                                        # push 前：查 origin/master..HEAD
 * pnpm format:changed --write <路径…>                        # 直接改好
 * ```
 * 退出码：有文件未格式化 → 1；**显式给了路径却一个可查文件都没解析出来 → 1**（多半是路径打错了）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const write = argv.includes('--write');
const paths = argv.filter((a) => a !== '--write');

/** `origin/master..HEAD` 里动过的文件 —— 即"我即将 push 的东西"，只含已提交内容。 */
function filesAboutToPush() {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/master'], {
      cwd: REPO,
      stdio: 'ignore',
    });
  } catch {
    console.error(
      '✘ 找不到 origin/master —— 先 `git fetch origin`。\n' +
        '  （不退回"工作树 vs HEAD"：那个口径在共享树上会列出别人未提交的改动。）',
    );
    process.exit(1);
  }
  return execFileSync('git', ['diff', '--name-only', 'origin/master..HEAD'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

const explicit = paths.length > 0;
const candidates = explicit ? paths : filesAboutToPush();

// 删掉的文件没法格式化；prettier 对不认识的扩展名用 --ignore-unknown 跳过。
const targets = candidates.filter((p) => existsSync(resolve(REPO, p)));

if (targets.length === 0) {
  if (explicit) {
    /*
     * ★ 显式给了路径却一个都没解析出来 = 多半路径打错了。
     * **这种情况下报绿是最坏的结果**：你以为查过了，其实一个字节都没看
     *（本仓「空集返回绿」那一族已经咬过很多次，包括咬在核对工具自己身上）。
     */
    console.error(
      `✘ 给了 ${paths.length} 个路径，但一个存在的文件都没解析出来：\n  ${paths.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log('· origin/master..HEAD 里没有改动过的文件 —— **没有检查任何东西**（这不是"通过"）。');
  process.exit(0);
}

const r = spawnSync(
  'npx',
  ['prettier', '--ignore-unknown', write ? '--write' : '--check', ...targets],
  { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/^npm warn.*$/gm, '').trim();
if (out) console.log(out);

if (r.status === 0) {
  console.log(
    `✔ ${targets.length} 个文件格式正确（口径：${explicit ? '你给的路径' : 'origin/master..HEAD'}）。\n` +
      '  ⚠️ 这**不**等于全仓格式正确 —— 它只看这几个文件；全仓那一档是 CI 的 `Format check`。',
  );
  process.exit(0);
}

console.error(
  '\n✘ 上面这些文件没有格式化。\n' +
    `  修：pnpm format:changed --write ${explicit ? paths.join(' ') : ''}\n`.trimEnd() +
    '\n  ⚠️ 只格式化**你自己**的文件。共享树上别人也有在途改动，\n' +
    '     "顺手把全仓格一遍"会动到别人没写完的东西（PROTOCOL §15 那一族）。',
);
process.exit(1);
