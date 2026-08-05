#!/usr/bin/env node
/**
 * `.github/workflows/*.yml` 的**结构**检查 —— 本机能跑，不需要 GitHub。
 *
 * ## 为什么手写而不是用 actionlint
 *
 * 本机没有 `act`、没有 `actionlint`、没有 docker（实测 `which` 全空）。
 * 而「只读一遍 YAML 就说修好了」正是这个 workflow **从来没跑过却看起来没问题**的原因。
 * 所以退而求其次：把**能在本地静态判定的性质**逐条写成断言。
 *
 * ## 它能查什么（都是真的踩过或差点踩到的）
 *
 * 1. **YAML 能不能解析** —— 最低门槛。
 * 2. **job / step 的键名是不是 GitHub 认识的**。
 *    ⚠️ 这条不是凑数：本任务写第一版时就在 `windows` job 里放了一个
 *    `steps_note:` 用来挂 YAML 锚点 —— GitHub 会**直接拒绝整个 workflow**，
 *    而本地读起来完全正常。这类错误只有机器查得出来。
 * 3. **`needs:` 指向的 job 真的存在**（打错一个字 = 那个 job 永远不跑）。
 * 4. **`${{ steps.X.outputs.Y }}` 里的 X 在同一个 job 里有 `id: X`**。
 *    T-144 把三处硬编码路径改成了 step output，写错 id 的后果是**空字符串**
 *    —— 不报错，只是把空串传给下一条命令。
 * 5. ★ **失败即红**：`manifest` job 不许有 `if: always()` / `continue-on-error`，
 *    `ci` 的门禁 job 的任何一步也不许有。
 *    这条守的是 C4 —— 「三个构建全挂 → 照样写出 `packs: []` → 整个 workflow 绿灯」。
 *    那行 `if: always()` 被删掉了，但**没有任何东西挡着它被加回来**，
 *    直到有了这条断言。
 *
 * ## 它查不了什么（明写）
 *
 * runner label 是否仍然存在、action 的 tag 是否存在、`uses:` 的输入参数是否合法、
 * shell 脚本在 Windows 上会不会跑、以及**任何需要真正执行的东西**。
 * 那些只有第一次真跑才知道。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WF_DIR = join(REPO_ROOT, '.github', 'workflows');

/* GitHub Actions 的合法键名。来源：docs.github.com「Workflow syntax for GitHub Actions」。 */
const WORKFLOW_KEYS = new Set([
  'name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs',
]);
const JOB_KEYS = new Set([
  'name', 'permissions', 'needs', 'if', 'runs-on', 'environment', 'concurrency',
  'outputs', 'env', 'defaults', 'steps', 'timeout-minutes', 'strategy',
  'continue-on-error', 'container', 'services', 'uses', 'with', 'secrets',
]);
const STEP_KEYS = new Set([
  'id', 'if', 'name', 'uses', 'run', 'working-directory', 'shell', 'with', 'env',
  'continue-on-error', 'timeout-minutes',
]);

/** 这些 job 的失败必须让整个 workflow 变红 —— 不许被 always() / continue-on-error 绕开。 */
const MUST_FAIL_LOUDLY = {
  'build-backends.yml': ['manifest'],
  'ci.yml': ['gate'],
};

const problems = [];
let checks = 0;

function must(cond, msg) {
  checks += 1;
  if (!cond) problems.push(msg);
}

const files = (await readdir(WF_DIR)).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
must(files.length > 0, `${WF_DIR} 里一个 workflow 都没有 —— 这个检查会因为"没东西可查"而永远绿`);

