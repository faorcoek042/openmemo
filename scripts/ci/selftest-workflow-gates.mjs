#!/usr/bin/env node
/**
 * 两道闸门的**反向验证**：证明它们真的会拦，而不是"改完看起来对"。
 *
 * 跑：`node scripts/ci/selftest-workflow-gates.mjs`（`pnpm test:ci-scripts` 会调）
 *
 * ── 为什么这份自检必须存在 ────────────────────────────────────────────────────────
 *
 * 这一周抓到了四道**其实从来没真正生效过**的守卫：零调用者、空集判通过、
 * 只证明"文本存在"、以及一条永远不会触发的兜底。这份文件是在同一族里新增两道闸，
 * 所以它必须先回答"你怎么知道它会拦"，而不是"我读了一遍 YAML 觉得对"。
 *
 * 本机没有 `act` / `actionlint` / docker，`schedule` 又**只在默认分支触发**
 * ⇒ 这两件事在 PR 上一次都跑不到。所以判据只能是：
 * **把 GitHub 已经写进文档的调度语义实现出来，然后对着真实的 YAML 逐格求值。**
 * 语义实现在 `scripts/ci/gha-expr.mjs`，它自己的单测在 `selftest-gha-expr.mjs`。
 *
 * ── 三组断言 ────────────────────────────────────────────────────────────────────
 *
 * **A 组（#102）**：`e2e-runtime` 的凭证作业在 `(审计 × 变异)` 全部结果组合下的调度真值表。
 *   核心两格：**审计绿 + 变异红 ⇒ 凭证发不出来**；**变异被跳过 ⇒ 凭证照发，
 *   但 `--mutations` 那一格必须渲染成 `skipped`**（跳过 ≠ 通过，且不许被吞掉）。
 *
 * **B 组（#91）**：所有带 `schedule:` 的腿都必须满足
 *
 *   > **`inputs` 全空时的行为，与 `inputs` 取各自 `default:` 时的行为逐字相同。**
 *
 *   `[实测 scheduled run 31526070085]` 已确证 `workflow_dispatch` 的 `default:`
 *   **不适用于** `schedule` 触发的运行（`inputs.*` 全是空串）。这条性质就是
 *   "兜底补齐了没有"的机器判据 —— 它对每一处 `${{ }}` 求值后逐点比对，
 *   不是查有没有出现 `||` 这几个字符。
 *
 * **C 组（反向验证，默认就跑，不是可选项）**：把 A/B 两组的修法**在内存里退回去**，
 *   断言对应的断言**真的变红**。一份"改完之后跑一遍绿了"的自检证明不了任何事 ——
 *   它同样会在护栏被删掉之后继续绿。C 组回答的是：**护栏没了的时候，这里会不会红。**
 *   ⚠️ 退回去的操作**只作用于内存里的字符串**，磁盘上的 workflow 一个字节都不动
 *   （PROTOCOL §10：「最终状态干净」救不了「过程中别人跑了一次」）。
 *
 * ── 它**查不了**什么（明写，别把它读成比它更强）────────────────────────────────
 *
 * · 它**不重新验证 GitHub 自己的语义**，只是把文档写明的那几条实现出来
 *   （默认 `success()`、状态函数解除默认、needs 的 skipped 会传染）。
 *   GitHub 哪天改语义，这份自检会继续绿而现实会变 —— 那种漂移只有真跑才看得见。
 *   A 组里那条「历史复现」就是为此存在的校准点：它拿修法**之前**的形状去跑，
 *   必须重现 `[实测 run 31568740737]` 真实发生过的事（审计绿+变异红 ⇒ 凭证照发）。
 * · 动态矩阵（`matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}`）算不出来，
 *   一律用占位符代入 —— 于是**只依赖 matrix 的表达式**在两个环境下必然相等，
 *   B 组对它们没有鉴别力。它鉴别的是**依赖 `inputs` 的那些**。
 * · runner 存不存在、action 的输入合不合法、shell 在 Windows 上跑不跑得起来：全不管。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { interpolate, simulateJobs } from './gha-expr.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WF_DIR = join(REPO_ROOT, '.github', 'workflows');

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
const is = (actual, expected, msg) =>
  actual === expected ? ok(msg) : bad(`${msg}\n      期望 ${expected}，实得 ${actual}`);

const section = (title) => {
  console.log('');
  console.log(`\x1b[1m── ${title}\x1b[0m`);
};

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 上下文的搭建：只有 `inputs` 是变量，其余一律**两个环境里取同一个占位值**
 *
 * 这是 B 组能成立的前提：如果 `github` / `matrix` / `steps` / `needs` 在两个环境里
 * 取值不同，比对出来的差异就说不清是"缺兜底"还是"环境不同"。所以除 `inputs` 外
 * 全部钉死成同一个占位符 —— 于是**任何差异都只可能来自 `inputs`**。
 *
 * ⚠️ 代价写清楚：`github.event_name` 也被钉死了，所以形如
 *    `github.event_name == 'schedule' || inputs.x` 的写法在 B 组眼里是"没差异"。
 *    本仓**不用**那种写法（兜底一律写在值这一层），但下一个人要是用了，
 *    B 组不会替他把关 —— 记在这儿。
 * ═══════════════════════════════════════════════════════════════════════════════════ */
const PLACEHOLDER = '⟨占位⟩';

