#!/usr/bin/env node
/**
 * ★ `scripts/check-test-ratchet.mjs` 的正反向自检。
 *
 * ## 为什么这个文件必须存在
 *
 * 那条棘轮防的是「**守卫文件在没人注意的情况下消失**」。而它自己也是一个守卫 ——
 * 如果它哪天悄悄退化成"永远绿"（扫描范围坏了、判据被顺手放宽、`--update` 被改成
 * 按当前树重新生成），**没有任何东西会说出来**，而我们会以为还有人守着。
 * 这正是它要防的那个病的形状：**"没跑"和"跑了并通过"在结果里长得一模一样。**
 *
 * 所以这里的每一条断言都钉**判据**，不是钉"跑过了"：每个正向用例旁边都有一条
 * `★反向：` —— 把该红的输入喂进去，**必须**非零退出，而且**必须**在输出里点名。
 *
 * ## 隔离
 *
 * 每个用例在 `mkdtemp` 出来的**独立 git 仓**里跑（PROTOCOL §10：反向验证不许在共享
 * 工作树里做 —— 树上随时有 9 个 agent 在跑 `pnpm -r test`）。
 * 被测脚本用 `dirname(import.meta.url)/..` 推仓库根，所以把它复制到
 * `<sandbox>/scripts/` 下，它就把 sandbox 当成整个世界，碰不到 /root/memo。
 *
 * 用 `git add` 而不 `commit`：被测脚本读的是 `git ls-files`（索引），有索引就够了。
 *
 * 用法：node scripts/ci/selftest-test-ratchet.mjs   （`pnpm test:ci-scripts` 会跑）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const SCRIPT = join(REPO, 'scripts', 'check-test-ratchet.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'om-test-ratchet-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('用例返回了 Promise，请用同步写法');
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✘ ${name}`);
    console.log(`      ${e && e.message ? e.message : e}`);
    failures.push(name);
  }
}

/** 探针文件的路径必须和被测脚本里的 PROBE_FILE 一致，否则自检会假红。 */
const PROBE = 'packages/runtime/src/backends/platformUnsupported.test.ts';

/**
 * 造一个沙箱仓：`n` 个测试文件（含探针）+ 一份按当前树生成的基线。
 * 文件数默认 150，稳稳高于被测脚本的 MIN_TEST_FILES=100 下限。
 */
function sandbox(n = 150, { seed = true } = {}) {
  const root = mkdtempSync(join(TMP, 'repo-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(root, 'scripts', 'check-test-ratchet.mjs'));

  const files = [PROBE];
  for (let i = 0; i < n - 1; i++)
    files.push(`packages/x/src/gen${String(i).padStart(3, '0')}.test.ts`);
  for (const f of files) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), '// fixture\n');
  }
  // 放一个非测试文件，确认扫描不会把它算进来
  writeFileSync(join(root, 'packages/x/src/notATest.ts'), '// fixture\n');

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  commit(root, 'fixture');
  writeFileSync(
    join(root, 'scripts', 'test-ratchet-baseline.json'),
    `${JSON.stringify({ floor: 0, tracked: [], removed: [] }, null, 2)}\n`,
  );
  // 用被测脚本自己的 --update 生成基线（顺带把 --update 也测了）。
  // `seed: false` 用于"扫描本身就该被判坏"的用例 —— 那种情况下 --update 会（正确地）
  // 拒绝生成基线，所以不能拿它来搭夹具。
  if (seed) {
    const up = run(root, ['--update']);
    if (up.status !== 0) throw new Error(`沙箱基线生成失败：${up.stderr}${up.stdout}`);
    // ★ 基线必须**提交**进去：`--against` 要靠 `git show <ref>:…baseline.json` 读它，
    //   基线只躺在工作区里的话，历史比对根本无从谈起（第一版夹具就是这么漏的）。
    execFileSync('git', ['add', '-A'], { cwd: root });
    commit(root, 'baseline');
  }
  return { root, files };
}

function run(root, args = []) {
  const r = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'check-test-ratchet.mjs'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    all: (r.stdout ?? '') + (r.stderr ?? ''),
  };
}

const readBase = (root) =>
  JSON.parse(readFileSync(join(root, 'scripts', 'test-ratchet-baseline.json'), 'utf8'));
const writeBase = (root, b) =>
  writeFileSync(
    join(root, 'scripts', 'test-ratchet-baseline.json'),
    `${JSON.stringify(b, null, 2)}\n`,
  );

