#!/usr/bin/env node
/**
 * 机器比对：**发布页正文里印的 sha256** ⟷ **CI 产出的 `SHA256SUMS`**。
 *
 * ## 为什么这一步必须存在（这是验证链上唯一一环靠人手抄的地方）
 *
 * `release-verify.mjs` 校的是「从公开 URL 匿名下下来的字节」对「CI 自己算的
 * `SHA256SUMS`」。这条链很结实 —— **但它从头到尾没有读过发布页正文一个字。**
 * 而用户真正会拿去核对的那三行，是**人手抄进正文的**：
 *
 *   ```
 *   cb87da4a…  openmemo-0.7.6-darwin-arm64.tar.gz
 *   ```
 *
 * ⇒ **抄错一位，整条链上没有任何一处会变红。** 用户拿页面上的数去 `sha256sum -c`
 * 会发现对不上，然后得出一个完全错误的结论（"下载损坏了" / "被掉包了"），
 * 而实际上字节是好的、只有那张纸印错了。
 *
 * 0.7.6 发版时这一步是**在 `/tmp` 里临时写个脚本跑一遍**做的。本仓已经反复立过
 * 这条判据：
 *
 * > **「一个需要人记得去做的判据，等价于一个迟早不会被做的判据。」**
 *
 * 所以它进仓、并接到 `release-upload.yml#body-check` 上 ——
 * 传完、匿名复核完，**紧接着就去读一遍发布页正文**，对不上就红。
 *
 * ## ⚠️ 它**不**证明什么
 *
 * 它只说「正文那几行 == CI 算出来的那几行」。字节本身对不对是 `release-verify.mjs`
 * 的活；两者合起来才是完整的一句「你下到的字节 == 我们构建出的字节 == 页面上印的数」。
 * 单独看这一条，它连"文件存不存在"都不知道。
 *
 * ## 地板：**数到 0 条就红**
 *
 * 一个"零条断言全部通过"的比对器是本仓最贵的那一类失败 —— 它坏掉的样子
 * （围栏解析器认不出正文的形状了、CI 那侧的清单取回来是空文件）和"全都对得上"
 * **在输出上完全一样**。所以两侧各有一条空集断言，见 `judgeBodyVsCi`。
 *
 * ⚠️ 这条地板**独自承重的范围比它看起来窄**，`selftest-compare-body.mjs` 的 B 组
 * 逐格量过：「CI 侧空、正文有 3 行」由**反方向**那条「正文里多出一行」接住，
 * 「正文空、CI 侧有 3 行」由正方向那条接住 —— 地板唯一独自接住的是
 * **两侧同时数到 0**，也就是这个比对器自己瞎掉的那一格。
 * 写在这里是为了让下一个人别因为"看起来重复"就把它删掉：那一格没有第二道防线。
 *
 * 用法：
 *   node scripts/ci/compare-body-vs-ci.mjs --body <正文文件> --sums <SHA256SUMS>
 * 退出码：0 = 逐字符一致；1 = 不一致 / 判据自己没料到的形状；2 = 参数不对。
 *
 * 反向验证：`scripts/ci/selftest-compare-body.mjs`（5 条反向用例 + 1 条阴性对照，
 * 已接进 `pnpm test:ci-scripts`）。
 */
import { readFileSync } from 'node:fs';

import { isDirectRun } from '../lib/entrypoint.mjs';

/** 一个规范的 sha256（小写十六进制 64 位）。大写在解析时统一折成小写再比。 */
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `<sha256>  <文件名>` 这一行的形状 —— `sha256sum` 的输出格式。
 *
 * ⚠️ 刻意**不**限制中间的空白数（`sha256sum` 用两个空格，手抄进正文时常常变成一个），
 * 也刻意接受大写十六进制。**"抄的时候顺手改了排版"不该被判成"哈希错了"** ——
 * 那种红会把下一个人送去查一个没坏的东西。真正的判据只有一条：**那 64 位对不对。**
 */
const SHA256_LINE = /^([0-9a-fA-F]{64})\s+(\S+)$/;

/**
 * 从发布页正文里，把 ``` 围栏里的 `<sha>  <文件名>` 行抽出来。
 *
 * ⚠️ **只认围栏里的**。正文散文里随口提到一串十六进制（比如 commit sha、
 * 「上一版那个 `cb87da4a…`」）不该被当成一条校验和声明 —— 那会造出一堆
 * "正文里多出一行"的假红，而假红比没有门更贵。
 *
 * @param {string} text 发布页正文（GitHub 发的是 CRLF，`trim()` 会顺手吃掉 `\r`）
 * @returns {Map<string, string>} 文件名 → 小写 sha256
 */
