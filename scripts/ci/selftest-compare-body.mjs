#!/usr/bin/env node
/**
 * `compare-body-vs-ci.mjs` 的反向验证 —— **「抄错一位，它真的会红吗？」**
 *
 * ## 为什么这份自检必须存在
 *
 * 这道门守的是发布链上**唯一一环靠人手抄的东西**（发布页正文里那三行 sha256）。
 * 一道守着"人手抄"的门，自己一旦空转，失效的样子和"每次都对得上"一模一样 ——
 * 而它一年只被真正执行几次（每次发版一次），**不会有人从现象上察觉**。
 *
 * 所以判据不是"跑一遍没报错"，是**逐条把它该抓的东西真的做出来，看它红不红**。
 *
 * ## A 组：5 条反向用例（每一条都是一次真的抄错）
 *
 * | # | 变异 | 现实里怎么发生 |
 * |---|---|---|
 * | A1 | 改一位十六进制 | 复制粘贴时少选/多选一个字符；手敲 |
 * | A2 | 正文整个是空的 | 正文还没写就跑了这道门；或者取正文那一步拿回了空串 |
 * | A3 | 删掉一行 | 三个平台只抄了两个（0.7.x 之前真发生过：漏 win-x64） |
 * | A4 | 两个文件名对调 | 表格与围栏分两次抄，其中一次顺序不同 |
 * | A5 | CI 那侧的 SHA256SUMS 是空文件 | artifact 取错/取空 ⇒ **这道门自己在空集上空转** |
 *
 * ⚠️ A5 与另外四条不同类：前四条是"发布页错了"，A5 是"**判据自己瞎了**"。
 * 一个把空集判成"全部一致"的比对器，正是本仓最贵的那一类失败。
 *
 * ## B 组：地板的消融（判据的判据）—— 并且**如实记下它承重的范围有多窄**
 *
 * 把 `judgeBodyVsCi` 里那两条空集断言抽掉，再逐格量一遍。实测结论：
 *
 * | 形状 | 退化版（无地板） | 谁抓到的 |
 * |---|---|---|
 * | **两侧都是 0 行** | **绿** | **只有地板**（这是 `∀x∈∅` 那个假绿） |
 * | CI 侧 0 行、正文 3 行 | 红 | 反方向那条「正文里多出一行」 |
 * | 正文 0 行、CI 侧 3 行 | 红 | 正方向那条「正文里没有这一行」 |
 * | 改一位 / 少一行 / 对调 | 红 | 逐格比对本身 |
 *
 * ⚠️ **别把 A2 / A5 的功劳记到地板头上。** 地板唯一独自承重的那一格是
 * **「两侧同时数到 0」** —— 也就是比对器自己瞎了的那一格（围栏解析器坏了、
 * SHA256SUMS 取回来是空文件、tag 取错）。那一格没有别的东西接得住，
 * 而它失效的样子正好是"全部一致"。B 组把这个范围逐格量出来，
 * 免得下一个人读了注释以为地板管得更宽、然后把它删掉。
 *
 * ## 夹具是**真的**
 *
 * 下面这三个文件名与三串 sha256 逐字取自 v0.7.6 的 `SHA256SUMS`
 * （`build-bundles` run `34038709845`，commit `4401e1f3`）。用真数据的理由：
 * 一份编出来的夹具证明不了解析器认得真实发布页的形状（围栏、CRLF、
 * 围栏外那些顺手提到的十六进制串）。
 */
import { judgeBodyVsCi, parseBodyChecksums, parseSumsFile } from './compare-body-vs-ci.mjs';

let failed = 0;
const is = (name, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(
    `  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`,
  );
};
/** 判红之外还要判**红得对不对** —— 一条指错方向的红会把下一个人送去修没坏的东西。 */
const saysSomethingAbout = (name, problems, needle) =>
  is(
    name,
    problems.some((p) => p.includes(needle)),
    true,
  );

const DARWIN = 'openmemo-0.7.6-darwin-arm64.tar.gz';
const LINUX = 'openmemo-0.7.6-linux-x64.tar.xz';
const WIN = 'openmemo-0.7.6-win-x64.zip';
const SHA = {
  [DARWIN]: 'cb87da4adb4e9dbc4ff4c403b54cfbacc6d8bfc294a54a1c67f2f9011dc8e5e7',
  [LINUX]: 'fe4b587060d072197f04114ccb271272c48f115720eb3ccb20d7d637c18f0f1a',
  [WIN]: '9ddac3a6f184d1e46b444a555325444e1afc124e78c4ddacce20cc841d00216e',
};

/** CI 那侧的 `SHA256SUMS`（`sha256sum` 的输出格式，两个空格）。 */
const SUMS = `${SHA[DARWIN]}  ${DARWIN}\n${SHA[LINUX]}  ${LINUX}\n${SHA[WIN]}  ${WIN}\n`;

/**
 * 发布页正文的形状：一张下载表 + 一段散文 + 一个 ``` 围栏。
 *
 * ⚠️ 这里**故意**在围栏外留了一串十六进制（那句"发布的这个 commit"）和一张
 * 提到同样三个文件名的表 —— 它们都**不该**被当成校验和声明。
 * 用 `\r\n` 是因为 GitHub 的 API 就是这么发正文的。
 */