/** 沙箱里提交一次。被测脚本读的是 `HEAD` 那棵树，所以夹具必须真的 commit。 */
function commit(root, msg) {
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-gpg-sign', '-m', msg],
    { cwd: root },
  );
}

/** 真删掉一个已提交的文件并提交（模拟"从陈旧索引提交"落地之后的样子）。 */
function deleteTracked(root, file) {
  execFileSync('git', ['rm', '-q', '-f', file], { cwd: root });
  commit(root, 'drop ' + file);
}

/** 新增一个已提交的测试文件。 */
function addCommittedTest(root, file) {
  writeFileSync(join(root, file), '// fixture\n');
  execFileSync('git', ['add', file], { cwd: root });
  commit(root, 'add ' + file);
}

/* ── ① 对照组：不动任何东西必须是绿的 ─────────────────────────────────────── */
console.log('\n① 对照组');

const base = sandbox();
check('未改动的沙箱 → 绿（否则下面所有反向用例都不可信）', () => {
  const r = run(base.root);
  if (r.status !== 0) throw new Error(`期望 0，实得 ${r.status}\n${r.all}`);
  if (!/一个都没少/.test(r.all)) throw new Error(`绿的时候也要说清楚数目：\n${r.all}`);
});

check('基线确实被 --update 填满了（150 在册，floor=150）', () => {
  const b = readBase(base.root);
  if (b.tracked.length !== 150) throw new Error(`tracked=${b.tracked.length}，期望 150`);
  if (b.floor !== 150) throw new Error(`floor=${b.floor}，期望 150`);
});

check('非测试文件没有被算进来（.ts 但不是 .test.ts）', () => {
  const b = readBase(base.root);
  if (b.tracked.some((f) => f.endsWith('notATest.ts'))) throw new Error('把非测试文件算进来了');
});

check('--update 幂等：再跑一次不加任何东西', () => {
  const before = readBase(base.root);
  const r = run(base.root, ['--update']);
  if (r.status !== 0) throw new Error(`期望 0，实得 ${r.status}\n${r.all}`);
  const after = readBase(base.root);
  if (after.tracked.length !== before.tracked.length) throw new Error('第二次 --update 改了名单');
});

/* ── ② ★反向：删掉一个在册测试文件必须红，而且要点名 ──────────────────────── */
console.log('\n② ★反向：静默删除（这就是 31d3ae3 那次事故）');

check('★反向：删掉 platformUnsupported.test.ts → 非零退出', () => {
  const s = sandbox();
  deleteTracked(s.root, PROBE);
  const r = run(s.root);
  // 探针文件被删时，自检会先拦下来 —— 这本身就是正确行为（扫不到探针 = 要么扫描坏了、
  // 要么这个必须存在的文件没了），但必须**红**且**点名**。
  if (r.status === 0) throw new Error(`删了守卫文件却是绿的！\n${r.all}`);
  if (!r.all.includes(PROBE)) throw new Error(`红了但没点名是哪个文件：\n${r.all}`);
});

check('★反向：删掉一个普通在册测试 → 红且点名该文件', () => {
  const s = sandbox();
  const victim = s.files.find((f) => f !== PROBE);
  deleteTracked(s.root, victim);
  const r = run(s.root);
  if (r.status === 0) throw new Error(`删了在册测试却是绿的！\n${r.all}`);
  if (!r.all.includes(victim)) throw new Error(`没点名 ${victim}：\n${r.all}`);
  if (!/不见了/.test(r.all)) throw new Error(`没说清是"不见了"：\n${r.all}`);
});

check('★反向：一次删 3 个 → 3 个都要被点名（不是只报第一个或只报数字）', () => {
  const s = sandbox();
  const victims = s.files.filter((f) => f !== PROBE).slice(0, 3);
  for (const v of victims) deleteTracked(s.root, v);
  const r = run(s.root);
  if (r.status === 0) throw new Error('绿了');
  for (const v of victims) if (!r.all.includes(v)) throw new Error(`漏点名 ${v}：\n${r.all}`);
});

/* ── ③ ★反向：--update 必须**救不了**删除（整个设计的关键） ────────────────── */
console.log('\n③ ★反向：--update 只增不减，闭眼跑也掩盖不了删除');

check('★反向：删文件后跑 --update，被删的文件**仍然留在**基线里', () => {
  const s = sandbox();
  const victim = s.files.find((f) => f !== PROBE);
  deleteTracked(s.root, victim);
  run(s.root, ['--update']);
  const b = readBase(s.root);
  if (!b.tracked.includes(victim)) {
    throw new Error('--update 把被删的文件从基线里抹掉了 —— 守卫在帮着擦指纹');
  }
});

