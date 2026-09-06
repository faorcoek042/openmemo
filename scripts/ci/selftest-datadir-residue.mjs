#!/usr/bin/env node
/**
 * selftest-datadir-residue.mjs —— 把 2026-08-11 那次**静默断裂**当夹具，钉在推送门禁上。
 *
 * ## 它守的是哪一次事故
 *
 * `datadir-migrate-audit.mjs` 的 C4 是「界面说的和实际发生的必须一致」这条判据
 * **唯一在验它的那一格**（其余七格验的是"数据搬对了"）。而它坏过一次：
 *
 *   · `2676e90`(2026-08-10) 把 C4 写成读 `sourceResidue` **数组** —— **当时是对的**。
 *   · `f21ca78`(#87, 2026-08-11) 把产品侧的 `SourceResidue` 改成三态标签联合
 *     `{kind:'read',entries} | {kind:'unreadable',reason}`，**审计脚本没跟着改**。
 *   · `Array.isArray(对象)` 恒为 false ⇒ `honest` 恒为 false ⇒ **C4 无条件 FAIL**。
 *   · 而 `e2e-datadir` 最后一次运行是 08-09 —— **在断裂之前**，且只有 `workflow_dispatch`。
 *     **整整一个月没有任何人知道那一格已经不工作了。**
 *
 * ## 为什么必须是一格**门禁**，而不是一次手跑
 *
 * 修那条判据的时候，验证只做在一份 bench 脚本上（`/tmp`，不进仓、不在链上）。
 * 那等于**没有验证**：下一个人把判据改回旧形状，不会有任何东西说话，
 * 而 `e2e-datadir` 要等谁想起来手动触发才会现形 —— 上一次这个间隔是一个月。
 *
 * ⚠️ **判红和判红的理由是两件事。** 形状不认识时它**照样红**，但那句话必须指着
 *    审计脚本自己（「判据过时了，别去修产品」）。A6 专门钉这一条：一条说错了
 *    原因的红，会把下一个人送去修一个没坏的东西 —— 那正是这次事故的实际代价。
 */
import { judgeResidueHonesty, readResidue } from './datadir-migrate-assertions.mjs';

let failed = 0;
const is = (name, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(
    `  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`,
  );
};

/**
 * 一个**假的**产品文案渲染器 —— 刻意不 import 产品代码。
 * 判据模块是纯函数，喂什么它就判什么；这里要的是可控的输入，不是真实文案。
 */
const AS_IF_EMPTY = '旧目录已经空了，但目录本身还在。';
const render = () => AS_IF_EMPTY;

const judge = (residue, msg, onDisk) =>
  judgeResidueHonesty({ residue, msg, onDisk, renderAsIfEmpty: render });

console.log('\nA 组：三态各自判 —— 不许塌陷成一件事（这正是 #87 在产品侧治的病）');

// ── A1 read + 名单齐全 ⇒ 绿 ──────────────────────────────────────────────────
{
  const r = judge(
    { kind: 'read', entries: ['models', 'openmemo.db'] },
    '旧目录仍在，里面还剩下：models、openmemo.db',
    ['models', 'openmemo.db'],
  );
  is('A1 read + 名单齐全 ⇒ 绿', r.honest, true);
  is('A1 分类为 read', r.kind, 'read');
}

// ── A2 磁盘上有、文案里没念到 ⇒ 红（就是 2026-08-08 那次事故的形状）──────────
{
  const r = judge(
    { kind: 'read', entries: ['models', 'openmemo.db', 'secrets.json'] },
    '旧目录仍在，里面还剩下：models、openmemo.db',
    ['models', 'openmemo.db', 'secrets.json'],
  );
  is('A2 ★ 文案漏念了 secrets.json ⇒ 红', r.honest, false);
}

// ── A3 报告里多说了一个磁盘上没有的 ⇒ 红（保守的假话仍然是假话）──────────────
{
  const r = judge(
    { kind: 'read', entries: ['models', 'openmemo.db', 'secrets.json'] },
    '旧目录仍在，里面还剩下：models、openmemo.db、secrets.json',
    ['models', 'openmemo.db'], // secrets.json 其实已经被删掉了
  );
  is('A3 报告多说了一个不在那儿的文件 ⇒ 红', r.honest, false);
}

// ── A4 ★ unreadable **不许判红** ────────────────────────────────────────────
{
  const r = judge(
    { kind: 'unreadable', reason: 'EACCES: permission denied' },
    '旧目录仍在，而且我没能读到那个目录（EACCES），所以不知道里面还剩什么。',
    [],
  );
  is('A4 ★ unreadable ⇒ **不判红**（「我不知道」不是缺陷）', r.honest, true);
  is('A4 分类为 unreadable', r.kind, 'unreadable');
}

