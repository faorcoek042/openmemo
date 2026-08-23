#!/usr/bin/env node
/**
 * 跨平台探针的**两头都断的基线棘轮** —— 让那面红旗重新有意义。
 *
 * ## 为什么需要它（这不是洁癖，是保护唯一的告警通道）
 *
 * 上一轮给 `ci-crossplatform.yml` 补了 cron，理由是它 `workflow_dispatch:` only
 * 时红着挂了 12 天没人知道。但补完 cron 之后立刻出现第二个问题：
 * **它今天在 macOS / Windows 上就是红的，于是它会每天红一次。**
 *
 * 而用户的 GitHub 邮件通知，是六条 e2e 腿当初设计告警时**唯一的承重点**。
 * 一个天天红的 workflow 会把人训练成略过 Actions 邮件 —— 那会**连带废掉六条腿的告警**。
 * 到那时我们不是回到"没人跑"，而是回到"**没人看**"，正是这一整轮要治的病。
 *
 * 本仓自己写过判据：**「一条永远红的守卫等于一条被删掉的守卫，而且会训练人忽略红灯。」**
 *
 * ## 判据：两个方向，缺一不可
 *
 *   ① 今天的失败集合里出现**基线里没有的**            ⇒ 红（有新伤）
 *   ② 基线里有一条**今天居然过了**（或整个消失了）    ⇒ **也红**（基线陈了，必须收紧）
 *
 * **② 那一半是这条棘轮不烂掉的全部关键。** 只有 ① 的棘轮就是「把该修的写成边界」——
 * 它会安静地烂上几个月，而且看起来一直在工作。有了 ②，**基线只能变小，不能停在原地**：
 * 谁顺手修好了一条，当天就会被这道门逼着把它从基线里划掉。
 *
 * ## ⚠️ 三道空转防线（没有它们，这条棘轮会在"什么都没跑"时报绿）
 *
 * 最危险的失败模式不是"漏判一条"，是**整轮根本没跑**：install 挂了、build 挂了、
 * 日志被截断……这时今天的失败集合是**空的**，① 不会响，而 ② 会响 ——
 * 但它会说"基线陈了，去删 50 条"，那是**离成因极远的一句错话**，
 * 比不响更坏（它会指挥人去清空基线）。所以在比对之前先问三件事：
 *
 *   · 测试日志里有没有 ≥ `MIN_PACKAGES` 个包报出过 `# pass`；
 *   · 通过数有没有到 `MIN_PASS`；
 *   · 自检 JSON 里的环数够不够 `MIN_LINKS`。
 *
 * 任何一条不满足 ⇒ 红，且说的是**"本轮没跑完，别拿它跟基线比"**。
 *
 * ## ⚠️ 基线只能手改
 *
 * 没有任何"运行时自动收录"的路径，**这是刻意的**。加一条必须改
 * `xplat-known-failures.json` ⇒ 出现在 diff 里 ⇒ 有人看得见、要写归因和失效版本。
 * 一个能自己往基线里加东西的棍轮，第二天就会把所有新伤都吸收掉。
 *
 * ## 用法
 *
 *   node scripts/ci/xplat-ratchet.mjs \
 *     --platform win32-x64 --test-log <path> --selftest-json <path>
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../lib/version.mjs';
import { parseTestLog } from './xplat-parse.mjs';

export const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'ci', 'xplat-known-failures.json');

/** 工作区里有测试的包数（`check-test-scripts.mjs` 数出来是 9）。少于它 = 有包没跑。 */
export const MIN_PACKAGES = 9;
/** 通过数下界。`[实测]` 三平台都在 2290–2340 之间；取 2000 只防塌方，不防增删。 */
export const MIN_PASS = 2000;
/** `test:ci-scripts` 的环数。与 `run-selftests-all.mjs` 的 `MIN_LINKS` 是两回事：那条防切短，这条防少跑。 */
export const MIN_LINKS = 25;

/**
 * 每格 runner 允许的 `flaky: true` 条数上限。
 *
 * ## 为什么需要 `flaky`，以及它为什么必须有上限
 *
 * `[实测]` 第一次真跑棘轮就撞上了：`apps/daemon › POST /api/notes/upload ›
 * 超出上限 → 413` 在 macOS 上**三轮里红了两轮**（32651393827 红、
 * 32656407764 绿、32660814749 红）。它写 socket 时踩 EPIPE，是真的间歇。
 *
 * **一条间歇失败的用例放进两头都断的棘轮里，会天天红**：红的那天不算新伤，
 * 绿的那天却会被判成"基线陈了，去划掉" —— 而划掉之后它下次红又变成新伤。
 * 两个方向轮流响，噪音比信号还多，最后的结局仍然是有人学会忽略它。
 *
 * 所以 `flaky: true` 的条目**只豁免方向②**（不因为今天绿了就要求划掉），
 * 方向①照常（它红的时候不算新伤，因为它在册）。
 *
 * ⚠️ 这是一个真正的减弱，所以必须有上限：**它是隔离区，不是垃圾桶**。
 * 上限取 3：够放真正间歇的那几条，不够把"懒得查"的都塞进来。
 * 撞上限时红的那句话是「先修一条再加一条」，不是「把上限调大」。
 */