for (const file of files.sort()) {
  const raw = await readFile(join(WF_DIR, file), 'utf8');
  let doc;
  try {
    doc = parse(raw);
  } catch (err) {
    problems.push(`${file}: YAML 解析失败 —— ${String(err)}`);
    continue;
  }

  for (const k of Object.keys(doc ?? {})) {
    must(WORKFLOW_KEYS.has(k), `${file}: 顶层键 \`${k}\` 不是 GitHub 认识的键`);
  }

  const jobs = doc?.jobs ?? {};
  const jobNames = new Set(Object.keys(jobs));
  must(jobNames.size > 0, `${file}: 没有任何 job`);

  for (const [jobName, job] of Object.entries(jobs)) {
    const where = `${file}#${jobName}`;

    for (const k of Object.keys(job ?? {})) {
      must(JOB_KEYS.has(k), `${where}: job 键 \`${k}\` 不是 GitHub 认识的键（会被整份拒绝）`);
    }

    must(job?.['runs-on'] != null || job?.uses != null, `${where}: 既没有 runs-on 也不是 reusable workflow`);

    for (const need of [].concat(job?.needs ?? [])) {
      must(jobNames.has(need), `${where}: needs 指向不存在的 job \`${need}\``);
    }

    const steps = job?.steps ?? [];
    const stepIds = new Set();
    for (const [i, step] of steps.entries()) {
      const sw = `${where}[${i}]${step?.name ? ` "${step.name}"` : ''}`;
      for (const k of Object.keys(step ?? {})) {
        must(STEP_KEYS.has(k), `${sw}: step 键 \`${k}\` 不是 GitHub 认识的键`);
      }
      must(
        (step?.uses == null) !== (step?.run == null),
        `${sw}: 一个 step 必须**恰好**有 uses 或 run 之一`,
      );
      if (step?.id) stepIds.add(step.id);
    }

    /* ── steps.<id>.outputs.<k> 的 id 必须在同一个 job 里存在 ── */
    const jobText = JSON.stringify(job);
    for (const m of jobText.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\./g)) {
      must(
        stepIds.has(m[1]),
        `${where}: 引用了 steps.${m[1]}.outputs.*，但这个 job 里没有 \`id: ${m[1]}\` 的 step ` +
          `（后果不是报错，是**把空字符串传下去**）`,
      );
    }

    /* ── 失败即红 ── */
    if ((MUST_FAIL_LOUDLY[file] ?? []).includes(jobName)) {
      const ifExpr = String(job?.if ?? '');
      must(
        !/always\s*\(\s*\)/.test(ifExpr),
        `${where}: job 上有 \`if: ${ifExpr}\` —— 依赖的构建全失败时它照样会跑，` +
          `写出一个空 manifest 并让整个 workflow 绿灯。这正是 C4。`,
      );
      must(
        job?.['continue-on-error'] !== true,
        `${where}: continue-on-error: true —— 这个 job 挂了必须让 workflow 变红`,
      );
      for (const [i, step] of (job?.steps ?? []).entries()) {
        must(
          step?.['continue-on-error'] !== true,
          `${where}[${i}]: continue-on-error: true —— 门禁步骤失败必须变红`,
        );
        must(
          !/always\s*\(\s*\)/.test(String(step?.if ?? '')),
          `${where}[${i}]: step 上有 always() —— 前面挂了它还跑，等于把失败盖住`,
        );
      }
    }
  }
}

/* ── 针对 T-144 改动的定点断言（钉结构，不钉措辞） ── */
{
  const bb = parse(await readFile(join(WF_DIR, 'build-backends.yml'), 'utf8'));
  must(bb.permissions?.contents === 'read', 'build-backends.yml: permissions 应收窄到 contents: read');
  must(bb.on?.workflow_dispatch !== undefined, 'build-backends.yml: 必须保留 workflow_dispatch');
  must(bb.on?.push === undefined, 'build-backends.yml: 不许自动 push 触发（用户要求第一次手动）');
  must(
    bb.jobs?.manifest?.if === undefined,
    'build-backends.yml: manifest job 不该有任何 if:（C4 的那行 always() 已删）',
  );
  const mergeStep = (bb.jobs?.manifest?.steps ?? []).find((s) => String(s.run ?? '').includes('merge-backend-manifest.mjs'));
  must(mergeStep != null, 'build-backends.yml: manifest job 没有调用 scripts/ci/merge-backend-manifest.mjs');
  must(
    !JSON.stringify(bb.jobs?.manifest ?? {}).includes('node -e'),
    'build-backends.yml: manifest job 里又出现了 inline `node -e` —— 那种东西没有任何测试能碰到它',
  );
  const allText = JSON.stringify(bb);
  must(!/\.build\/whisper-/.test(allText), 'build-backends.yml: 又出现了硬编码的 .build/whisper-* 路径（C7）');
  must(!/choco install ninja/.test(allText), 'build-backends.yml: choco install ninja 回来了，而脚本仍然没有 -G Ninja（C6）');

  const ci = parse(await readFile(join(WF_DIR, 'ci.yml'), 'utf8'));
  must(ci.on?.push === undefined, 'ci.yml: 不许自动 push 触发（用户要求第一次手动）');
  const runs = (ci.jobs?.gate?.steps ?? []).map((s) => String(s.run ?? '')).join('\n');
  for (const cmd of ['pnpm typecheck', 'pnpm lint', 'pnpm -r test', 'pnpm test:ci-scripts']) {
    must(runs.includes(cmd), `ci.yml: 门禁里没有 \`${cmd}\``);
  }
  must(
    !/pnpm -r build/.test(runs),
    'ci.yml: 用了 `pnpm -r build` —— PROTOCOL §7 补充要求一律 `pnpm build:safe`，' +
      '本地跑同一条命令会覆盖用户正在看的 apps/web/dist',
  );
}

if (problems.length > 0) {
  console.log(`✘ lint-workflows: ${problems.length} 个问题（共 ${checks} 条断言）`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(`✔ lint-workflows: ${checks} 条断言全部通过（${files.length} 个 workflow）`);