check('★反向：删文件 + --update 之后，门禁**依然是红的**', () => {
  const s = sandbox();
  const victim = s.files.find((f) => f !== PROBE);
  deleteTracked(s.root, victim);
  run(s.root, ['--update']);
  const r = run(s.root);
  if (r.status === 0) throw new Error(`跑一次 --update 就把门禁洗绿了！\n${r.all}`);
  if (!r.all.includes(victim)) throw new Error('红了但没点名');
});

/* ── ④ 合法删除必须还能做（棘轮 ≠ 禁止删除） ──────────────────────────────── */
console.log('\n④ 合法删除：挪进 removed + 写 reason 就该放行');

check('挪进 removed 并写 reason → 绿', () => {
  const s = sandbox();
  const victim = s.files.find((f) => f !== PROBE);
  deleteTracked(s.root, victim);
  const b = readBase(s.root);
  b.tracked = b.tracked.filter((f) => f !== victim);
  b.removed.push({ file: victim, reason: '这个测试测的东西已经整块下线了（自检夹具）' });
  writeBase(s.root, b);
  const r = run(s.root);
  if (r.status !== 0) throw new Error(`合法删除被挡住了：\n${r.all}`);
});

check('★反向：挪进 removed 但**不写 reason** → 红', () => {
  const s = sandbox();
  const victim = s.files.find((f) => f !== PROBE);
  deleteTracked(s.root, victim);
  const b = readBase(s.root);
  b.tracked = b.tracked.filter((f) => f !== victim);
  b.removed.push({ file: victim });
  writeBase(s.root, b);
  const r = run(s.root);
  if (r.status === 0) throw new Error(`没写理由的豁免被放行了：\n${r.all}`);
  if (!/reason/.test(r.all)) throw new Error(`没说清缺的是 reason：\n${r.all}`);
});

check('★反向：reason 是空白字符串也不算写了', () => {
  const s = sandbox();
  const victim = s.files.find((f) => f !== PROBE);
  deleteTracked(s.root, victim);
  const b = readBase(s.root);
  b.tracked = b.tracked.filter((f) => f !== victim);
  b.removed.push({ file: victim, reason: '   ' });
  writeBase(s.root, b);
  if (run(s.root).status === 0) throw new Error('空白 reason 被当成写了理由');
});

check('★反向：removed 里的文件又回到树上 → 红（豁免名单只准变短）', () => {
  const s = sandbox();
  const victim = s.files.find((f) => f !== PROBE);
  const b = readBase(s.root);
  b.tracked = b.tracked.filter((f) => f !== victim);
  b.removed.push({ file: victim, reason: '自检夹具' });
  writeBase(s.root, b);
  const r = run(s.root); // 文件其实还在树上
  if (r.status === 0) throw new Error(`过期豁免条目被放行了：\n${r.all}`);
  if (!r.all.includes(victim)) throw new Error('没点名');
});

/* ── ⑤ ★反向：直接从名单里删行（绕过 removed）必须被 floor 抓住 ────────────── */
console.log('\n⑤ ★反向：floor —— 直接删名单里的行也不行');

check('★反向：删文件 + 从 tracked 里删掉那一行 → floor 判红', () => {
  const s = sandbox();
  const victim = s.files.find((f) => f !== PROBE);
  deleteTracked(s.root, victim);
  const b = readBase(s.root);
  b.tracked = b.tracked.filter((f) => f !== victim); // 不进 removed，直接抹掉
  writeBase(s.root, b);
  const r = run(s.root);
  if (r.status === 0) throw new Error(`直接删名单行就洗白了！\n${r.all}`);
  if (!/名单本身变短/.test(r.all)) throw new Error(`没说清是名单变短：\n${r.all}`);
});

/* ── ⑥ ★反向：新增未登记 → 红，并给出可执行的修法 ────────────────────────── */
console.log('\n⑥ ★反向：新增的测试文件必须登记');

check('新增一个测试文件但不 --update → **不挡门禁**，但要点名提示', () => {
  // ⚠️ 这条断言的方向是**被实测改过的**：第一版判红，落地几分钟就被另一条腿的
  // 新测试撞红了（9 个 agent 同树）。一条经常为合法工作变红的守卫会被所有人忽略，
  // 连带它真正要抓的"删除"一起失效。所以改成提示。判据见被测脚本里那段注释。
  const s = sandbox();
  const fresh = 'packages/x/src/brandNew.test.ts';
  addCommittedTest(s.root, fresh);
  const r = run(s.root);
  if (r.status !== 0) throw new Error(`未登记的新测试挡住了门禁：\n${r.all}`);
  if (!r.all.includes(fresh)) throw new Error('没点名新文件');
  if (!/--update/.test(r.all)) throw new Error('没给出登记方法');
});

