/**
 * ★ 仓库级守卫：**注释里「`see` + 驼峰标识符」指向的东西必须真的存在。**
 *
 * ## 为什么会有这条
 *
 * 这一族缺陷的形状是：**读者以为有保护，实际没有**。它比"没做"更贵，
 * 因为它让下一个人**不去做** —— 三个人先后读过 `argGuard.ts` 那条注释，
 * 三个人都以为连接时复查已经有了。
 *
 * 本轮修的三条里有两条是同一个形状：
 *
 * | 注释声称 | 实际 |
 * |---|---|
 * | `argGuard.ts` 让读者去看下面的 `resolveAndCheck` | `[实测 grep]` 全仓只有这条注释本身，函数从不存在 |
 * | `runner.ts` 「On Windows this is emulated via taskkill」 | `[实测 grep]` 全仓零 `taskkill` 调用 |
 *
 * `taskkill` 那条这条守卫抓不到（它不是 `see <标识符>` 的形状）。
 * **抓不到的部分如实写在这里**，不假装覆盖面比实际大 —— 上一次正是"文档把防线写高一格"
 * 才让 `childProcessAllowlist` 那条规则空了十几轮。
 *
 * ## 判据为什么是"驼峰"
 *
 * 只认**含大写字母的驼峰标识符**（`resolveAndCheck` ✓，`kill(2)` ✗，`D-06 §9` ✗）。
 * 这一条把误报压到 0：`[实测]` 本仓 `apps/` 与 `packages/` 的 src 下共 9 处 `see <驼峰>`，
 * 修复前**恰好命中 1 条真缺陷**（`resolveAndCheck`），其余 8 条全部能解析到声明或文件名。
 *
 * 调试期间它一度还报了 `localFile.ts:52  see resolveSafe` —— 那是**误报**：
 * `resolveSafe` 是个带 `private async` 前缀的类方法，第一版的声明正则只认行首裸名字。
 * 记在这里是因为教训不在"少写了个修饰符"，而在：
 * **一条误报的守卫会被下一个人用一行豁免关掉，然后它就再也不响了。**
 *
 * ## 它不保证什么
 *
 * - 只查"名字存不存在"，**不查那个名字做的事对不对**。
 *   `assertHostNotPrivate` 存在，但它是预检不是连接时复查 —— 那半靠人读。
 * - 只扫 `.ts` / `.tsx`，不扫 `.md` / `.yml` / `.sh`。
 * - 不扫 `node_modules` / `vendor` / `dist`。
 */
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/** 仓库根 —— `dist/subprocess/__tests__/` 上溯 5 层（与 childProcessAllowlist.test.ts 同法）。 */
const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'));

/** 允许出现在声明名字前面的修饰符。漏一个就会变成误报，见文件头那段教训。 */
const MODIFIERS =
  '(?:export\\s+|default\\s+|declare\\s+|abstract\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|async\\s+|get\\s+|set\\s+|\\*\\s*)*';

/**
 * 「`see` + 驼峰名字」。**必须含大写字母**，否则 `see kill(2)` 这类散文会被当成标识符。
 *
 * ⚠️ 本守卫的代价，写在这里免得下一个人以为是 bug：
 * **想在注释里引用一个"不存在的名字"（比如讲解这次缺陷）就得换个写法。**
 * 本文件自己第一版就被自己拦下了 —— 三处，全在文档里举例。
 * 这是**刻意不加豁免**的结果：换个写法的代价是一次，
 * 而一个"自己豁免自己"的守卫，会教下一个人也给自己开一个口子。
 */
const REFERENCE = /see ([a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*)/g;

function sourceFiles(): string[] {
  return globSync('{apps,packages}/*/src/**/*.{ts,tsx}', { cwd: REPO })
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => !p.includes('node_modules/') && !p.includes('/dist/'))
    .sort();
}

describe('★ 注释里的 `see <标识符>` 不许指向不存在的东西', () => {
  const files = sourceFiles();

  it('先证明扫描器真的扫到了源码（扫到 0 个文件时下面那条会"通过"）', () => {
    assert.equal(
      files.length > 200,
      true,
      `只扫到 ${String(files.length)} 个源文件 —— glob 或仓库根算错了，本文件的绿灯没有意义`,
    );
  });

  it('★ 每一个被引用的标识符都必须能解析到声明或源文件名', () => {
    const declared = new Set<string>();
    const fileNames = new Set<string>();
    const sources = new Map<string, string>();

    for (const rel of files) {
      const text = readFileSync(join(REPO, rel), 'utf8');
      sources.set(rel, text);
      fileNames.add(basename(rel).replace(/\.tsx?$/, ''));
      for (const m of text.matchAll(
        new RegExp(`${MODIFIERS}(?:function|const|let|var|class|interface|type|enum)\\s+([A-Za-z_$][\\w$]*)`, 'g'),
      )) {
        if (m[1] !== undefined) declared.add(m[1]);
      }
      // 对象字面量的键、类方法、接口成员 —— 名字后面跟 `(` `<` `:` `?` 的那些。
      for (const m of text.matchAll(new RegExp(`^\\s*${MODIFIERS}([a-zA-Z_$][\\w$]*)\\s*[(<:?]`, 'gm'))) {
        if (m[1] !== undefined) declared.add(m[1]);
      }
    }

    // 阴性对照：索引里必须有几个我们确定存在的名字，否则"全都解析得到"只是索引坏了。
    for (const known of ['isPrivateOrReservedHost', 'assertHostNotPrivate', 'buildChildEnv']) {
      assert.equal(declared.has(known), true, `声明索引里没有 ${known} —— 索引坏了，下面的断言不成立`);
    }

    const dangling: string[] = [];
    for (const [rel, text] of sources) {
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(REFERENCE)) {
          const id = m[1];
          if (id === undefined) continue;
          if (!declared.has(id) && !fileNames.has(id)) {
            dangling.push(`${rel}:${String(i + 1)}  ->  ${id}`);
          }
        }
      });
    }

    assert.deepEqual(
      dangling,
      [],
      '注释指向了不存在的东西。要么把它实现出来，要么把注释改成实话 ——\n' +
        '  不许改成含糊的说法，也不许只在别的文件里挂个 ⚠️（ADR-003 那条就是这么烂了半个月的）：\n' +
        `${dangling.map((d) => `    ${d}`).join('\n')}`,
    );
  });
});
