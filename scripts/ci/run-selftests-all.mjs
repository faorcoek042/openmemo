#!/usr/bin/env node
/**
 * ★ 把 `test:ci-scripts` 那条 `&&` 长链跑完，**不在第一处红的地方停下**。
 *
 * ## 它治的病（`[实测]`，两次真跑，不是推理）
 *
 * `ci-crossplatform.yml` 的文件头写着它存在的理由是**信息密度**：
 *
 * > 「一次 dispatch 想把 macOS / Windows 上**所有**坏点一次列全，
 * >   而不是每轮只看到最靠前的那一个然后再排队 20 分钟。」
 *
 * 它用 `if: ${{ !cancelled() }}` 解决了**步骤之间**的截断。但**步骤内部**还有两层，
 * 而文件头不知道它们的存在：
 *
 * - `pnpm test:ci-scripts` 是一条 **35 环的 `&&` 链**，断在第一环。
 *   `[实测 run 31389910051 + 32651393827，两次一致]`
 *   win32 断在第 6 环（`selftest-elf-glibc`），macOS 断在第 7 环（`selftest-pack-deps`）
 *   ⇒ **后面 28 / 29 个自检从来没有在这两个平台上执行过一次。**
 * - `pnpm -r test` 的 bail（由 `--no-bail` 单独治，见 `ci-crossplatform.yml` 那一步）。
 *
 * ### 被这条链遮住最久的那件事
 *
 * `ci-crossplatform.yml` 里有一段 `[未验证，需真机]` 的预测，写于 2026-08-07：
 * 「`selftest-buildbox.sh` / `selftest-build-whisper.sh` 用到 `ldd`，Windows 上没有；
 *   macOS 上 `sed` 是 BSD 版」。那两个 `.sh` 排在链条**第 27、28 环**。
 * 链条从来没走到过第 7 环之后 ⇒ **这条预测在两次真跑里一次都没有被执行到**，
 * 却以「探针会把它验出来」的语气写了 17 天。
 * 这正是本仓四种守卫失效形态里的第 ④ 种：**注释型断言** ——
 * 一句描述得很具体、听起来已经被机器管着的话，而机器结构上够不着它。
 *
 * ## 为什么单源仍然是 `package.json` 的那条链
 *
 * 本脚本**不自己维护清单**，它把 `scripts['test:ci-scripts']` 按 `&&` 切开来跑。
 * 理由是 `lint-workflows.mjs:583-604`（T-163）那组断言盯的就是那条字符串
 * ——「一条没接进 `test:ci-scripts` 的自检等于不存在」。
 * 如果这里另立一份清单，两份就会漂，而**漂掉的那一半失效时看起来和从没有过一模一样**。
 *
 * ## 它**不**改变 `ci.yml` 的行为
 *
 * `ci.yml` 的 `gate` 仍然跑 `pnpm test:ci-scripts`（短路版）。门禁要的是**快速判决**，
 * 第一处红就够它拦住合并了。本脚本只给**探针**用：探针要的是一次列全。
 * 两者跑的是**同一份清单**，所以不会出现「门禁跑 35 条、探针跑另外 30 条」。
 *
 * ## 反向验证（判据：抽掉修法必须红）
 *
 * `scripts/ci/selftest-workflow-expiry.mjs` 的 B 组逐条钉住：链条被切短会红、
 * 有一环红时**后面的环仍然被执行**（拿一条故意在中间红的假链跑）、
 * 以及"一条都没解析出来"必须红（空转防线）。
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join, dirname } from 'node:path';
import { SKIP_EXIT_CODE } from './platform-scope.mjs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 把 `a && b && c` 切成 [a, b, c]。
 *
 * 刻意用最笨的切法：这条链里从来没有出现过 `&&` 以外的连接符，也没有引号里的 `&&`。
 * 一旦哪天出现了（比如有人加了 `sh -c "x && y"`），切出来的那一环会认不出形状，
 * 于是下面 `parseLink` 那道「认不出来就红」的闸会先响 —— 那比这里悄悄切错好。
 */
