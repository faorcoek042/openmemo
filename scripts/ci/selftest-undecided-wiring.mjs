#!/usr/bin/env node
/**
 * 覆盖面（undecided）那条管道的**接线守卫** —— 五条腿一起查，秒级，不需要网络。
 *
 * ## 它治的病：**这条管道断掉时不会有任何东西变红**
 *
 * 一格未决计数要走完**八处手写、必须两两对齐**的东西才到得了凭证
 * （早先这里写的是"四个名字"，**数少了** —— 2026-08-17 复核逐处点出来）：
 *
 * ```
 *   审计脚本 --undecided-out e2e-<leg>-undecided-<label>.json     ①
 *        ↓
 *   upload-artifact  name: e2e-<leg>-undecided-<label>            ②
 *                    path: e2e-<leg>-undecided-<label>.json       ③
 *        ↓
 *   download-artifact pattern: e2e-<leg>-undecided-*              ④
 *        ↓
 *   sum-undecided.mjs --file-template 'e2e-<leg>-undecided-{label}.json'  ⑤
 *        ↓
 *   emit-e2e-attestation.mjs ${{ steps.sum.outputs.undecided_flag }}      ⑥
 * ```
 *
 * ①〜⑤ **任意两处对不上**，`sum-undecided.mjs` 会照它的裁决**只警告、收敛成 null、
 * 退出码 0**（那条裁决是对的：一个展示用的统计不该连累凭证本身）。后果是：
 *
 *   · 那一步**绿**；
 *   · 整条腿**绿**；
 *   · 凭证照发，只是 `undecided` 从一个数字变回 `null`；
 *   · 发布闸门把它印成「**没上报覆盖面**（未接线或读不到）」——
 *     和「这条腿从来没接过线」**一模一样**。
 *
 * 也就是说：**把线接好，和把线接错，在所有灯上长得一样。** 而这条管道存在的
 * 全部理由，就是把「查过了确实是 0」和「根本没查」分开说
 * （`emit-e2e-attestation.mjs` 里 `null` vs `0` 那段注释）。
 * 一条会悄悄退回 `null` 的管道，等于把那个区分又还回去了。
 *
 * ## ⚠️ 这一条是本轮 notes 接线时**顺手发现的，不是 notes 独有的**
 *
 * 五条腿（runtime / browser / record / allcomponents / notes）今天都靠
 * 「八处手写、人眼对齐」维持。它们**现在是对的** —— 这份文件把「现在是对的」
 * 变成「改坏了会红」。
 *
 * ## 判据（只查机械可判定的，不猜语义）
 *
 *   R1 ①⑤ 同模板：`--undecided-out` 的文件名（把 `${{ matrix.label }}` 归一成
 *      `{label}`）必须与 `--file-template` 逐字相同。同一条腿有多个
 *      `--undecided-out` 调用点（browser 有两处，两种模式各一）时，**每一处都要对**。
 *   R2 ②③ 与①同源：upload 的 `name` = 模板去掉 `.json`；`path` = 模板。
 *   R3 ④ 覆盖得住②：download 的 `pattern` = 模板里 `{label}` 之前那一截 + `*`。
 *   R4 ⑥ 真的在读求和结果：emit 那一行必须含 `${{ steps.<id>.outputs.undecided_flag }}`，
 *      且 `<id>` 真的是那个 sum 步骤的 `id:`。
 *   R5 🔴 **不许接了线还写死**：emit 那一行不许再出现字面量 `--undecided <数字>`。
 *   R6 ⑥ 那个插值**不许加引号**：`"${{ … }}"` 会把 `--undecided 3` 变成一个 argv
 *      词，`arg()` 找不到 `--undecided` ⇒ 静默退回 null（与断线同形）。
 *   R7 🔴 **JSON 键**：审计脚本写进那个文件的键，必须就是 `sum-undecided.mjs`
 *      要读的那个（`--field` 的默认值 `unknowns`）。
 *      ⚠️ 这一处是**第八个名字，而 R1–R6 一个都没守它** —— 复核点出来的洞：
 *      把审计脚本里的 `unknowns` 改成别的（比如 `undecidedCount`），
 *      五个文件名仍然逐字对齐、这份自测**全绿**，而 `sum-undecided.mjs` 会
 *      读不到字段 ⇒ 警告 ⇒ 收敛成 null ⇒ 退出码 0 ⇒ 凭证退回"没上报覆盖面"。
 *      **那正是这个文件存在要消灭的那一种失败。**
 *
 * ## 反向证明
 *
 * 光查「现状对不对」是**①空转**那一档：今天它必然全绿，而它是不是真的会红没人知道。
 * 所以下面每条判据都配一段**故意改坏的 YAML**，逐条要求它当场红 ——
 * 抽掉哪一条判据，对应那段坏 YAML 就会溜过去。
 *
 * ⚠️ **别把这份文件说成"N 条判据 × M 条腿"** —— 它跑出来是**一个扁平的用例数**：
 * 每条腿一条（把七条判据一次跑完、任一条不过就是这条腿红）+ 一条扫描地板
 * + 一条基准夹具 + 每段坏 YAML 一条。早先我在 PR 描述里写成"六条判据 × 五条腿"，
 * 那是一句听起来更大、而机器数不出来的话。**以脚本最后打印的那个数为准。**
 *
 * 用法：`node scripts/ci/selftest-undecided-wiring.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readFileSafe = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/**
 * `sum-undecided.mjs` 读的是哪个字段 —— **从它自己的源码里抠**，不另抄一份。
 * 抄一份就又多了一处会漂的名字，而这份文件正是为此存在的。
 */
