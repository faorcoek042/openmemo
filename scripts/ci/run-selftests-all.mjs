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
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
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
    const ok = r.status === 0;
    results.push({ label, ok, status: r.status, timedOut, spawnError: r.error?.message, ms });
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
  return { ok: results.every((r) => r.ok), results, fatal: null };
}

async function main() {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  const chain = String(pkg.scripts?.['test:ci-scripts'] ?? '');
  const { results, fatal } = await runAll({ chain, cwd: REPO_ROOT });
  if (fatal) {
    console.error(`✘ run-selftests-all: ${fatal}`);
    process.exit(1);
  }
  reportAndExit(results);
}

function reportAndExit(results) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n══ 汇总（${process.platform}/${process.arch}）══════════════════════════════`);
  for (const r of results) {
    console.log(
      `  ${r.ok ? '✔' : '✘'} ${r.label}` +
        (r.ok
          ? ''
          : ` ← ${r.timedOut ? 'timeout' : r.spawnError ? 'spawn 失败' : `exit ${r.status}`}`),
    );
  }
  if (failed.length === 0) {
    console.log(`\n✔ run-selftests-all: ${results.length} 环全绿（${process.platform}）`);
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