export function parseBodyChecksums(text) {
  const out = new Map();
  let inFence = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const m = SHA256_LINE.exec(line);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/**
 * 解析 CI 那侧的 `SHA256SUMS`（`release-upload.mjs` 现算出来、`release-verify.mjs`
 * 匿名复核过的那一份）。整个文件都是数据，没有围栏。
 *
 * @param {string} text
 * @returns {Map<string, string>} 文件名 → 小写 sha256
 */
export function parseSumsFile(text) {
  const out = new Map();
  for (const raw of String(text).split('\n')) {
    const m = SHA256_LINE.exec(raw.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/**
 * 判据本体 —— **纯函数**，吃两段文本，吐一个判决。
 *
 * 之所以是纯函数而不是"顶层执行 + `process.exit()`"：v0.7.6 的已知边界第 10 条
 * 记着仓里还有 4 个脚本因为那种写法**结构上不可测** ——「判据写在顶层执行的脚本里，
 * import 不进来 ⇒ 没有任何东西能喂它输入」。新加的门不该再添一个。
 *
 * @param {{ bodyText: string, sumsText: string }} input
 * @returns {{ ok: boolean, problems: string[], rows: Array<{name: string, page: string|undefined, ci: string, same: boolean}>, bodyCount: number, ciCount: number }}
 */
export function judgeBodyVsCi({ bodyText, sumsText }) {
  const body = parseBodyChecksums(bodyText);
  const ci = parseSumsFile(sumsText);
  const problems = [];

  /* ★ 地板（两侧各一条）：数到 0 条就红 —— 见文件头「地板」那一节。 */
  if (ci.size === 0) {
    problems.push('CI 的 SHA256SUMS 里一条都没解析出来 —— 拒绝在空集上报绿');
  }
  if (body.size === 0) {
    problems.push('发布页正文里一条 sha256 都没解析出来 —— 拒绝在空集上报绿');
  }

  for (const [name, sum] of ci) {
    if (!HEX64.test(sum)) problems.push(`CI 那侧 ${name} 的 sha256 形状不对：${sum}`);
    if (!body.has(name)) {
      problems.push(`发布页正文里没有 ${name} 这一行（CI 有）`);
      continue;
    }
    if (body.get(name) !== sum) {
      problems.push(`不一致 ${name}\n    页面 : ${body.get(name)}\n    CI   : ${sum}`);
    }
  }
  /* 反方向：正文里印了一个 CI 没产出的文件名（改名、抄了上一版的那一行）。 */
  for (const name of body.keys()) {
    if (!ci.has(name)) problems.push(`发布页正文里多出一行 ${name}（CI 没有）`);
  }

  const rows = [...ci]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, sum]) => ({ name, page: body.get(name), ci: sum, same: body.get(name) === sum }));

  return { ok: problems.length === 0, problems, rows, bodyCount: body.size, ciCount: ci.size };
}

function main(argv) {
  const arg = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const bodyPath = arg('--body');
  const sumsPath = arg('--sums');
  if (!bodyPath || !sumsPath) {
    console.error(
      '用法: node scripts/ci/compare-body-vs-ci.mjs --body <正文文件> --sums <SHA256SUMS>',
    );
    return 2;
  }

  const verdict = judgeBodyVsCi({
    bodyText: readFileSync(bodyPath, 'utf8'),
    sumsText: readFileSync(sumsPath, 'utf8'),
  });

  console.log(
    `── 机器比对：发布页正文 ${verdict.bodyCount} 行 ⟷ CI SHA256SUMS ${verdict.ciCount} 行`,
  );
  for (const r of verdict.rows) {
    console.log(
      `   ${r.same ? '✔' : '✘'} ${r.name}  ${r.same ? r.ci : `页面=${r.page} CI=${r.ci}`}`,
    );
  }
  if (!verdict.ok) {
    console.error(`\n✘ 比对失败，${verdict.problems.length} 条：`);
    for (const p of verdict.problems) console.error(`   · ${p}`);
    return 1;
  }
  console.log(`\n✔ ${verdict.ciCount} 个资产的 sha256 在发布页正文与 CI SHA256SUMS 上逐字符一致。`);
  return 0;
}

// ⚠️ 入口守卫只许用 `isDirectRun()`（判据见 scripts/lib/entrypoint.mjs 文件头）：
// 手拼 `file://` / `resolve()` 比较这两种写法经软链调用时会让整个脚本静默空转。
if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