const SUM_FIELD = (() => {
  const src = readFileSafe(join(REPO, 'scripts', 'ci', 'sum-undecided.mjs')) ?? '';
  return src.match(/arg\('--field',\s*'([^']+)'\)/)?.[1] ?? 'unknowns';
})();
const WF_DIR = join(REPO, '.github', 'workflows');

let cases = 0;
let failures = 0;
const say = (s = '') => console.log(s);
const ok = (name) => {
  cases += 1;
  say(`  ✔ ${name}`);
};
const bad = (name, why) => {
  cases += 1;
  failures += 1;
  say(`  ✘ ${name}\n      ${why}`);
};

/** `${{ matrix.label }}` / `${{matrix.label}}` → `{label}`，好让两侧可以逐字比。 */
const normLabel = (s) => String(s ?? '').replace(/\$\{\{\s*matrix\.label\s*\}\}/g, '{label}');

/** 把一个 job 的所有 step 摊平（含它们的 `run` / `with` / `id` / `name`）。 */
function stepsOf(doc) {
  const out = [];
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    for (const s of job?.steps ?? []) out.push({ jobName, ...s });
  }
  return out;
}

/**
 * 从一份 workflow 里把那条管道的六个名字抠出来。
 * 抠不到就返回 `null` —— 调用方据此判断"这条腿根本没接这条管道"（不是失败）。
 */
export function extractWiring(text) {
  const doc = parse(text);
  const steps = stepsOf(doc);

  const sumStep = steps.find((s) => /sum-undecided\.mjs/.test(String(s.run ?? '')));
  if (!sumStep) return null;

  const run = String(sumStep.run);
  const tpl = run.match(/--file-template\s+'([^']+)'/)?.[1] ?? null;

  /*
   * ⚠️ **按行取，不要用一个正则去啃。** `--undecided-out` 的值里合法地含空格：
   *   `e2e-runtime.yml:259` 写的是**不带引号**的
   *   `--undecided-out e2e-runtime-undecided-${{ matrix.label }}.json \`
   *   —— `${{ matrix.label }}` 内部有空格，`[^\s]+` 会在 `${{` 后面就断掉，
   *   于是抠出半个文件名、和模板永远对不上 ⇒ 这个守卫会**恒红**。
   *   （恒红的守卫和恒绿的一样没用，只是让人更快学会无视它。）
   */
  const outs = [];
  const FLAG = '--undecided-out';
  for (const s of steps) {
    for (const line of String(s.run ?? '').split('\n')) {
      const i = line.indexOf(FLAG);
      if (i < 0) continue;
      let v = line.slice(i + FLAG.length).trim();
      v = v.replace(/\\\s*$/, '').trim(); // 行尾的续行反斜杠
      v = v.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
      outs.push(normLabel(v));
    }
  }

  const uploads = steps
    .filter((s) => /upload-artifact/.test(String(s.uses ?? '')))
    .map((s) => ({
      name: normLabel(s.with?.name),
      path: normLabel(s.with?.path),
      ifNoFiles: s.with?.['if-no-files-found'],
      cond: String(s.if ?? ''),
    }))
    .filter((u) => /undecided/.test(u.name));

  const download = steps
    .filter((s) => /download-artifact/.test(String(s.uses ?? '')))
    .map((s) => String(s.with?.pattern ?? ''))
    .find((p) => /undecided/.test(p));

  const emitStep = steps.find((s) => /emit-e2e-attestation\.mjs/.test(String(s.run ?? '')));

  /*
   * ★ R7 用：`--undecided-out` 是哪个脚本写的 —— 从同一条 `run` 里把
   *   `node scripts/ci/<x>.mjs` 抠出来。抠不到就返回 null，R7 会说"查不了"
   *   （而不是默默跳过：查不了和查过了是两回事）。
   */
  let producer = null;
  for (const st of steps) {
    const run = String(st.run ?? '');
    if (!run.includes('--undecided-out')) continue;
    producer = run.match(/node\s+(scripts\/ci\/[\w.-]+\.mjs)/)?.[1] ?? null;
    if (producer) break;
  }

  return {
    producer,
    tpl,
    outs,
    uploads,
    download,
    sumId: sumStep.id ?? null,
    emitRun: emitStep ? String(emitStep.run) : null,
  };
}

