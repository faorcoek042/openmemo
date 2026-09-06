#!/usr/bin/env node
/**
 * `gate` job（`.github/workflows/ci.yml`）跑完之后的**三态汇总** —— 通过 / 失败 / 未验证。
 *
 * ## 为什么需要这个（2026-08-10 现场实测）
 *
 * `gate` 是单个 job、9 个门禁 step 顺序执行、一红全停 —— 这本身是对的（见下一节）。
 * 但后果是：一个 step 红了，后面几个 step 在 Actions 的 UI 里全部显示成灰色的
 * "Skipped"。这一天里连续观测到 4 次同一个模式：人看着那一排灰色 dash，
 * 脑子里读出来的不是"这几条检查没跑过"，而是习惯性地略过（run 31330302267 /
 * 31330405726 / 31330431471 / 31330576799，一次比一次靠后地卡在不同的 step，
 * `Test` 和 `Mutation-spec anchors` 连续 4 次 CI 运行**一次都没有真的执行过**，
 * 但每次 Actions 页面看起来都只是"某一步红了"，不是"9 条门禁里有 5 条根本没跑"）。
 *
 * 这个脚本把"没跑"从颜色判断变成一行数得出来的文字：**通过 X / 失败 Y / 未验证 Z**。
 * "未验证"和"失败"分开算——一个从没执行过的检查，不等于它检查的东西是错的，
 * 但也绝不能被算进"通过"里。
 *
 * ## 为什么是一个独立 job，而不是给 `gate` 自己的 step 加 `if: always()`
 *
 * 字面上最直接的做法是给 `gate` 的每个 step 加 `if: always()`，让它们在前面
 * 挂了之后照样跑。**这条路走不通**：`scripts/ci/lint-workflows.mjs` 的
 * `MUST_FAIL_LOUDLY['ci.yml'] = ['gate']` 明确禁止 `gate` job 自己的任何 step
 * 带 `if: always()` / `continue-on-error`——防的是 C4（`build-backends.yml` 的
 * `merge` job 三个构建全挂，照样写出一个空 manifest 并绿灯，「失败被写成成功」）。
 * `.github/workflows/ci.yml` 里 `gate` job 末尾那条注释说的是同一件事。
 * 给 `gate` 的 step 加 `always()`，会让"前面挂了，后面步骤能不能拿到真实产物"
 * 这件事变得不可靠（比如 `Install` 挂了，`Test` 却因为 always() 硬跑，那不是
 * 更多信号，是噪音），而且会当场打红我自己在同一天修好的 `lint-workflows.mjs`。
 *
 * 所以这里不碰 `gate` 的 fail-fast 语义——它一红照样原地停，该 skipped 的 step
 * 依旧 skipped。这个脚本只**读** `gate` 传出来的 `steps.<id>.outcome`
 * （GitHub 对没跑到的 step 本来就会给出 `skipped`，不需要 `always()` 就能拿到
 * 这个信号），在下游一个单独的、`if: always()` 的 `gate-summary` job 里做
 * 归类和打印——`gate-summary` 不在 `MUST_FAIL_LOUDLY` 名单里，`lint-workflows.mjs`
 * 不会拦，且它本身不做任何判断产物对不对的活，只做「哪些真的跑完并通过了」的计数，
 * 不会重演 C4 那种「没跑却报绿」。
 *
 * ## 为什么 `gate-summary` 自己也不能被跳过
 *
 * 如果这一步也用默认的 `if: success()`，`gate` 一红它自己就先被跳过了——
 * 一个用来报告"谁没跑到"的 step，如果自己也因为上游失败而 skipped，那就白做了。
 * 所以 `gate-summary` job 是 `needs: gate` + `if: always()`；GitHub Actions 对
 * 失败 job 的 `outputs:` 依然会传给下游（前提是下游自己 `if: always()`），
 * 这是标准行为，不需要额外开关。
 *
 * ## 未验证 ≠ 通过，未验证也 ≠ 只是提示
 *
 * `allPass` 要求 `gate` 整体 result 是 `success`，且 0 条失败、0 条未验证。
 * 少一条没跑到，`gate-summary` 自己也用非零退出——三态里任何一态不是"通过"，
 * 这一步就不该看起来是绿的。
 *
 * ## 用法
 *
 *   GATE_RESULT=success \
 *   GATE_STEP_NAMES=format_check,build \
 *   GATE_STEP_FORMAT_CHECK=success \
 *   GATE_STEP_BUILD=skipped \
 *   node scripts/ci/summarize-gate.mjs
 *
 * 纯逻辑部分（`classify` / `summarize`）不碰 env / 不碰文件，由
 * `scripts/ci/selftest-summarize-gate.mjs` 直接 import 单测。
 */
