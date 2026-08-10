#!/usr/bin/env node
/**
 * `sum-undecided.mjs` 的反向验证 —— 挂在 `pnpm test:ci-scripts` 上。
 *
 * ## 这份自检最要守住的一条性质
 *
 * `sum-undecided.mjs` 的裁决（Manager 2026-08-10 二次裁决）是：**任何一格对不上
 * 就整体收敛成 null，绝不拼凑"凑巧到齐的那几格"的和，也绝不非 0 退出**（非 0 退出
 * 会连累到"写凭证"这一步不执行，让整条腿的凭证 artifact 都发不出去 —— 比
 * `undecided=null` 更糟）。
 *
 * 所以本自检除了常规的"输入 → 输出对不对"，还专门有一组 **B 组「反向验证」**：
 * 先把"缺一格 → null"那条分支临时改成"缺一格就拼凑剩下几格的和"，重跑整份
 * 自检，确认 B2（缺一格）**真的会红**（证明这条护栏不是摆设），然后把改动
 * 还原。这一步是硬性要求，不是可选的加分项——见本文件底部 `--prove-regression`
 * 那一段。
 *
 * 跑法：
 *   node scripts/ci/selftest-sum-undecided.mjs
 *       —— 正常自检（A/B 两组），已挂进 pnpm test:ci-scripts。
 *   node scripts/ci/selftest-sum-undecided.mjs --prove-regression
 *       —— 额外把"缺一格→null"临时改成"缺一格就拼凑"，重跑一遍全套断言，
 *          断言 B2 变红（证明护栏有牙齿），再把改动还原、校验文件已还原。
 *          这一步在开发时手动跑过一次即可，不需要挂进日常 CI
 *          （它会真的改写 sum-undecided.mjs 源码，即便会自动还原，也不该
 *          混进日常跑的那条链路）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'sum-undecided.mjs');

let checked = 0;
let failed = 0;
const ok = (msg) => {
  checked += 1;
  console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
};
const bad = (msg) => {
  checked += 1;
  failed += 1;
  console.log(`  \x1b[31m✘\x1b[0m ${msg}`);
};

/** 造一个 `{ dir, ghOutPath }`，dir 下按 files 写好若干 `<label>.json` 之类的产物。 */
function makeCellDir(scratch, name, files) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(dir, filename), content);
  }
  return dir;
}

function run(dir, extra = []) {
  const ghOut = join(mkdtempSync(join(tmpdir(), 'om-sum-gh-')), 'out.txt');
  writeFileSync(ghOut, '');
  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--dir',
      dir,
      '--expect-labels',
      'linux-x64,darwin-arm64,win32-x64',
      '--file-template',
      'e2e-runtime-undecided-{label}.json',
      '--github-output',
      ghOut,
      ...extra,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  const ghText = existsSync(ghOut) ? readFileSync(ghOut, 'utf8') : '';
  const m = ghText.match(/^undecided_flag=(.*)$/m);
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    flag: m ? m[1] : null,
  };
}