/** 从 workflow 文本里把用到的 `steps.X.outputs.Y` / `needs.X.outputs.Y` 扫出来，建成具体对象。 */
function placeholderContexts(text) {
  const steps = {};
  for (const m of text.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
    steps[m[1]] ??= { outputs: {}, outcome: 'success', conclusion: 'success' };
    steps[m[1]].outputs[m[2]] = PLACEHOLDER;
  }
  for (const m of text.matchAll(/steps\.([A-Za-z0-9_-]+)\.(outcome|conclusion)/g)) {
    steps[m[1]] ??= { outputs: {}, outcome: 'success', conclusion: 'success' };
  }
  const needs = {};
  for (const m of text.matchAll(/needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
    needs[m[1]] ??= { result: 'success', outputs: {} };
    needs[m[1]].outputs[m[2]] = PLACEHOLDER;
  }
  for (const m of text.matchAll(/needs\.([A-Za-z0-9_-]+)\.result/g)) {
    needs[m[1]] ??= { result: 'success', outputs: {} };
  }
  return { steps, needs };
}

/** matrix：静态 `include` 就逐格用真值；动态的（fromJSON）只能占位。 */
function matrixCombos(job) {
  const inc = job?.strategy?.matrix?.include;
  if (Array.isArray(inc) && inc.length > 0) return inc;
  const keys = new Set(['label', 'target', 'artifact', 'runner', 'only', 'leg', 'os']);
  const m = {};
  for (const k of keys) m[k] = PLACEHOLDER;
  return [m];
}

/** `inputs` 的两个环境。A = 各自的 `default:`（`workflow_dispatch` 语义）；B = 全空（`schedule` 实测）。 */
function inputEnvs(doc) {
  const decl = doc?.on?.workflow_dispatch?.inputs ?? {};
  const names = Object.keys(decl);
  const defaults = {};
  const empties = {};
  for (const n of names) {
    const d = decl[n] ?? {};
    // 布尔输入在 dispatch 下拿到的是真正的布尔；string/choice/number 拿到字符串。
    defaults[n] = d.type === 'boolean' ? (d.default ?? false) : String(d.default ?? '');
    // `[实测 run 31526070085]`：schedule 下每一个 inputs.* 都是长度为 0 的空串。
    empties[n] = '';
  }
  return { names, defaults, empties };
}

/** 走遍一个 job 里所有含 `${{` 的字符串，产出 `{ path, raw }`。 */
function* templateSites(node, path = '') {
  if (typeof node === 'string') {
    if (node.includes('${{')) yield { path, raw: node };
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) yield* templateSites(v, `${path}[${i}]`);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) yield* templateSites(v, `${path}.${k}`);
  }
}