import { appendFileSync } from 'node:fs';
import { isDirectRun } from '../lib/entrypoint.mjs';

/** GitHub 的 `steps.<id>.outcome` / `needs.<job>.result` 只会是这四种之一。 */
export function classify(outcome) {
  if (outcome === 'success') return '通过';
  if (outcome === 'failure') return '失败';
  // 'skipped' / 'cancelled' / undefined / '' 一律算未验证：
  // 不知道它到底跑没跑、跑了结果对不对，就不能算进"通过"。
  return '未验证';
}

/**
 * @param {string} gateResult `needs.gate.result`
 * @param {Array<{name: string, label?: string, outcome: string}>} entries
 */
export function summarize(gateResult, entries) {
  const rows = entries.map((e) => ({ ...e, state: classify(e.outcome) }));
  const counts = { 通过: 0, 失败: 0, 未验证: 0 };
  for (const r of rows) counts[r.state] += 1;
  const allPass = classify(gateResult) === '通过' && counts['失败'] === 0 && counts['未验证'] === 0;
  return { rows, counts, allPass };
}

/** 每个 step id 的人类可读标签，顺序即 `ci.yml` 里 `gate` job 的执行顺序。 */
export const STEP_LABELS = {
  format_check: 'Format check',
  install: 'Install',
  build: 'Build (workspace packages)',
  typecheck: 'Typecheck',
  lint: 'Lint',
  tracked_sources: 'Tracked-sources guard',
  orphan_exports: 'Orphan-exports ratchet',
  duplicate_declarations: 'Duplicate-declarations ratchet',
  test_ratchet: 'Test-file ratchet',
  locale_ratchet: 'Locale key guard',
  contract_fields: 'Contract-field readers',
  dependency_audit: 'Dependency-source audit',
  ci_scripts_selftest: 'CI scripts self-test',
  test: 'Test',
  mutation_anchors: 'Mutation-spec anchors',
};

export function renderText(gateResult, rows, counts, allPass) {
  const lines = [];
  lines.push(`gate job 整体 result：${gateResult || '(空)'}`);
  lines.push('');
  for (const r of rows) {
    const mark = r.state === '通过' ? '✓' : r.state === '失败' ? '✗' : '?';
    lines.push(`  ${mark} ${r.state}  ${r.label ?? r.name}  (outcome=${r.outcome || '(空)'})`);
  }
  lines.push('');
  lines.push(
    `结论：通过 ${counts['通过']} / 失败 ${counts['失败']} / 未验证 ${counts['未验证']}` +
      `（共 ${rows.length}）`,
  );
  if (!allPass) {
    lines.push('');
    lines.push('⚠️ 未全部通过 —— 未验证不算通过，这一步会以非零退出。');
  }
  return lines.join('\n');
}

export function renderMarkdown(gateResult, rows, counts, allPass) {
  return [
    '## gate 三态汇总',
    '',
    `gate job 整体 result：\`${gateResult || '(空)'}\``,
    '',
    '| 检查 | 状态 | outcome |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.label ?? r.name} | ${r.state} | \`${r.outcome || '(空)'}\` |`),
    '',
    `**结论：通过 ${counts['通过']} / 失败 ${counts['失败']} / 未验证 ${counts['未验证']}` +
      `（共 ${rows.length}）**`,
    '',
    allPass ? '✓ 全部通过' : '✗ 未全部通过 —— 未验证不算通过',
    '',
  ].join('\n');
}

function main() {
  const gateResult = process.env.GATE_RESULT ?? '';
  const names = (process.env.GATE_STEP_NAMES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (names.length === 0) {
    console.error('GATE_STEP_NAMES 是空的 —— 汇总不到任何 step，多半是 workflow 没传对。');
    process.exit(2);
  }

  const entries = names.map((name) => {
    const envKey = `GATE_STEP_${name.toUpperCase()}`;
    const outcome = process.env[envKey] ?? '';
    return { name, label: STEP_LABELS[name] ?? name, outcome };
  });

  const { rows, counts, allPass } = summarize(gateResult, entries);

  console.log(renderText(gateResult, rows, counts, allPass));

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, renderMarkdown(gateResult, rows, counts, allPass));
  }

  process.exit(allPass ? 0 : 1);
}

/*
 * ⚠️ 入口守卫只许用 `isDirectRun()`（判据见 `scripts/lib/entrypoint.mjs` 文件头）。
 * 这一个是 `ci.yml` 的**收尾汇总**：它空转 = 那份汇总整个不存在，而 exit 0 让门禁照样绿。
 */
if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