check('★反向：但"未登记"绝不能掩盖"消失" —— 两者同时发生时仍要红', () => {
  // 这条是上一条的安全网：把 unregistered 降级成提示之后，必须证明
  // **降级没有顺带把 missing 也放过**（同一次运行里两种情况都在）。
  const s = sandbox();
  const victim = s.files.find((f) => f !== PROBE);
  deleteTracked(s.root, victim); // 少了一个在册的
  const fresh = 'packages/x/src/brandNew.test.ts'; // 同时多了一个没登记的
  addCommittedTest(s.root, fresh);
  const r = run(s.root);
  if (r.status === 0) throw new Error(`有文件消失却被放行了：\n${r.all}`);
  if (!r.all.includes(victim)) throw new Error('没点名消失的那个');
});

check('新增之后跑 --update → 恢复绿', () => {
  const s = sandbox();
  const fresh = 'packages/x/src/brandNew.test.ts';
  addCommittedTest(s.root, fresh);
  run(s.root, ['--update']);
  const r = run(s.root);
  if (r.status !== 0) throw new Error(`登记之后还是红的：\n${r.all}`);
  if (readBase(s.root).floor !== 151) throw new Error('floor 没有跟着涨');
});

check('★ 别人 `git add` 了但**还没提交**的测试不算数（这条就是我踩的那个坑）', () => {
  // 事故：在 9 个 agent 共用的树上跑 --update，把别人**已 stage、未提交**的文件
  // 写进了基线并推上去 —— master 上"基线里有、树上没有" → 棘轮判红。
  // 判据因此改成读 `HEAD`（已提交的那棵树），结论不再取决于任何人 stage 了什么。
  const s = sandbox();
  const staged = 'packages/x/src/someoneElse.test.ts';
  writeFileSync(join(s.root, staged), '// 别人 stage 了但没提交\n');
  execFileSync('git', ['add', staged], { cwd: s.root });

  const r = run(s.root);
  if (r.status !== 0) throw new Error(`别人未提交的文件让门禁红了：\n${r.all}`);
  if (r.all.includes(staged)) throw new Error('未提交的文件不该出现在结论里');

  const u = run(s.root, ['--update']);
  if (u.status !== 0) throw new Error('--update 失败');
  if (readBase(s.root).tracked.includes(staged)) {
    throw new Error('--update 把别人**没提交**的文件写进了基线 —— 正是那次把 master 弄红的原因');
  }
});

/* ── ⑦ 自检的自检：扫描范围坏掉时不许假绿 ─────────────────────────────────── */
console.log('\n⑦ ★反向：扫描范围坏掉 / 基线坏掉');

check('★反向：测试文件太少（扫描坏了）→ 红，且说的是"扫描坏了"不是"测试变少了"', () => {
  const s = sandbox(20, { seed: false }); // 低于 MIN_TEST_FILES=100
  const r = run(s.root);
  if (r.status === 0) throw new Error('只扫到 20 个文件却是绿的');
  if (!/扫描范围坏了/.test(r.all)) throw new Error(`归因说错了：\n${r.all}`);
});

check('★反向：扫描看起来坏了时，`--update` 也必须拒绝写基线', () => {
  // 这条是上一条的必要补充：如果 --update 肯在"只扫到 20 个"的状态下生成基线，
  // 那么一次误操作就能把 floor 从 150 洗成 20 —— 棘轮当场失忆，而且是绿着失忆的。
  const s = sandbox(20, { seed: false });
  const r = run(s.root, ['--update']);
  if (r.status === 0) throw new Error(`--update 在扫描坏掉时还是写了基线：\n${r.all}`);
  const b = readBase(s.root);
  if (b.floor !== 0 || b.tracked.length !== 0)
    throw new Error('失败路径写脏了基线（应该一个字不写）');
});

check('★反向：基线文件读不到 → 红（不许当成"没基线所以放行"）', () => {
  const s = sandbox();
  rmSync(join(s.root, 'scripts', 'test-ratchet-baseline.json'), { force: true });
  const r = run(s.root);
  if (r.status === 0) throw new Error('基线没了却是绿的 —— 这就是一条被静默关掉的守卫');
});

/* ── ⑨ `--against <ref>`：堵「整棵树被回退」那个缺口 ────────────────────────── */
console.log('\n⑨ --against：整树回退（基线和文件一起退回去）');