/** 七条判据（R1–R7）。返回一个问题清单（空 = 这条腿接线是通的）。 */
export function checkWiring(w) {
  const problems = [];
  if (!w.tpl) {
    problems.push("R1 求和步骤里找不到 `--file-template '…'`");
    return problems;
  }
  const prefix = w.tpl.includes('{label}') ? w.tpl.slice(0, w.tpl.indexOf('{label}')) : null;
  if (prefix === null) problems.push(`R1 --file-template 里没有 {label} 占位符：${w.tpl}`);

  // R1：每一个 --undecided-out 都必须与模板同名
  if (w.outs.length === 0) problems.push('R1 没有任何一步传 `--undecided-out` —— 管道的源头是空的');
  for (const o of w.outs) {
    if (o !== w.tpl) problems.push(`R1 --undecided-out 与 --file-template 对不上：${o} ≠ ${w.tpl}`);
  }

  // R2：upload 的 name / path
  if (w.uploads.length === 0) problems.push('R2 没有上传那份覆盖面计数的 upload-artifact 步骤');
  for (const u of w.uploads) {
    const wantName = w.tpl.replace(/\.json$/, '');
    if (u.name !== wantName) problems.push(`R2 upload name 对不上：${u.name} ≠ ${wantName}`);
    if (u.path !== w.tpl) problems.push(`R2 upload path 对不上：${u.path} ≠ ${w.tpl}`);
    if (u.ifNoFiles !== 'warn') {
      problems.push(
        `R2 覆盖面那份 artifact 的 if-no-files-found 应当是 warn（实得 ${u.ifNoFiles}）——` +
          ' error 会让"脚本没来得及写这个文件"在这里再红一次，而它该由下游收敛成 null',
      );
    }
    if (!/!cancelled\(\)/.test(u.cond)) {
      problems.push(
        'R2 覆盖面那份 artifact 的上传必须带 `if: ${{ !cancelled() }}` ——' +
          ' 一次红跑的未决清单恰恰是最想看的东西',
      );
    }
  }

  // R3：download 的 pattern 必须覆盖得住 upload 的 name
  if (prefix !== null) {
    const wantPattern = `${prefix}*`;
    if (w.download !== wantPattern) {
      problems.push(`R3 download pattern 对不上：${w.download} ≠ ${wantPattern}`);
    }
  }

  // R4/R5/R6：emit 那一行
  if (!w.emitRun) {
    problems.push('R4 找不到 emit-e2e-attestation.mjs 那一步');
  } else {
    if (!w.sumId)
      problems.push('R4 求和那一步没有 `id:` —— 下游取不到它的 outputs（会静默传空串）');
    const wantExpr = new RegExp(
      `\\$\\{\\{\\s*steps\\.${w.sumId ?? '\\w+'}\\.outputs\\.undecided_flag\\s*\\}\\}`,
    );
    if (!wantExpr.test(w.emitRun)) {
      problems.push(`R4 emit 那一行没有读 steps.${w.sumId}.outputs.undecided_flag`);
    }
    if (/--undecided\s+\d/.test(w.emitRun)) {
      problems.push(
        'R5 🔴 emit 那一行还写死着 `--undecided <数字>` —— 接了线就不许再写死，' +
          '否则那个数字永远不会跟着实际情况变（「恒为 N」是一句会过期的话）',
      );
    }
    if (/"\$\{\{\s*steps\.\w+\.outputs\.undecided_flag\s*\}\}"/.test(w.emitRun)) {
      problems.push(
        'R6 那个插值被加了引号 —— `"--undecided 3"` 会变成一个 argv 词，' +
          '`arg()` 找不到 `--undecided`，于是**静默**退回 null（与断线同形）',
      );
    }
  }

  /*
   * R7：JSON 键。`sum-undecided.mjs` 默认读 `unknowns`；写文件的那个审计脚本
   * 必须真的写这个键。两边任一侧改名 ⇒ 读不到 ⇒ 警告 ⇒ null ⇒ 退出码 0，
   * **而 R1–R6 全绿**。这是第八处手写，也是此前唯一没人守的那处。
   */
  if (!w.producer) {
    problems.push(
      'R7 抠不出是哪个脚本写的那份文件（`--undecided-out` 那条 run 里没有 node 脚本名）',
    );
  } else {
    const src = readFileSafe(join(REPO, w.producer));
    if (src === null) {
      problems.push(`R7 找不到写文件的脚本：${w.producer}`);
    } else if (!new RegExp(`\\b${SUM_FIELD}\\s*:`).test(src)) {
      problems.push(
        `R7 ${w.producer} 里找不到 \`${SUM_FIELD}:\` 这个键 —— ` +
          `而 sum-undecided.mjs 读的就是它。改了名两边就对不上了，` +
          '表现是"警告 + 收敛成 null + 退出码 0"，五个文件名却仍然逐字对齐。',
      );
    }
  }
  return problems;
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('── ① 仓里每条接了这条管道的腿，六条判据都必须过 ──────────────────────────');

/*
 * ⚠️ 「用没用这条管道」的判据是**有没有一个 step 真的在跑 `sum-undecided.mjs`**，
 *   不是"文件里提没提到它"。`e2e-import.yml` 的注释里提到了它，而那条腿**刻意
 *   不走这条管道**：它的 `--undecided` 由 `inputs.skipF1` 推出来
 *   （`--undecided ${{ inputs.skipF1 && '1' || '0' }}`），并且在 :312-330 有一整段
 *   仍然成立的论证。按"提到就算"去查，会给那条腿判一个**它没有犯的错**（R5）——
 *   而对着正确的东西报红，比不报还坏。
 */
const wfFiles = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));
const wired = [];
for (const f of wfFiles.sort()) {
  const w = extractWiring(readFileSync(join(WF_DIR, f), 'utf8'));
  if (w === null) continue; // 这条腿没接这条管道 —— 不是失败
  wired.push(f);
  const problems = checkWiring(w);
  if (problems.length === 0) ok(`${f}（模板 ${w.tpl}）`);
  else bad(f, problems.join('\n      '));
}