function renderSite(raw, ctx) {
  try {
    return interpolate(raw, ctx);
  } catch (e) {
    // 求值不了也没关系：只要两个环境**同样**求值不了，就不是 inputs 造成的差异。
    return `⟨求值失败: ${String(e.message).slice(0, 60)}⟩`;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * 豁免：兜底不在 `${{ }}` 这一层，或者这一处**根本不做决定**
 *
 * ⚠️ 豁免**必须自带证明**。一张只写"这个我知道，放过它"的白名单，就是本周抓到的
 *    第三道假守卫（只证明文本存在）的近亲 —— 它会在被豁免的那件事悄悄消失之后
 *    继续绿。所以每一条豁免都带一个 `proven(step)`：**证明不成立时，这条豁免作废，
 *    差异照报**。也就是说，删掉下游那个 `|| "all"` 会当场红。
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** `run:` 里除注释与空行外，每一行都是 `echo`／`printf`。也就是**这一步只打印**。 */
const onlyPrints = (step) => {
  const body = String(step?.run ?? '');
  if (!body.trim()) return false;
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .every((l) => /^(echo|printf)\b/.test(l));
};

/** `run:` 里对这个 env 名做了默认值兜底（JS 的 `process.env.X || "d"` 或 shell 的 `${X:-d}`）。 */
const fallsBackDownstream = (envName, dflt) => (step) => {
  const body = String(step?.run ?? '');
  const js = new RegExp(String.raw`process\.env\.${envName}\s*\|\|\s*["']${dflt}["']`);
  const sh = new RegExp(String.raw`\$\{${envName}:-${dflt}\}`);
  return js.test(body) || sh.test(body);
};

const EXEMPTIONS = [
  {
    file: 'e2e-allcomponents.yml',
    job: 'plan',
    pathRe: /\.env\.RAW_(MODE|BUDGET|LEGS|BUNDLE)$/,
    reason:
      '「观测 inputs」那一步**刻意打印原始值、不带兜底** —— 补上兜底就把待测的现象消灭了。' +
      '它是 run 31526070085 那条事实的产地，也是下次 GitHub 改语义时最先说话的地方。',
    proven: onlyPrints,
  },
  {
    file: 'e2e-allcomponents.yml',
    job: 'plan',
    pathRe: /\.env\.LEGS$/,
    reason:
      '兜底在下游脚本里：`const legs = process.env.LEGS || "all"`（env 传值，不把 inputs 拼进脚本正文）',
    proven: fallsBackDownstream('LEGS', 'all'),
  },
  {
    file: 'e2e-record.yml',
    job: 'plan',
    pathRe: /\.env\.LEGS$/,
    reason: '同上：`const legs = process.env.LEGS || "all"`，与 allcomponents 同一口径',
    proven: fallsBackDownstream('LEGS', 'all'),
  },
];

/** 返回 `{held}`（豁免成立，跳过这处差异）或 `{broken}`（豁免的证明不成立 ⇒ 照报，并附上原因）。 */
function exemption(file, jobName, path, job) {
  const hit = EXEMPTIONS.find((e) => e.file === file && e.job === jobName && e.pathRe.test(path));
  if (!hit) return null;
  exemptionsConsidered.add(`${file}#${jobName}#${hit.pathRe}`);
  const m = /\.steps\[(\d+)\]/.exec(path);
  const step = m ? (job?.steps ?? [])[Number(m[1])] : null;
  if (step && hit.proven(step)) return { held: true };
  return {
    broken:
      `豁免的证明**不成立**了（理由本来是：${hit.reason}）—— ` +
      '要么下游那个兜底被删了，要么这一步不再只是打印。豁免作废，这处差异照报。',
  };
}

/** 用过哪些豁免。防"白名单里躺着一条早就没有主语的豁免"。 */
const exemptionsConsidered = new Set();

/**
 * B 组的核心：返回 `inputs` 全空 与 `inputs` 取默认值 两个环境下**渲染结果不同**的所有位置。
 * 返回 `[{ file, job, combo, path, empty, dflt, raw }]`。
 */
function scheduleDivergences(file, text) {
  const doc = parse(text);
  const { defaults, empties } = inputEnvs(doc);
  const { steps, needs } = placeholderContexts(text);
  const out = [];
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    for (const [ci, matrix] of matrixCombos(job).entries()) {
      const base = {
        github: {
          event_name: PLACEHOLDER,
          ref: 'refs/heads/master',
          repository: 'o/r',
          run_id: '1',
          sha: '0'.repeat(40),
          token: PLACEHOLDER,
          workspace: PLACEHOLDER,
        },
        matrix,
        steps,
        needs,
        env: {},
        job: { status: 'success' },
        runner: { os: 'Linux', temp: '/tmp' },
        vars: {},
        secrets: {},
      };
      const ctxEmpty = { ...base, inputs: empties, github: { ...base.github, event: { inputs: empties } } }; // prettier-ignore
      const ctxDflt = { ...base, inputs: defaults, github: { ...base.github, event: { inputs: defaults } } }; // prettier-ignore
      for (const { path, raw } of templateSites(job, `jobs.${jobName}`)) {
        const a = renderSite(raw, ctxEmpty);
        const b = renderSite(raw, ctxDflt);
        if (a === b) continue;
        const ex = exemption(file, jobName, path, job);
        if (ex?.held) continue;
        out.push({
          file,
          job: jobName,
          combo: matrix.label ?? matrix.leg ?? String(ci),
          path,
          empty: a,
          dflt: b,
          exemptBroken: ex?.broken ?? null,
          raw: raw.replace(/\s+/g, ' ').trim().slice(0, 110),
        });
      }
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * A 组（#102）：`e2e-runtime` 凭证作业的调度真值表
 * ═══════════════════════════════════════════════════════════════════════════════════ */

const RUNTIME_FILE = join(WF_DIR, 'e2e-runtime.yml');
const runtimeText = readFileSync(RUNTIME_FILE, 'utf8');

/**
 * 跑一格：给定 inputs 与各 job 的"若跑则结果"，返回全部 job 的最终状态。
 * `text` 可以是被 C 组改过的版本 —— A 组和 C 组共用同一段模拟代码，
 * 否则"退回去也绿"可能只是因为两段代码不一样。
 */
function runtimeSchedule(text, { inputs, results = {}, workflowCancelled = false }) {
  const doc = parse(text);
  const { steps, needs } = placeholderContexts(text);
  return simulateJobs({
    jobs: doc.jobs,
    results,
    ctx: {
      inputs,
      github: { event_name: 'workflow_dispatch', ref: 'refs/heads/master' },
      steps,
      needs,
      __workflowCancelled: workflowCancelled,
    },
  });
}

const ARTIFACT_RUN = { bundleSource: 'artifact', bundlesRunId: '31568189189', resumeTest: true, mutations: true }; // prettier-ignore
const CHECKOUT_RUN = { bundleSource: 'checkout', bundlesRunId: '', resumeTest: true, mutations: true }; // prettier-ignore
const SCHEDULE_RUN = { bundleSource: '', bundlesRunId: '', resumeTest: '', mutations: '' };

section('A 组（#102）· e2e-runtime 凭证作业的三态真值表');

{
  const t = runtimeText;

  // A1 —— 全绿：凭证发得出来。（不先钉这一格，后面每一格"发不出来"都可能只是因为它从来发不出来。）
  is(
    runtimeSchedule(t, { inputs: ARTIFACT_RUN }).attest,
    'success',
    'A1 artifact 模式 + 审计绿 + 变异绿 ⇒ 凭证**发得出来**',
  );

  // A2 —— 🔴 本次要修的那件事：审计绿、变异红 ⇒ 凭证必须发不出来。
  is(
    runtimeSchedule(t, { inputs: ARTIFACT_RUN, results: { mutations: 'failure' } }).attest,
    'skipped',
    'A2 🔴 审计绿 + **变异红** ⇒ 凭证作业被跳过，**凭证根本不存在**（run 31568740737 那次发出来了）',
  );

  // A3 —— 变异被取消，同样不发（取消 ≠ 通过）。
  is(
    runtimeSchedule(t, { inputs: ARTIFACT_RUN, results: { mutations: 'cancelled' } }).attest,
    'skipped',
    'A3 变异被**取消** ⇒ 凭证发不出来',
  );

  // A4 —— 审计红：原本就该拦，别在修 A2 的时候把它弄丢了。
  is(
    runtimeSchedule(t, { inputs: ARTIFACT_RUN, results: { audit: 'failure' } }).attest,
    'skipped',
    'A4 **审计红** + 变异绿 ⇒ 凭证发不出来（`!cancelled()` 解除默认 success 之后，这条靠手写的 needs.audit.result 补回来）',
  );

  // A5 —— 整条 run 被取消。
  is(
    runtimeSchedule(t, { inputs: ARTIFACT_RUN, workflowCancelled: true }).attest,
    'skipped',
    'A5 整条 run 被取消 ⇒ 凭证发不出来',
  );

  // A6 —— 🔴 变异被跳过：凭证**照发**（否则 mutations=false 会让发布闸门直接卡死）。
  const skipRun = { ...ARTIFACT_RUN, mutations: false };
  const skipped = runtimeSchedule(t, { inputs: skipRun });
  is(skipped.mutations, 'skipped', 'A6a mutations=false ⇒ 变异作业被跳过');
  is(
    skipped.attest,
    'success',
    'A6b 变异被跳过 ⇒ 凭证**仍然发得出来**（这是有意的：不发会让发布闸门卡死）',
  );

  // A7 —— 🔴 而"被跳过"这件事必须**在凭证里说出来**，不许被吞掉。
  const doc = parse(t);
  const emitStep = (doc.jobs.attest.steps ?? []).find((s) => /--leg runtime/.test(String(s.run ?? ''))); // prettier-ignore
  if (!emitStep) {
    bad('A7 找不到 attest 作业里那条 `emit-e2e-attestation.mjs --leg runtime` 的步骤');
  } else {
    /*
     * ★ 2026-08-17：`--mutations` 从两态变三态（关掉 v0.7.3 已知边界第 13 条）。
     *   「跑没跑」仍由 `needs.mutations.result` 决定，而「跑了之后每条有没有结论」
     *   来自汇总步骤 `steps.mut.outputs.mutations_state`（`ran` | `ran-unverified`）。
     *   所以这里的夹具要能喂第二个维度 —— 少喂它，下面三条会渲染出 `--mutations ""`。
     */
    const render = (mutResult, mutState = 'ran', unverifiedFlag = '') =>
      interpolate(String(emitStep.run), {
        needs: {
          audit: { result: 'success', outputs: { bundle_run_id: '31568189189' } },
          mutations: { result: mutResult, outputs: {} },
        },
        steps: {
          sum: { outputs: { undecided_flag: '--undecided 0' } },
          mut: { outputs: { mutations_state: mutState, unverified_flag: unverifiedFlag } },
        },
        inputs: skipRun,
      });
    const asSkipped = render('skipped');
    const asRan = render('success');
    const asUnverified = render(
      'success',
      'ran-unverified',
      '--unverified-mutations "darwin-arm64:M-driver-lie"',
    );
    is(
      /--mutations "skipped"/.test(asSkipped),
      true,
      'A7a 变异被跳过时，写凭证那一行渲染成 `--mutations "skipped"` —— 跳过被**说出来了**',
    );
    is(
      /--mutations "ran"/.test(asRan),
      true,
      'A7b 变异跑过且每条都有结论时渲染成 `--mutations "ran"`',
    );
    is(
      asSkipped === asRan,
      false,
      'A7c 两种情形渲染出的命令**不一样** —— 否则凭证里两者长得一模一样，等于没说',
    );
    /*
     * 🔴 A7d/A7e：**「跑了但有一条什么都没证明」必须渲染成另一句话，并带上是哪几条。**
     *   此前 `success` 一律渲染成 `ran`，于是退出码 3（跑了但什么都没证明）
     *   被记成好消息 —— darwin 那一格从 08-10 起每一轮都是这样。
     */
    is(
      /--mutations "ran-unverified"/.test(asUnverified),
      true,
      'A7d 有变异什么都没证明时渲染成 `--mutations "ran-unverified"`',
    );
    is(
      /--unverified-mutations "darwin-arm64:M-driver-lie"/.test(asUnverified),
      true,
      'A7e 而且**说得出是哪几条** —— 只报状态不报清单等于报警不给线索',
    );
    is(asUnverified === asRan, false, 'A7f 「都有结论」与「有一条没结论」渲染出的命令**不一样**');
  }

  // A8 —— 模式门：checkout（默认，也是 schedule 落到的那一档）不发凭证。
  is(
    runtimeSchedule(t, { inputs: CHECKOUT_RUN }).attest,
    'skipped',
    'A8 checkout 模式（默认）不发凭证',
  );
  is(
    runtimeSchedule(t, { inputs: SCHEDULE_RUN }).attest,
    'skipped',
    'A9 schedule（inputs 全空）不发凭证 —— 与 checkout 默认档一致',
  );
  is(
    runtimeSchedule(t, { inputs: SCHEDULE_RUN }).mutations,
    'success',
    'A10 🔴 schedule（inputs 全空）下**变异矩阵照跑**（#91：这一格此前是 skipped）',
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * B 组（#91）：带 cron 的腿，「空 inputs ≡ default inputs」
 * ═══════════════════════════════════════════════════════════════════════════════════ */

section('B 组（#91）· 定时腿：inputs 全空的行为必须与 default: 逐字相同');

const allFiles = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const scheduled = allFiles
  .filter((f) => {
    const d = parse(readFileSync(join(WF_DIR, f), 'utf8'));
    return d?.on?.schedule != null;
  })
  .sort();

/*
 * 防"空集判通过"：这一组的主语是"带 cron 的 workflow"。一个都没有的话，
 * 下面的循环会跑零次然后报绿 —— 那正是本周抓到的第二道假守卫的形状。
 */
is(scheduled.length >= 6, true, `B0 带 cron 的 workflow 有 ${scheduled.length} 个（至少 6 条腿）`);

/**
 * ★ 2026-08-23：B0b 原文是「带 cron 的**都是** e2e 腿」。
 *
 * `ci-crossplatform.yml` 补 cron 时它当场红了 —— **红得完全正确**，它拦住的是
 * 「一个新东西被挂上定时跑，而没人想过它的空 inputs 行为」。所以这里**不删它**，
 * 只把它从"都是 e2e"改成"要么是 e2e，要么在下面这张表里逐条说清楚"。
 *
 * 表里每一条都要回答两个问题，否则不许进来：
 *   ① 它有没有 `inputs:`？没有 ⇒ #91 那整族问题不适用（不是被忽略，是不存在）。
 *   ② 它为什么不该有 `attest` 作业？（D 组的主语是发布凭证腿，不是所有定时跑。）
 */
const NON_E2E_SCHEDULED = {
  'proxy-coverage.yml': {
    noInputs: true,
    why:
      '代理覆盖逐条实测。没有 inputs ⇒ #91 的「schedule 下 default: 不生效」不适用。' +
      '不发凭证：它证的是"设置页说已生效的代理真的覆盖了每一条出网路径"，不是"这批产物可发布"。' +
      '2026-08-23 首次在 CI 上跑绿（run 32656062961）之后才挂 cron —— 顺序是判据要求的。',
  },
  'ci-crossplatform.yml': {
    noInputs: true,
    why:
      '跨平台探针。没有 inputs ⇒ #91 的「schedule 下 default: 不生效」不适用。' +
      '不发凭证：它证的是"今天 macOS/Windows 上什么是坏的"，不是"这批产物可发布"。',
  },
};

const unexplained = scheduled.filter((f) => !f.startsWith('e2e-') && NON_E2E_SCHEDULED[f] == null);
is(
  unexplained.length,
  0,
  `B0b 带 cron 的要么是 e2e 腿，要么在 NON_E2E_SCHEDULED 里说清楚` +
    `${unexplained.length ? `（没交代的：${unexplained.join(', ')}）` : ''}`,
);

/*
 * ★ 反向：表里登记了、但其实**没有** cron 的条目必须红。
 *   否则这张表会变成一张只增不减的许可证清单 —— 某条 workflow 的 cron 被撤掉之后，
 *   它的豁免还留着，下一个人加回 cron 时就不会再被问那两个问题了。
 */
const staleExempt = Object.keys(NON_E2E_SCHEDULED).filter((f) => !scheduled.includes(f));
is(
  staleExempt.length,
  0,
  `B0c NON_E2E_SCHEDULED 里没有过期条目` +
    `${staleExempt.length ? `（这些已经没有 cron 了，请删掉：${staleExempt.join(', ')}）` : ''}`,
);

/* ★ 表里声称"没有 inputs"的，必须真的没有 —— 声明与事实脱钩就等于没声明。 */
for (const [f, meta] of Object.entries(NON_E2E_SCHEDULED)) {
  if (!meta.noInputs || !scheduled.includes(f)) continue;
  const d = parse(readFileSync(join(WF_DIR, f), 'utf8'));
  is(
    d?.on?.workflow_dispatch?.inputs == null,
    true,
    `B0d ${f}：登记里写着"没有 inputs"，就必须真的没有 —— ` +
      `加了 inputs 请先读 e2e-import.yml:35-52 那段 #91，再回来补兜底并改这条登记`,
  );
}

for (const f of scheduled) {
  const text = readFileSync(join(WF_DIR, f), 'utf8');
  const div = scheduleDivergences(f, text);
  if (div.length === 0) {
    ok(`B ${f}：inputs 全空与取 default: 时，每一处 \${{ }} 渲染结果都相同`);
  } else {
    bad(
      `B ${f}：有 ${div.length} 处在 inputs 全空时与 default: **不同** —— ` +
        `定时跑会在这些地方悄悄换行为（不是变红）：\n` +
        div
          .map(
            (d) =>
              `      · ${d.job}[${d.combo}] ${d.path}` +
              (d.exemptBroken ? `\n        ⚠️ ${d.exemptBroken}` : '') +
              `\n` +
              `        空 inputs → ${JSON.stringify(d.empty)}\n` +
              `        默认值   → ${JSON.stringify(d.dflt)}\n` +
              `        原文     → ${d.raw}`,
          )
          .join('\n'),
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * D 组：**没钉批次就不发凭证** —— 六条腿一条不落
 *
 * 这一条与 B 组不是同一件事，别把它们读混：
 *   · B 组问「定时跑和手动跑做的事一不一样」；
 *   · D 组问「**这次跑到底有没有把要背书的那批包钉死**」。
 *
 * 为什么必须钉死：`bundleRunId` 留空时，三个平台各自去解析"最近一次带本平台产物的
 * 成功 run"，完全可能落到**不同批**的包上；而凭证名只取**一个** run id
 * （矩阵 job 的 output 由最后完成的那一格写入，无一致性保证）。
 * 于是凭证会写着"三平台验过 run X"，而其中某些平台验的根本不是 X ——
 * **那不是覆盖面不足，那是伪证**。`e2e-allcomponents` 早就为此立了这条规矩
 * （"自动解析的 run 不发凭证"），#91 把它铺到其余五条腿上。
 *
 * 加了 cron 之后这件事从"少见"变成"每天一次"，所以它必须有机器判据。
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** 在给定 inputs 下，模拟整条 workflow，返回 `attest` 作业的最终状态。 */
function attestStateUnder(text, inputs) {
  const doc = parse(text);
  if (!doc?.jobs?.attest) return '⟨没有 attest 作业⟩';
  const { steps, needs } = placeholderContexts(text);
  return simulateJobs({
    jobs: doc.jobs,
    results: {},
    ctx: {
      inputs,
      github: { event_name: 'workflow_dispatch', ref: 'refs/heads/master' },
      steps,
      needs,
    },
  }).attest;
}

/**
 * 每条腿"把批次钉死"长什么样。**这张表就是各腿输入名不一致的那份账**
 * （`bundlesRunId` 多一个 s、`assembleFromSource` 要显式关掉、`legs` 要 all……），
 * 与 `verify-e2e-attestation.mjs` 的 DISPATCH_HINT 说的是同一件事。
 */
const PINNED = {
  // `runIdKey` = 这条腿"钉批次"的那个输入名。**把它挖空**就得到「模式对、但没钉批次」
  // 那一格 —— D 组第三条断言问的就是它。两张表合成一张，省得哪天只改一边。
  // ⚠️ 名字六条腿不统一（`bundlesRunId` 多一个 s），这正是它值得写成数据的理由。
  'e2e-runtime.yml': { runIdKey: 'bundlesRunId', inputs: { bundleSource: 'artifact', bundlesRunId: '31568189189', mutations: true, resumeTest: true } }, // prettier-ignore
  'e2e-browser.yml': { runIdKey: 'bundleRunId', inputs: { assembleFromSource: false, bundleRunId: '31568189189', diagnoseDownload: '' } }, // prettier-ignore
  'e2e-notes.yml': { runIdKey: 'bundleRunId', inputs: { assembleFromSource: false, bundleRunId: '31568189189' } }, // prettier-ignore
  'e2e-import.yml': { runIdKey: 'bundleRunId', inputs: { bundleRunId: '31568189189', skipF1: false } }, // prettier-ignore
  'e2e-record.yml': { runIdKey: 'bundleRunId', inputs: { bundleRunId: '31568189189', legs: 'all' } }, // prettier-ignore
  'e2e-allcomponents.yml': { runIdKey: 'bundleRunId', inputs: { bundleRunId: '31568189189', legs: 'all', mode: 'sample', modelBudgetMb: '2600' } }, // prettier-ignore
};

section('D 组 · 六条腿一律「没钉批次就不发凭证」');

/*
 * 防"空集判通过"：这张表必须覆盖每一条**发凭证的**定时腿，一条都不许漏。
 *
 * ⚠️ 主语在 2026-08-23 收窄过一次，理由要写清楚，否则下一个人会以为是在放水：
 *   原来写的是"每条带 cron 的腿"。`ci-crossplatform.yml` 补 cron 之后它红了，
 *   而那个红**是主语错了**，不是漏登记 —— D 组问的是「没钉批次就不发凭证」，
 *   而跨平台探针**根本不发凭证**（它没有也不该有 `attest` 作业）。
 *   把一个不发凭证的东西塞进这张表，只会逼人给它编一个 `runIdKey`。
 *
 * 收窄之后仍然守得住的：**发凭证的腿一条都不许漏**（下面 `attestLegs` 的取法是
 * "有 attest 作业"，不是"名字以 e2e- 开头" —— 后者靠命名，前者靠事实）。
 */
const attestLegs = scheduled.filter(
  (f) => parse(readFileSync(join(WF_DIR, f), 'utf8'))?.jobs?.attest != null,
);
is(
  attestLegs.length >= 6,
  true,
  `D0a 带 cron 且发凭证的腿有 ${attestLegs.length} 条（至少 6 条 —— 少于这个数说明有腿掉了 attest 作业）`,
);
const uncovered = attestLegs.filter((f) => PINNED[f] == null);
is(
  uncovered.length,
  0,
  `D0 每条带 cron 且发凭证的腿都在「钉批次」表里${uncovered.length ? `（漏了 ${uncovered.join(', ')}）` : ''}`,
);
/* ★ 反向：表里登记了却已经没有 cron / 没有 attest 的条目，同样要红。 */
const stalePinned = Object.keys(PINNED).filter((f) => !attestLegs.includes(f));
is(
  stalePinned.length,
  0,
  `D0b PINNED 里没有过期条目${stalePinned.length ? `（已不是带 cron 的发凭证腿：${stalePinned.join(', ')}）` : ''}`,
);

for (const f of attestLegs) {
  if (!PINNED[f]) continue;
  const text = readFileSync(join(WF_DIR, f), 'utf8');
  const doc = parse(text);
  if (!doc?.jobs?.attest) {
    bad(`D ${f}：没有 attest 作业 —— 这条腿凭什么进发布闸门的腿列表？`);
    continue;
  }
  const { defaults, empties } = inputEnvs(doc);
  is(attestStateUnder(text, empties), 'skipped', `D ${f}：schedule（inputs 全空）**不发凭证**`);
  is(
    attestStateUnder(text, defaults),
    'skipped',
    `D ${f}：默认参数的手动 dispatch（没钉批次）**不发凭证**`,
  );
  is(
    attestStateUnder(text, PINNED[f].inputs),
    'success',
    `D ${f}：钉死批次之后凭证**发得出来**（否则上面几条只是"它从来不发"）`,
  );
  /*
   * ★ 最关键的一格：**模式全对、就是没钉批次**。
   *   前两条（schedule / 默认参数）在有些腿上是被"模式不对"顺带挡住的，
   *   挡它们的不是批次门。只有这一格能证明批次门自己在工作。
   */
  const unpinned = { ...PINNED[f].inputs, [PINNED[f].runIdKey]: '' };
  is(
    attestStateUnder(text, unpinned),
    'skipped',
    `D ${f}：模式全对但 \`${PINNED[f].runIdKey}\` 留空（三平台各自解析，可能不是同一批）⇒ **不发凭证**`,
  );
}

/*
 * 顺带把闸门自己的那份账对一遍：`verify-e2e-attestation.mjs` 认哪些腿，就得给出
 * 哪些腿的触发命令。`browser` 曾经在 LEGS 里却不在 DISPATCH_HINT 里 ——
 * 于是它缺凭证时闸门只会说"没有登记触发方式，自己去 workflow 里看输入名"。
 */
{
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'verify-e2e-attestation.mjs'), 'utf8');
  const legs = /--legs',\s*'([^']+)'/.exec(src)?.[1]?.split(',') ?? [];
  is(legs.length >= 6, true, `D9a 闸门登记了 ${legs.length} 条腿`);
  const hintBlock = src.slice(src.indexOf('const DISPATCH_HINT'));
  const missing = legs.filter((l) => !new RegExp(String.raw`^\s*${l}:`, 'm').test(hintBlock));
  is(
    missing.length,
    0,
    `D9b 闸门认的每条腿都有触发命令${missing.length ? `（缺 ${missing.join(', ')}）` : ''} —— ` +
      '一句"自己去 YAML 里看输入名"的提示，和没有提示差别很小',
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * C 组：反向验证 —— **把修法退回去，上面那些断言必须红**
 *
 * 只改内存里的字符串，磁盘上的 workflow 一个字节不动。
 * ═══════════════════════════════════════════════════════════════════════════════════ */

section('C 组 · 反向验证：把修法退回去，上面的断言必须真的变红');

/** 把 e2e-runtime 的 attest 作业退回 #102 修复**之前**的形状。 */
function replaceJobIf(text, jobName, newIfLine) {
  const lines = text.split('\n');
  const jobAt = lines.findIndex((l) => l === `  ${jobName}:`);
  if (jobAt < 0) return null;
  // 在这个 job 的块里找到 `    if:` 那一行，把它连同后续更深缩进的续行一起换掉。
  let i = jobAt + 1;
  for (; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) return null; // 走出这个 job 了，没找到 if:
    if (/^ {4}if:/.test(lines[i])) break;
  }
  if (i >= lines.length) return null;
  let j = i + 1;
  while (j < lines.length && /^ {6}/.test(lines[j])) j++;
  return [...lines.slice(0, i), newIfLine, ...lines.slice(j)].join('\n');
}

function revertAttestGate(text) {
  let t = text.replace('    needs: [audit, mutations]\n', '    needs: [audit]\n');
  t = replaceJobIf(t, 'attest', "    if: ${{ inputs.bundleSource == 'artifact' }}");
  // 连 `--mutations` 那一行一起拿掉 —— 历史形状里它根本不存在，
  // 而 C3 要断言的正是"旧凭证连说这件事的字段都没有"。
  if (t !== null) t = t.replace(/^.*--mutations ".*\n/m, '');
  // 判据落在**解析出来的结构**上，不落在"文本里还有没有某几个字"上：
  // 写凭证那一行本来就会提到 needs.mutations.result，用文本判会把自己判错。
  let attest;
  try {
    attest = t === null ? null : parse(t)?.jobs?.attest;
  } catch {
    attest = null;
  }
  const revertedOk =
    attest != null &&
    JSON.stringify([].concat(attest.needs ?? [])) === JSON.stringify(['audit']) &&
    !/needs\./.test(String(attest.if ?? '')) &&
    !/--mutations/.test(JSON.stringify(attest.steps ?? []));
  if (!revertedOk) {
    bad('C0 没能把 attest 退回旧形状 —— 这组反向验证本身失效了，**别当它绿**');
    return null;
  }
  return t;
}

{
  const old = revertAttestGate(runtimeText);
  if (old) {
    ok('C0 成功在内存里把 attest 退回 `needs: [audit]` + `if: bundleSource == artifact`');

    /*
     * C1 —— **历史复现，也是这份模拟器唯一的校准点。**
     *   `[实测 e2e-runtime run 31568740737]` 真实发生过：三平台审计 success、
     *   `变异验证（linux-x64）` failure、run conclusion=failure，
     *   而 `e2e 凭证` 作业 **success** 且 `e2e-attest-runtime-31568189189` 照发。
     *   拿旧形状喂进模拟器，必须重现这一格。重现不了 ⇒ 模拟器与现实脱节，
     *   上面 A 组全部结论作废。
     */
    is(
      runtimeSchedule(old, { inputs: ARTIFACT_RUN, results: { mutations: 'failure' } }).attest,
      'success',
      'C1 🔴 旧形状下「审计绿 + 变异红」⇒ 凭证**照发** —— 重现了 run 31568740737 真实发生的事',
    );

    // C2 —— 也就是说 A2 那条断言确实有牙齿：新旧形状在同一格上给出相反的答案。
    const nowSkipped =
      runtimeSchedule(runtimeText, { inputs: ARTIFACT_RUN, results: { mutations: 'failure' } })
        .attest === 'skipped';
    is(nowSkipped, true, 'C2 同一格在新形状下变成 skipped ⇒ A2 不是恒真断言');

    // C3 —— 旧形状下 mutations=false 也照发凭证，且凭证里**没有任何字段**说得出这件事。
    const oldDoc = parse(old);
    const oldEmit = String(
      (oldDoc.jobs.attest.steps ?? []).find((s) => /--leg runtime/.test(String(s.run ?? '')))
        ?.run ?? '',
    );
    is(
      /--mutations/.test(oldEmit),
      false,
      'C3 旧形状的写凭证命令里**根本没有 --mutations** —— 跳过与全跑发出的凭证长得一模一样',
    );
  }
}

/**
 * 把 #91 的兜底逐个退回去，断言 B 组**当场报出差异**。
 * 每一项：`{ 名字, 文件, 退回操作 }`。退不动就当场判红（否则这条反向验证是假的）。
 */
const B_REVERTS = [
  {
    name: 'C4 e2e-runtime：变异开关的兜底',
    file: 'e2e-runtime.yml',
    revert: (t) => t.replace("format('{0}', inputs.mutations) != 'false'", 'inputs.mutations'),
  },
  {
    name: 'C5 e2e-runtime：断点续传开关的兜底',
    file: 'e2e-runtime.yml',
    revert: (t) => t.replace("format('{0}', inputs.resumeTest) != 'false'", 'inputs.resumeTest'),
  },
  {
    name: 'C6 e2e-browser：现场组装开关的兜底（退回去会整条腿换模式）',
    file: 'e2e-browser.yml',
    revert: (t) =>
      t
        .replaceAll("format('{0}', inputs.assembleFromSource) == 'false'", '!inputs.assembleFromSource') // prettier-ignore
        .replaceAll("format('{0}', inputs.assembleFromSource) != 'false'", 'inputs.assembleFromSource'), // prettier-ignore
  },
  {
    name: 'C7 e2e-notes：现场组装开关的兜底',
    file: 'e2e-notes.yml',
    revert: (t) =>
      t
        .replaceAll("format('{0}', inputs.assembleFromSource) == 'false'", '!inputs.assembleFromSource') // prettier-ignore
        .replaceAll("format('{0}', inputs.assembleFromSource) != 'false'", 'inputs.assembleFromSource'), // prettier-ignore
  },
  {
    name: 'C9 e2e-record：凭证作业的批次门 + legs 兜底',
    file: 'e2e-record.yml',
    revert: (t) =>
      t.replace(
        "    if: ${{ inputs.bundleRunId != '' && (inputs.legs || 'all') == 'all' }}",
        "    if: ${{ inputs.legs == 'all' }}",
      ),
  },
  {
    name: 'C10 e2e-allcomponents：attest 里那处 --mode 的兜底（当初刻意不补的那颗雷）',
    file: 'e2e-allcomponents.yml',
    revert: (t) =>
      t.replace(
        '            --mode "${{ inputs.mode || \'sample\' }}" \\\n            --out dist/e2e-attest.json',
        '            --mode "${{ inputs.mode }}" \\\n            --out dist/e2e-attest.json',
      ),
  },
];

for (const { name, file, revert } of B_REVERTS) {
  const orig = readFileSync(join(WF_DIR, file), 'utf8');
  const broken = revert(orig);
  if (broken === orig) {
    bad(`${name}：退回操作**什么都没改到**（锚点漂了）—— 这条反向验证此刻是假的，别当它绿`);
    continue;
  }
  const div = scheduleDivergences(file, broken);
  if (div.length > 0) {
    ok(`${name} —— 退回去之后 B 组报出 ${div.length} 处差异（${div[0].job}${div[0].path}）`);
  } else {
    bad(`${name} —— 退回去之后 B 组**依然是绿的**：这条兜底没有被任何断言守着`);
  }
}

/*
 * D 组的反向验证：把「没钉批次就不发凭证」那道门拆掉，D 组必须当场红。
 * 这几条**不在** B 组的射程里 —— B 组比的是渲染出来的字符串，
 * 而这里改变的是**作业跑不跑**，两个环境下改法一致、字符串一个字都没差。
 * 少了这一组，`e2e-import` 那道门就是一条没有任何断言守着的护栏。
 */
const D_REVERTS = [
  {
    name: 'C11 e2e-import：拆掉「没钉批次就不发凭证」那道门',
    file: 'e2e-import.yml',
    revert: (t) => t.replace("    if: ${{ inputs.bundleRunId != '' }}\n", ''),
  },
  {
    name: 'C12 e2e-browser：把批次门那半条去掉（退回只看模式）',
    file: 'e2e-browser.yml',
    revert: (t) =>
      replaceJobIf(
        t,
        'attest',
        "    if: ${{ format('{0}', inputs.assembleFromSource) == 'false' }}",
      ),
  },
  {
    name: 'C13 e2e-notes：把批次门那半条去掉（退回只看模式）',
    file: 'e2e-notes.yml',
    revert: (t) =>
      replaceJobIf(
        t,
        'attest',
        "    if: ${{ format('{0}', inputs.assembleFromSource) == 'false' }}",
      ),
  },
  {
    name: 'C14 e2e-record：把批次门那半条去掉（退回只看 legs）',
    file: 'e2e-record.yml',
    revert: (t) => replaceJobIf(t, 'attest', "    if: ${{ inputs.legs == 'all' }}"),
  },
  {
    name: 'C15 e2e-allcomponents：把批次门那半条去掉（退回只看 legs）',
    file: 'e2e-allcomponents.yml',
    revert: (t) => replaceJobIf(t, 'attest', "    if: ${{ inputs.legs == 'all' }}"),
  },
  {
    // ⚠️ 退回去的这一版**保留**三态那几行，只把 `bundlesRunId != ''` 拿掉 ——
    //    否则拆的就是两道门，说不清是哪一道在起作用。
    name: 'C16 e2e-runtime：把批次门那半条去掉（三态那几行原样保留）',
    file: 'e2e-runtime.yml',
    revert: (t) =>
      replaceJobIf(
        t,
        'attest',
        [
          '    if: >-',
          '      ${{ !cancelled()',
          "      && inputs.bundleSource == 'artifact'",
          "      && needs.audit.result == 'success'",
          "      && (needs.mutations.result == 'success' || needs.mutations.result == 'skipped') }}",
        ].join('\n'),
      ),
  },
];

for (const { name, file, revert } of D_REVERTS) {
  const orig = readFileSync(join(WF_DIR, file), 'utf8');
  const broken = revert(orig);
  if (broken == null || broken === orig) {
    bad(`${name}：退回操作**什么都没改到**（锚点漂了）—— 这条反向验证此刻是假的，别当它绿`);
    continue;
  }
  const doc = parse(broken);
  const { defaults, empties } = inputEnvs(doc);
  const unpinned = { ...PINNED[file].inputs, [PINNED[file].runIdKey]: '' };
  const stillSkips =
    attestStateUnder(broken, empties) === 'skipped' &&
    attestStateUnder(broken, defaults) === 'skipped' &&
    attestStateUnder(broken, unpinned) === 'skipped';
  if (stillSkips) {
    bad(`${name} —— 拆掉之后 D 组**依然是绿的**：那道门没有被任何断言守着`);
  } else {
    ok(`${name} —— 拆掉之后没钉批次也会发凭证，D 组当场红`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════ */

console.log('');
/*
 * 防"空集判通过"（第三道）：整份自检必须真的跑过东西。
 * 下限写死是有意的 —— 断言被整段注释掉时，这一行会红。
 */
const FLOOR = 60;
if (checked < FLOOR) {
  console.log(`\x1b[31m✘ 只跑了 ${checked} 条断言，少于下限 ${FLOOR} —— 有断言被跳过了\x1b[0m`);
  process.exit(1);
}
if (failed > 0) {
  console.log(`\x1b[31m✘ ${checked - failed} passed, ${failed} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✔ ${checked} passed, 0 failed\x1b[0m`);