// ── A5 ★ unreadable 却把话说成「已经空了」⇒ 红（#87 治的那个塌陷）───────────
{
  const r = judge({ kind: 'unreadable', reason: 'EACCES' }, AS_IF_EMPTY, []);
  is('A5 ★ unreadable 被说成「我看了，是空的」⇒ 红', r.honest, false);
}

// ── A6 ★★ 把 f21ca78 重放一遍：产品退回旧的 string[] 形状 ────────────────────
{
  const r = judge(['models', 'openmemo.db'], '旧目录仍在，里面还剩下：models、openmemo.db', [
    'models',
    'openmemo.db',
  ]);
  is('A6 ★★ 重放 f21ca78（数组形状）⇒ 照样红', r.honest, false);
  is('A6 分类为 unknown-shape', r.kind, 'unknown-shape');
  // 判红和判红的理由是两件事：这句话必须指着审计脚本，不是指着产品
  is('A6 ★ 失败信息指着审计脚本，不是产品', r.why.includes('不是产品坏了'), true);
  is('A6 ★ 失败信息点名要改哪个文件', r.why.includes('datadir-migrate-assertions.mjs'), true);
}

// ── A7 其它认不出来的形状（null / 字符串 / 缺字段）也走 unknown-shape ────────
for (const [label, v] of [
  ['null', null],
  ['undefined', undefined],
  ['字符串', 'models,openmemo.db'],
  ['缺 entries', { kind: 'read' }],
  ['缺 reason', { kind: 'unreadable' }],
  ['未知 kind', { kind: 'guessed', entries: [] }],
]) {
  is(`A7 ${label} ⇒ unknown-shape`, readResidue(v).kind, 'unknown-shape');
}

console.log('\nB 组：反向验证 —— 证明这道门**换来了鉴别力**，不是摆设');

/**
 * `2676e90` 那一版判据的**逐字复刻**。它是这道自检的夹具：
 * 如果新旧两版在同一份输入上给出**相同**的结论，那这道门就什么都没证明。
 */
const oldHonest = (residue, msg) => {
  const list = Array.isArray(residue) ? residue.map(String) : [];
  return list.length > 0 && list.every((x) => msg.includes(x));
};

// ── B1 ★★ 今天真实的三态输入：旧判据**假红**，新判据绿 ──────────────────────
{
  const residue = { kind: 'read', entries: ['models', 'openmemo.db'] };
  const msg = '旧目录仍在，里面还剩下：models、openmemo.db';
  const disk = ['models', 'openmemo.db'];
  is('B1 ★★ 旧判据遇上三态对象 ⇒ 恒 false（就是那一个月的假红）', oldHonest(residue, msg), false);
  is('B1 ★★ 新判据在同一份输入上 ⇒ 绿', judge(residue, msg, disk).honest, true);
  // 两者结论不同 ⇒ 这道门确实有鉴别力
  is(
    'B1 ★★ 新旧结论必须不同（否则这道门什么都没证明）',
    oldHonest(residue, msg) === judge(residue, msg, disk).honest,
    false,
  );
}

// ── B2 旧判据在数组形状上是绿的 —— 所以 A6 那一格只有新判据能抓 ─────────────
{
  const residue = ['models', 'openmemo.db'];
  const msg = '旧目录仍在，里面还剩下：models、openmemo.db';
  is('B2 旧判据在数组形状上 ⇒ 绿（它认得这个形状）', oldHonest(residue, msg), true);
  is(
    'B2 新判据在同一份输入上 ⇒ 红（形状已经不是产品在用的那个）',
    judge(residue, msg, ['models', 'openmemo.db']).honest,
    false,
  );
}

// ── B3 消融：把「文案没念到的」那一项拆掉 ⇒ A2 必须从红变绿（证明它在承重）──
{
  const residue = { kind: 'read', entries: ['models', 'openmemo.db', 'secrets.json'] };
  const msg = '旧目录仍在，里面还剩下：models、openmemo.db';
  const disk = ['models', 'openmemo.db', 'secrets.json'];
  // 退化版：只比"报告 vs 磁盘"，不比"文案 vs 磁盘"
  const ablated = () => {
    const res = readResidue(residue);
    const unnamed = disk.filter((n) => !res.entries.includes(n));
    const overspoken = res.entries.filter((n) => !disk.includes(n));
    return unnamed.length === 0 && overspoken.length === 0;
  };
  is('B3 消融「文案没念到的」⇒ 退化版放行', ablated(), true);
  is('B3 完整版仍然抓住', judge(residue, msg, disk).honest, false);
}

console.log(
  failed === 0
    ? `\n\x1b[32m✔ selftest-datadir-residue: 全部通过\x1b[0m`
    : `\n\x1b[31m✘ selftest-datadir-residue: ${failed} 条失败\x1b[0m`,
);
process.exit(failed > 0 ? 1 : 0);
