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
  'name',
  'run-name',
  'on',
  'permissions',
  'env',
  'defaults',
  'concurrency',
  'jobs',
]);
const JOB_KEYS = new Set([
  'name',
  'permissions',
  'needs',
  'if',
  'runs-on',
  'environment',
  'concurrency',
  'outputs',
  'env',
  'defaults',
  'steps',
  'timeout-minutes',
  'strategy',
  'continue-on-error',
  'container',
  'services',
  'uses',
  'with',
  'secrets',
]);
const STEP_KEYS = new Set([
  'id',
  'if',
  'name',
  'uses',
  'run',
  'working-directory',
  'shell',
  'with',
  'env',
  'continue-on-error',
  'timeout-minutes',
]);

/** 这些 job 的失败必须让整个 workflow 变红 —— 不许被 always() / continue-on-error 绕开。 */
const MUST_FAIL_LOUDLY = {
  'build-backends.yml': ['manifest'],
  'ci.yml': ['gate'],
  /*
   * T-154：上传与校验两个 job 都不许被绕开。
   * 尤其是 `verify` —— 一个"挂了也不影响绿灯"的校验，等于把
   * 「我们发出去的东西对不对」这件事变成装饰。
   */
  'release-upload.yml': ['upload', 'verify'],
};

const problems = [];
let checks = 0;
/**
 * 有多少个 job **解除了默认的 `success()`** 却带着 `needs:`（见下面那条 #102 断言）。
 * 用来防"空集判通过"：这条规则今天有主语（`e2e-runtime` 的 attest），
 * 哪天主语没了，要么是有人把修法退回去了，要么这条规则该删 —— 两种都得有人看见。
 */
let statusFnJobsSeen = 0;

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

    must(
      job?.['runs-on'] != null || job?.uses != null,
      `${where}: 既没有 runs-on 也不是 reusable workflow`,
    );

    for (const need of [].concat(job?.needs ?? [])) {
      must(jobNames.has(need), `${where}: needs 指向不存在的 job \`${need}\``);
    }

    /* ══════════════════════════════════════════════════════════════════════════════
     * ★ #102：**解除了默认 `success()`，就必须把每一条 `needs` 的 result 逐条写回来**
     *
     * GitHub 的规则（文档原文，"Evaluate expressions in workflows and actions"）：
     *   `A default status check of success() is applied unless you include one of
     *    these functions.`（success / failure / always / cancelled）
     *
     * 也就是说 `if: ${{ !cancelled() && … }}` 会**一次性解除**"所有 needs 都得 success"
     * 这条默认要求。有时候必须解除 —— 那是唯一能把 needs 的 `skipped` 和 `failure`
     * 分开对待的办法（默认语义下两者都让本 job 一起被跳过）。但解除的代价是：
     * 一道**自动**的闸换成了一份**手写**的清单，而手写清单会漏。
     *
     * 漏了长什么样：`e2e-runtime` 的 attest 作业曾经 `needs: [audit]`，变异 job
     * 压根不在里面 —— `[实测 run 31568740737]` 三平台审计全绿、变异红、run 判 failure，
     * 而 `e2e-attest-runtime-31568189189` **照发了、未过期**。那次还不是状态函数的锅
     * （是 `needs` 自己漏了一个），但加上状态函数之后，同样的"漏一条"会更安静：
     * 连默认的 success 兜底都不在了。
     *
     * 所以这条断言钉的是：**`needs:` 里的每一个名字，都得在 `if:` 里被
     * `needs.<名字>.result` 提到**。它不管你把它判成什么（那是设计决定），
     * 只管**你确实对它做过一个决定**。
     * ════════════════════════════════════════════════════════════════════════════ */
    const jobIf = String(job?.if ?? '');
    const needList = [].concat(job?.needs ?? []);
    /*
     * 两种"其实没解除"的情形不在管辖范围内：
     *   · 表达式里写了**未取反的 `success()`** —— 那就是把默认检查显式写了一遍，
     *     覆盖面与默认完全相同（`release-upload.yml#verify` 正是这么写的，
     *     它的注释还专门解释了为什么要显式写出来）。
     *   · `if:` 里根本没有状态函数 —— 默认的 `success()` 仍在，自动管住全部 needs。
     */
    const hasBareSuccess = /(^|[^!\w])success\s*\(\s*\)/.test(jobIf);
    const dissolvesDefault =
      /\b(always|cancelled|failure)\s*\(\s*\)/.test(jobIf) && !hasBareSuccess;
    if (dissolvesDefault && needList.length > 0) {
      statusFnJobsSeen += 1;
      /*
       * ⚠️ 白名单：**只放"不做任何判定"的纯汇报作业**，而且必须写清理由。
       *   放行的判据不是"它一直是这样"，而是「它绿不绿都不构成一句关于产品的断言，
       *   且真正做判定的那个 job 失败时 run 已经是红的」。
       *   一个做判定的作业出现在这里，就是把 #102 又演一遍。
       */
      const REPORTER_ONLY = {
        // `gate` 已在 MUST_FAIL_LOUDLY 里：它红 → run 红。gate-summary 只把
        // gate/format 已经产生的 outcome 读出来数清楚，自身不产出任何判定，
        // 而它必须在 gate 红时照跑 —— 一个"谁没跑到"的汇报器如果自己被跳过就白做了。
        'ci.yml#gate-summary': '纯汇报：只读已有 outcome 计数，不做判定；判定方 gate 红则 run 红',
      };
      const exemptReason = REPORTER_ONLY[`${file}#${jobName}`];
      if (exemptReason) {
        must(
          typeof exemptReason === 'string' && exemptReason.length > 10,
          `${where}: 豁免必须带理由（这条是空的）`,
        );
      } else {
        for (const need of needList) {
          const esc = String(need).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          must(
            new RegExp(String.raw`needs\.${esc}\.result`).test(jobIf),
            `${where}: \`if:\` 里用了 always()/cancelled()/failure()（于是默认的 success ` +
              `检查被解除了），但 \`needs\` 里的 \`${need}\` **没有任何 ` +
              `\`needs.${need}.result\` 判断** —— 它失败/取消时这个 job 会照跑。` +
              `三条出路：把这条 result 写进 \`if:\`；把状态函数换成显式的 \`success() && …\`；` +
              `或者它确实是个不做判定的纯汇报作业 —— 那就写进本文件的 REPORTER_ONLY 并说明理由。`,
          );
        }
      }
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
        /*
         * ⚠️ 这条只禁 `always()`，**不禁** `!cancelled()`。两者不是一回事：
         *
         * - `continue-on-error: true` → **真的**盖住失败（上面那条禁死它）。
         * - step 上的 `if:` → **盖不住任何东西**：失败的那一步照样把 job 判红，
         *   `if:` 只决定"别的步骤要不要跑"。
         * - `always()` 连**被取消**时也跑，纯浪费，且语义上像在对抗取消 —— 仍然禁。
         * - `!cancelled()` 是被认可的写法：前面挂了后面照常出结论，取消时老实停。
         *
         * 判据：**"失败要不要变红"和"别的检查要不要跑"是两件事**，
         * 早先这条断言的措辞把它们混成一件，代价是一条 lint 红能静默关掉 7 道守卫。
         */
        must(
          !/always\s*\(\s*\)/.test(String(step?.if ?? '')),
          `${where}[${i}]: step 上有 always() —— 取消时也会跑。要"前面挂了也照常出结论"请用 ` +
            `\`if: \${{ !cancelled() && … }}\`（它不会盖住失败：没有 continue-on-error，红照样红）`,
        );
      }
    }
  }
}