const sha = (root) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

check('★★ 整树回退：普通模式**绿**（两边一致），--against **红** —— 这就是那个缺口', () => {
  const s = sandbox();
  const baseSha = sha(s.root); // ← 基准：150 在册

  // 有人加了一个新测试并登记（floor 150 → 151）
  const fresh = 'packages/x/src/addedLater.test.ts';
  addCommittedTest(s.root, fresh);
  run(s.root, ['--update']);
  execFileSync('git', ['add', '-A'], { cwd: s.root });
  commit(s.root, 'register ' + fresh);
  const afterSha = sha(s.root);
  if (readBase(s.root).floor !== 151) throw new Error('前置条件不成立：floor 应该是 151');

  // 现在模拟"从陈旧索引提交"：文件**和基线一起**退回到 baseSha 那一版
  execFileSync('git', ['rm', '-q', '-f', fresh], { cwd: s.root });
  execFileSync('git', ['checkout', baseSha, '--', 'scripts/test-ratchet-baseline.json'], {
    cwd: s.root,
  });
  execFileSync('git', ['add', '-A'], { cwd: s.root });
  commit(s.root, '「只改注释，零行为变更」');

  // ① 普通模式：两边一致，看不出问题 —— 这正是缺口本身
  const plain = run(s.root);
  if (plain.status !== 0) {
    throw new Error(
      `前置条件不成立：整树回退后普通模式应该是绿的（缺口就在这），实得：\n${plain.all}`,
    );
  }

  // ② --against 基准：基线自己缩了 → 必须红，并点名
  const against = run(s.root, ['--against', afterSha]);
  if (against.status === 0) throw new Error(`--against 没抓住整树回退：\n${against.all}`);
  if (!against.all.includes(fresh)) throw new Error(`红了但没点名消失的条目：\n${against.all}`);
  if (!/基线自己缩水/.test(against.all)) throw new Error(`没说清成因：\n${against.all}`);
});

check('--against 基准正常时 → 绿，**且明说比对做过了**（不能和"没比"长一样）', () => {
  const s = sandbox();
  const baseSha = sha(s.root);
  addCommittedTest(s.root, 'packages/x/src/later.test.ts');
  run(s.root, ['--update']);
  execFileSync('git', ['add', '-A'], { cwd: s.root });
  commit(s.root, 'register');

  const r = run(s.root, ['--against', baseSha]);
  if (r.status !== 0) throw new Error(`正常增长被判红了：\n${r.all}`);
  if (!/历史比对已做/.test(r.all)) throw new Error(`绿了但没说做过比对：\n${r.all}`);
  if (!r.all.includes(baseSha.slice(0, 7))) throw new Error('没说和谁比的');
});

check('★反向：基准读不到 → **不判红**，但必须大声说"没跑成"', () => {
  const s = sandbox();
  const r = run(s.root, ['--against', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
  if (r.status !== 0) throw new Error(`基准取不到就判红 = 一盏经常为合法情况亮的灯：\n${r.all}`);
  if (!/没跑成/.test(r.all)) throw new Error(`"没比对"和"比过没问题"长得一样了：\n${r.all}`);
});

check('全零 SHA（新分支首推）→ 绿，且说明是正常情况不是故障', () => {
  const s = sandbox();
  const r = run(s.root, ['--against', '0000000000000000000000000000000000000000']);
  if (r.status !== 0) throw new Error(`全零基准被当成异常：\n${r.all}`);
  if (!/新分支首推/.test(r.all)) throw new Error(`没解释全零是什么：\n${r.all}`);
});

check('不给 --against 时，绿输出必须明说"未做历史比对"', () => {
  const s = sandbox();
  const r = run(s.root);
  if (!/未做历史比对/.test(r.all)) throw new Error(`没比对却不说，等于假装比过了：\n${r.all}`);
});

/* ── ⑧ 真仓库上的一致性（不改任何东西，只读） ─────────────────────────────── */
console.log('\n⑧ 真仓库');

check('/root/memo 上跑真脚本 → 绿（基线和树是一致的）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`真仓库上棘轮是红的：\n${(r.stdout ?? '') + (r.stderr ?? '')}`);
  }
});

check('探针文件今天真的在（它就是被删过的那一个）', () => {
  const listed = execFileSync('git', ['ls-files', '--', PROBE], { cwd: REPO, encoding: 'utf8' });
  if (!listed.trim()) throw new Error(`${PROBE} 不在版本库里 —— 又被删了？`);
});

console.log(`\n${failures.length === 0 ? '✔' : '✘'} ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
