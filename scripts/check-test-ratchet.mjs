#!/usr/bin/env node
/**
 * ★ 仓库级棘轮：**测试/守卫文件不许在没人注意的情况下消失。**
 *
 * ## 它挡的是什么（今天真发生了两次）
 *
 * `31d3ae3` 的提交信息自述「**只改注释，零行为变更**」，实际上**静默删除了**
 * `packages/runtime/src/backends/platformUnsupported.test.ts`，**191 行**。
 * 已由 `7581cff` 恢复。那 191 行钉的是一条反复下过的禁令：
 *
 *     ★★ 反例：Mac 上的 coreml 不许被判"平台不适用"（哪怕它一个包都没有）
 *
 * 它没了，那条禁令就只剩嘴上说说。
 *
 * ## 病的形状（这才是要防的，不是"那个人不小心"）
 *
 * > **在共享树上，从陈旧索引提交 = 静默删除别人已提交的文件，
 * > 而且它不会出现在提交者自己的 diff 里。**
 *
 * 删除在 `git show --stat` 里明明白白（`platformUnsupported.test.ts | 191 ---------`），
 * **但提交者只看自己改的那两个文件**。所以判据**不能**是"提交信息里有没有说删了东西"
 * （那是启发式，能被绕过也会误报，而这次正是提交信息说了假话），
 * 也**不能**是"有没有人去看 diff"（没人看）。
 *
 * **判据必须是事实：那个文件现在还在不在。**
 *
 * ## 形状：棘轮 + 豁免名单（和 check-orphan-exports.mjs 同一套）
 *
 * 不是"禁止删除"—— 我们确实会删过时的测试。是：
 *
 * - 基线 `tracked` 里的文件**消失** → **红**，并**点名是哪几个**；
 * - 要合法删除：把它从 `tracked` 挪进 `removed`，**并写 `reason`**（和 `check:orphans`
 *   要求写 `note` 是同一个姿势）—— 删除从"没人看见的事"变成"一次显式决定"；
 * - 树上出现**基线里没有的**测试文件 → **只提示，不判红**（`ⓘ`），提示跑 `--update`。
 *   第一版这条是判红的，落地**几分钟就被撞红了**（另一条腿提交了一个新测试）。
 *   树上同时有 9 个 agent，判红等于经常为**合法工作**亮红灯，而本仓的判据是
 *   **那种守卫会被所有人学会忽略** —— 连它真正要抓的"删除"一起淹掉。
 *   详细理由写在下面 `unregistered` 那段的注释里。
 *
 * ### `--update` 是**只增不减**的，所以闭眼跑它也不会掩盖删除
 *
 * 这一条是整个设计的关键。如果 `--update` 按当前树重新生成整份名单，
 * 那么"删掉测试 + 跑一次 --update"就把证据也一起抹了 —— 守卫会亲手帮凶手擦掉指纹。
 * 所以 `--update` **只往 `tracked` 里加，从不删**：被删掉的文件会一直留在名单里、
 * 一直红，直到有人**手写一条 `reason`** 把它挪进 `removed`。
 *
 * ### `floor`：防"直接把那一行从名单里删掉"
 *
 * 光有名单还不够 —— 把 `tracked` 里那行删掉，守卫就不知道它存在过。
 * 所以另存一个整数 `floor`，判据是 **`tracked.length + removed.length >= floor`**。
 * 两个名单都只增不减，所以这个和是**单调不减**的；它掉下来 = 有人在改名单本身。
 *
 * ## ⚠️ 一个诚实的残留缺口（不要以为这条守卫全包了）
 *
 * 本守卫的记忆**存在版本库里**。所以「**把整棵树回退到一个更早的快照**」这种提交，
 * 会把测试文件**和基线一起**退回去 —— 两边一致，守卫是绿的。
 * 也就是说：**在基线登记之前就被删掉的新文件，本守卫抓不到。**
 * 能抓到那一档的判据只有"和远端历史比"（`origin/master` 的文件集必须是当前的子集），
 * 那需要 CI 侧 `fetch-depth` 的改动，**没有做**，留给下一轮决定。
 * 本守卫能抓到的是：**任何在基线登记之后消失的文件** —— 包括这次事故里那一个。
 *
 * ## 用法
 *
 *   node scripts/check-test-ratchet.mjs            # 门禁模式
 *   node scripts/check-test-ratchet.mjs --update   # 把新出现的测试文件登记进基线（只增不减）
 *   node scripts/check-test-ratchet.mjs --json     # 机器可读
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const BASELINE_PATH = join(REPO, 'scripts', 'test-ratchet-baseline.json');

/** 认哪些文件是"守卫文件"。改这条 = 改守卫的射程，请连同 `floor` 一起想清楚。 */
const TEST_FILE = /\.test\.tsx?$/;