const bodyWith = (lines) =>
  [
    '**本地部署的音视频笔记工具。**',
    '',
    '| 系统 | 文件 |',
    '| --- | --- |',
    `| Linux x64 | \`${LINUX}\` |`,
    `| Windows x64 | \`${WIN}\` |`,
    `| macOS arm64 | \`${DARWIN}\` |`,
    '',
    '本批产物出自 commit `4401e1f3885e1e2d597e91ec718c580094ff0fb2`。',
    '',
    '## 校验和',
    '',
    '```',
    ...lines,
    '```',
    '',
    '上传后 CI **不带任何凭证、从上面这些公开地址重新下载了一遍**，逐字符复核过 sha256。',
  ].join('\r\n');

const GOOD_LINES = [`${SHA[DARWIN]}  ${DARWIN}`, `${SHA[LINUX]}  ${LINUX}`, `${SHA[WIN]}  ${WIN}`];

console.log('\n阴性对照：一份**没有动过**的正文 —— 它必须是绿的');
{
  const v = judgeBodyVsCi({ bodyText: bodyWith(GOOD_LINES), sumsText: SUMS });
  is('阴性对照 ⇒ 绿', v.ok, true);
  is('阴性对照：正文那侧解析出 3 行', v.bodyCount, 3);
  is('阴性对照：CI 那侧解析出 3 行', v.ciCount, 3);
  // 围栏外那串 commit sha 与表格里的文件名**没有**被算成校验和声明。
  is(
    '围栏外的十六进制不算数（否则会造出一堆假红）',
    parseBodyChecksums(bodyWith(GOOD_LINES)).size,
    3,
  );
}

console.log('\nA 组：5 条反向用例 —— 每一条都必须红，而且要红得指对地方');

// ── A1 改一位十六进制 ────────────────────────────────────────────────────────
{
  const bad = SHA[LINUX].slice(0, -1) + 'b'; // …f1a → …f1b
  const v = judgeBodyVsCi({
    bodyText: bodyWith([GOOD_LINES[0], `${bad}  ${LINUX}`, GOOD_LINES[2]]),
    sumsText: SUMS,
  });
  is('A1 ★ 改一位 ⇒ 红', v.ok, false);
  saysSomethingAbout('A1 报错指着 linux 那一行', v.problems, LINUX);
  saysSomethingAbout('A1 报错里同时印出页面值与 CI 值', v.problems, '页面 :');
  is('A1 另外两行仍判为一致（红得**只**红该红的那一行）', v.rows.filter((r) => r.same).length, 2);
}

// ── A2 正文整个是空的 ───────────────────────────────────────────────────────
{
  const v = judgeBodyVsCi({ bodyText: '', sumsText: SUMS });
  is('A2 ★ 空正文 ⇒ 红', v.ok, false);
  saysSomethingAbout(
    'A2 报错说的是「正文里一条都没解析出来」',
    v.problems,
    '发布页正文里一条 sha256 都没解析出来',
  );
}

// ── A3 删掉一行（三个平台只抄了两个）─────────────────────────────────────────
{
  const v = judgeBodyVsCi({
    bodyText: bodyWith([GOOD_LINES[0], GOOD_LINES[1]]), // 少了 win-x64
    sumsText: SUMS,
  });
  is('A3 ★ 少抄一行 ⇒ 红', v.ok, false);
  saysSomethingAbout('A3 报错点名少的是 win-x64', v.problems, `发布页正文里没有 ${WIN} 这一行`);
}

// ── A4 两个文件名对调 ───────────────────────────────────────────────────────
{
  const v = judgeBodyVsCi({
    bodyText: bodyWith([
      GOOD_LINES[0],
      `${SHA[LINUX]}  ${WIN}`, // linux 的 sha 挂到了 win 的名字上
      `${SHA[WIN]}  ${LINUX}`,
    ]),
    sumsText: SUMS,
  });
  is('A4 ★ 文件名对调 ⇒ 红', v.ok, false);
  saysSomethingAbout('A4 报错点名 linux 那一格不一致', v.problems, `不一致 ${LINUX}`);
  saysSomethingAbout('A4 报错点名 win 那一格不一致', v.problems, `不一致 ${WIN}`);
  // ⚠️ 对调之后**两侧的行数与文件名集合完全相同** —— 只数条数的判据会放它过去。
  is('A4 两侧条数相同（所以"数条数"抓不到它）', v.bodyCount === v.ciCount, true);
}

// ── A5 CI 那侧是空文件 ⇒ 判据自己瞎了 ────────────────────────────────────────
{
  const v = judgeBodyVsCi({ bodyText: bodyWith(GOOD_LINES), sumsText: '' });
  is('A5 ★ CI 侧 SHA256SUMS 为空 ⇒ 红（不许在空集上报绿）', v.ok, false);
  saysSomethingAbout(
    'A5 报错说的是「CI 的 SHA256SUMS 里一条都没解析出来」',
    v.problems,
    'CI 的 SHA256SUMS 里一条都没解析出来',
  );
  is('A5 CI 那侧确实解析出 0 行', v.ciCount, 0);
}

