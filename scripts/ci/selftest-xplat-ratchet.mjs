#!/usr/bin/env node
/**
 * 反向验证跨平台棘轮：`xplat-parse.mjs` + `xplat-ratchet.mjs`。
 *
 * ## 判据（本仓规矩）：抽掉修法，对应的断言必须重新红
 *
 * 最要紧的三条：
 *
 *   · **B2** —— 基线里有一条今天过了 ⇒ **必须红**。这一半是整条棘轮不烂掉的关键：
 *     只有"新伤要红"的棘轮，就是「把该修的写成边界」，它会安静地烂上几个月
 *     而且看起来一直在工作。
 *   · **C1–C3** —— 空转防线。**最危险的失败模式不是漏判一条，是整轮根本没跑**：
 *     那时今天的失败集合是空的，"新伤"不会响，而"基线陈了"会响 ——
 *     并且会说"去删掉 50 条"。那是一句离成因极远的错话，**比不响更坏**
 *     （它会指挥人去清空基线）。所以这三条要的不只是"红"，是**红对了理由**。
 *   · **A1/A2** —— 解析器对着两份**真 CI 日志**标定：数出来的叶子条数必须与
 *     TAP 自己报的 `# fail` 合计逐字相等。没有这条，整条棘轮建立在一个
 *     没人验过的解析器上 —— 而解析器少认几条不会红，只会让基线看起来变小。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTestLog } from './xplat-parse.mjs';
import { judge, BASELINE_PATH, MIN_PACKAGES, MIN_PASS, MIN_LINKS } from './xplat-ratchet.mjs';

let pass = 0;
let fail = 0;
const section = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (m) => (pass++, console.log(`  \x1b[32m✔\x1b[0m ${m}`));
const bad = (m, d) => (
  fail++,
  console.log(`  \x1b[31m✘\x1b[0m ${m}`),
  d && console.log(`      \x1b[31m${d}\x1b[0m`)
);
const is = (a, e, m) =>
  a === e ? ok(m) : bad(m, `实得 ${JSON.stringify(a)}，应为 ${JSON.stringify(e)}`);
const because = (arr, needle, m) =>
  arr.some((x) => String(x).includes(needle))
    ? ok(m)
    : bad(m, `没有一条提到 ${JSON.stringify(needle)}。实得：\n        ${arr.join('\n        ')}`);

const REPO = join(fileURLToPath(new URL('../..', import.meta.url)));
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

/* 健康的一轮，用来当所有反向用例的对照底座。 */
const HEALTHY = { packages: MIN_PACKAGES, pass: MIN_PASS, links: MIN_LINKS };

/* ═══════════════════════════════════════════════════════════════════════════════════
 * A 组 · 解析器标定（对着真 CI 日志，不是自己造的样本）
 * ═══════════════════════════════════════════════════════════════════════════════════ */
section('A 组 · TAP 解析器：对着真 CI 日志标定');