/* ── ci.yml 的 gate：一条红不许静默关掉后面的守卫 ──────────────────────────────
 *
 * 事故 `[实测]` run 31415258130：**一条 lint 红，后面 7 道守卫全部 skipped。**
 * 这是 #75 的转世 —— 那次是 Format check 红 → 下游 8 个 job 全 skipped，
 * 我们把它拆成独立 job 治好了 job 层；**同一个形状在 step 层原封不动地活着。**
 *
 * 判据不是"全加 always() 了事"，而是**逐步问：前面挂了，这步是不是真的失去意义？**
 * 实测（没跑 build 的干净 clone）：6 步是**假依赖**（照样能出结论），
 * 3 步是**真依赖**（缺 dist 直接抛「先 pnpm build:safe」）。
 *
 * 这条断言钉的是**假依赖那几步必须带条件** —— 少一个，它就会在下一条红里
 * 重新变回 skipped，而 skipped **不是 passed**。
 */
{
  const ci = parse(await readFile(join(WF_DIR, 'ci.yml'), 'utf8'));
  const steps = ci.jobs?.gate?.steps ?? [];
  const byId = new Map(steps.filter((s) => s?.id).map((s) => [s.id, s]));

  // 假依赖：只要 install 成功就该跑，前面谁红都不影响它们的结论
  for (const id of [
    'build',
    'typecheck',
    'lint',
    'tracked_sources',
    'orphan_exports',
    'test_ratchet',
    'locale_ratchet',
    'contract_fields',
  ]) {
    const s = byId.get(id);
    must(!!s, `ci.yml: gate 里找不到 \`id: ${id}\` 的 step`);
    must(
      /!\s*cancelled\s*\(\s*\)/.test(String(s?.if ?? '')),
      `ci.yml: gate 的 \`${id}\` 少了 \`if: \${{ !cancelled() && … }}\` —— ` +
        '前面随便哪一步红，它就会被静默 skip。实测过一次：一条 lint 红关掉了 7 道守卫，' +
        '而 **skipped 不是 passed**',
    );
    must(
      /steps\.install\.outcome\s*==\s*'success'/.test(String(s?.if ?? '')),
      `ci.yml: gate 的 \`${id}\` 应当只在 install 成功时跑（install 是唯一的真依赖）`,
    );
  }

  // 真依赖：跳过是诚实的，但必须写明依赖谁，不能是"恰好排在后面"
  for (const [id, dep] of [
    ['ci_scripts_selftest', 'build'],
    ['test', 'build'],
    ['mutation_anchors', 'build'],
  ]) {
    const s = byId.get(id);
    must(!!s, `ci.yml: gate 里找不到 \`id: ${id}\` 的 step`);
    must(
      new RegExp(`steps\\.${dep}\\.outcome\\s*==\\s*'success'`).test(String(s?.if ?? '')),
      `ci.yml: gate 的 \`${id}\` 真依赖 \`${dep}\`，必须把这条依赖**写进 if:**，` +
        '而不是靠"排在它后面"—— 靠顺序的依赖在重排时会无声地失效',
    );
  }

  must(
    /steps\.test\.outcome\s*==\s*'success'/.test(String(byId.get('mutation_anchors')?.if ?? '')),
    'ci.yml: mutation_anchors 还依赖 `test`（18 条锚点里有 6 条钉在 apps/web/.test-out/**，' +
      '那是 pnpm -r test 编出来的）—— Test 没跑成时它必然假红，应当跳过',
  );
}