console.log('\nB 组：地板的消融 —— 逐格量出「地板到底独自承住了哪一格」');

/**
 * 退化版：逐格比对照做，**只是把两条空集地板去掉**。
 * 它是 `judgeBodyVsCi` 在"没有地板"那一版下的样子。
 */
const ablated = (bodyText, sumsText) => {
  const body = parseBodyChecksums(bodyText);
  const ci = parseSumsFile(sumsText);
  const problems = [];
  for (const [name, sum] of ci) {
    if (!body.has(name)) problems.push(`缺 ${name}`);
    else if (body.get(name) !== sum) problems.push(`不一致 ${name}`);
  }
  for (const name of body.keys()) if (!ci.has(name)) problems.push(`多 ${name}`);
  return problems.length === 0;
};

// ── B1 ★★ 两侧同时数到 0：**地板唯一独自承重的那一格** ──────────────────────
//     这正是比对器自己瞎掉的形状（围栏解析器坏了 + SHA256SUMS 取回来是空的）。
//     退化版对它报绿，而"绿"与"三个资产全部一致"在输出上一模一样。
is('B1 ★★ 退化版在「两侧都是 0 行」上报绿（= 地板独自承住这一格）', ablated('', ''), true);
is('B1  完整版在同一份输入上仍然红', judgeBodyVsCi({ bodyText: '', sumsText: '' }).ok, false);

// ── B2 / B3 ⚠️ 如实记下：A5 与 A2 **不是**靠地板抓到的 ───────────────────────
{
  const ciEmpty = judgeBodyVsCi({ bodyText: bodyWith(GOOD_LINES), sumsText: '' });
  is(
    'B2 退化版在「CI 侧空、正文 3 行」上**也红**（不是地板的功劳）',
    ablated(bodyWith(GOOD_LINES), ''),
    false,
  );
  saysSomethingAbout(
    'B2 真正接住它的是反方向那条「正文里多出一行」',
    ciEmpty.problems,
    '发布页正文里多出一行',
  );

  const bodyEmpty = judgeBodyVsCi({ bodyText: '', sumsText: SUMS });
  is('B3 退化版在「正文空、CI 侧 3 行」上**也红**（不是地板的功劳）', ablated('', SUMS), false);
  saysSomethingAbout(
    'B3 真正接住它的是正方向那条「正文里没有这一行」',
    bodyEmpty.problems,
    '这一行（CI 有）',
  );
}

// ── B4 反过来：地板也不该把逐格比对的功劳抢走 ────────────────────────────────
is(
  'B4 退化版在 A1（改一位）上仍然红（说明 A1 不是靠地板抓到的）',
  ablated(bodyWith([GOOD_LINES[0], `${SHA[LINUX].slice(0, -1)}b  ${LINUX}`, GOOD_LINES[2]]), SUMS),
  false,
);

console.log('\nC 组：解析器的形状 —— 只在"少查一条"那一侧近似');
{
  // 大写十六进制 / 单空格：是排版差异，不是哈希错了。判红会把人送去查没坏的东西。
  const v = judgeBodyVsCi({
    bodyText: bodyWith([`${SHA[DARWIN].toUpperCase()} ${DARWIN}`, GOOD_LINES[1], GOOD_LINES[2]]),
    sumsText: SUMS,
  });
  is('C1 大写 + 单空格 ⇒ 仍判一致', v.ok, true);
  // 63 位（少一个字符）不是"排版"，是真的抄错了 —— 它连行都不该被解析出来，
  // 于是走「正文里没有这一行」那条红。
  const short = judgeBodyVsCi({
    bodyText: bodyWith([`${SHA[DARWIN].slice(0, 63)}  ${DARWIN}`, GOOD_LINES[1], GOOD_LINES[2]]),
    sumsText: SUMS,
  });
  is('C2 ★ 少一个字符（63 位）⇒ 红', short.ok, false);
  saysSomethingAbout(
    'C2 报错点名 darwin 那一行',
    short.problems,
    `发布页正文里没有 ${DARWIN} 这一行`,
  );
  // 正文里印了一个 CI 没产出的文件名（抄了上一版那一行）。
  const stale = judgeBodyVsCi({
    bodyText: bodyWith([...GOOD_LINES, `${SHA[WIN]}  openmemo-0.7.5-win-x64.zip`]),
    sumsText: SUMS,
  });
  is('C3 ★ 正文里多出一行上一版的文件 ⇒ 红', stale.ok, false);
  saysSomethingAbout('C3 报错说「正文里多出一行」', stale.problems, '发布页正文里多出一行');
}

console.log(
  failed === 0
    ? `\n\x1b[32m✔ selftest-compare-body: 全部通过\x1b[0m`
    : `\n\x1b[31m✘ selftest-compare-body: ${failed} 条失败\x1b[0m`,
);
process.exit(failed > 0 ? 1 : 0);