/**
 * 扫描不是空集的地板。低于它 = 扫描本身坏了（而不是"真的没有测试了"）。
 * ⑤A-2：本仓已有四种"对空集返回绿"的形态，守卫的第一条断言必须是"我真的看到东西了"。
 */
const MIN_TEST_FILES = 100;

/**
 * 探针：这个文件必须被扫到。
 * 刻意选**这次事故里被删掉的那一个** —— 它要是又不见了，这条守卫第一时间就说话。
 */
const PROBE_FILE = 'packages/runtime/src/backends/platformUnsupported.test.ts';

/**
 * 列出**git 认得的**测试文件。
 *
 * 用 `git ls-files -z` 而不是 `find` / `grep` / shell glob，理由和
 * `check-orphan-exports.mjs:96-102` 记的是同一条：
 * `find` 在 Windows 上会撞见 `find.exe`；`grep -r` 会把含字面控制字节的文件
 * **静默当二进制跳过**；shell 的 `**` 语义各家不同。**在 Node 里过滤最不会骗人。**
 *
 * 另外"git 认得的"这一点是判据本身的一部分：未跟踪的半成品测试不该被算进棘轮
 * （否则别人 `git add` 之前的草稿会让门禁红），而**已提交的文件消失**正是要抓的。
 */
function trackedTestFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p && TEST_FILE.test(p));
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (e) {
    console.error(`✘ 读不到基线 ${BASELINE_PATH}：${e.message}`);
    console.error('  基线不可读时**不能**当成"没有基线所以放行" —— 那就是一条被静默关掉的守卫。');
    process.exit(1);
  }
}

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const wantUpdate = argv.includes('--update');

const current = trackedTestFiles();
const currentSet = new Set(current);

/* ── ① 自检先跑：扫描器本身没坏 ─────────────────────────────────────────────── */
const selfProblems = [];
if (current.length < MIN_TEST_FILES) {
  selfProblems.push(
    `只扫到 ${current.length} 个测试文件（下限 ${MIN_TEST_FILES}）—— 扫描范围坏了，不是"测试变少了"`,
  );
}
if (!currentSet.has(PROBE_FILE)) {
  selfProblems.push(`探针文件不在扫描结果里：${PROBE_FILE}`);
}
if (selfProblems.length > 0) {
  console.error('✘ check-test-ratchet 自检未通过 —— 先修扫描器，它现在的结论不可信：');
  for (const p of selfProblems) console.error(`   · ${p}`);
  console.error('\n  （一个扫不到东西的守卫会对空集返回绿，比没有守卫更坏 —— 它看起来像在守着。）');
  process.exit(1);
}

const baseline = loadBaseline();
const tracked = baseline.tracked ?? [];
const removed = baseline.removed ?? [];
const floor = baseline.floor ?? 0;

/* ── ② --update：只增不减地登记新文件 ───────────────────────────────────────── */
if (wantUpdate) {
  const known = new Set([...tracked, ...removed.map((r) => r.file)]);
  const added = current.filter((f) => !known.has(f)).sort();
  if (added.length === 0) {
    console.log('✔ 基线已经是最新的，没有新的测试文件要登记。');
    process.exit(0);
  }
  const next = {
    ...baseline,
    // ★ 只往里加。**绝不**按当前树重新生成 —— 那会把"被删掉的文件"一起抹掉，
    //   等于守卫帮着擦指纹（见文件头）。
    tracked: [...tracked, ...added].sort(),
    floor: tracked.length + added.length + removed.length,
    generatedAt: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`✔ 登记了 ${added.length} 个新的测试文件，floor ${floor} → ${next.floor}：`);
  for (const f of added) console.log(`   + ${f}`);
  console.log('\n  记得把 scripts/test-ratchet-baseline.json 一起提交。');
  process.exit(0);
}

/* ── ③ 判据 ─────────────────────────────────────────────────────────────────── */
const missing = tracked.filter((f) => !currentSet.has(f));
const knownSet = new Set([...tracked, ...removed.map((r) => r.file)]);
const unregistered = current.filter((f) => !knownSet.has(f)).sort();
const resurrected = removed.filter((r) => currentSet.has(r.file));
const reasonless = removed.filter((r) => !r.reason || String(r.reason).trim() === '');
const accounted = tracked.length + removed.length;

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        total: current.length,
        floor,
        accounted,
        missing,
        unregistered,
        reasonless: reasonless.map((r) => r.file),
      },
      null,
      2,
    ),
  );
}