export function splitChain(cmd) {
  return String(cmd)
    .split('&&')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 一环 = 一个可执行命令。只认这条链里真实存在的两种形状。
 *
 * ⚠️ 不用 `shell: true` 转交给系统 shell：Windows runner 的默认 shell 是 pwsh，
 * 而这条链里的 `bash scripts/ci/*.sh` 在 pwsh 下要靠 PATH 里的 Git Bash。
 * 显式 spawn 才能保证三个平台跑的是同一件事。
 */
export function parseLink(link) {
  const m = /^(node|bash)\s+(\S+)(.*)$/.exec(link);
  if (!m) return null;
  const [, bin, script, rest] = m;
  const args = rest.trim() ? rest.trim().split(/\s+/) : [];
  return { bin, script, args, label: `${bin} ${script}${rest}`.trim() };
}

/* ══════════════════════════════════════════════════════════════════════════════════
 * T-163 的判据本体：**`scripts/ci/selftest-*` 全集必须 ⊆ `test:ci-scripts`**
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * 扫描地板。**这是防「扫描器悄悄什么都不匹配了」的那道保险。**
 *
 * 一个 glob 打错一个字 ⇒ 扫出 0 个 ⇒ `[].every()` 恒真 ⇒ 这道门从此永远绿，
 * 而它失效的样子和「全都接上了」一模一样。取 20（今天 29 个），只防塌方：
 * 真要成批删自检是一次显式决定，撞上这条地板时红的那句话会把两种读法都端出来。
 */
export const SELFTEST_FLOOR = 20;

/** 读 `scripts/ci/` 下所有 `selftest-*.mjs` / `selftest-*.sh` 的**文件名**。 */
export async function listSelftestFiles(dir = join(REPO_ROOT, 'scripts', 'ci')) {
  return (await readdir(dir))
    .filter((f) => f.startsWith('selftest-') && (f.endsWith('.mjs') || f.endsWith('.sh')))
    .sort();
}

/**
 * T-163：**一条没接进 `test:ci-scripts` 的自检等于不存在。**
 *
 * ## 为什么从「手写 7 条」改成「扫描全集」（#85）
 *
 * 上一版是一份**手抄的名单**，钉住 7 个自检。审计当天数出来的实况是：
 * 磁盘上 **29** 个 `selftest-*`，链上 29 个，而这道门只看得见其中 **7** 个。
 * ⇒ **另外 22 个里的任何一个被从链里摘掉，`ci.yml` 一声不吭。**
 *
 * 唯一的兜底是本文件的 `MIN_LINKS = 25`（今天 38 环 ⇒ 要删满 13 环才响），
 * 而它**只在 `ci-crossplatform.yml` 夜跑上跑，不在推送门禁上**。
 * 也就是说：摘掉一个自检、当天合进 master，没有任何一盏灯会亮。
 *
 * 这正是这道门自己要防的那件事，发生在它自己身上 —— 一份手抄名单与它要
 * 覆盖的集合**各自演化**，而漂掉的那一半失效时看起来和从没有过一模一样。
 * （同一形状的第三次：`check-orphan-exports` 按裸名匹配 #83、
 *   `selftest-launcher-path` 的 LEGS 手写 4/8。）
 *
 * ## ⚠️ 刻意**没有**豁免名单
 *
 * 一份「这几个可以不接链」的例外表，第二天就会变成新的手抄名单。
 * 真有一个自检不该进链，就让它在这里红一次 —— 那一次红逼出的是一个**显式决定**
 * （要么接上，要么连同文件一起删掉），而不是一行悄悄加进例外表的名字。
 *
 * ## ⚠️ 判据是「解析出来的那一环的脚本名」，不是 `chain.includes(名字)`
 *
 * 子串匹配会被**参数**满足：`node scripts/ci/x.mjs --baseline selftest-bundle.mjs`
 * 里 `selftest-bundle.mjs` 出现了，但它根本不会被执行。老实现用的就是
 * `cmd.includes(f)`。这里改用已经被反向验证过的 `parseLink()` 取每一环真正的脚本。
 *
 * @param {{chain: string, selftestFiles: string[], floor?: number}} o
 * @returns {{ok: boolean, problems: string[], scanned: number, missing: string[]}}
 */
export function auditSelftestCoverage({ chain, selftestFiles, floor = SELFTEST_FLOOR } = {}) {
  const problems = [];
  const files = [...(selftestFiles ?? [])].sort();

  if (files.length < floor) {
    problems.push(
      `scripts/ci/ 里只扫到 ${files.length} 个 \`selftest-*\`（地板 ${floor}）——\n` +
        `      要么**扫描器坏了**（那样这道门会从此永远绿，比没有门更坏），\n` +
        `      要么真的成批删了自检（那是一次显式决定，请连同这条地板一起改）。\n` +
        `      两种都得有人当场看一眼，所以这里不比对、直接红。`,
    );
    return { ok: false, problems, scanned: files.length, missing: [] };
  }

  const inChain = new Set();
  for (const link of splitChain(chain)) {
    const parsed = parseLink(link);
    if (parsed) inChain.add(basename(parsed.script));
  }

  const missing = files.filter((f) => !inChain.has(f));
  if (missing.length > 0) {
    problems.push(
      `package.json: test:ci-scripts 里没有这 ${missing.length} 个自检 —— ` +
        `**没被跑到的自检等于不存在**：\n` +
        missing.map((f) => `        scripts/ci/${f}`).join('\n') +
        `\n      （扫到 ${files.length} 个 selftest-*，链上认出 ${inChain.size} 个脚本。）\n` +
        `      要么把它接进链，要么连同文件一起删掉 —— 不许留着一个不会跑的自检，` +
        `那比没有它更坏：它看起来像一份证明。`,
    );
  }

  return { ok: problems.length === 0, problems, scanned: files.length, missing };
}

/** 单环上限。一个挂住的自检不许把整台 runner 的时间吃光。 */
const PER_LINK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 形状下界。**这条是空转防线**：链条被谁"顺手简化"成两三环时，
 * 本脚本会报绿（每一环都过了）而实际上什么都没检查。
 * 数字取自 `[实测 d72dc34]` 的 35 环，留了余量只防塌方，不防增删一两条。
 */
const MIN_LINKS = 25;

/**
 * 跑完一条链，返回逐环结果。**入参化是为了让反向验证跑得起来** ——
 * 「一环红了，后面的环仍然被执行」这条性质只有拿一条**故意在中间红**的假链
 * 才证得了，而真链（希望）不是随时都有一环红的。
 *
 * @param {{chain: string, cwd: string, minLinks?: number, quiet?: boolean}} o
 */
export async function runAll({ chain, cwd, minLinks = MIN_LINKS, quiet = false } = {}) {
  const say = quiet ? () => {} : (s) => console.log(s);
  const links = splitChain(chain);

  if (links.length < minLinks) {
    return {
      ok: false,
      results: [],
      fatal:
        `从 package.json 的 test:ci-scripts 只解析出 ${links.length} 环 (< ${minLinks})。` +
        `要么那条链被截短了，要么这里的切法过期了 —— 两种都必须有人看一眼，不许当成"跑完了"。`,
    };
  }

  const bad = links.filter((l) => parseLink(l) === null);
  if (bad.length > 0) {
    return {
      ok: false,
      results: [],
      fatal:
        `这些环认不出来（只支持 \`node X\` / \`bash X\`）：\n` +
        bad.map((b) => `    ${b}`).join('\n') +
        `\n认不出来就跑不到 —— 与其悄悄跳过，不如在这里红。`,
    };
  }

  say(
    `══ run-selftests-all ══ ${links.length} 环，**全部跑完再汇总**（不在第一处红停下）\n` +
      `   平台：${process.platform}/${process.arch} node ${process.versions.node}\n`,
  );

  const results = [];
  for (const [i, link] of links.entries()) {
    const { bin, script, args, label } = parseLink(link);
    const n = `[${String(i + 1).padStart(2)}/${links.length}]`;
    say(`\n───── ${n} ${label} ─────`);
    const t0 = Date.now();
    const r = spawnSync(bin, [script, ...args], {
      cwd,
      stdio: quiet ? 'ignore' : 'inherit',
      timeout: PER_LINK_TIMEOUT_MS,
      shell: false,
    });
    const ms = Date.now() - t0;
    // spawnSync 超时会给 signal=SIGTERM 且 status=null；status=null 也可能是 spawn 失败。
    const timedOut = r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal != null);
    /*
     * ★ 250 = `platform-scope.mjs` 的「本平台上无意义，跳过」。
     *   它**不是**通过：单独计数、单独一栏、单独写进 JSON。
     *   「跳过」和「通过」一旦在输出里分不开，这条链就退化成它要治的那个病。
     */
    const skipped = r.status === SKIP_EXIT_CODE && !timedOut;
    const ok = r.status === 0;
    results.push({
      label,
      ok,
      skipped,
      status: r.status,
      timedOut,
      spawnError: r.error?.message,
      ms,
    });
    if (skipped) {
      say(`───── ${n} ◐ ${label} —— 按平台收窄，本平台跳过（不计入绿）`);
      continue;
    }
    if (!ok) {
      say(
        `───── ${n} ✘ ${label} —— ` +
          (timedOut
            ? `超过 ${PER_LINK_TIMEOUT_MS / 1000}s 被打断`
            : r.error
              ? `起不来：${r.error.message}`
              : `exit ${r.status}`) +
          ` **继续跑下一环**（这正是本脚本存在的理由）`,
      );
    }
  }
  return { ok: results.every((r) => r.ok || r.skipped), results, fatal: null };
}