/* ── 针对 T-144 改动的定点断言（钉结构，不钉措辞） ── */
{
  const bb = parse(await readFile(join(WF_DIR, 'build-backends.yml'), 'utf8'));
  must(
    bb.permissions?.contents === 'read',
    'build-backends.yml: permissions 应收窄到 contents: read',
  );
  must(bb.on?.workflow_dispatch !== undefined, 'build-backends.yml: 必须保留 workflow_dispatch');
  must(bb.on?.push === undefined, 'build-backends.yml: 不许自动 push 触发（用户要求第一次手动）');
  must(
    bb.jobs?.manifest?.if === undefined,
    'build-backends.yml: manifest job 不该有任何 if:（C4 的那行 always() 已删）',
  );
  const mergeStep = (bb.jobs?.manifest?.steps ?? []).find((s) =>
    String(s.run ?? '').includes('merge-backend-manifest.mjs'),
  );
  must(
    mergeStep != null,
    'build-backends.yml: manifest job 没有调用 scripts/ci/merge-backend-manifest.mjs',
  );
  must(
    !JSON.stringify(bb.jobs?.manifest ?? {}).includes('node -e'),
    'build-backends.yml: manifest job 里又出现了 inline `node -e` —— 那种东西没有任何测试能碰到它',
  );
  const allText = JSON.stringify(bb);
  must(
    !/\.build\/whisper-/.test(allText),
    'build-backends.yml: 又出现了硬编码的 .build/whisper-* 路径（C7）',
  );
  must(
    !/choco install ninja/.test(allText),
    'build-backends.yml: choco install ninja 回来了，而脚本仍然没有 -G Ninja（C6）',
  );

  /* ═════════════════════════════════════════════════════════════════════════════════
   * ★ T-163 · 「GLIBC 下限」与「runner 标签」必须保持解耦
   *
   * 历史：T-145 把 vulkan/cuda 从 22.04 挪到 24.04（为了 apt 的 glslc），
   * 顺手把产物的运行时下限从 2.34 抬到 2.38；T-161 又挪回 22.04 把它压下来，
   * 于是撞上 runner 退役（2026-09-17 起 deprecation）。**来回横跳两次，
   * 每次都是因为这两件事被绑在同一个 `runs-on:` 上。**
   *
   * T-163 把它们拆开：`runs-on` 跟着 GitHub 的排期走，编译发生在 buildbox 容器里。
   * 下面这几条钉的就是"拆开"这个**结构**本身 —— 不钉 runner 的名字（那会在下一次
   * 升级时变成一条过期的守卫，参见上面 ci.yml 那条被用户指令翻过来的断言）。
   *
   * ⚠️ 扫描前先剥掉整行注释：本文件里这些 `run:` 块的注释**大量**提到
   *    `buildbox.sh` / `check-elf-glibc`，正因为它们在解释这件事。
   *    不剥的话，把编译搬回宿主、只在注释里留一句"以前用 buildbox"，这几条会照样绿。
   * ═════════════════════════════════════════════════════════════════════════════════ */
  {
    const stripShellComments = (src) =>
      String(src ?? '')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .join('\n');

    const linux = bb.jobs?.linux;
    must(linux != null, 'build-backends.yml: 没有 linux job');
    const steps = linux?.steps ?? [];
    const runs = steps.map((s) => ({
      name: s.name ?? s.uses ?? '(anon)',
      code: stripShellComments(s.run),
    }));

    /* ① 编译/链接/跑产物的每一步都必须经过 buildbox.sh。
     *
     * ★ T-167：`scripts/build-probe.sh` **从这张表里移走了**，因为 workflow 不再直接调它 ——
     *   它现在由 `build-whisper.sh` 在同一次 buildbox 调用里调用（探针要和 ggml 库同目录，
     *   所以它必须在打包之前就进 stage）。**性质没有放松，只是换了钉的位置**：
     *   下面 ⑤ 那组断言钉的是「build-whisper.sh 里必须有那次调用 + 那条守卫」，
     *   而 build-whisper.sh 本身仍然在这张表里、仍然必须经过 buildbox.sh。
     *   —— 不这么改的话，这条断言会因为"没东西可查"而报出一个假红。 */
    const COMPILE_MARKERS = ['scripts/build-whisper.sh', 'scripts/ci/smoke-linux-pack.sh'];
    for (const marker of COMPILE_MARKERS) {
      const hits = runs.filter((r) => r.code.includes(marker));
      must(
        hits.length > 0,
        `build-backends.yml#linux: 没有任何一步调用 ${marker} —— 这条守卫会因为"没东西可查"而永远绿`,
      );
      for (const h of hits) {
        must(
          h.code.includes('scripts/ci/buildbox.sh'),
          `build-backends.yml#linux "${h.name}": 直接在 runner 上跑 ${marker}。` +
            `runner 是 ubuntu-24.04（glibc 2.39），产物的下限会跟着跑到 2.39 —— ` +
            `而 GGML_BACKEND_DL 下 dlopen 失败是**静默的**（D-11 §8.2）。` +
            `编译与跑产物一律经过 scripts/ci/buildbox.sh。`,
        );
      }
    }

    /* ② 那个镜像必须是本仓自己的 Dockerfile 造的，且 BASE_IMAGE 写在 workflow 里（看得见）。 */
    const imgStep = runs.find((r) => r.code.includes('scripts/ci/buildbox.Dockerfile'));
    must(
      imgStep != null,
      'build-backends.yml#linux: 没有一步用 scripts/ci/buildbox.Dockerfile 造编译镜像',
    );
    must(
      (imgStep?.code ?? '').includes('--build-arg BASE_IMAGE='),
      'build-backends.yml#linux: `docker build` 没有显式传 BASE_IMAGE —— ' +
        '那条决定 glibc 下限的选择不该藏在 Dockerfile 的默认值里',
    );

    /* ③ 编译**开始之前**先断言容器自己的 glibc（省得跑完整个 CUDA 编译才发现镜像被换了）。 */
    must(
      runs.some((r) => /buildbox\.sh\s+--report/.test(r.code)),
      'build-backends.yml#linux: 少了 `buildbox.sh --report` —— ' +
        '它是"我们以为在容器里编，实际上是不是"的第一道闸',
    );

    /* ④ 真正的判据：逐个 ELF 的 objdump 守卫。包与探针**各一条**。 */
    const guards = runs.filter((r) => r.code.includes('check-elf-glibc.mjs'));
    must(
      guards.length >= 2,
      `build-backends.yml#linux: check-elf-glibc 守卫只有 ${guards.length} 条。` +
        `包（stage_dir）与探针（dist/probe）要各一条 —— 探针是随包出厂的可执行文件，` +
        `它挂掉的表现是"探测不到任何 GPU"，与"这台机器真的没有 GPU"在界面上完全一样。`,
    );
    for (const g of guards) {
      must(
        /--max\s+2\.34\b/.test(g.code),
        `build-backends.yml#linux "${g.name}": check-elf-glibc 的 --max 不是字面量 2.34。` +
          `2.34 是 Ubuntu 22.04 上编出来的实测值；把它写成变量或表达式，` +
          `等于把基线交给别处去定义。`,
      );
    }
    must(
      guards.some((g) => g.code.includes('dist/probe')),
      'build-backends.yml#linux: 没有一条 check-elf-glibc 覆盖 dist/probe（探针）',
    );

    /* ═════════════════════════════════════════════════════════════════════════════
     * ⑤ ★ T-167 · 探针**随包出厂**这件事本身要被钉住
     *
     * 三条独立的事实合起来才让它成立，缺一条就回到"发了也用不了"：
     *   ① 探针动态链接 `libggml-base` / `libggml`（`[本机实测]` 裸跑报
     *      `cannot open shared object file: libggml-base.so.0`）；
     *   ② `runtime/setup.ts` 的 `backendDir` = `dirname(probePath)`；
     *   ③ 探针只能枚举**与它同目录**的后端模块。
     * → 它必须在包里，而且是**每一个**包里。
     *
     * 所以这里钉的不是 workflow 的措辞，是**结构**：
     *   · build-whisper.sh 真的调了 build-probe.sh，并且落点是 STAGE（不是 dist/）；
     *   · 编不出来当场 die（否则会打出一个"里面没有探针"的包并报绿）；
     *   · workflow 那一步是**复制**，不是第二次编译（upload 的必须和包里的是同一份字节）。
     * ═════════════════════════════════════════════════════════════════════════════ */
    const bw = await readFile(join(REPO_ROOT, 'scripts', 'build-whisper.sh'), 'utf8');
    const bwCode = stripShellComments(bw);
    must(
      /build-probe\.sh[\s\S]{0,200}--out\s+"\$\{STAGE\}\//.test(bwCode),
      'scripts/build-whisper.sh: 没有把 openmemo-probe 编进 ${STAGE}。' +
        '探针动态链接 libggml-base，且 runtime/setup.ts 的 backendDir = dirname(probePath) —— ' +
        '不在包里的探针在用户机器上一次都启动不了。',
    );
    must(
      /\[\[\s*!\s*-e\s*"\$\{STAGE\}\/\$\{PROBE_NAME\}"\s*\]\][\s\S]{0,600}\bdie\b/.test(bwCode),
      'scripts/build-whisper.sh: 探针没编出来时没有 die。' +
        '少了守卫就会打出一个"能下载、能安装、里面没有探针"的包并报绿 —— ' +
        '而缺探针的表现是「尚未探测到硬件能力」，与"这台机器真的没有 GPU"完全一样。',
    );
    for (const jobName of ['macos', 'linux', 'windows']) {
      const jobSteps = (bb.jobs?.[jobName]?.steps ?? []).map((s) => ({
        name: s.name ?? s.uses ?? '(anon)',
        code: stripShellComments(s.run),
      }));
      const probeSteps = jobSteps.filter((s) => /dist\/probe/.test(s.code));
      must(
        probeSteps.length > 0,
        `build-backends.yml#${jobName}: 没有任何一步产出 dist/probe —— 探针的独立 artifact 不见了`,
      );
      for (const s of probeSteps) {
        must(
          !/scripts\/build-probe\.sh/.test(s.code),
          `build-backends.yml#${jobName} "${s.name}": 又在 workflow 里单独编了一次探针。` +
            `那会产生两个都叫 openmemo-probe、却没有任何东西保证一样的文件 —— ` +
            `守卫验的是其中一个，用户拿到的是另一个。这一步只该从 stage 复制。`,
        );
      }
    }

    /* ⑥ macOS 那一格的同族守卫：LC_BUILD_VERSION.minos。 */
    const macRuns = (bb.jobs?.macos?.steps ?? []).map((s) => ({
      name: s.name ?? s.uses ?? '(anon)',
      code: stripShellComments(s.run),
    }));
    const minosGuards = macRuns.filter((r) => r.code.includes('check-macho-minos.mjs'));
    must(
      minosGuards.length > 0,
      'build-backends.yml#macos: 没有 check-macho-minos 守卫。' +
        '不显式设部署目标，编译器就把构建机(macos-26)的版本写进 minos，' +
        '而 minos 高于用户系统时 dyld 直接拒绝加载 —— 表现是"探测不到任何 GPU"。',
    );
    for (const g of minosGuards) {
      must(
        /--max\s+13\.3\b/.test(g.code),
        `build-backends.yml#macos "${g.name}": check-macho-minos 的 --max 不是字面量 13.3。` +
          `13.3 来自上游 build-xcframework.sh:5 的 MACOS_MIN_OS_VERSION，` +
          `写成变量或表达式等于把基线交给别处去定义。`,
      );
      must(
        g.code.includes('stage_dir'),
        `build-backends.yml#macos "${g.name}": 守卫没有覆盖 stage_dir（= 整个包，含探针）`,
      );
    }

    /* ⑦ 基线只许有一份：`scripts/lib/baselines.sh` 与 workflow 里的 --max 必须一致。
     *    这两个数字此前分别写在 build-whisper.sh、build-probe.sh（漏了）和 workflow 里，
     *    三次事故的共同成因就是"同一个数字写在两个地方，然后只改了一个"。 */
    const baselines = await readFile(join(REPO_ROOT, 'scripts', 'lib', 'baselines.sh'), 'utf8');
    const readBaseline = (name) =>
      new RegExp(`^${name}="([^"]+)"`, 'm').exec(baselines)?.[1] ?? null;
    const macBase = readBaseline('OPENMEMO_MACOS_DEPLOYMENT_TARGET');
    const glibcBase = readBaseline('OPENMEMO_LINUX_GLIBC_MAX');
    must(macBase === '13.3', `scripts/lib/baselines.sh: macOS 部署目标应为 13.3，实得 ${macBase}`);
    must(glibcBase === '2.34', `scripts/lib/baselines.sh: glibc 上限应为 2.34，实得 ${glibcBase}`);
    must(
      /source\s+"\$\{SCRIPT_DIR\}\/lib\/baselines\.sh"/.test(stripShellComments(bw)),
      'scripts/build-whisper.sh: 没有 source scripts/lib/baselines.sh',
    );
    const bp = stripShellComments(
      await readFile(join(REPO_ROOT, 'scripts', 'build-probe.sh'), 'utf8'),
    );
    must(
      /source\s+"\$\{SCRIPT_DIR\}\/lib\/baselines\.sh"/.test(bp),
      'scripts/build-probe.sh: 没有 source scripts/lib/baselines.sh',
    );
    must(
      /-mmacosx-version-min=\$\{OPENMEMO_MACOS_DEPLOYMENT_TARGET\}/.test(bp),
      'scripts/build-probe.sh: darwin 分支没有传 -mmacosx-version-min。' +
        '不传的话探针的 minos 会取构建机(macos-26)的版本 —— ' +
        '`[本机实测 T-167]` 真产物就是 26.0.0，而同一个包里的 20 个二进制是 13.3.0。',
    );
  }

  /* T-163：新守卫必须真的被跑到。一条没接进 test:ci-scripts 的自检等于不存在。 */
  {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
    const cmd = String(pkg.scripts?.['test:ci-scripts'] ?? '');
    for (const f of [
      'selftest-elf-glibc.mjs',
      'selftest-macho-minos.mjs',
      'selftest-buildbox.sh',
      'selftest-build-whisper.sh',
      // T-22 预编译包：`verify-bundle.sh` 是出厂检查，只在打包流水线上跑一次，
      // 而它写错的方式基本都是**少检查几条然后报绿**（C5 那一族）。
      // 它的自检被摘掉时，失效的样子和"本来就没有"一模一样 —— 所以钉在这里。
      'selftest-bundle.mjs',
      // D-12：版本号单一事实来源。被"顺手简化"掉时会当场红，而不是等用户发现
      // 界面上那个数字又几个月没动过了。
      'check-version-sync.mjs',
    ]) {
      must(
        cmd.includes(f),
        `package.json: test:ci-scripts 里没有 ${f} —— 没被跑到的自检等于不存在`,
      );
    }
  }

  const ci = parse(await readFile(join(WF_DIR, 'ci.yml'), 'utf8'));
  /*
   * ★ T-145：这条断言**方向反过来了**，而且是被用户的新指令翻的。
   *
   * T-144 写下它时的前提是「用户要求第一次手动跑并盯着」，那时候 `on.push` 存在
   * 就是违规。2026-08-05 手动跑通（1m42s 绿）之后，用户指示改为自动触发 ——
   * 理由是那句「一个只能手动触发的 CI 不是 CI」。
   *
   * 值得记一笔的是：**这条守卫在我改 ci.yml 的当天就红了，而且红得完全正确。**
   * 它拦住的不是错误，是一个**已经过期的前提**。守卫该改，不是该删 ——
   * 所以这里把它翻成正向断言：现在「没有自动触发」才是违规。
   */
  must(
    ci.on?.push !== undefined,
    'ci.yml: 门禁必须自动触发（用户 2026-08-05 指令），on.push 不见了',
  );
  must(
    Array.isArray(ci.on?.push?.branches) && ci.on.push.branches.includes('master'),
    'ci.yml: on.push 应限定 branches: [master]（配合 pull_request，避免 PR 分支双触发）',
  );
  must('pull_request' in (ci.on ?? {}), 'ci.yml: 缺 pull_request 触发');
  /*
   * ★ 不许加 paths / paths-ignore 过滤。理由写在 ci.yml 的文件头，一句话版本：
   *   被 paths 过滤掉的检查在分支保护里显示为「未运行」而不是「通过」，
   *   而且它和本仓在清的假绿家族是同一个形状 ——「没跑」和「跑了并通过」长得一样。
   */
  must(
    ci.on?.push?.paths === undefined && ci.on?.push?.['paths-ignore'] === undefined,
    'ci.yml: on.push 上出现了 paths/paths-ignore 过滤 —— 理由见 ci.yml 文件头，别加',
  );
  const runs = (ci.jobs?.gate?.steps ?? []).map((s) => String(s.run ?? '')).join('\n');
  for (const cmd of ['pnpm typecheck', 'pnpm lint', 'pnpm -r test', 'pnpm test:ci-scripts']) {
    must(runs.includes(cmd), `ci.yml: 门禁里没有 \`${cmd}\``);
  }
  must(
    !/pnpm -r build/.test(runs),
    'ci.yml: 用了 `pnpm -r build` —— PROTOCOL §7 补充要求一律 `pnpm build:safe`，' +
      '本地跑同一条命令会覆盖用户正在看的 apps/web/dist',
  );

  /* ═════════════════════════════════════════════════════════════════════════════════
   * T-171 · ci-crossplatform.yml 必须跑与 ci.yml **同一套**静态检查
   *
   * 立这一组的成因：`ci-crossplatform.yml` 此前**没有 lint、也没有 test:ci-scripts**。
   * 而 `ci.yml`（ubuntu-24.04）当时是全仓**唯一自动触发**的 workflow，其余 5 个都是
   * `workflow_dispatch`。两件事叠起来的净效果是：**「跨平台」这三个字在 lint 和
   * CI 自检这两格上等于不存在** —— 而它恰恰是最该跨平台跑的两格
   * （eslint 的 import 解析吃文件系统大小写敏感性；那 7 个 CI 自检守的是
   * `build-backends.yml` 的判定逻辑，而那个 workflow 本来就要在三个平台上跑）。
   *
   * ⚠️ **上一段的"唯一自动触发"已过期**（写于 T-171，2026-08-07）：2026-08-12 起
   * 六条 e2e 腿带 cron，`ci-crossplatform.yml` 自己从 2026-08-23 起也带。
   * 仍然成立的那半、也是这组断言真正的地基：
   *   **`ci.yml` 是唯一挡合并的 workflow，所以「ci.yml 绿」不蕴含
   *     「测试在 Windows / macOS 上过」。**
   * 过期的理由要**改写成还成立的那部分**，不是整条划掉 —— 否则下一个人会拿
   * "理由已经不成立"当成"这组断言可以删了"（ADR-017 那条同形的教训）。
   *
   * ⚠️ 判据不是"补齐了就完了"，是**"少一条当场红"** —— 否则下一个人把它删掉时，
   * 失效的样子和"本来就没有"一模一样，这正是本仓在清的假绿家族。
   * 这一组由 `pnpm test:ci-scripts` 的第一步跑，而它在 `ci.yml` 里 ⇒ **有自动调用方**。
   *
   * ⚠️ **不要**在下面这张表里加 `pnpm format:check`。理由与实测数字写在
   * `ci-crossplatform.yml` 里那段 ⛔ 注释：`[T-171 实测]` 481 个文件不合格，
   * 今天接进去就是一条永远红的门禁。**先统一格式，再上门禁。**
   * ═════════════════════════════════════════════════════════════════════════════════ */
  {
    const XP = 'ci-crossplatform.yml';
    const xp = parse(await readFile(join(WF_DIR, XP), 'utf8'));
    const xpRuns = Object.values(xp.jobs ?? {})
      .flatMap((j) => j?.steps ?? [])
      .map((s) => String(s.run ?? ''))
      .join('\n');
    /*
     * ⚠️ 这四条钉的是**不短路**的那一版命令，不是 `ci.yml` 的那一版。
     *
     * `[实测 run 31389910051 + 32651393827]` 短路把这条探针变成了它自己文件头
     * 宣称要治的那个病：`pnpm -r test` 在第一个失败的包上 bail（win32 上因此
     * `apps/web` 559 条 + `apps/daemon` 785 条一条都没跑，而输出里没有一个字说了这件事），
     * `pnpm test:ci-scripts` 是 35 环 `&&` 链、断在第 6/7 环。
     * **一个只报出"最靠前那一条"的探针，和一个没跑的探针，在输出上分不开。**
     *
     * → 探针端必须是 `--no-bail` / `run-selftests-all.mjs`；
     *   `ci.yml` 门禁端**刻意保留**短路（它要的是快速判决，见上面那组断言）。
     */
    for (const cmd of [
      'pnpm lint',
      'pnpm typecheck',
      'pnpm -r --no-bail test',
      'node scripts/ci/run-selftests-all.mjs',
    ]) {
      must(
        xpRuns.includes(cmd),
        `${XP}: 缺 \`${cmd}\` —— 跨平台探针必须跑与 ci.yml 同一套检查，` +
          `且必须跑**不截断**的那一版（T-171 立，2026-08-23 补 no-bail）`,
      );
    }
    /*
     * ★ 反向：探针端不许退回短路版。
     *   `pnpm -r test`（不带 --no-bail）与 `pnpm test:ci-scripts` 一旦出现在这里，
     *   就意味着有人把"一次列全"换回了"只列最靠前那一条"，而那个退化**不会**
     *   让任何一格变红 —— 它只会让红的条数变少，看起来还像是好消息。
     */
    must(
      !/pnpm -r test(?!\S)/.test(xpRuns),
      `${XP}: 出现了短路版 \`pnpm -r test\` —— 探针端必须用 \`pnpm -r --no-bail test\`，` +
        `否则第一个失败的包之后的所有包都不跑，而输出里看不出来（见本文件头 ① ）`,
    );
    must(
      !/pnpm test:ci-scripts(?!\S)/.test(xpRuns),
      `${XP}: 出现了短路版 \`pnpm test:ci-scripts\` —— 探针端必须用 ` +
        `\`node scripts/ci/run-selftests-all.mjs\`（同一份清单，跑完再汇总）`,
    );
    must(
      !/pnpm -r build/.test(xpRuns),
      `${XP}: 用了 \`pnpm -r build\` —— PROTOCOL §7 补充要求一律 \`pnpm build:safe\``,
    );
    /*
     * 探针**不许**变成**合并门禁**而不先处理 `!cancelled()`：文件头 ⚠️ 那条判据写着
     * 「如果哪天有人想把这个 workflow 当门禁用，必须先把 `!cancelled()` 全删掉」。
     *
     * ★ 2026-08-23 两处订正，方向相反，都要看：
     *
     *   ① **收紧**：原来只查 `on.push`。`pull_request` 同样是挡合并的触发方式，
     *      而它当时是个洞 —— 加一条 `pull_request:` 就能绕过这条断言。补上。
     *   ② **明确放行 `schedule`**：cron **不挡任何人合并**，它只是每天问一次
     *      「今天 macOS / Windows 上还有什么是坏的」。那恰恰是最需要 `!cancelled()`
     *      的场景 —— 每轮只看到最靠前的一个坏点，等于把六天的信息摊成六轮。
     *
     * 判据用的是「挡不挡合并」，不是「自不自动触发」。这两个概念此前被混在一起，
     * 而混在一起的代价是具体的：本文件加 cron 时，原来那条断言**一声不吭地放行了**
     * —— 它查的 `on.push` 确实没出现。**一条只盯着一种触发方式的断言，
     * 在别人换一种触发方式时不会红，而它看起来仍然在工作。**
     */
    const hasNotCancelled = /!\s*cancelled\s*\(\s*\)/.test(JSON.stringify(xp));
    const blocksMerge = xp.on?.push !== undefined || xp.on?.pull_request !== undefined;
    must(
      !(hasNotCancelled && blocksMerge),
      `${XP}: 同时有 \`!cancelled()\` 和 \`on.push\`/\`on.pull_request\` —— 探针要转**合并门禁**，` +
        `必须先按文件头那条判据把 \`!cancelled()\` 全删掉，否则后续步骤会在前面已红时继续跑。` +
        `（\`schedule\` 不在此列：定时跑不挡合并，而它最需要"一次列全"。）`,
    );
    /*
     * ★ cron 本身也钉住：它是 2026-08-23 才补上的，而补它的理由是一条实测的代价 ——
     *   `workflow_dispatch:` only 时，run 31389910051 红着挂了 12 天没人知道，
     *   期间 `ci.yml` 一直绿。删掉 cron 会让那 12 天重新变得可能，而删掉它
     *   **不会让任何一格变红** —— 所以这里替它红。
     */
    must(
      xp.on?.schedule !== undefined,
      `${XP}: 没有 \`on.schedule\` —— 只能手动触发的探针，它的红会挂在那里没人知道。` +
        `\`[实测]\` run 31389910051 红了 12 天，而同期 ci.yml 一直是绿的。` +
        `真要撤掉 cron，请连同 \`scripts/ci/check-workflow-expiry.mjs\` 里那条登记一起处理。`,
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * T-154 · release-upload 的权限边界 —— 这一组断言就是那份"能做什么/不能做什么"的合同
 *
 * 背景：`pack-publish` T-150 拒绝给 workflow 加 `contents: write`，理由是
 * 「让 CI 代劳会把那道闸悄悄绕过去 —— 绕过的还是同一道闸，只是换了个执行者」。
 * 用户 2026-08-06 明确下令让 CI 传，于是闸开了 —— **但只开"上传"这一格**。
 *
 * GitHub 的权限刻度里没有"只能新增 release 资产"这一档：`contents: write` 一给，
 * 建 release / 改 release / 删资产在 token 层面就全都可以了。
 * **也就是说这条边界没法靠 scope 表达，只能靠"调用面收窄 + 守卫钉住"。**
 * 下面这些断言就是那个守卫。它们钉的是结构（谁有写权限、脚本里出现了什么方法），
 * 不钉措辞。
 * ═══════════════════════════════════════════════════════════════════════════════════ */
{
  const RU = 'release-upload.yml';
  const ru = parse(await readFile(join(WF_DIR, RU), 'utf8'));

  /* ① 顶层不许有任何权限。写在顶层会同时落到 verify 上，而 verify 的全部意义是"没有凭证"。 */
  must(
    ru.permissions != null &&
      typeof ru.permissions === 'object' &&
      Object.keys(ru.permissions).length === 0,
    `${RU}: 顶层 permissions 必须是空的（\`permissions: {}\`）—— 写权限只能挂在需要它的那一个 job 上`,
  );

  /* ② 全仓只允许 `upload` 这一个 job 拿 contents: write。 */
  const writers = Object.entries(ru.jobs ?? {})
    .filter(([, j]) => j?.permissions?.contents === 'write')
    .map(([n]) => n);
  must(
    writers.length === 1 && writers[0] === 'upload',
    `${RU}: 拿到 contents: write 的 job 应当**只有** upload，实得 [${writers.join(', ')}]`,
  );

  /* ③ verify 不许有任何 write 权限，也不许被喂 token。 */
  const verify = ru.jobs?.verify;
  must(verify != null, `${RU}: 没有 verify job —— 上传完不校验等于只证明了"我们以为传上去了"`);
  must([].concat(verify?.needs ?? []).includes('upload'), `${RU}: verify 必须 needs: [upload]`);
  must(
    Object.values(verify?.permissions ?? {}).every((v) => v !== 'write'),
    `${RU}#verify: 拿到了 write 权限 —— 一个手里攥着写权限的校验者证明不了"匿名用户拿得到"`,
  );
  /*
   * verify 的 `if:` 只允许挡 dry-run 那一种情况。
   * 挡别的（比如 `if: false`、`if: inputs.skip_verify != 'true'`）等于给"不校验"开一个后门，
   * 而这个 workflow 的价值一半在于"传完真的会去看一眼"。
   * `[实测 run 31099024189]`：这一行本身就是 dry-run 稳定红逼出来的，见 YAML 里的注释。
   */
  const verifyIf = String(verify?.if ?? '');
  must(
    verifyIf === '' || verifyIf.includes('dry_run'),
    `${RU}#verify: if 表达式是 \`${verifyIf}\` —— 只允许用它挡 dry-run，别用来给"不校验"开后门`,
  );

  const verifyText = JSON.stringify(verify ?? {});
  must(
    !/GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|github\.token|secrets\./.test(verifyText),
    `${RU}#verify: 出现了 token —— 这个 job 存在的全部理由就是"不带凭证也能下下来"。` +
      `带着 token 它会继续绿，但再也证明不了任何东西（尤其发现不了 draft release）。` +
      `修法是把 env 拿掉，不是把这条断言删掉`,
  );

  /* ④ 上传不许自动触发：往外发东西这件事必须有人按一下。 */
  must(ru.on?.workflow_dispatch !== undefined, `${RU}: 必须保留 workflow_dispatch`);
  must(
    ru.on?.push === undefined && ru.on?.release === undefined && ru.on?.schedule === undefined,
    `${RU}: 不许 push / release / schedule 自动触发 —— 上传是对外动作，必须有人按`,
  );
  must(
    ru.concurrency?.['cancel-in-progress'] === false,
    `${RU}: concurrency.cancel-in-progress 必须是 false。` +
      `取消一次进行中的上传，留下的正是 state != uploaded 的半截资产，而本 job 没有删除能力去收拾它`,
  );

  /* ⑤ 三个 workflow 里都不许出现"建/改/删 release"的命令行形态。 */
  for (const [file, doc] of [
    [RU, ru],
    ['build-backends.yml', parse(await readFile(join(WF_DIR, 'build-backends.yml'), 'utf8'))],
    [
      'mirror-model-blobs.yml',
      parse(await readFile(join(WF_DIR, 'mirror-model-blobs.yml'), 'utf8')),
    ],
  ]) {
    const text = JSON.stringify(doc);
    for (const bad of [
      'release create',
      'release delete',
      'release edit',
      '--clobber',
      'repo edit',
    ]) {
      must(
        !text.includes(bad),
        `${file}: 出现了 \`${bad}\` —— 建/改/删 release 与改仓库设置不在本流水线的授权范围内`,
      );
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * T-154 · 上传脚本的**调用面**：只允许 GET 与 POST-asset
 *
 * 这一条是上面那条的另一半。`contents: write` 一旦给出去，能不能建 release 完全取决于
 * 脚本里写了什么请求 —— 所以把"脚本里出现了哪些 HTTP 方法"变成断言。
 *
 * ⚠️ 扫描前要先去掉注释：这两个脚本的注释里**大量**出现 `--clobber` / `DELETE` 这些词，
 *    因为它们正是在解释"为什么不这么做"。一条会把解释文字当成违规的守卫，
 *    只会逼人把解释删掉 —— 那正好毁掉这里最有价值的东西。
 * ═══════════════════════════════════════════════════════════════════════════════════ */
{
  /* 块注释与整行 `//` 注释一律先去掉；行内的 `https://` 不会被误伤。 */
  const stripComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');

  const code = {};
  for (const f of ['release-upload.mjs', 'release-verify.mjs']) {
    code[f] = stripComments(await readFile(join(REPO_ROOT, 'scripts', 'ci', f), 'utf8'));

    const methods = [...code[f].matchAll(/method:\s*['"]([A-Za-z]+)['"]/g)].map((m) => m[1]);
    for (const m of methods) {
      must(
        m === 'POST',
        `scripts/ci/${f}: 出现了 HTTP ${m}。本流水线只授权两种请求：` +
          `GET releases/tags/… 与 POST …/releases/{id}/assets。` +
          `DELETE / PATCH / PUT 分别对应"删资产 / 改 release（含 draft→published）/ 覆盖"，都在授权之外`,
      );
    }
    /*
     * ⚠️ `--clobber` **刻意不在这张表里**：它是 `gh` 的开关，而 `gh release` 已经被禁；
     *    反过来，那两个字在本脚本的**失败消息**里出现过（"本脚本不会 --clobber，因为…"），
     *    把它列进来会逼人把那句解释删掉 —— 守卫不该以毁掉解释为代价生效。
     */
    for (const bad of ['gh release', 'gh repo', 'gh api']) {
      must(!code[f].includes(bad), `scripts/ci/${f}: 代码里出现了 \`${bad}\``);
    }
  }

  /*
   * 唯一那次 POST 必须打在 release 自己报出来的 `upload_url` 上。
   * 这条挡的是**建 release** —— 那也是一次 POST（打到 `/repos/{o}/{r}/releases`），
   * 光靠"方法必须是 POST"是拦不住的，得钉住它打在哪儿。
   */
  const posts = (code['release-upload.mjs'].match(/method:\s*'POST'/g) ?? []).length;
  must(
    posts === 1,
    `scripts/ci/release-upload.mjs: 应当**恰好**有一次 POST（上传资产），实得 ${posts} 次`,
  );
  must(
    /function postAsset\(uploadUrlTemplate[\s\S]{0,400}method:\s*'POST'/.test(
      code['release-upload.mjs'],
    ),
    'scripts/ci/release-upload.mjs: 那次 POST 必须在 postAsset() 里、且 URL 来自 release 自己的 upload_url' +
      '（打到 /repos/{o}/{r}/releases 上的 POST 就是"建 release"，那不在授权范围内）',
  );
  must(
    !/method:/.test(code['release-verify.mjs']),
    'scripts/ci/release-verify.mjs: 校验脚本里出现了非 GET 的请求 —— 它只该读，不该写',
  );

  /* verify 的凭证守卫本身不许被"顺手简化"掉 —— 它没了，这一步就变成一个永远绿的装饰。 */
  const verifySrc = await readFile(join(REPO_ROOT, 'scripts', 'ci', 'release-verify.mjs'), 'utf8');
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
    must(
      new RegExp(`CREDENTIAL_ENV[\\s\\S]{0,200}${k}`).test(verifySrc),
      `scripts/ci/release-verify.mjs: CREDENTIAL_ENV 里少了 ${k} —— 那一条守卫是"匿名可下"这个结论的全部依据`,
    );
  }
  must(
    /const present = CREDENTIAL_ENV[\s\S]{0,900}process\.exit\(1\)/.test(verifySrc),
    'scripts/ci/release-verify.mjs: 检测到凭证之后必须 process.exit(1)（只打印一行 warning 等于没有守卫）',
  );
}

/* ── ci.yml 的并发口径不许被静默改回去 ────────────────────────────────────────
 *
 * 事故（本轮，**是我自己干的**）：按 SHA 分组那条配置在一个**独立 worktree** 里改的，
 * 于是 `/root/memo` 工作区那份 `ci.yml` 一直是旧的。后来我在共享树上
 * read-modify-write 同一个文件，把**自己刚验证过的改动整段写回了旧版**，
 * 并且被别人的 `git push origin master` 一起带上了主干。
 * 没有报错、没有冲突、diff 里那 50 行删除**我自己都没看见**。
 *
 * 这就是本轮一直在治的那个病 —— 只是它这次落在**没有任何棘轮覆盖的文件**上：
 * 测试文件棘轮只看 `*.test.ts`，locale 守卫只看 `locales/*.json`，`ci.yml` 谁都没管。
 *
 * 判据不建立在"提交信息说了什么"或"有没有人看 diff"上，只看**事实**：
 * 那两行配置现在是不是还长这样。改口径是可以的 —— 但必须**同时改这条断言**，
 * 也就是变成一次**显式决定**，而不是一次没人看见的回退。
 */
{
  const ciSrc = await readFile(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  must(
    /group:\s*ci-\$\{\{\s*github\.event_name == 'push' && github\.sha \|\| github\.ref\s*\}\}/.test(
      ciSrc,
    ),
    "ci.yml: concurrency.group 必须按 **SHA** 分组 push 事件（`ci-${{ github.event_name == 'push' && github.sha || github.ref }}`）—— " +
      '共用 `github.ref` 会让突发连推时中间的提交拿不到判决（实测一天 18/84 = 21.4% 被取消）',
  );
  must(
    /cancel-in-progress:\s*\$\{\{\s*github\.event_name != 'push'\s*\}\}/.test(ciSrc),
    "ci.yml: concurrency.cancel-in-progress 必须是 `${{ github.event_name != 'push' }}` —— " +
      'master 的 push 不许被取消（PR 分支仍然保留取消）',
  );
  must(
    /非 head 提交仍然拿不到任何判决/.test(ciSrc),
    'ci.yml: 那段「按 SHA 分组**仍然**修不了非 head 提交这一档、目前靠纪律不靠机器」的说明必须留着 —— ' +
      '删掉它就等于宣称机器管住了它，而机器并没有',
  );
}

/*
 * ★ 防"空集判通过"（本周抓到的四道假守卫之一就是这个形状）。
 *   上面那条 #102 断言只在"job 用了状态函数且有 needs"时才有主语。
 *   如果全仓一个这样的 job 都没有，它就会**每天绿、每天什么都没查** ——
 *   而今天是有的（`e2e-runtime` 的 attest）。所以这里把"主语存在"本身也变成一条断言。
 */
must(
  statusFnJobsSeen > 0,
  '没有任何 job 的 `if:` 用了状态函数（always/cancelled/success/failure）且带 needs —— ' +
    '上面那条「解除默认 success 就得逐条检查 needs.*.result」的断言因此**一条都没查**。' +
    '要么是有人把 #102 的修法退回去了（e2e-runtime 的 attest 应该是它的主语），' +
    '要么这条规则确实没主语了、该连同这句一起删。两种都得有人当场看见。',
);

if (problems.length > 0) {
  console.log(`✘ lint-workflows: ${problems.length} 个问题（共 ${checks} 条断言）`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(`✔ lint-workflows: ${checks} 条断言全部通过（${files.length} 个 workflow）`);