const FIXTURES = join(REPO, 'scripts', 'ci', 'fixtures', 'xplat');
{
  /*
   * 夹具是两份**真的** CI 日志片段（run 32656407764）。
   * 用真日志而不是自己写的样本，是因为要验的正是"能不能读懂 node --test 真实吐出来的东西"——
   * 自己造的样本只能证明"我造的和我解的是同一套假设"（这条理由抄自 selftest-pack-deps 的文件头）。
   */
  for (const [name, wantFail, wantPkgs] of [
    ['win32-x64.tap.txt', 42, 9],
    ['darwin-arm64.tap.txt', 5, 9],
  ]) {
    const p = join(FIXTURES, name);
    if (!existsSync(p)) {
      bad(`A0 夹具 ${name} 不存在 —— 没有它，解析器等于没被验过`);
      continue;
    }
    const r = parseTestLog(readFileSync(p, 'utf8'));
    is(
      r.failures.length,
      r.totalFail,
      `A1 ${name}：数出 ${r.failures.length} 条叶子失败，与 TAP 自报的 \`# fail\` 合计 ${r.totalFail} 逐字相等`,
    );
    is(
      r.failures.length,
      wantFail,
      `A1b ${name}：条数就是当时那 ${wantFail} 条（钉住，防解析器悄悄少认）`,
    );
    is(Object.keys(r.packages).length, wantPkgs, `A1c ${name}：${wantPkgs} 个包都报了统计`);
    is(
      new Set(r.failures).size,
      r.failures.length,
      `A1d ${name}：${r.failures.length} 个 id 互不相同（撞 id 会让基线少一条而不报错）`,
    );
  }
}
{
  /*
   * ★ 祖先链必须从 `# Subtest:` 建，不能从 `ok` 行建 —— TAP 里套件的 `ok` 打在
   *   它所有子节点**之后**，拿它当"入栈"会把上一个已经结束的兄弟当成父亲。
   *   第一版就是这么错的：`#77 finding① self-lock` 底下那条被记成了 `DB 与队列接入 › …`。
   */
  const p = join(FIXTURES, 'darwin-arm64.tap.txt');
  if (existsSync(p)) {
    const r = parseTestLog(readFileSync(p, 'utf8'));
    const selfLock = r.failures.find((f) => f.includes('stop() 必须在宽限期'));
    is(
      selfLock?.includes('self-lock'),
      true,
      'A2 ★ 祖先链取的是真父亲（self-lock），不是上一个结束的兄弟',
    );
    is(selfLock?.startsWith('apps/daemon › '), true, 'A2b id 以包名打头');
  }
}
{
  const empty = parseTestLog('');
  is(empty.failures.length, 0, 'A3 空输入 → 0 条失败（而 C 组会因为"没跑完"红，见下）');
  is(empty.totalPass, 0, 'A3b 空输入 → 0 条通过');
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * B 组 · 棘轮的两个方向
 * ═══════════════════════════════════════════════════════════════════════════════════ */
section('B 组 · 两个方向都要断');

const BASE = {
  platforms: {
    'p-test': {
      tests: [{ id: 'pkg › suite › case A', why: 'unexamined', since: '0.7.4', note: 'x' }],
      selftests: [
        { id: 'node scripts/ci/selftest-x.mjs', why: 'unexamined', since: '0.7.4', note: 'x' },
      ],
    },
  },
};
const today = (tests, selftests) => ({ tests, selftests, skipped: [] });

{
  const v = judge({
    platform: 'p-test',
    baseline: BASE,
    today: today(['pkg › suite › case A'], ['node scripts/ci/selftest-x.mjs']),
    health: HEALTHY,
  });
  is(v.ok, true, 'B0 正向：今天与基线逐条一致 ⇒ 绿（否则下面所有反向都不可信）');
}
{
  const v = judge({
    platform: 'p-test',
    baseline: BASE,
    today: today(
      ['pkg › suite › case A', 'pkg › suite › case NEW'],
      ['node scripts/ci/selftest-x.mjs'],
    ),
    health: HEALTHY,
  });
  is(v.ok, false, 'B1 ★反向①：冒出一条基线里没有的 ⇒ 红');
  is(v.newDamage.length, 1, 'B1b 只报那一条新伤，不连坐');
  because(
    v.newDamage.map((d) => d.id),
    'case NEW',
    'B1c 点名了是哪一条',
  );
  is(v.stale.length, 0, 'B1d 没有误报"基线陈了"');
}
{
  /* ★★ 这一条是整条棘轮不烂掉的关键。 */
  const v = judge({
    platform: 'p-test',
    baseline: BASE,
    today: today([], ['node scripts/ci/selftest-x.mjs']),
    health: HEALTHY,
  });
  is(v.ok, false, 'B2 ★★反向②：基线里有一条今天过了 ⇒ **也红**（有人修好了，必须划掉）');
  because(
    v.stale.map((d) => d.id),
    'case A',
    'B2b 点名了该划掉哪一条',
  );
  is(v.newDamage.length, 0, 'B2c 没有误报新伤');
}
{
  const v = judge({
    platform: 'p-test',
    baseline: BASE,
    today: today(['pkg › suite › case A'], []),
    health: HEALTHY,
  });
  is(v.ok, false, 'B3 ★反向②（自检那一半）：基线里的自检今天绿了 ⇒ 也红');
  because(
    v.stale.map((d) => d.id),
    'selftest-x',
    'B3b 点名了是哪个自检',
  );
}
{
  const v = judge({
    platform: 'p-nonexistent',
    baseline: BASE,
    today: today([], []),
    health: HEALTHY,
  });
  is(v.ok, false, 'B4 ★反向：基线里没有这个平台 ⇒ 红');
  because(v.fatal, '新加一格 runner', 'B4b 说清了该怎么办（给新 runner 补一份基线）');
}
{
  /* 跳过的那些既不算通过也不算失败 —— 它们根本不该进比对。 */
  const v = judge({
    platform: 'p-test',
    baseline: BASE,
    today: {
      tests: ['pkg › suite › case A'],
      selftests: ['node scripts/ci/selftest-x.mjs'],
      skipped: ['bash scripts/ci/selftest-buildbox.sh'],
    },
    health: HEALTHY,
  });
  is(v.ok, true, 'B5 按平台跳过的那些不进比对（跳过既不是通过也不是失败）');
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * C 组 · 空转防线 —— 要的不只是"红"，是**红对了理由**
 * ═══════════════════════════════════════════════════════════════════════════════════ */
section('C 组 · 空转防线：整轮没跑完时，不许红成"基线陈了"');

for (const [label, health, needle] of [
  ['C1 只有 3 个包报了统计（有包没跑）', { ...HEALTHY, packages: 3 }, '本轮没跑完'],
  ['C2 通过数只有 12（构建挂了之类）', { ...HEALTHY, pass: 12 }, '本轮没跑完'],
  ['C3 自检只跑了 4 环（链条被截断）', { ...HEALTHY, links: 4 }, '不比对'],
]) {
  /* 关键：喂的是**空的**今日集合 —— 正是"什么都没跑"的现场。 */
  const v = judge({ platform: 'p-test', baseline: BASE, today: today([], []), health });
  is(v.ok, false, `${label} ⇒ 红`);
  because(v.fatal, needle, `${label} ⇒ 红的理由是"没跑完"，不是"基线陈了"`);
  is(v.stale.length, 0, `${label} ⇒ **不许**同时报"基线陈了" —— 那会指挥人去清空基线，比不响更坏`);
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * D 组 · 真基线文件本身的形状
 * ═══════════════════════════════════════════════════════════════════════════════════ */
section('D 组 · 签入的基线文件');

{
  const plats = Object.keys(baseline.platforms ?? {});
  is(plats.length >= 3, true, `D1 基线覆盖 ${plats.length} 格 runner（矩阵有 3 格）`);

  const control = baseline.platforms['linux-x64 (control)'];
  is(
    (control?.tests?.length ?? -1) + (control?.selftests?.length ?? -1),
    0,
    'D2 ★ 对照组那一格基线**必须是空的** —— 它与 ci.yml 跑同一批检查，一旦冒出一条就是主线坏了',
  );

  const VALID = new Set(['host-assumption', 'real-bug', 'unexamined']);
  let entries = 0;
  const bads = [];
  for (const [p, e] of Object.entries(baseline.platforms)) {
    for (const row of [...(e.tests ?? []), ...(e.selftests ?? [])]) {
      entries++;
      if (!VALID.has(row.why)) bads.push(`${p}: ${row.id} 的 why=${JSON.stringify(row.why)}`);
      if (!row.since) bads.push(`${p}: ${row.id} 没有 since（失效版本）`);
      if (!row.note) bads.push(`${p}: ${row.id} 没有 note`);
    }
  }
  is(entries > 0, true, `D3 基线里有 ${entries} 条（空基线 = 这套东西什么都没在守）`);
  is(
    bads.length,
    0,
    `D4 每条都有合法的 why / since / note${bads.length ? `：\n      ${bads.join('\n      ')}` : ''}`,
  );

  const dupes = [];
  for (const [p, e] of Object.entries(baseline.platforms)) {
    for (const key of ['tests', 'selftests']) {
      const ids = (e[key] ?? []).map((r) => r.id);
      if (new Set(ids).size !== ids.length) dupes.push(`${p}.${key}`);
    }
  }
  is(dupes.length, 0, `D5 同一格里没有重复 id${dupes.length ? `（${dupes.join(', ')}）` : ''}`);
}

console.log('');
if (fail > 0) {
  console.error(`\x1b[31m✘ selftest-xplat-ratchet: ${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✔ selftest-xplat-ratchet: ${pass} 个用例全部通过\x1b[0m`);