async function main() {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  const chain = String(pkg.scripts?.['test:ci-scripts'] ?? '');
  const { results, fatal } = await runAll({ chain, cwd: REPO_ROOT });

  /*
   * `--json <path>`：给 `xplat-ratchet.mjs` 读的**结构化**结果。
   *
   * ⚠️ 这不是锦上添花。棘轮的第一版是去**刮**下面那段人类可读汇总的，
   * 而它当场刮错了：`══ 汇总（` 这个锚点在 `selftest-ci-manifest` 的输出里也有，
   * 于是刮到了另一个脚本的汇总，报出 "16 环" 而真值是 37 —— 而且**它不会红**，
   * 只会把基线对比建立在一份残缺的今日集合上。
   * **能产出结构化结果的东西，就不该让别人去刮它的人类可读输出。**
   */
  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt >= 0) {
    const out = process.argv[jsonAt + 1];
    if (!out) {
      console.error('✘ run-selftests-all: --json 后面没给路径');
      process.exit(1);
    }
    await writeFile(
      out,
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          total: results.length,
          links: results.map((r) => ({
            label: r.label,
            status: r.skipped ? 'skip' : r.ok ? 'pass' : 'fail',
            exit: r.status,
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`   （逐环结果已写入 ${out}）`);
  }

  if (fatal) {
    console.error(`✘ run-selftests-all: ${fatal}`);
    process.exit(1);
  }
  reportAndExit(results);
}

function reportAndExit(results) {
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n══ 汇总（${process.platform}/${process.arch}）══════════════════════════════`);
  for (const r of results) {
    const mark = r.skipped ? '◐' : r.ok ? '✔' : '✘';
    const why = r.skipped
      ? ' ← 按平台收窄，跳过（**不是**通过）'
      : r.ok
        ? ''
        : ` ← ${r.timedOut ? 'timeout' : r.spawnError ? 'spawn 失败' : `exit ${r.status}`}`;
    console.log(`  ${mark} ${r.label}${why}`);
  }
  if (failed.length === 0) {
    console.log(
      `\n✔ run-selftests-all: ${results.length - skipped.length} 环绿 / ` +
        `${skipped.length} 环按平台跳过 / 0 环红（${process.platform}）`,
    );
    return;
  }
  console.error(
    `\n✘ run-selftests-all: ${failed.length}/${results.length} 环红（${process.platform}）：\n` +
      failed.map((f) => `    ${f.label}`).join('\n') +
      `\n\n★ 这份清单是**完整的**（链条跑到底了）。` +
      `短路版 \`pnpm test:ci-scripts\` 在这个平台上只会报出其中最靠前的一条。`,
  );
  process.exit(1);
}

// 被 selftest import 时不自动跑。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
