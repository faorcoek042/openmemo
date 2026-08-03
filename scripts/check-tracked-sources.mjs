#!/usr/bin/env node
/**
 * 防线：源码目录被 `.gitignore` 意外匹配。
 *
 * ## 起因（真实事故）
 *
 * `.gitignore` 里**不带前导斜杠**的 `models/` 在 git 语义下匹配**任意层级**的同名目录，
 * 于是命中了 `apps/web/src/features/models/`。两个症状：
 *
 * 1. **11 个源文件从未进过版本库** —— 一次 `git clean -fdx` 就全没了。
 * 2. **Tailwind v4 遵守 `.gitignore`，从不扫描被忽略的目录** ——
 *    该目录**独有**的 class（`w-[26rem]` / `z-20`）从未被生成，
 *    而 `absolute` / `rounded-lg` 因别处也在用照常生效。
 *    **同一个 className 一半生效一半不生效，读代码永远看不出来**，
 *    用户看到的只是"下拉有点穿模"。
 *
 * 根因藏在三层之下：穿模 ← class 没生成 ← 目录没被扫 ← gitignore 没锚定。
 *
 * ## 为什么检查目录而不是检查文件
 *
 * 文件一旦入库，git 就不再报它被忽略（tracked 优先于 ignore）——
 * 于是"文件是否未跟踪"这个判据在**修复之后就失效了**，挡不住重犯。
 * 而 **Tailwind 的扫描仍然按 `.gitignore` 走**，症状 2 照样会回来。
 *
 * 所以判据必须是：**源码目录本身不许被 `.gitignore` 匹配**（用 `git check-ignore` 直接问 git）。
 */
import { execFileSync } from 'node:child_process';

const ROOTS = ['apps', 'packages'];
const ARTIFACT =
  /(^|\/)(node_modules|dist|dist-types|\.build|\.test-out|\.vite|\.cache|coverage|prebuilds)(\/|$)/;

/** 列出所有源码目录（排除产物目录）。 */
function sourceDirs(root) {
  let out;
  try {
    out = execFileSync('find', [root, '-type', 'd'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return out.filter((d) => !ARTIFACT.test(d));
}

const dirs = ROOTS.flatMap(sourceDirs);
if (!dirs.length) {
  console.error('✘ 没找到任何源码目录，检查脚本本身可能有问题');
  process.exit(1);
}

// `--no-index` 是关键：默认 check-ignore 会先看索引，
// **已入库的文件会让它闭嘴** —— 而 Tailwind 的扫描只看 `.gitignore` 规则、不看索引。
// 不加这个旗标，修复之后这条检查就永远是绿的，挡不住重犯。
let ignored = [];
try {
  const out = execFileSync('git', ['check-ignore', '--no-index', '--', ...dirs], {
    encoding: 'utf8',
  });
  ignored = out.split('\n').filter(Boolean);
} catch (e) {
  // 退出码 1 = 没有任何路径被忽略，这是我们想要的结果
  if (e.status !== 1) throw e;
}

if (ignored.length) {
  console.error(`\n✘ ${ignored.length} 个源码目录被 .gitignore 匹配：\n`);
  for (const d of ignored) console.error(`   ${d}`);
  console.error(
    `\n后果有两层，第二层很难自己发现：` +
      `\n  1. 目录里的新文件**不会进版本库**（git clean 就没了）` +
      `\n  2. **Tailwind 不扫描被忽略的目录** → 该目录独有的 class 从不生成，` +
      `\n     而共用的 class 照常生效 —— 表现为"样式一半对一半不对"，读代码看不出来` +
      `\n\n成因几乎总是：模式**没有前导斜杠**，于是匹配任意层级的同名目录。` +
      `\n例如 \`models/\` 会命中 \`apps/web/src/features/models/\`。修法：写成 \`/models/\`。\n`,
  );
  process.exit(1);
}
console.log(`✔ ${dirs.length} 个源码目录均未被 .gitignore 匹配`);
