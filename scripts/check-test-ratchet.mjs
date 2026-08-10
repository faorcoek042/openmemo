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
 * ## 那个残留缺口，以及 `--against` 怎么堵它
 *
 * 本守卫的记忆**存在版本库里**。所以「**把整棵树回退到一个更早的快照**」这种提交，
 * 会把测试文件**和基线一起**退回去 —— 两边一致，**上面那些判据全是绿的**。
 * 这就是第一版如实登记的缺口。
 *
 * `--against <ref>` 堵它，靠的是**基线只增不减**这条已经立好的规矩：
 * 既然 `tracked`/`removed` 只增、`floor` 单调不减，那么「**基线自己缩了**」
 * 本身就是一个可判的异常 —— 而整树回退**正好落在这个信号上**
 * （回退后的基线必定是某个更早、更短的版本）。
 *
 * 只需要读**一份文件**（基准 commit 上的那份基线），所以 CI 里
 * `git fetch --depth=1 origin <base>` 定点取一个 commit 就够了，
 * **不用动全局 `fetch-depth`**（那会给每个 job 都加克隆代价）。
 * `[实测]` depth=1 浅克隆里定点 fetch 一个历史 SHA：**1.8 秒**，随后
 * `git show <sha>:scripts/test-ratchet-baseline.json` 正常读出。
 *
 * ⚠️ **仍然剩下的部分（别读成"现在全包了"）**：
 * `--against` 只在**给得出基准**时有效。基准取不到（force-push、新分支首推、
 * fetch 失败）时它**不判红**（那会变成一盏经常为合法情况亮的灯），
 * 而是**明说"没跑成"**。所以绿输出里永远会写清楚这次到底比没比 ——
 * **"没比对"和"比过且没问题"绝不能长得一样**，那正是本守卫要防的病本身。
 *
 * ## 用法
 *
 *   node scripts/check-test-ratchet.mjs                  # 门禁模式
 *   node scripts/check-test-ratchet.mjs --update         # 登记新测试文件（只增不减）
 *   node scripts/check-test-ratchet.mjs --against <ref>  # 再和基准比一次基线有没有缩水
 *   node scripts/check-test-ratchet.mjs --json           # 机器可读
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
 * 列出**已提交的**测试文件（`HEAD` 那棵树，不是索引）。
 *
 * 用 `git ls-tree -r HEAD -z` 而不是 `find` / `grep` / shell glob，理由和
 * `check-orphan-exports.mjs:96-102` 记的是同一条：
 * `find` 在 Windows 上会撞见 `find.exe`；`grep -r` 会把含字面控制字节的文件
 * **静默当二进制跳过**；shell 的 `**` 语义各家不同。**在 Node 里过滤最不会骗人。**
 *
 * ## ⚠️ 为什么是 `ls-tree HEAD` 而不是 `ls-files`（索引）—— 这条是踩出来的
 *
 * 第一版读的是 `git ls-files`，也就是**索引**。在 `/root/memo` 这种 9 个 agent
 * 共用一棵树的地方，索引里**装着别人 `git add` 了但还没提交的文件**。
 *
 * 后果当场发生了：我在共享树上跑了一次 `--update`，把另一条腿**尚未提交的**
 * `apps/daemon/src/http/rest/backendInstallAvailability.test.ts` 写进了基线并推了上去。
 * master 那边**基线里有、树上没有** → 棘轮判"文件不见了" → **master 红**。
 * 红的不是别人删了东西，是**我登记了一个在 master 上根本不存在的文件**。
 *
 * 判据因此改成「**已提交**的那棵树」：
 * - 结论不再取决于**任何人**当下 stage 了什么 —— 同一个提交，在 CI 上和在谁的机器上
 *   都给同一个答案（和 `.prettierignore` 那轮立的「门禁必须确定」是同一条）；
 * - `--update` 再也不可能把别人没提交的东西写进基线。
 *
 * 代价：本地**提交之前**的陈旧索引删除它看不见了。可以接受 ——
 * 判据本来就是「**已提交**的文件消失」，而真正的执行点是 CI，那里 `HEAD` 就是被推上去的那个提交。
 */
function trackedTestFiles(ref = 'HEAD') {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', ref], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p && TEST_FILE.test(p));
}

/**
 * 读**另一个 commit** 上的那份基线。用于 `--against`（见文件头「残留缺口」）。
 * 读不到就返回 null —— 由调用方决定怎么说话，**这里不许默默当成"没问题"**。
 */
