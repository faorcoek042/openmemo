#!/usr/bin/env node
/**
 * 从 release 的**公开 URL**、**不带任何凭证**重新下载刚刚上传的资产，复算 sha256 与清单比对。
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * ★ 这一步在证明什么（三件事，一次做完）
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 *   1. **字节没变。** 上传返回 200 只证明"我们以为传上去了"。
 *      唯一能证明"用户拿到的和我们校验过的是同一份"的办法，是走用户那条路再取一次。
 *   2. **匿名下得到。** 整个下载过程一个 token 都没有 —— 而 **draft release 的附件
 *      匿名是下不到的**（pack-publish T-146 §1.2 实测）。所以这一步顺带把
 *      "release 不是 draft" 也验了，不需要另写一条检查。
 *   3. **URL 形态是产品真的会用的那个**：`github.com/<o>/<r>/releases/download/<tag>/<name>`，
 *      302 之后落在 `*.githubusercontent.com`（该 host 在 ALLOWED_DOWNLOAD_HOSTS 里）。
 *
 * ── "不带凭证"是**机器检查**的，不是纪律 ────────────────────────────────────────────
 *
 * 本脚本启动时会检查自己的环境里有没有 `GITHUB_TOKEN` / `GH_TOKEN` / `GH_ENTERPRISE_TOKEN`，
 * **有就当场失败**。理由：一个"约定不要传 token"的检查，迟早会被某个人"顺手"
 * 在 step 上补一行 `env: GITHUB_TOKEN: …`（那看起来永远像是在修一个 401），
 * 而那一刻这一步就**再也证明不了匿名可下**了 —— 它会继续绿，只是不再有意义。
 *
 * > 判据和本仓一贯的一样：**不是"记得别加"，是"加了就当场红"。**
 *
 * ── 为什么校验清单是"下载目录里那份 SHA256SUMS" ─────────────────────────────────────
 *
 * `release-upload.mjs` 产出的 `SHA256SUMS` **恰好**列出本次要保证在 release 上存在的资产，
 * 一个不多一个不少。于是把资产全下到同一个目录之后，**最显然的那条命令**
 *
 *     cd <下载目录> && sha256sum -c SHA256SUMS
 *
 * 本来就是对的 —— 不需要 `--ignore-missing`，不需要读文档。
 * （workflow 里真的会再跑一遍那条 coreutils 命令，作为一次独立于本脚本的复核。）
 *
 * 用法：
 *   node scripts/ci/release-verify.mjs --plan <含 SHA256SUMS + RELEASE-UPLOAD-PLAN.json 的目录> \
 *                                      --out <下载到哪里>
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

const PLAN_DIR = resolve(arg('--plan', 'dist/release-stage'));
const OUT = resolve(arg('--out', 'dist/release-verify'));

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

const problems = [];

async function summary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) await appendFile(f, `${md}\n`);
}

async function finish() {
  if (problems.length > 0) {
    say('');
    console.error(`✘ release-verify: ${problems.length} 个问题`);
    for (const p of problems) console.error(`  - ${p}`);
    await summary(`### ✘ release-verify 失败\n\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
    process.exit(1);
  }
}

/* ── ★ 凭证守卫：这一步的意义完全建立在"没有凭证"上 ──────────────────────────────── */

const CREDENTIAL_ENV = ['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_API_TOKEN'];
{
  const present = CREDENTIAL_ENV.filter((k) => (process.env[k] ?? '') !== '');
  if (present.length > 0) {
    console.error(
      `✘ release-verify: 环境里有凭证（${present.join(', ')}）。\n` +
        '  这一步存在的全部理由就是"不带凭证也能下下来" —— 带着 token 跑，它会继续绿，\n' +
        '  但再也证明不了任何东西（尤其证明不了 release 不是 draft）。\n' +
        '  修法不是把这条检查删掉，是把那个 env 从这一步上拿掉。',
    );
    process.exit(1);
  }
}

/* ── 清单 ────────────────────────────────────────────────────────────────────────── */

function parseSha256Sums(text, where) {
  const out = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const m = /^([0-9a-f]{64})\s[ *](.+)$/.exec(line);
    if (!m) {
      problems.push(`${where}:${i + 1} 不是 sha256sum 的标准格式：${JSON.stringify(line)}`);
      continue;
    }
    out.push({ sha256: m[1], name: m[2] });
  }
  return out;
}

