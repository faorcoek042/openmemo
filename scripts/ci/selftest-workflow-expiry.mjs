#!/usr/bin/env node
/**
 * 反向验证 `check-workflow-expiry.mjs` 与 `run-selftests-all.mjs`。
 *
 * 这两个脚本是同一个修法的两半，所以自检合在一个文件里：
 *   · A 组 —— 「只能手动跑的 workflow 必须登记，挂起的必须有截止版本」这道门；
 *   · B 组 —— 「链条跑到底，不在第一处红停下」那个跑法。
 *
 * ## 判据（本仓规矩）：**抽掉修法，对应的断言必须重新红**
 *
 * A 组最要紧的一条是 **A9**：把时钟拨回 v0.7.2、把登记恢复成 `proxy-coverage`
 * 原来那条判据 —— 这道门**当场红**。也就是说，如果 2026-08-13 发 0.7.2 那天
 * 这个文件已经存在，那三次发版**不可能**都没看见它。
 * 一条守卫值不值得要，看的就是它对**已经发生过的那次事故**红不红。
 *
 * B 组最要紧的一条是 **B5**：拿一条**故意在中间红**的假链去跑，
 * 断言后面的环**仍然被执行过**。短路版在这一条上必然红 —— 那正是它们的区别。
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { audit, isDark, versionAtLeast, DARK_WORKFLOWS } from './check-workflow-expiry.mjs';
import { splitChain, parseLink, runAll } from './run-selftests-all.mjs';

let pass = 0;
let fail = 0;
const section = (s) => console.log(`\n${s}`);
function ok(msg) {
  pass++;
  console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
}
function bad(msg, detail) {
  fail++;
  console.log(`  \x1b[31m✘\x1b[0m ${msg}`);
  if (detail) console.log(`      \x1b[31m${detail}\x1b[0m`);
}
function is(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else bad(msg, `实得 ${JSON.stringify(actual)}，应为 ${JSON.stringify(expected)}`);
}
/** 断言 problems 里**至少有一条**提到 `needle`。判"红了没"要连"为什么红"一起判。 */
function redBecause(problems, needle, msg) {
  const hit = problems.some((p) => p.includes(needle));
  if (hit) ok(msg);
  else
    bad(
      msg,
      `没有任何一条 problem 提到 ${JSON.stringify(needle)}。实得 ${problems.length} 条：\n` +
        problems.map((p) => `        ${p.split('\n')[0]}`).join('\n'),
    );
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * A 组 · 「暗着的 workflow」登记册
 * ═══════════════════════════════════════════════════════════════════════════════════ */

section('\x1b[1mA 组 · 只能手动触发的 workflow 必须登记，挂起的必须有截止版本\x1b[0m');

/* A0 正向：今天的真登记 + 今天的真版本，必须是绿的（否则下面所有反向都不可信）。 */
{
  const { problems, dark } = await audit({ version: '0.7.4' });
  is(problems.length, 0, `A0 正向：v0.7.4 下真实登记册无问题（扫到 ${dark.length} 条暗 workflow）`);
  is(
    dark.length > 0,
    true,
    `A0b 前提自检：真的扫到了暗 workflow（${dark.length} 条）—— 不是空集判绿`,
  );
}

/* A1 少登记一条 ⇒ 红，且点名是哪个文件。 */
{
  const short = DARK_WORKFLOWS.filter((e) => e.file !== 'release-upload.yml');
  const { problems } = await audit({ version: '0.7.4', registry: short });
  redBecause(problems, 'release-upload.yml', 'A1 ★反向：漏登记一条暗 workflow ⇒ 红，并点名它');
  redBecause(problems, 'DARK_WORKFLOWS', 'A1b 红的那句话说了该怎么办（去登记册里二选一）');
}

/* A2 登记了一条其实已经有自动触发器的 ⇒ 红（过期条目不许留成通行证）。 */
{
  const stale = [
    ...DARK_WORKFLOWS,
    { file: 'ci.yml', kind: 'deliberate', evidence: 'ci.yml:1', why: '假的' },
  ];
  const { problems } = await audit({ version: '0.7.4', registry: stale });
  redBecause(problems, '已经有自动触发器了', 'A2 ★反向：登记了一条已经自动触发的 ⇒ 红');
}

/* A3 登记了一个不存在的文件 ⇒ 红。 */
{
  const ghost = [
    ...DARK_WORKFLOWS,
    { file: 'nope.yml', kind: 'deliberate', evidence: 'nope.yml:1', why: '假的' },
  ];
  const { problems } = await audit({ version: '0.7.4', registry: ghost });
  redBecause(problems, 'nope.yml 不存在了', 'A3 ★反向：登记了一个不存在的 workflow ⇒ 红');
}

/* A4/A5 形状：deliberate 缺 evidence、pending 缺 expiresAt / forks ⇒ 各红一次。 */
{
  const noEvidence = DARK_WORKFLOWS.map((e) =>
    e.file === 'release-upload.yml' ? { ...e, evidence: undefined } : e,
  );
  const { problems } = await audit({ version: '0.7.4', registry: noEvidence });
  redBecause(
    problems,
    "kind:'deliberate' 必须给 evidence",
    'A4 ★反向：刻意手动却没指出理由写在哪 ⇒ 红',
  );
}
{
  const noExpiry = DARK_WORKFLOWS.map((e) =>
    e.file === 'ffmpeg-lgpl-verify.yml' ? { ...e, expiresAt: undefined } : e,
  );
  const { problems } = await audit({ version: '0.7.4', registry: noExpiry });
  redBecause(problems, '没有截止线的"挂起"就是永久停车位', 'A5 ★反向：挂起项没有截止版本 ⇒ 红');
}
{
  const noForks = DARK_WORKFLOWS.map((e) =>
    e.file === 'ffmpeg-lgpl-verify.yml' ? { ...e, forks: undefined } : e,
  );
  const { problems } = await audit({ version: '0.7.4', registry: noForks });
  redBecause(problems, '必须给 forks', 'A5b ★反向：挂起项说不出两条出路 ⇒ 红');
}

/* A6 版本比较：按数字比，不按字符串比。0.7.10 > 0.7.9，两种错法都会判反。 */
section('  ── 版本比较（字符串比和 parseFloat 都会判反）');
is(versionAtLeast('0.7.4', '0.7.4'), true, 'A6 到期当天算过期（≥ 是含等号的）');
is(versionAtLeast('0.7.3', '0.7.4'), false, 'A6b 还没到就不算');
is(versionAtLeast('0.7.10', '0.7.9'), true, 'A6c ★ 0.7.10 > 0.7.9（字符串比会判反）');
is(versionAtLeast('0.8.0', '0.7.99'), true, 'A6d ★ 0.8.0 > 0.7.99（次版本号优先）');
is(versionAtLeast('0.7.99', '0.8.0'), false, 'A6e ★ 0.7.99 < 0.8.0');

/* A7 isDark：三种自动触发器各自都能让它不再是暗的；只有 workflow_dispatch 才算暗。 */
section('  ── isDark：三种自动触发器一个都不许漏');
is(isDark({ on: { workflow_dispatch: null } }), true, 'A7 只有 workflow_dispatch ⇒ 暗');
is(
  isDark({ on: { workflow_dispatch: null, push: { branches: ['master'] } } }),
  false,
  'A7b push ⇒ 不暗',
);
is(
  isDark({ on: { workflow_dispatch: null, pull_request: null } }),
  false,
  'A7c pull_request ⇒ 不暗',
);
is(
  isDark({ on: { workflow_dispatch: null, schedule: [{ cron: '0 0 * * *' }] } }),
  false,
  'A7d ★ schedule ⇒ 不暗（这一条就是本轮给 ci-crossplatform 补的东西）',
);

/*
 * A8/A9 · ★ 过期判定 —— **跑在 /tmp 的夹具上，不依赖今天登记册里恰好有哪几条**。
 *
 * 上一版拿 `proxy-coverage.yml` 当样本。它当天就被兑现了（绿了 → 挂 cron →
 * 不再是暗的 → 登记删除），于是那几条断言跟着坏。
 * **一条会被"把事情做对"弄坏的自检，等于在惩罚做对。** 改成夹具。
 */
section('  ── ★ 过期判定（夹具，不依赖真登记册）');
{
  const wf = mkdtempSync(join(tmpdir(), 'om-wfexp-'));
  try {
    writeFileSync(
      join(wf, 'dark-thing.yml'),
      'name: dark-thing\non:\n  workflow_dispatch:\njobs:\n  a:\n    runs-on: x\n',
    );
    const reg = [
      {
        file: 'dark-thing.yml',
        kind: 'pending',
        expiresAt: '0.7.6',
        evidence: 'dark-thing.yml:1',
        why: '夹具：一条自己写了「停在这里不算终态」的承诺。',
        forks: '① 给它一个自动触发器；② 删掉并归档。',
      },
    ];
    const at = (v) => audit({ version: v, registry: reg, wfDir: wf });

    const { problems: p076 } = await at('0.7.6');
    redBecause(p076, '过期判据已经触发', 'A8 ★ 产品到截止版本 v0.7.6 ⇒ 红');
    redBecause(p076, '两条出路', 'A8b 红的那句话端出了两条出路，不只是说"过期了"');
    redBecause(p076, '别靠改大 expiresAt 让它闭嘴', 'A8c 堵住了"顺延一下"这条最省事的假出路');

    const { problems: p075 } = await at('0.7.5');
    is(p075.length, 0, 'A8d 阴性对照：v0.7.5 还没到期 ⇒ 绿（这道门不是焊死在红上的）');

    const { problems: p080 } = await at('0.8.0');
    redBecause(p080, '过期判据已经触发', 'A8e 越过截止线之后一直红，不是只在等于那一版时红');

    /*
     * ★★ A9 —— 这一条是这整个文件存在的理由：**重演已经发生过的那次事故**。
     *
     * 真实历史：`proxy-coverage.yml` 的过期判据（截止 v0.7.2）写在 YAML 注释里，
     * 没有任何守卫会读，于是 0.7.2 / 0.7.3 / 0.7.4 三次发版一次都没看见它，
     * 红旗挂了 13 天。下面把那条登记原样重建在夹具里，逐个版本问一遍。
     */
    const historic = [{ ...reg[0], file: 'dark-thing.yml', expiresAt: '0.7.2' }];
    const askAt = (v) => audit({ version: v, registry: historic, wfDir: wf });
    is(
      (await askAt('0.7.1')).problems.length,
      0,
      'A9a v0.7.1（判据写下时）⇒ 绿 —— 所以下面的红是到期，不是恒红',
    );
    for (const v of ['0.7.2', '0.7.3', '0.7.4']) {
      const { problems } = await askAt(v);
      redBecause(
        problems,
        '过期判据已经触发',
        `A9 ★★ v${v} 发版时这道门会红 —— 真实历史里这一版**没有**任何东西红`,
      );
    }
  } finally {
    rmSync(wf, { recursive: true, force: true });
  }
}

/* A10 空转防线：workflow 目录是空的 ⇒ 必须红，不许"没东西可查"报绿。 */
{
  const empty = mkdtempSync(join(tmpdir(), 'om-wfempty-'));
  try {
    const { problems } = await audit({ version: '0.7.4', registry: [], wfDir: empty });
    redBecause(problems, '没东西可查', 'A10 ★反向：一个 workflow 都没有 ⇒ 红（空集不许判绿）');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * B 组 · 链条跑到底，不在第一处红停下
 * ═══════════════════════════════════════════════════════════════════════════════════ */

section('\x1b[1mB 组 · run-selftests-all：链条跑到底，不在第一处红停下\x1b[0m');

/* B1 切分：真链切出来的环数与"数 && 的个数 + 1"一致，且每一环都认得出形状。 */
{
  const { readFileSync } = await import('node:fs');
  /*
   * ⚠️ 必须 `fileURLToPath()`，**不许**用 `new URL(...).pathname`。
   *
   * 这一行原来写的就是 `.pathname`，而它在 Windows 上给出 `/D:/a/…`，
   * 拼出来变成 `D:\D:\a\…\package.json` → ENOENT。
   * `[实测 run 32655289213]` —— 而抓到它的正是本 PR 给 `ci-crossplatform`
   * 补的那两件事（cron + 不截断）：这条自检排在 37 环里的第 36 环，
   * 短路版**根本走不到它**。D-11 §3.2 第 1 条早就写过这个坑
   * （「手拼 file:// → 三个平台全部 false」），而知道它存在并不能阻止我再犯一次；
   * 每轮真的跑一遍才能。
   */
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  );
  const chain = String(pkg.scripts['test:ci-scripts']);
  const links = splitChain(chain);
  is(links.length, chain.split('&&').length, 'B1 真链切出来的环数 = && 个数 + 1（没有空环被吞）');
  is(links.length >= 25, true, `B1b 真链有 ${links.length} 环（≥ 25，空转防线的下界）`);
  is(
    links.every((l) => parseLink(l) !== null),
    true,
    'B1c 真链每一环都认得出形状（认不出来就跑不到，那才是最坏的）',
  );
}

/* B2 parseLink：两种真实形状 + 带参数 + 认不出来时返回 null（不是瞎猜）。 */
is(parseLink('node scripts/x.mjs')?.bin, 'node', 'B2 认得 `node X`');
is(parseLink('bash scripts/x.sh')?.bin, 'bash', 'B2b 认得 `bash X`');
is(
  JSON.stringify(parseLink('node scripts/x.mjs --after')?.args),
  '["--after"]',
  'B2c 参数带得过去（链尾那条 `--after` 靠它）',
);
is(parseLink('pnpm run x'), null, 'B2d ★ 认不出来就返回 null —— 不许瞎猜一个跑法');

/* B3/B4 空转防线：环数不够、或有环认不出来 ⇒ fatal，一环都不跑。 */
{
  const r = await runAll({ chain: 'node a.mjs && node b.mjs', cwd: tmpdir(), quiet: true });
  is(r.ok, false, 'B3 ★反向：链条被截短到 2 环 ⇒ 红');
  is(r.results.length, 0, 'B3b 截短时一环都不跑（不许"跑了两条然后报绿"）');
  is(/只解析出 2 环/.test(r.fatal ?? ''), true, 'B3c 红的那句话说了实得几环');
}
{
  const chain = Array.from({ length: 30 }, (_, i) => `node a${i}.mjs`).join(' && ') + ' && pnpm x';
  const r = await runAll({ chain, cwd: tmpdir(), quiet: true });
  is(r.ok, false, 'B4 ★反向：有一环认不出形状 ⇒ 红');
  is(/pnpm x/.test(r.fatal ?? ''), true, 'B4b 红的那句话点名了是哪一环');
}

/*
 * ★★ B5 —— 这一条就是"不短路"本身。
 *
 * 造一条 30 环的假链，**第 3 环故意 exit 1**，每一环都往磁盘上留一个脚印。
 * 跑完之后数脚印：必须是 30 个。短路版在这里只会留 3 个 —— 那正是
 * `[实测]` macOS 上「短路版只报 1 条红、跑到底之后是 5 条」的成因。
 */
{
  const work = mkdtempSync(join(tmpdir(), 'om-runall-'));
  try {
    mkdirSync(join(work, 'marks'));
    const N = 30;
    const FAIL_AT = 2; // 0-based ⇒ 第 3 环
    for (let i = 0; i < N; i++) {
      writeFileSync(
        join(work, `a${i}.mjs`),
        `import {writeFileSync} from 'node:fs';\n` +
          `writeFileSync(${JSON.stringify(join(work, 'marks', String(i)))}, '1');\n` +
          `process.exit(${i === FAIL_AT ? 1 : 0});\n`,
      );
    }
    const chain = Array.from({ length: N }, (_, i) => `node a${i}.mjs`).join(' && ');
    const r = await runAll({ chain, cwd: work, quiet: true });

    const ran = Array.from({ length: N }, (_, i) => existsSync(join(work, 'marks', String(i))));
    const ranCount = ran.filter(Boolean).length;
    is(
      ranCount,
      N,
      `B5 ★★ 第 3 环红了，后面 ${N - FAIL_AT - 1} 环**仍然被执行**（实得跑了 ${ranCount}/${N} 环）`,
    );
    is(r.ok, false, 'B5b 有一环红 ⇒ 整体仍然是红的（不短路 ≠ 不判红）');
    is(r.results.filter((x) => !x.ok).length, 1, 'B5c 汇总里正好一条红，且不多报');
    is(r.results[FAIL_AT].ok, false, 'B5d 红的是第 3 环那一条，没有指错人');
    is(r.results.length, N, 'B5e 汇总里有全部 30 环的结论 —— "跑过并通过"和"没跑"在输出里分得开');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* B6 一环起不来（文件不存在）也算红，且照样往下跑 —— 不是抛异常整条链断掉。 */
{
  const work = mkdtempSync(join(tmpdir(), 'om-runall2-'));
  try {
    const N = 26;
    for (let i = 1; i < N; i++) writeFileSync(join(work, `a${i}.mjs`), 'process.exit(0);\n');
    // a0.mjs 故意不创建
    const chain = Array.from({ length: N }, (_, i) => `node a${i}.mjs`).join(' && ');
    const r = await runAll({ chain, cwd: work, quiet: true });
    is(r.ok, false, 'B6 ★反向：第一环的脚本根本不存在 ⇒ 红');
    is(r.results.length, N, 'B6b 且后面 25 环照样跑完了（起不来不许把整条链带走）');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════ */

console.log('');
if (fail > 0) {
  console.error(`\x1b[31m✘ selftest-workflow-expiry: ${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✔ selftest-workflow-expiry: ${pass} 个用例全部通过\x1b[0m`);