const problems = [];

if (missing.length > 0) {
  problems.push('missing');
  console.error(`\n✘ **有 ${missing.length} 个已登记的测试文件不见了**：\n`);
  for (const f of missing) console.error(`   − ${f}`);
  console.error(
    [
      '',
      '  文件在不在是**事实**，不看提交信息 —— 今天就有一条自述「只改注释、零行为变更」的提交',
      '  静默删掉了 191 行的守卫测试，而删除**不会出现在提交者自己的 diff 里**。',
      '',
      '  三条出路，挑一条：',
      '  ① 你不是有意删的（多半是从**陈旧索引**提交的）→ 把文件恢复回来：',
      `       git checkout <删它之前的提交> -- ${missing[0]}`,
      '     并检查同一次提交是不是还顺手删了别的东西：git show --stat <你的提交>',
      '  ② 你**确实**要删它 → 编辑 scripts/test-ratchet-baseline.json：',
      '     把这几行从 `tracked` 挪进 `removed`，每条**必须**写 `reason` 说明为什么可以删。',
      '     （`floor` 不要动 —— 两个名单的**和**不许变小。）',
      '  ③ 它只是改名/搬家了 → 同 ②，reason 里写清搬去哪了。',
    ].join('\n'),
  );
}

if (accounted < floor) {
  problems.push('floor');
  console.error(
    [
      '',
      `✘ **名单本身变短了**：tracked(${tracked.length}) + removed(${removed.length}) = ${accounted}，低于 floor ${floor}。`,
      '',
      '  这意味着有人**直接把行从基线里删掉了**，而不是挪进 removed。',
      '  那样守卫就再也不知道那个文件存在过 —— 正是这条棘轮要防的事。',
      '  合法的删除请走 `removed` + `reason`，两个名单的和只能增不能减。',
    ].join('\n'),
  );
}

if (reasonless.length > 0) {
  problems.push('reasonless');
  console.error(`\n✘ **removed 里有 ${reasonless.length} 条没写 reason**：\n`);
  for (const r of reasonless) console.error(`   ? ${r.file}`);
  console.error(
    '\n  豁免必须带理由，否则它就是一个没人记得为什么存在的洞（和 check:orphans 的 note 同一个要求）。',
  );
}

if (resurrected.length > 0) {
  problems.push('resurrected');
  console.error(`\n✘ **removed 里有 ${resurrected.length} 条又回到树上了**：\n`);
  for (const r of resurrected) console.error(`   ↩ ${r.file}`);
  console.error('\n  把它挪回 `tracked` —— 豁免名单只准变短，不准留着过期条目。');
}

if (unregistered.length > 0) {
  // ⚠️ 这条**不判红**，是提示。理由是实测出来的，不是想出来的：
  //
  // 第一版把"未登记"也判红，理由是「基线不跟上新增，就保护不到刚加进来的文件」。
  // 它落地**几分钟之内**就红了 —— 另一条腿提交了一个新测试
  // （`backendInstallAvailability.test.ts`），master 当场红在我这一格。
  //
  // 树上同时有 9 个 agent，每个人加测试都会撞一次。而本仓的判据写得很清楚：
  // **一条经常为「合法工作」变红的守卫，会训练所有人忽略它** —— 那就等于把它删了，
  // 而且顺带把它真正要抓的那件事（**删除**）也一起淹掉。
  //
  // 代价看起来是"新文件在登记前没被保护"，但**那个窗口本来就是开的**：
  // 见文件头「残留缺口」—— 新文件的基线条目会和它自己**一起**被陈旧索引退回去，
  // 所以判红并不能真的护住这一档。**判红付出的是真代价，换来的是假保护。**
  //
  // 真正护住这一档要靠"和远端历史比"，那是另一条判据（见文件头）。
  console.log(`\nⓘ 有 ${unregistered.length} 个测试文件还没登记进基线（**不影响门禁**）：\n`);
  for (const f of unregistered) console.log(`   + ${f}`);
  console.log(
    [
      '',
      '  顺手登记一下（**只增不减，闭眼跑也不会掩盖删除**）：',
      '',
      '      pnpm check:test-ratchet --update',
      '',
      '  登记之后它才进入"消失就报警"的保护圈；不登记只是没保护，不会挡任何人。',
    ].join('\n'),
  );
}

if (problems.length > 0) {
  process.exit(1);
}

console.log(
  `✔ 测试文件棘轮：${current.length} 个在册（floor ${floor}，removed ${removed.length}），一个都没少`,
);