function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'om-sum-undecided-selftest-'));
  const fresh = (n) => join(scratch, n); // makeCellDir 自己 mkdir

  console.log('\n\x1b[1msum-undecided 反向验证\x1b[0m');

  /* ═══ A 组：正常情形 ═══════════════════════════════════════════════════════ */
  console.log('\n\x1b[1mA 组：正常情形\x1b[0m');

  {
    // A1（correction a）—— 三格都到齐，值分别是 2/0/1 → 和是 3。
    const dir = makeCellDir(scratch, 'a1', {
      'e2e-runtime-undecided-linux-x64.json': '{"unknowns": 2}\n',
      'e2e-runtime-undecided-darwin-arm64.json': '{"unknowns": 0}\n',
      'e2e-runtime-undecided-win32-x64.json': '{"unknowns": 1}\n',
    });
    const r = run(dir);
    if (r.status === 0 && r.flag === '--undecided 3') {
      ok('A1 三格都到齐（2/0/1）→ exit 0，undecided_flag = "--undecided 3"');
    } else {
      bad(
        `A1 期望 exit 0 + flag="--undecided 3"，实得 exit ${r.status} flag=${JSON.stringify(r.flag)}\n${r.out.slice(0, 500)}`,
      );
    }
  }

  {
    // A2（correction c，"最要紧的一条"）—— 三格都到齐但全是 0，必须区分于"缺失"。
    const dir = makeCellDir(scratch, 'a2', {
      'e2e-runtime-undecided-linux-x64.json': '{"unknowns": 0}\n',
      'e2e-runtime-undecided-darwin-arm64.json': '{"unknowns": 0}\n',
      'e2e-runtime-undecided-win32-x64.json': '{"unknowns": 0}\n',
    });
    const r = run(dir);
    if (r.status === 0 && r.flag === '--undecided 0') {
      ok('A2 三格都到齐但全报 0 → flag = "--undecided 0"（不是空/null——0 与缺失必须分得开）');
    } else {
      bad(
        `A2 期望 flag="--undecided 0"，实得 exit ${r.status} flag=${JSON.stringify(r.flag)}\n${r.out.slice(0, 500)}`,
      );
    }
  }

  /* ═══ B 组：对不上的情形 —— 必须 exit 0 + flag 为空，绝不拼凑 ═══════════════════ */
  console.log('\n\x1b[1mB 组：对不上的情形（必须 exit 0 + null，绝不拼凑、绝不非 0 退出）\x1b[0m');

  let b2; // 供 --prove-regression 复查（下面无条件赋值，初值本来就读不到）
  {
    // B2（correction b）—— 缺一格。绝不能等于剩下两格的和（"部分求和"是被明确禁止的旧设计）。
    const dir = makeCellDir(scratch, 'b2', {
      'e2e-runtime-undecided-linux-x64.json': '{"unknowns": 5}\n',
      'e2e-runtime-undecided-darwin-arm64.json': '{"unknowns": 7}\n',
      // win32-x64 缺失
    });
    const r = run(dir);
    b2 = r;
    if (r.status === 0 && r.flag === '') {
      ok('B2 缺一格（win32-x64）→ exit 0，undecided_flag 为空（不是"5+7=12"那个部分和）');
    } else {
      bad(
        `B2 期望 exit 0 + flag=""，实得 exit ${r.status} flag=${JSON.stringify(r.flag)}（若等于 12 说明拼凑了部分和，这是被明确禁止的旧设计）\n${r.out.slice(0, 500)}`,
      );
    }
  }

  {
    // B1 —— 一格都没有（目录存在但是空的）。
    const dir = fresh('b1-empty');
    mkdirSync(dir, { recursive: true });
    const r = run(dir);
    if (r.status === 0 && r.flag === '') {
      ok('B1 目录是空的 → exit 0，undecided_flag 为空');
    } else {
      bad(
        `B1 期望 exit 0 + flag=""，实得 exit ${r.status} flag=${JSON.stringify(r.flag)}\n${r.out.slice(0, 500)}`,
      );
    }
  }

  {
    // B3 —— 目录压根不存在（比如整个 download-artifact 步骤一个 artifact 都没下到）。
    const dir = join(scratch, 'b3-does-not-exist');
    const r = run(dir);
    if (r.status === 0 && r.flag === '') {
      ok('B3 目录不存在 → exit 0，undecided_flag 为空（不是脚本崩溃）');
    } else {
      bad(
        `B3 期望 exit 0 + flag=""，实得 exit ${r.status} flag=${JSON.stringify(r.flag)}\n${r.out.slice(0, 500)}`,
      );
    }
  }

  {
    // B4 —— 多出一个没人认领的文件。
    const dir = makeCellDir(scratch, 'b4', {
      'e2e-runtime-undecided-linux-x64.json': '{"unknowns": 1}\n',
      'e2e-runtime-undecided-darwin-arm64.json': '{"unknowns": 1}\n',
      'e2e-runtime-undecided-win32-x64.json': '{"unknowns": 1}\n',
      'e2e-runtime-undecided-freebsd-x64.json': '{"unknowns": 99}\n', // 没在 --expect-labels 里
    });
    const r = run(dir);
    if (r.status === 0 && r.flag === '') {
      ok('B4 多出一个未预期的文件 → exit 0，undecided_flag 为空（不悄悄忽略、也不悄悄计入）');
    } else {
      bad(
        `B4 期望 exit 0 + flag=""，实得 exit ${r.status} flag=${JSON.stringify(r.flag)}\n${r.out.slice(0, 500)}`,
      );
    }
  }

  {
    // B5 —— 文件在，但不是合法 JSON。
    const dir = makeCellDir(scratch, 'b5', {
      'e2e-runtime-undecided-linux-x64.json': 'not json at all',
      'e2e-runtime-undecided-darwin-arm64.json': '{"unknowns": 1}\n',
      'e2e-runtime-undecided-win32-x64.json': '{"unknowns": 1}\n',
    });
    const r = run(dir);
    if (r.status === 0 && r.flag === '') {
      ok('B5 一个文件不是合法 JSON → exit 0，undecided_flag 为空');
    } else {
      bad(
        `B5 期望 exit 0 + flag=""，实得 exit ${r.status} flag=${JSON.stringify(r.flag)}\n${r.out.slice(0, 500)}`,
      );
    }
  }

  {
    // B6 —— 字段不是非负整数（比如字符串、负数、小数）。
    const dir = makeCellDir(scratch, 'b6', {
      'e2e-runtime-undecided-linux-x64.json': '{"unknowns": "not-a-number"}\n',
      'e2e-runtime-undecided-darwin-arm64.json': '{"unknowns": 1}\n',
      'e2e-runtime-undecided-win32-x64.json': '{"unknowns": 1}\n',
    });
    const r = run(dir);
    if (r.status === 0 && r.flag === '') {
      ok('B6 字段不是数字 → exit 0，undecided_flag 为空');
    } else {
      bad(
        `B6 期望 exit 0 + flag=""，实得 exit ${r.status} flag=${JSON.stringify(r.flag)}\n${r.out.slice(0, 500)}`,
      );
    }
  }

  {
    // B7 —— --expect-labels 里有重复。
    const dir = makeCellDir(scratch, 'b7', {
      'e2e-runtime-undecided-linux-x64.json': '{"unknowns": 1}\n',
      'e2e-runtime-undecided-darwin-arm64.json': '{"unknowns": 1}\n',
      'e2e-runtime-undecided-win32-x64.json': '{"unknowns": 1}\n',
    });
    const ghOut = join(mkdtempSync(join(tmpdir(), 'om-sum-gh-')), 'out.txt');
    writeFileSync(ghOut, '');
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--dir',
        dir,
        '--expect-labels',
        'linux-x64,linux-x64,darwin-arm64,win32-x64',
        '--file-template',
        'e2e-runtime-undecided-{label}.json',
        '--github-output',
        ghOut,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const ghText = existsSync(ghOut) ? readFileSync(ghOut, 'utf8') : '';
    const m = ghText.match(/^undecided_flag=(.*)$/m);
    const flag = m ? m[1] : null;
    if (r.status === 0 && flag === '') {
      ok('B7 --expect-labels 里有重复标签 → exit 0，undecided_flag 为空');
    } else {
      bad(`B7 期望 exit 0 + flag=""，实得 exit ${r.status} flag=${JSON.stringify(flag)}`);
    }
  }

  /* ═══ C 组：调用方本身配置错误 —— 这两项照旧 die() ═══════════════════════════ */
  console.log('\n\x1b[1mC 组：调用方配置错误（与"某平台没跑到"不是同一类问题，照旧 die）\x1b[0m');

  {
    const r = spawnSync(process.execPath, [SCRIPT, '--expect-labels', 'linux-x64'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status !== 0) ok('C1 缺 --dir → 非 0 退出（这是配置错误，不是运行时缺格）');
    else bad('C1 缺 --dir 居然 exit 0');
  }

  {
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', fresh('c2')], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status !== 0) ok('C2 缺 --expect-labels → 非 0 退出');
    else bad('C2 缺 --expect-labels 居然 exit 0');
  }

  rmSync(scratch, { recursive: true, force: true });

  console.log('');
  // b2 供 --prove-regression 复查：单独把这一格的 flag 带出函数外，
  // 让回归证明能断言"红的正是这一格、且正是那个被禁止的部分和"，
  // 而不只是"整套里有什么东西红了"（后者可能撞上无关案例，误报护栏有牙齿）。
  const b2Flag = b2 ? b2.flag : null;
  if (checked < 11) {
    console.log(`\x1b[31m✘ 只跑了 ${checked} 条断言 —— 少于预期，先怀疑这个自检本身瞎了\x1b[0m`);
    return { ok: false, b2Flag };
  }
  if (failed > 0) {
    console.log(`\x1b[31m✘ ${checked - failed} passed, ${failed} failed\x1b[0m`);
    return { ok: false, b2Flag };
  }
  console.log(`\x1b[32m✔ ${checked} passed, 0 failed\x1b[0m`);
  return { ok: true, b2Flag };
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * --prove-regression：证明 B2 那条护栏真的有牙齿
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 做法：把 sum-undecided.mjs 里"缺失就整体收敛成 null"的那一段临时替换成
 * "缺失就跳过、只对拿到的几格求和"（也就是被裁决明确禁止的旧设计），
 * 重跑一遍上面整套断言，断言里的 B2 必须变红（因为那样 flag 会变成
 * "--undecided 12"而不是空字符串）。跑完不论成败都把源文件还原，
 * 并且用字节比对确认真的回到了原样。
 */
function proveRegression() {
  console.log('\n\x1b[1m--prove-regression：临时松开"缺一格→null"，确认 B2 会红\x1b[0m');
  const original = readFileSync(SCRIPT, 'utf8');

  const needle = `  if (!jsonFilesInDir.includes(filename)) {
    problems.push(\`缺失：标签 \${label} 期望的 \${filename} 没找到\`);
    breakdown.push({ label, filename, status: 'missing' });
    continue;
  }`;
  if (!original.includes(needle)) {
    console.log('\x1b[31m✘ 找不到要临时改写的那段代码（脚本被改过？）—— 放弃回归证明\x1b[0m');
    return false;
  }
  // 旧设计：缺了就跳过，不计入 problems，只对拿到的那几格求和。
  const mutated = original.replace(
    needle,
    `  if (!jsonFilesInDir.includes(filename)) {
    breakdown.push({ label, filename, status: 'missing-but-silently-skipped' });
    continue; // ★ 临时松开：不再 push 进 problems —— 这正是被明确禁止的旧设计
  }`,
  );

  writeFileSync(SCRIPT, mutated);
  let regressionCaught;
  try {
    const { ok: passedWithMutation, b2Flag: mutatedB2Flag } = main();
    // 只看"整套是否有红"不够精确——万一红的是别的、不相干的案例，
    // 会被误判成"这条护栏有牙齿"。所以除了整体判红，还要求 B2 这一格
    // 具体产出的 flag 恰好等于被明确禁止的"部分和"（5+7=12），
    // 这样才是真的撞上了这个具体缺陷，不是凑巧撞上了别的失败。
    const wentRed = passedWithMutation === false;
    const gotForbiddenPartialSum = mutatedB2Flag === '--undecided 12';
    regressionCaught = wentRed && gotForbiddenPartialSum;
    if (!wentRed) {
      console.log('\x1b[31m✘ 松开护栏后整套自检居然还是绿的 —— B2 这条断言抓不住这个缺陷\x1b[0m');
    } else if (!gotForbiddenPartialSum) {
      console.log(
        `\x1b[31m✘ 整套是红了，但 B2 那格的 flag 实得 ${JSON.stringify(mutatedB2Flag)}，不是被禁止的部分和 "--undecided 12" —— 红的可能是别的案例，这条护栏没被真正撞到\x1b[0m`,
      );
    }
  } finally {
    writeFileSync(SCRIPT, original);
    const restored = readFileSync(SCRIPT, 'utf8');
    if (restored !== original) {
      console.log('\x1b[31m✘ 还原后字节对不上原文件 —— 立刻手工检查 sum-undecided.mjs！\x1b[0m');
      process.exitCode = 1;
    } else {
      console.log('\x1b[32m✔ sum-undecided.mjs 已还原，与改写前逐字节一致\x1b[0m');
    }
  }

  if (regressionCaught) {
    console.log(
      '\x1b[32m✔ 松开护栏后 B2 确实变红了，且拿到的正是被禁止的部分和（5+7=12）—— 证明这条护栏不是摆设\x1b[0m',
    );
    return true;
  }
  return false;
}

const wantProve = process.argv.includes('--prove-regression');
const { ok: normalOk } = main();
let finalOk = normalOk;
if (wantProve) {
  const proveOk = proveRegression();
  finalOk = normalOk && proveOk;
}

process.exit(finalOk ? 0 : 1);