async function main() {
  const plan = JSON.parse(await readFile(join(PLAN_DIR, 'RELEASE-UPLOAD-PLAN.json'), 'utf8'));
  const sums = parseSha256Sums(await readFile(join(PLAN_DIR, 'SHA256SUMS'), 'utf8'), 'SHA256SUMS');
  if (problems.length > 0) await finish();

  if (sums.length === 0) {
    problems.push('SHA256SUMS 一行都没有 —— 一个"什么都没验"却报成功的校验，比没有校验更糟');
    await finish();
  }
  /*
   * 计划与清单必须互相盖满。两份都由上一 job 产出，但它们是两条独立的路径写出来的；
   * 对不上就说明中间有人动过手（或者哪一条漏写了），此时**宁可红**。
   */
  const planNames = new Set(plan.assets.map((a) => a.name));
  const sumNames = new Set(sums.map((s) => s.name));
  for (const n of planNames)
    if (!sumNames.has(n)) problems.push(`计划里有 ${n}，SHA256SUMS 里没有`);
  for (const n of sumNames)
    if (!planNames.has(n)) problems.push(`SHA256SUMS 里有 ${n}，计划里没有`);
  for (const a of plan.assets) {
    const s = sums.find((x) => x.name === a.name);
    if (s && s.sha256 !== a.sha256)
      problems.push(`${a.name}: 计划说 ${a.sha256}，SHA256SUMS 说 ${s.sha256}`);
  }
  if (problems.length > 0) await finish();

  const base = (plan.downloadBase ?? 'https://github.com').replace(/\/+$/, '');
  hdr(`0. 不带任何凭证，从公开 URL 重新下载 ${sums.length} 个资产`);
  say(`   ${base}/${plan.repo}/releases/download/${plan.tag}/<资产名>`);
  say(`   环境里没有 ${CREDENTIAL_ENV.join(' / ')}（已断言）；请求里也没有 Authorization 头。`);
  say('');

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  for (const want of sums) {
    const url = `${base}/${plan.repo}/releases/download/${encodeURIComponent(plan.tag)}/${encodeURIComponent(want.name)}`;
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'openmemo-release-verify' },
      });
    } catch (e) {
      problems.push(
        `${want.name}: 匿名下载请求失败 —— ${e instanceof Error ? e.message : String(e)}`,
      );
      say(`   ✘ ${want.name.padEnd(56)} 请求失败`);
      continue;
    }
    if (!r.ok) {
      problems.push(
        `${want.name}: 匿名下载 HTTP ${r.status}。` +
          (r.status === 404
            ? ' 404 在这里最常见的成因是 **release 是 draft**（draft 的附件必须带 token 才下得到），' +
              '其次才是资产名写错。产品端的用户拿到的会是同一个 404'
            : ''),
      );
      say(`   ✘ ${want.name.padEnd(56)} HTTP ${r.status}`);
      continue;
    }

    const h = createHash('sha256');
    const chunks = [];
    let size = 0;
    for await (const c of r.body) {
      h.update(c);
      chunks.push(c);
      size += c.length;
    }
    const got = h.digest('hex');
    await writeFile(join(OUT, want.name), Buffer.concat(chunks));

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const finalHost = (() => {
      try {
        return new URL(r.url).host;
      } catch {
        return '?';
      }
    })();
    if (got !== want.sha256) {
      problems.push(
        `${want.name}: 清单说 ${want.sha256}，从公开 URL 下下来复算是 ${got}（${size} B）`,
      );
      say(`   ✘ ${want.name.padEnd(56)} sha256 不符（${secs}s，落到 ${finalHost}）`);
      continue;
    }
    say(`   ✔ ${want.name.padEnd(56)} ${String(size).padStart(12)} B  ${secs}s  → ${finalHost}`);
  }

  /* 把清单也放进下载目录，让 `sha256sum -c SHA256SUMS` 这条命令在那儿本来就是对的。 */
  await writeFile(
    join(OUT, 'SHA256SUMS'),
    `${sums.map((s) => `${s.sha256}  ${s.name}`).join('\n')}\n`,
  );

  hdr('1. 结果');
  if (problems.length === 0) {
    say(`   ${sums.length} 个资产，全部匿名下得到、且 sha256 与清单逐字符一致。`);
    say(`   下载目录：${OUT}（含一份只列这些文件的 SHA256SUMS）`);
    say('   独立复核用：  cd <下载目录> && sha256sum -c SHA256SUMS');
    await summary(
      [
        `### ✅ release-verify → \`${plan.tag}\``,
        '',
        `**不带任何凭证**从 \`${base}/${plan.repo}/releases/download/${plan.tag}/…\` 重新下载了 ` +
          `**${sums.length}** 个资产，逐个复算 sha256 与清单一致。`,
        '',
        '（这一步同时证明了 release 不是 draft —— draft 的附件匿名下不到。）',
        '',
      ].join('\n'),
    );
  }
  await finish();
}

await main();