export const MAX_FLAKY = 3;

/**
 * @param {{
 *   platform: string,
 *   baseline: any,
 *   today: {tests: string[], selftests: string[], skipped: string[]},
 *   health: {packages: number, pass: number, links: number},
 * }} o
 */
export function judge({ platform, baseline, today, health }) {
  /** @type {string[]} */
  const fatal = [];
  const entry = baseline?.platforms?.[platform];
  if (!entry) {
    fatal.push(
      `基线里没有平台 ${platform} —— 新加一格 runner 就必须同时给它一份基线，` +
        `否则它的红会被这条棘轮当成"没有已知失败"而全部报成新伤（或者反过来被忽略）。`,
    );
    return { fatal, newDamage: [], stale: [], ok: false };
  }

  /* ── 空转防线：先确认这一轮真的跑完了，再谈比对 ── */
  if (health.packages < MIN_PACKAGES) {
    fatal.push(
      `只有 ${health.packages} 个包报出了 \`# pass\`（下界 ${MIN_PACKAGES}）—— ` +
        `**本轮没跑完**。不拿它跟基线比：那样会得出"基线陈了、去删掉 N 条"这种离成因极远的结论。`,
    );
  }
  if (health.pass < MIN_PASS) {
    fatal.push(`通过数只有 ${health.pass}（下界 ${MIN_PASS}）—— **本轮没跑完**，同上，不比对。`);
  }
  if (health.links < MIN_LINKS) {
    fatal.push(
      `自检只跑了 ${health.links} 环（下界 ${MIN_LINKS}）—— ` +
        `要么链条被截短，要么 --json 那份结果是残缺的。不比对。`,
    );
  }
  if (fatal.length > 0) return { fatal, newDamage: [], stale: [], ok: false };

  /*
   * ★ `flaky: true` 只豁免方向②。它仍然在册，所以它红的时候不是新伤。
   *   隔离区必须小且看得见 —— 超过上限当场红（见 MAX_FLAKY 的注释）。
   */
  const rows = [...(entry.tests ?? []), ...(entry.selftests ?? [])];
  const flaky = rows.filter((e) => e.flaky);
  if (flaky.length > MAX_FLAKY) {
    fatal.push(
      `${platform} 的基线里有 ${flaky.length} 条 \`flaky\`，超过上限 ${MAX_FLAKY}。` +
        `**隔离区不是垃圾桶** —— 先修掉一条再加一条，别调大上限。\n` +
        `    ` +
        flaky.map((e) => e.id).join('\n    '),
    );
  }
  const noNote = flaky.filter((e) => !/(红了|绿|run \d)/.test(String(e.note ?? '')));
  if (noNote.length > 0) {
    fatal.push(
      `这些 \`flaky\` 条目的 note 里没有间歇性的**证据**（哪几次红、哪几次绿）：\n    ` +
        noNote.map((e) => e.id).join('\n    ') +
        `\n    没有证据的 "flaky" 与 "懒得查" 分不开，而它豁免的正是这条棘轮最要紧的那一半。`,
    );
  }
  if (fatal.length > 0) return { fatal, newDamage: [], stale: [], ok: false, flaky };

  const flakyIds = new Set(flaky.map((e) => e.id));
  const baseTests = new Set((entry.tests ?? []).map((e) => e.id));
  const baseSelf = new Set((entry.selftests ?? []).map((e) => e.id));
  const todayTests = new Set(today.tests);
  const todaySelf = new Set(today.selftests);

  const newDamage = [
    ...[...todayTests].filter((id) => !baseTests.has(id)).map((id) => ({ kind: 'test', id })),
    ...[...todaySelf].filter((id) => !baseSelf.has(id)).map((id) => ({ kind: 'selftest', id })),
  ];
  const stale = [
    ...[...baseTests]
      .filter((id) => !todayTests.has(id) && !flakyIds.has(id))
      .map((id) => ({ kind: 'test', id })),
    ...[...baseSelf]
      .filter((id) => !todaySelf.has(id) && !flakyIds.has(id))
      .map((id) => ({ kind: 'selftest', id })),
  ];

  return {
    fatal,
    newDamage,
    stale,
    flaky,
    ok: newDamage.length === 0 && stale.length === 0,
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const platform = arg('--platform');
  const testLog = arg('--test-log');
  const selftestJson = arg('--selftest-json');
  if (!platform || !testLog || !selftestJson) {
    console.error(
      '用法：node scripts/ci/xplat-ratchet.mjs --platform <label> --test-log <path> --selftest-json <path>',
    );
    process.exit(1);
  }
  for (const [what, p] of [
    ['测试日志', testLog],
    ['自检结果', selftestJson],
  ]) {
    if (!existsSync(p)) {
      console.error(
        `✘ xplat-ratchet: ${what} ${p} 不存在。\n` +
          `  上游那一步大概根本没跑起来 —— 这不是"今天没有失败"，是"今天什么都不知道"。`,
      );
      process.exit(1);
    }
  }

  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const parsed = parseTestLog(await readFile(testLog, 'utf8'));
  const self = JSON.parse(await readFile(selftestJson, 'utf8'));

  const today = {
    tests: parsed.failures,
    selftests: self.links.filter((l) => l.status === 'fail').map((l) => l.label),
    skipped: self.links.filter((l) => l.status === 'skip').map((l) => l.label),
  };
  const health = {
    packages: Object.keys(parsed.packages).length,
    pass: parsed.totalPass,
    links: self.total ?? self.links.length,
  };

  const entry = baseline?.platforms?.[platform] ?? {};
  const baseCount = (entry.tests?.length ?? 0) + (entry.selftests?.length ?? 0);
  const todayCount = today.tests.length + today.selftests.length;

  /*
   * ★ 数量要**印出来**，别让它只能靠读日志得到。
   *   一个人扫一眼 step summary 就该知道"今天和昨天一不一样"。
   */
  const headline =
    `跨平台棘轮 · ${platform} 基线 ${baseCount} 条 / 今天 ${todayCount} 条` +
    ` （测试 ${today.tests.length} · 自检 ${today.selftests.length} · 按平台跳过 ${today.skipped.length}）`;
  console.log(`\n══ ${headline}`);
  console.log(
    `   本轮健康度：${health.packages} 个包报了 pass，共 ${health.pass} 条通过；自检 ${health.links} 环`,
  );

  const verdict = judge({ platform, baseline, today, health });
  if (verdict.flaky?.length) {
    console.log(
      `   ⚠️ 隔离区：${verdict.flaky.length}/${MAX_FLAKY} 条标了 flaky（只豁免"今天过了要划掉"那一半，不豁免新伤）`,
    );
  }

  const lines = [`### ${headline}`, ''];
  if (verdict.fatal.length > 0) {
    console.error(`\n✘ 本轮不可比对：`);
    for (const f of verdict.fatal) console.error(`    ${f}`);
    lines.push('**✘ 本轮不可比对（没跑完）**', '', ...verdict.fatal.map((f) => `- ${f}`));
    await summary(lines);
    process.exit(1);
  }
  if (verdict.newDamage.length > 0) {
    console.error(`\n✘ 新伤 ${verdict.newDamage.length} 条 —— 基线里没有它们：`);
    for (const d of verdict.newDamage) console.error(`    [${d.kind}] ${d.id}`);
    lines.push(
      `**✘ 新伤 ${verdict.newDamage.length} 条**（基线里没有）`,
      '',
      ...verdict.newDamage.map((d) => `- \`${d.kind}\` ${d.id}`),
    );
  }
  if (verdict.stale.length > 0) {
    console.error(`\n✘ 基线陈了 ${verdict.stale.length} 条 —— 它们今天没有失败：`);
    for (const d of verdict.stale) console.error(`    [${d.kind}] ${d.id}`);
    console.error(
      `\n  这**不是**坏消息，是有人把它修好了。` +
        `\n  请把它们从 ${BASELINE_PATH} 里划掉 —— 基线只能变小。` +
        `\n  （这一半就是这条棘轮不烂掉的全部关键：没有它，基线会停在原地几个月而看起来一直在工作。）`,
    );
    lines.push(
      `**✘ 基线陈了 ${verdict.stale.length} 条**（今天没失败 —— 有人修好了，去划掉）`,
      '',
      ...verdict.stale.map((d) => `- \`${d.kind}\` ${d.id}`),
    );
  }
  if (verdict.ok) {
    console.log(`\n✔ xplat-ratchet: 与基线逐条一致 —— 没有新伤，也没有该划掉的。`);
    if (today.skipped.length > 0) {
      console.log(`   （另有 ${today.skipped.length} 环按平台收窄跳过，那些不是"通过"）`);
    }
    lines.push('**✔ 与基线逐条一致** —— 没有新伤，也没有该划掉的。');
  }
  await summary(lines);
  process.exit(verdict.ok ? 0 : 1);
}

async function summary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(f, lines.join('\n') + '\n\n', 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
