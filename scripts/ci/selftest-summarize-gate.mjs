#!/usr/bin/env node
/**
 * `scripts/ci/summarize-gate.mjs` 的自检 —— 纯函数直接 import 单测，
 * CLI 部分用 `spawnSync` 走一遍真实入口（含 `GITHUB_STEP_SUMMARY` 落盘）。
 *
 * 判据和这个目录里其它 selftest 一样：**每一条"必须红/必须算未验证"的性质，
 * 都用一个具体输入证明它真的会那样分类，并断言在真实输出上**，不是读代码猜。
 *
 * 跑：`node scripts/ci/selftest-summarize-gate.mjs`（`pnpm test:ci-scripts` 会调）
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, renderMarkdown, renderText, STEP_LABELS, summarize } from './summarize-gate.mjs';

const SCRIPT = fileURLToPath(new URL('./summarize-gate.mjs', import.meta.url));

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

console.log('① classify()：GitHub 的四种 outcome/result，逐个钉死映射');
{
  check('success → 通过', () => assert.equal(classify('success'), '通过'));
  check('failure → 失败', () => assert.equal(classify('failure'), '失败'));
  check('skipped → 未验证（没跑到，不能算过）', () => assert.equal(classify('skipped'), '未验证'));
  check('cancelled → 未验证', () => assert.equal(classify('cancelled'), '未验证'));
  check('空字符串 → 未验证（没传上来，不能当成"跑过且过了"）', () =>
    assert.equal(classify(''), '未验证'),
  );
  check('undefined → 未验证', () => assert.equal(classify(undefined), '未验证'));
  check('未知字符串 → 未验证（宁可算未验证，不猜它是过是挂）', () =>
    assert.equal(classify('weird-future-value'), '未验证'),
  );
}

console.log('② summarize()：全绿 → allPass');
{
  const names = Object.keys(STEP_LABELS);
  const entries = names.map((name) => ({ name, label: STEP_LABELS[name], outcome: 'success' }));
  const { rows, counts, allPass } = summarize('success', entries);
  check('9 条全部归类为通过', () => assert.equal(counts['通过'], 9));
  check('失败 0 / 未验证 0', () => assert.equal(counts['失败'] + counts['未验证'], 0));
  check('allPass === true', () => assert.equal(allPass, true));
  check('rows 长度等于输入条数', () => assert.equal(rows.length, 9));
}

console.log('③ ★ summarize()：这一天现场实测的真实形状 —— 一条红、后面全灰');
{
  // 对应 run 31330431471 / 31330576799：Format check / Build / Typecheck 跑完，
  // Lint 红，后面 5 条（Tracked-sources guard 起到 Mutation-spec anchors）全 skipped。
  const entries = [
    { name: 'format_check', label: STEP_LABELS.format_check, outcome: 'success' },
    { name: 'build', label: STEP_LABELS.build, outcome: 'success' },
    { name: 'typecheck', label: STEP_LABELS.typecheck, outcome: 'success' },
    { name: 'lint', label: STEP_LABELS.lint, outcome: 'failure' },
    { name: 'tracked_sources', label: STEP_LABELS.tracked_sources, outcome: 'skipped' },
    { name: 'orphan_exports', label: STEP_LABELS.orphan_exports, outcome: 'skipped' },
    { name: 'ci_scripts_selftest', label: STEP_LABELS.ci_scripts_selftest, outcome: 'skipped' },
    { name: 'test', label: STEP_LABELS.test, outcome: 'skipped' },
    { name: 'mutation_anchors', label: STEP_LABELS.mutation_anchors, outcome: 'skipped' },
  ];
  const { counts, allPass } = summarize('failure', entries);
  check('通过 3（Format check / Build / Typecheck）', () => assert.equal(counts['通过'], 3));
  check('失败 1（Lint）', () => assert.equal(counts['失败'], 1));
  check('未验证 5（Test 和 Mutation-spec anchors 都在这 5 条里）', () =>
    assert.equal(counts['未验证'], 5),
  );
  check('allPass === false', () => assert.equal(allPass, false));
}

console.log('④ ★ summarize()：gate 整体 result 是 success，但某个 output 传丢了');
{
  // 这一条防的是"字段名打错"那类事故（lint-workflows.mjs 对 steps.<id>.outputs.*
  // 有专门一条断言，但 needs.<job>.outputs.* 这条链它管不到）：哪怕 gate 本身绿，
  // 只要有一条 outcome 没传上来（空字符串），也不能被算成通过。
  const entries = [
    { name: 'format_check', outcome: 'success' },
    { name: 'build', outcome: '' }, // 假装 job outputs 里漏传了这一条
  ];
  const { counts, allPass } = summarize('success', entries);
  check('漏传的那条算未验证，不是通过', () => assert.equal(counts['未验证'], 1));
  check('allPass === false（gate 绿，但汇总本身不完整，仍不算过）', () =>
    assert.equal(allPass, false),
  );
}

console.log('⑤ renderText() / renderMarkdown()：三态字样、结论行都在输出里');
{
  const entries = [
    { name: 'a', label: 'A', outcome: 'success' },
    { name: 'b', label: 'B', outcome: 'failure' },
    { name: 'c', label: 'C', outcome: 'skipped' },
  ];
  const { rows, counts, allPass } = summarize('failure', entries);
  const text = renderText('failure', rows, counts, allPass);
  const md = renderMarkdown('failure', rows, counts, allPass);

  check('文本里三态都点名出现', () => {
    assert.match(text, /通过/);
    assert.match(text, /失败/);
    assert.match(text, /未验证/);
  });
  check('文本里结论行给出确切计数（通过 1 / 失败 1 / 未验证 1）', () =>
    assert.match(text, /通过 1 \/ 失败 1 \/ 未验证 1（共 3）/),
  );
  check('markdown 表格里三行状态都在，且不是同一个词糊过去', () => {
    assert.match(md, /\| A \| 通过 \|/);
    assert.match(md, /\| B \| 失败 \|/);
    assert.match(md, /\| C \| 未验证 \|/);
  });
  check('未全部通过时 markdown 明确写"✗ 未全部通过"，不是含糊的"完成"', () =>
    assert.match(md, /✗ 未全部通过/),
  );
}

console.log('⑥ ★ CLI 端到端：真的 spawn 一次，含 GITHUB_STEP_SUMMARY 落盘 + 退出码');
{
  const dir = mkdtempSync(join(tmpdir(), 'summarize-gate-selftest-'));
  const summaryFile = join(dir, 'step_summary.md');
  writeFileSync(summaryFile, ''); // GitHub runner 会预先建好这个文件

  try {
    const bad = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GATE_RESULT: 'failure',
        GATE_STEP_NAMES: 'format_check,build,typecheck,lint,test',
        GATE_STEP_FORMAT_CHECK: 'success',
        GATE_STEP_BUILD: 'success',
        GATE_STEP_TYPECHECK: 'failure',
        GATE_STEP_LINT: 'skipped',
        GATE_STEP_TEST: 'skipped',
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    });
    check('CLI 以非零退出（有失败 + 未验证，不该是绿的）', () => assert.notEqual(bad.status, 0));
    check('stdout 打出"未验证:"意义上的结论行', () => assert.match(bad.stdout, /未验证 2（共 5）/));
    check('GITHUB_STEP_SUMMARY 文件真的被写入了内容', () => {
      const written = readFileSync(summaryFile, 'utf8');
      assert.match(written, /gate 三态汇总/);
      assert.match(written, /✗ 未全部通过/);
    });

    // 覆盖全绿的正向分支，防止"CLI 永远退出非零"这种反向漏做。
    writeFileSync(summaryFile, '');
    const good = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GATE_RESULT: 'success',
        GATE_STEP_NAMES: 'a,b',
        GATE_STEP_A: 'success',
        GATE_STEP_B: 'success',
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    });
    check('全绿时 CLI 退出 0', () => assert.equal(good.status, 0));
    check('全绿时 markdown 写"✓ 全部通过"', () =>
      assert.match(readFileSync(summaryFile, 'utf8'), /✓ 全部通过/),
    );

    const empty = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, GATE_RESULT: 'success', GATE_STEP_NAMES: '' },
    });
    check('GATE_STEP_NAMES 为空时 CLI 以 exit 2 拒绝（防"传丢了却看着像跑过"）', () =>
      assert.equal(empty.status, 2),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n✔ 全部通过（${passed} 条断言）`);
