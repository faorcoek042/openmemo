#!/usr/bin/env node
/**
 * 把「每个变异矩阵格各自有哪几条变异什么都没证明」汇总成两个命令行片段，
 * 喂给 `emit-e2e-attestation.mjs`。
 *
 * ## 为什么不复用 `sum-undecided.mjs`
 *
 * 那个脚本汇总的是**一个数**。这里要的是**是哪几条** —— 只给一个数（甚至一个布尔），
 * 下一个人看到 `ran-unverified` 仍然不知道该去查什么，那是"报了警不给线索"。
 *
 * ## 🔴 缺一格时的收敛方向，与 `sum-undecided.mjs` **刻意相反**
 *
 * `sum-undecided.mjs` 缺一格 ⇒ 收敛成 `null`（"没上报"），因为那一格的语义是
 * **一个可以诚实地说"不知道"的计数**。
 *
 * 这里不行：`mutations` 那一格只要不是 `ran-unverified`，凭证就会说
 * **「每一条变异都有结论」** —— 那是一句**正面的断言**。文件没下到、读不出、
 * 标签对不上时，我们**并不知道**它成不成立，而把"不知道"写成一句正面断言
 * 正是这一整轮在拆的东西。
 *
 * ⇒ 所以这里**向"有未验证的"收敛**：任何一格对不上，都判 `ran-unverified`，
 *   并把对不上的那一格**当成一条未验证项列出来**（`<label>:(覆盖面读不到)`）。
 *   代价是可能虚报一条；而虚报一条的后果是**闸门多念一句**（不拦），
 *   漏报一条的后果是**凭证说了假话**。两者不对称，所以往响的那边倒。
 *
 * ## 输出协议（照 `sum-undecided.mjs` 的形状：直接拼进下一条命令行）
 *
 *   · `mutations_state`  —— `ran` | `ran-unverified`
 *   · `unverified_flag`  —— `--unverified-mutations "a,b"`，或空字符串
 *
 * ## 用法
 *
 *   node scripts/ci/collect-unverified-mutations.mjs \
 *     --dir unverified \
 *     --expect-labels linux-x64,darwin-arm64 \
 *     --file-template 'e2e-runtime-unverified-{label}.json' \
 *     [--github-output "$GITHUB_OUTPUT"]
 *
 * `--dir` / `--expect-labels` 缺失是**调用方自己的配置错误**（写死在 YAML 里，
 * 不随平台跑没跑而变），照 `sum-undecided.mjs` 的规矩 die()。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const die = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};

/**
 * 纯判据（可 import，`selftest-attestation-mutations.mjs` 对着它跑）。
 *
 * `readOne(label)` 返回 `{ ok: true, ids: [...] }` 或 `{ ok: false, why }`。
 * 返回 `{ state, ids, notes }`。
 */
export function collectUnverified(labels, readOne) {
  const ids = [];
  const notes = [];
  for (const label of labels) {
    const r = readOne(label);
    if (!r || r.ok !== true) {
      // ★ 往响的那边倒：不知道 ≠ 都有结论。
      ids.push(`${label}:(覆盖面读不到)`);
      notes.push(`⚠ ${label}：${r?.why ?? '没读到'} —— 按"可能有未验证的"计，绝不当成全都有结论`);
      continue;
    }
    for (const id of r.ids) ids.push(`${label}:${id}`);
  }
  return { state: ids.length > 0 ? 'ran-unverified' : 'ran', ids, notes };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith('collect-unverified-mutations.mjs')) {
  const dir = arg('--dir', null);
  const labelsRaw = arg('--expect-labels', null);
  const tpl = arg('--file-template', null);
  const ghOut = arg('--github-output', null);
  if (!dir) die('--dir 必填');
  if (!labelsRaw) die('--expect-labels 必填');
  if (!tpl || !tpl.includes('{label}')) die('--file-template 必填，且要含 {label} 占位符');

  const labels = labelsRaw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const { state, ids, notes } = collectUnverified(labels, (label) => {
    const f = join(dir, tpl.replace('{label}', label));
    if (!existsSync(f)) return { ok: false, why: `缺文件 ${f}` };
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (!Array.isArray(j.unverified)) return { ok: false, why: 'unverified 不是数组' };
      return { ok: true, ids: j.unverified.map(String).filter(Boolean) };
    } catch (e) {
      return { ok: false, why: String(e.message).slice(0, 80) };
    }
  });

  for (const n of notes) console.warn(n);
  console.log(`变异未验证汇总：state=${state}${ids.length ? ` · ${ids.join('、')}` : ''}`);

  const flag = ids.length > 0 ? `--unverified-mutations "${ids.join(',')}"` : '';
  if (ghOut) {
    appendFileSync(ghOut, `mutations_state=${state}\n`);
    appendFileSync(ghOut, `unverified_flag=${flag}\n`);
  }
}