/*
 * ★ 扫描不是空集的地板。本仓已有多种"对空集返回绿"的形态，
 *   守卫的第一条断言必须是"我真的看到东西了"。
 */
cases += 1;
if (wired.length >= 5) {
  say(`  ✔ 扫到 ${wired.length} 条接了这条管道的腿（地板 5）：${wired.join(', ')}`);
} else {
  failures += 1;
  say(`  ✘ 只扫到 ${wired.length} 条腿（地板 5）—— 扫描本身坏了，不是"真的没有腿在用它"`);
}

say('');
say('── ② 反向证明：每条判据配一段故意改坏的 YAML，必须当场红 ──────────────────');

/** 一份**最小**的、接线正确的 workflow —— 下面每个用例只改坏它的一处。 */
const GOOD = `
name: fixture
on: { workflow_dispatch: {} }
jobs:
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - name: 跑审计
        run: |
          node scripts/ci/e2e-browser-audit.mjs \\
            --undecided-out "e2e-fix-undecided-\${{ matrix.label }}.json"
      - name: 留档
        if: \${{ !cancelled() }}
        uses: actions/upload-artifact@v6
        with:
          name: e2e-fix-undecided-\${{ matrix.label }}
          path: e2e-fix-undecided-\${{ matrix.label }}.json
          if-no-files-found: warn
  attest:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@v7
        with:
          pattern: e2e-fix-undecided-*
          path: undecided
          merge-multiple: true
      - name: 求和
        id: sum
        run: |
          node scripts/ci/sum-undecided.mjs --dir undecided \\
            --expect-labels "$PLATFORMS" \\
            --file-template 'e2e-fix-undecided-{label}.json' \\
            --github-output "$GITHUB_OUTPUT"
      - name: 写凭证
        run: |
          node scripts/ci/emit-e2e-attestation.mjs --leg fix \\
            \${{ steps.sum.outputs.undecided_flag }} --out dist/e2e-attest.json
`;

