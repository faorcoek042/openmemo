/**
 * ★ 仓库级守卫：**源码文件里不许出现字面控制字节**。
 *
 * ## 这条守的是什么
 *
 * GNU grep 只要在文件前若干字节里见到 `NUL`，就把整个文件判定为 binary，
 * 然后 `grep -r` **一声不响地跳过它** —— 不是报错，不是 "Binary file matches"，
 * 在 `-r` + 有其它命中的场景下就是**没有输出**。
 *
 * `[实测]`（本轮抓到的，HEAD `2cc5610` 之前）：
 *
 * ```
 * $ grep -rn "MEDIA_EXTENSIONS" packages/pipeline/src/subprocess/
 * （无输出）
 * $ grep -rn --binary-files=text "MEDIA_EXTENSIONS" packages/pipeline/src/subprocess/
 * packages/pipeline/src/subprocess/argGuard.ts:436:export const MEDIA_EXTENSIONS = new Set([
 * $ file packages/pipeline/src/subprocess/argGuard.ts
 * packages/pipeline/src/subprocess/argGuard.ts: data
 * ```
 *
 * 成因是 `argGuard.ts` 的 `CONTROL_CHARS` 正则里写了三个**真的**控制字节
 * （`0x00` / `0x1f` / `0x7f`），而不是 `\x00` 这样的转义序列。语义完全一样
 * （`[实测]` 全码点比对 0 差异），后果全在工具上。
 *
 * **为什么这条值得单独立一个守卫**：被隐形的那个文件是
 * `packages/pipeline/src/subprocess/argGuard.ts` —— 参数注入防线、SSRF 私网判定、
 * 媒体扩展名白名单、可执行文件白名单**全都在里面**，是本仓库最该被审计的一个文件。
 * 本项目的历次盘点大量依赖 `grep -rn` 下"零命中"的结论；只要这个文件是 binary，
 * **每一条这样的结论对它都是无效的**，而且无效得毫无征兆。
 *
 * 同族：⑤G（`.gitignore` 少一个前导 `/` → Tailwind 与 git 双双跳过那个目录，
 * 一个视觉 bug + 11 个源文件没进版本库）。
 * **判据一致：任何让工具"静默忽略源码"的东西，都要当 bug 修，不是风格问题。**
 *
 * ## 为什么住在 packages/pipeline 里
 *
 * 事实上的门禁命令是 `pnpm -r test`，而 `pnpm -r` **默认不含 workspace root** ——
 * 挂在根 `package.json` 上的守卫在真正被跑的那条命令里根本不会执行
 * （`scripts/check-test-scripts.mjs` 的文件头记着同一件事）。
 * 放在这里是因为**被隐形的那个文件就在这个目录**。
 * 若日后要提升成 `pnpm check:*` 的一员，逻辑可以整段搬走，不依赖本包任何东西。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/** 仓库根 —— `dist/subprocess/__tests__/` 上溯 5 层。 */
const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'));

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-types',
  '.build',
  '.test-out',
  '.git',
  'vendor',
  'coverage',
  '.vite',
  'assets',
]);

/** 只扫**源码**：产物与第三方不归我们管。 */
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|json|css|md|ya?ml|sh|sql)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.isFile() && SOURCE_EXT.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * grep 判 binary 的实际判据是「前若干字节里有 NUL」，但这里收得更严一点：
 * 任何 C0 控制字符（除 `\t` `\n` `\r`）与 `DEL`。理由是它们在编辑器/终端/diff 里
 * 全都不可见 —— 只要肉眼看不见，就迟早会被"顺手格式化"掉而没人发现。
 */
// eslint-disable-next-line no-control-regex -- 这条规则要禁的正是本守卫要找的东西
const FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

describe('★ 源码必须是纯文本 —— 否则 grep -r 会静默跳过它', () => {
  const files = sourceFiles(REPO);

  it('先证明扫描本身不是空集（空集会让下面那条永远绿）', () => {
    // ⑤A-2：本项目已有四种"对空集返回绿"的形态。守卫的第一条断言必须是"我真的看到东西了"。
    assert.equal(files.length > 500, true, `只扫到 ${files.length} 个源码文件，扫描范围坏了`);
    assert.equal(
      // ★ T-63：期望值要用 `join()` 拼。`files` 是 `join()` 造出来的，Windows 上带反斜杠，
      // 而写死的 POSIX 串永远匹配不上 —— `[CI 实测 run 31313108614, win32-x64]`
      // 这条"前提自检"自己成了那个不成立的前提，于是整条守卫在 Windows 上从未生效。
      files.some((f) =>
        f.endsWith(join('packages', 'pipeline', 'src', 'subprocess', 'argGuard.ts')),
      ),
      true,
      '当初出问题的那个文件必须在扫描范围内，否则这条守卫钉的是零',
    );
  });

  it('★ 全仓源码零个字面控制字节', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'latin1'); // 按字节读，不做 UTF-8 解码
      const m = FORBIDDEN.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        const code = `0x${(m[0].codePointAt(0) ?? 0).toString(16).padStart(2, '0')}`;
        offenders.push(`${relative(REPO, f)}:${line} 含字面控制字节 ${code}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '这些文件里有肉眼看不见的控制字节。含 NUL 的文件会被 grep -r 判为 binary 并**静默跳过** ——\n' +
        '正则里要控制字符请写转义序列（`\\x00`），不要写字面字节：\n  ' +
        offenders.join('\n  '),
    );
  });

  it('守卫本身有效：造一个含 NUL 的样本必须被判出来', () => {
    // 钉的是判据，不是"跑过了"。FORBIDDEN 被"顺手放宽"时这条会红。
    // ⚠️ 样本必须**程序构造**，不能在本文件里写字面控制字节 ——
    // 否则这个守卫会把自己判红（本轮第一版就是这样，[实测] 三个 offender 里有一个是它自己）。
    const NUL = String.fromCharCode(0x00);
    const US = String.fromCharCode(0x1f);
    const DEL = String.fromCharCode(0x7f);
    assert.equal(FORBIDDEN.test(`const R = /[${NUL}-${US}]/;`), true, 'NUL 必须被判出');
    assert.equal(FORBIDDEN.test(`a${DEL}b`), true, 'DEL 必须被判出');
    // 正常源码里合法的空白不许误伤 —— 否则这条守卫会变成假红灯（⑤B）
    assert.equal(FORBIDDEN.test('a\tb\r\nc'), false, '制表符与换行是合法的');
    assert.equal(FORBIDDEN.test('const R = /[\\x00-\\x1f\\x7f]/;'), false, '转义写法是合法的');
  });
});