function baselineAtRef(ref) {
  try {
    const raw = execFileSync('git', ['show', `${ref}:scripts/test-ratchet-baseline.json`], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
/** `--against <ref>`：和 `<ref>` 上的那份基线比，看**基线自己有没有缩水**。 */
const againstIdx = argv.indexOf('--against');
const againstRef = againstIdx >= 0 ? (argv[againstIdx + 1] ?? '').trim() : '';
/** 全零 SHA 是 GitHub 在"新分支的第一次 push"时给的 `github.event.before`，不是异常。 */
const isNullRef = /^0{7,40}$/.test(againstRef);

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
    // ★ 必须取 max，**不能重算**。这是审计里查出来的一个真 bug（我自己写的）：
    //
    //   原本写的是 `tracked.length + added.length + removed.length` —— 一次**重算**。
    //   于是这条路径打开了：手删 `tracked` 里 N 行 → 再加 1 个新测试 → 跑 `--update`
    //   → floor **静默降 N**，条件 ③ 的 `accounted < floor` 从此永远不会响。
    //
    //   文件头承诺「`--update` 只增不减，闭眼跑也不会掩盖删除」——
    //   那句话对 `tracked[]` 成立，**对 `floor` 不成立**。
    //   **一个专门防"守卫帮着擦指纹"的设计，自己留了一道擦指纹的门。**
    //
    //   取 max 之后 floor 单调不减：删名单行只会让 accounted 掉到 floor 底下 ⇒ 当场红。
    floor: Math.max(floor, tracked.length + added.length + removed.length),
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

/* ── ④ `--against <ref>`：堵「整棵树被回退」那个缺口 ─────────────────────────────
 *
 * 本守卫的记忆存在版本库里，所以「把整棵树回退到更早快照」的提交会把测试文件
 * **和基线一起**退回去 —— 两边一致，上面那些判据全是绿的。
 *
 * 但**基线只增不减是已经立好的规矩**（`--update` 只增、`floor` 单调不减）。
 * 所以「**基线自己缩了**」本身就是一个可判的异常信号，而整树回退**正好落在它上面**：
 * 回退后的基线一定是某个更早的、更短的版本。
 *
 * 只读**一份文件**（基准 commit 上的那份基线），所以 CI 里只要
 * `git fetch --depth=1 origin <base>` 定点取一个 commit 就够了 ——
 * **不需要动全局 `fetch-depth`**（那会给每个 job 都加克隆代价）。
 * `[实测]` 在 depth=1 的浅克隆里定点 fetch 一个历史 SHA：**1.8s**，随后
 * `git show <sha>:scripts/test-ratchet-baseline.json` 能正常读出。
 */
let againstNote = '';
if (againstRef && !isNullRef) {
  const baseBaseline = baselineAtRef(againstRef);
  if (baseBaseline === null) {
    // ⚠️ **不判红**（基准取不到多半是 force-push / 首推 / fetch 没成功，
    //    判红就是一盏经常为合法情况亮的灯），但**必须大声说没比成** ——
    //    "没比"和"比过且没问题"绝不能长得一样。
    againstNote = `⚠️ 历史比对**没跑成**：读不到 ${againstRef} 上的基线（没 fetch 到？force-push？）`;
  } else {
    const baseKnown = [
      ...(baseBaseline.tracked ?? []),
      ...(baseBaseline.removed ?? []).map((r) => r.file),
    ];
    const nowKnown = new Set([...tracked, ...removed.map((r) => r.file)]);
    const vanished = baseKnown.filter((f) => !nowKnown.has(f));
    const baseFloor = baseBaseline.floor ?? 0;

    if (vanished.length > 0 || floor < baseFloor) {
      problems.push('regressed');
      console.error(`\n✘ **基线自己缩水了**（和 ${againstRef} 比）：\n`);
      if (vanished.length > 0) {
        console.error(`   基准上在册、现在整条不见了的有 ${vanished.length} 条：`);
        for (const f of vanished.slice(0, 20)) console.error(`   − ${f}`);
        if (vanished.length > 20) console.error(`   …… 还有 ${vanished.length - 20} 条`);
      }
      if (floor < baseFloor) console.error(`   floor 从 ${baseFloor} 掉到了 ${floor}`);
      console.error(
        [
          '',
          '  基线**只增不减**是这条棘轮的规矩，所以它变短本身就是异常。最可能的成因：',
          '  **这次提交把整棵树（连基线一起）回退到了一个更早的快照** ——',
          '  典型来源就是**从陈旧索引提交**，而它不会出现在你自己的 diff 里。',
          '',
          `  先看一眼这次提交到底动了什么：git show --stat <你的提交>`,
          `  再对一下基线：git diff ${againstRef} -- scripts/test-ratchet-baseline.json`,
        ].join('\n'),
      );
    } else {
      againstNote = `历史比对已做（vs ${againstRef}：基准 ${baseKnown.length} 条全部还在，floor ${baseFloor} → ${floor}）`;
    }
  }
} else {
  againstNote = isNullRef
    ? '未做历史比对（基准是全零 SHA —— 新分支首推，正常）'
    : '未做历史比对（没给 --against）';
}

if (problems.length > 0) {
  if (againstNote) console.error(`\n${againstNote}`);
  process.exit(1);
}

// ★ 绿的时候也要把**做了什么**说出来。"没比对"和"比对过且没问题"必须能一眼分开 ——
//   否则这条守卫就有了一个"看起来在守、其实没跑"的姿势，那正是它自己要防的病。
console.log(
  `✔ 测试文件棘轮：${current.length} 个在册（floor ${floor}，removed ${removed.length}），一个都没少`,
);
console.log(`  ${againstNote}`);