cases += 1;
{
  const problems = checkWiring(extractWiring(GOOD));
  if (problems.length === 0) say('  ✔ 基准夹具（接线正确）是绿的 —— 否则下面每条红都不作数');
  else {
    failures += 1;
    say(`  ✘ 基准夹具就红了，这份反向证明什么都证不了：\n      ${problems.join('\n      ')}`);
  }
}

/** [名字, 把 GOOD 改坏的替换, 期望命中的判据编号] */
const BREAKAGES = [
  [
    'R1 审计写的文件名与求和模板差一个字（最常见的手滑）',
    (s) => s.replace('--undecided-out "e2e-fix-undecided-', '--undecided-out "e2e-fixx-undecided-'),
    'R1',
  ],
  [
    'R1 干脆没传 --undecided-out（源头是空的）',
    (s) => s.replace(/--undecided-out[^\n]*\n/, '\n'),
    'R1',
  ],
  [
    'R2 upload 的 name 漂了（artifact 名与文件名不同源）',
    (s) => s.replace('name: e2e-fix-undecided-', 'name: e2e-fix-cov-'),
    'R2',
  ],
  [
    'R2 覆盖面 artifact 写成 if-no-files-found: error（会为下游本该收敛的情况再红一次）',
    (s) => s.replace('if-no-files-found: warn', 'if-no-files-found: error'),
    'R2',
  ],
  [
    'R2 上传丢了 !cancelled()（红跑的未决清单从此看不到）',
    (s) => s.replace('if: ${{ !cancelled() }}\n        ', ''),
    'R2',
  ],
  [
    'R3 download pattern 与 upload name 对不上（下不到任何一格）',
    (s) => s.replace('pattern: e2e-fix-undecided-*', 'pattern: e2e-fix-coverage-*'),
    'R3',
  ],
  ['R4 求和那一步丢了 id:（下游静默拿到空串）', (s) => s.replace('        id: sum\n', ''), 'R4'],
  [
    'R5 🔴 接了线还写死 --undecided 0',
    (s) => s.replace('${{ steps.sum.outputs.undecided_flag }}', '--undecided 0'),
    'R5',
  ],
  [
    'R7 🔴 审计脚本把 JSON 键改了名（五个文件名仍逐字对齐，R1–R6 全绿）',
    (t) => t.replace('scripts/ci/e2e-browser-audit.mjs', 'scripts/ci/__no_such_producer__.mjs'),
    'R7',
  ],
  [
    'R6 那个插值被加了引号（--undecided 3 变成一个 argv 词，静默退回 null）',
    (s) =>
      s.replace(
        '${{ steps.sum.outputs.undecided_flag }}',
        '"${{ steps.sum.outputs.undecided_flag }}"',
      ),
    'R6',
  ],
];

for (const [name, breakIt, wantRule] of BREAKAGES) {
  const broken = breakIt(GOOD);
  if (broken === GOOD) {
    bad(name, '这段替换什么都没改到 —— 用例本身失效了（夹具改过而替换串没跟）');
    continue;
  }
  const problems = checkWiring(extractWiring(broken));
  const hit = problems.some((p) => p.startsWith(wantRule));
  if (hit) ok(name);
  else {
    bad(
      name,
      `期望命中 ${wantRule}，实得：${problems.length === 0 ? '（全绿 —— 这条判据没有牙齿）' : problems.join(' / ')}`,
    );
  }
}

say('');
say(`── ${cases} 条，失败 ${failures} 条 ──`);
if (failures > 0) {
  say('');
  say('✘ 覆盖面管道的接线守卫**没有过关**。');
  process.exit(1);
}
say('✔ 覆盖面管道：五条腿的六个名字都对得上，且每条判据都被证明会红。');
