#!/usr/bin/env node
/**
 * `e2e-runtime-assertions.mjs` 的**变异证明** —— 本机能跑，不需要 GitHub、不需要包。
 *
 * ## 这份文件为什么存在
 *
 * 因为 runtime 那条腿刚被抓到一条**恒不触发的检测**（#106 顺带）：
 *
 * ```js
 * /先安装 CPU/.test(String(p.inapplicableReason ?? ''))
 * ```
 *
 * 它匹配的是 **T-191 之前**的文案。现文案是「还没装过就**先装** CPU 基础包」——
 * `先安装 CPU` ≠ `先装 CPU`。所以从 T-191 那天起它**一次都没匹配过任何东西**：
 * 产品真的退化回那个 bug，屏幕上也不会多一个字。
 *
 * ★ 本周在清的第①类失效：**断言的东西在缺陷状态下也成立**。
 *   这里的"成立"是"恒为假 ⇒ 恒不报告" —— 而它看起来像还有人在守。
 *
 * 判据已经换成读结构。但**换一条判据不等于证明了新判据会触发** ——
 * 那正是上一条烂掉的方式（改文案的人也以为自己没动判据）。
 * 所以每条判据在这里过三关，抄 `selftest-e2e-record.mjs` 的那三条：
 *   ① **真形状（缺陷现场）的输入必须触发**（挡"恒不触发"）；
 *   ② **每一个健康形状都不许触发**（挡"恒触发"）；
 *   ③ **判据必须与文案无关** —— 把 daemon 那句话换成任意别的字符串、
 *      甚至完全不给，结论都不许变；而结构一坏就必须变。
 *
 * 外加一条**契约漂移守卫**：`.mjs` 拿不到 TS 的类型检查，所以这里正面核一次
 * `hardware_not_probed_yet` 这个字面量还在不在 `Inapplicability` 里。
 * 有人重命名那一格时这里当场红 —— 否则判据会悄悄退回"恒不触发"。
 *
 * 用法：`node scripts/ci/selftest-e2e-runtime.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NOT_PROBED_YET_KIND,
  checkUninstallReachedDisk,
  saysHardwareNotProbedYet,
  stillSaysHardwareNotProbedYet,
} from './e2e-runtime-assertions.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cases = 0;
let failures = 0;
const say = (s = '') => console.log(s);
const ok = (name) => {
  cases += 1;
  say(`  ✔ ${name}`);
};
const bad = (name, why) => {
  cases += 1;
  failures += 1;
  say(`  ✘ ${name}\n      ${why}`);
};

/**
 * **缺陷现场**：用户刚在网页上装完 CPU 基础包，探针也跑通了，
 * 而目录对加速包仍然说「还没探测到硬件能力，先去装 CPU 基础包」。
 *
 * 形状照 `GetBackendCatalogResponse.packs[]`（`packages/shared/src/api.ts`）与
 * `Inapplicability`（`packages/shared/src/hardware.ts`）逐格来。
 */
const BUG_SHAPE = {
  id: 'whispercpp-vulkan-linux-x64',
  backend: 'vulkan',
  os: 'linux',
  arch: 'x64',
  applicable: false,
  inapplicableKind: 'undetermined',
  inapplicability: { kind: 'hardware_not_probed_yet' },
};

/** 健康形状们 —— 一个都不许触发。 */
const HEALTHY = [
  ['能装（applicable=true）', { ...BUG_SHAPE, applicable: true, inapplicability: null }],
  [
    '别的平台的包（换台机器也没用，与"还没测"无关）',
    {
      ...BUG_SHAPE,
      inapplicableKind: 'platform',
      inapplicability: { kind: 'platform_mismatch', packOs: 'darwin', packArch: 'arm64' },
    },
  ],
  [
    '★ 探针给过结论、确认本机没有可用设备（"测过了、不支持" ≠ "还没测"）',
    {
      ...BUG_SHAPE,
      inapplicableKind: 'unsupported',
      inapplicability: {
        kind: 'backend_unavailable',
        unavailableKind: 'no_usable_devices',
        detail: 'installed but enumerated no devices',
      },
    },
  ],
  [
    '老 daemon：根本不发 inapplicability（不知道 ≠ 缺陷）',
    { ...BUG_SHAPE, inapplicability: undefined },
  ],
  ['空对象 / 半个对象', { ...BUG_SHAPE, inapplicability: {} }],
];

/* ══════════════════════════════════════════════════════════════════════════ */
say('── ① 缺陷现场必须被检测到（挡"恒不触发" —— 上一条正是这么烂掉的）');

if (saysHardwareNotProbedYet(BUG_SHAPE)) {
  ok('缺陷形状 → 触发');
} else {
  bad('缺陷形状必须触发', '判据对着自己要抓的那个现场都不响 —— 它等于不存在');
}
if (stillSaysHardwareNotProbedYet(BUG_SHAPE)) {
  ok('缺陷形状（重启后那一问，额外要求 inapplicableKind=undetermined）→ 触发');
} else {
  bad('重启后那一问必须触发', '两格由 daemon 同一次判断产出，夹具却让它落空了');
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ② 健康形状一个都不许触发（挡"恒触发"）');

assert.ok(HEALTHY.length >= 5, '健康样本少于 5 个 —— 这一组覆盖不到各分支');
for (const [why, pack] of HEALTHY) {
  if (saysHardwareNotProbedYet(pack)) {
    bad(
      `「${why}」不该触发`,
      `判据把一个健康形状报成了缺陷：${JSON.stringify(pack.inapplicability)}`,
    );
  } else {
    ok(`「${why}」→ 不触发`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ③ 判据必须与文案无关（上一条就是被一次改文案静默杀死的）');

/*
 * ⚠️ 这一组单独存在的理由：**"换了判据"不等于"判据不会再漂"。**
 * T-191 改文案的人并不认为自己动了判据。所以这里正面钉一次：
 * 往条目上塞任意文案（含上一版正则要找的那句原话、和它的现行版本），
 * 结论都不许变。
 */
for (const noise of [
  { inapplicableReason: '尚未探测到硬件能力；请先安装 CPU 基础包，安装后会自动重新探测' },
  { inapplicableReason: '尚未探测到硬件能力 —— 还没装过就先装 CPU 基础包' },
  { inapplicableReason: 'We have not probed this machine yet' },
  { inapplicableReason: '' },
]) {
  const r = saysHardwareNotProbedYet({ ...BUG_SHAPE, ...noise });
  if (r) ok(`加噪 ${JSON.stringify(noise).slice(0, 46)}… → 结论不变（仍触发）`);
  else bad('判据被文案影响了', `加上 ${JSON.stringify(noise)} 之后就不触发了`);
}

/*
 * ★ 反向：结构一坏就必须停止触发。
 * 少了这一条，上面四条只是"恒触发"的另一种说法 —— 一个 `() => true`
 * 也能让"加噪不改变结论"成立。
 */
{
  const onlyProse = {
    ...BUG_SHAPE,
    inapplicability: null,
    inapplicableReason: '尚未探测到硬件能力 —— 还没装过就先装 CPU 基础包',
  };
  if (saysHardwareNotProbedYet(onlyProse)) {
    bad('结构没了、只剩那句话时不该触发', '判据还在读散文 —— 或者它恒为真');
  } else {
    ok('★ 结构没了、只剩那句中文 → 不触发：判据读的确实是结构');
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ④ 契约漂移守卫：这个 kind 必须真的还在 Inapplicability 里');

/*
 * `.mjs` 拿不到 TS 的类型检查 ⇒ 判据里那个字面量与契约之间**没有任何东西在守**。
 * 有人把那一格重命名（或删掉），判据会静默退回"恒不触发" —— 正是本次要修的形状。
 * 所以这里对着源码正面核一次。判据是**逐字的联合成员声明**，不是"文件里出现过这几个字"。
 */
{
  const src = readFileSync(join(REPO, 'packages', 'shared', 'src', 'hardware.ts'), 'utf8');
  const decl = `readonly kind: '${NOT_PROBED_YET_KIND}';`;
  const hits = src.split(decl).length - 1;
  if (hits === 1) {
    ok(`hardware.ts 里恰好一处 \`${decl}\``);
  } else {
    bad(
      `hardware.ts 里应当恰好有一处 \`${decl}\``,
      `实际 ${hits} 处 —— 那一格被改名/删掉/复制了，而判据里的字面量没跟上，` +
        '它会静默退回"恒不触发"（这正是本次修掉的那个形状）',
    );
  }
  // 前提检查：拿一个必不存在的名字过一遍，证明上面那条不是恒真
  const nonsense = `readonly kind: 'definitely_not_a_real_kind_${Date.now()}';`;
  if (src.includes(nonsense)) bad('前提检查', '不可能的字面量竟然命中了 —— 这条守卫是恒真的');
  else ok('前提检查：不存在的 kind 确实匹配不到（上一条不是恒真）');
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ⑤ 卸载：「记录没了」与「字节没了」是两件事（#110）');

/*
 * 这一组的形状与①②③相同，但被测的是 `checkUninstallReachedDisk`。
 *
 * ★ 它为什么需要**成对**的样本：这条判据有两个方向，各自都能被单独绕过。
 *   · 只查「该走的走了」⇒ 把每个文件都报成 refused、一个不删，全部通过；
 *   · 只查「该留的留了」⇒ 什么都不删、什么都不报，全部通过。
 *   下面 GOOD 里两条、BAD 里七条，正是钉住这两个方向各自的失效。
 *
 * 判据本身在 `e2e-runtime-assertions.mjs`；把它任何一段拿掉，这一组当场红。
 */

/** 删之前那份记录点名的文件（`declaredFilePaths()` 的产物 + 名字）。 */
const DECL = [
  { name: 'ggml-cpu.so', path: '/tmp/store/models/by-name/backend/cpu/ggml-cpu.so' },
  { name: 'whisper.tar.gz', path: '/tmp/store/models/by-name/backend/cpu/whisper.tar.gz' },
];
const P = (n) => DECL.find((f) => f.name === n).path;
const OUT_OF_BOUNDS =
  'Legacy installed-file record "/etc/ssl/x" resolves to /etc/ssl/x, which is outside every allowed root (/tmp/store/models) — refusing to hand out a path we do not own';

/** 两条**真·合法**的现场：判据必须放它们过去。 */
const UNINSTALL_GOOD = [
  [
    '干净卸载：204，记录点名的两个文件盘上都没了',
    {
      status: 204,
      filesNotRemoved: null,
      declared: DECL,
      stillOnDisk: [],
      expectCleanRemoval: true,
    },
  ],
  [
    '★ #55 那条新的合法态：200 + filesNotRemoved，被拒的那个**字节还在**、没被拒的那个没了',
    {
      status: 200,
      filesNotRemoved: [{ name: 'ggml-cpu.so', reason: OUT_OF_BOUNDS }],
      declared: DECL,
      stillOnDisk: [P('ggml-cpu.so')],
    },
  ],
];

/** 每一条都必须被判红 —— 每条对应一种真实的绕过法。 */
const UNINSTALL_BAD = [
  [
    '★★ M-uninstall-keep-files：记录删了、204 照回，而字节一个没走（T-192 的形状）',
    {
      status: 204,
      filesNotRemoved: null,
      declared: DECL,
      stillOnDisk: [P('ggml-cpu.so'), P('whisper.tar.gz')],
      expectCleanRemoval: true,
    },
  ],
  [
    '只走掉一半：204 说全删了，其实还剩一个',
    {
      status: 204,
      filesNotRemoved: null,
      declared: DECL,
      stillOnDisk: [P('whisper.tar.gz')],
      expectCleanRemoval: true,
    },
  ],
  [
    '★ 把删除整个禁掉、再把每个文件都报成 refused —— 只查①的判据会放它过去',
    {
      status: 200,
      filesNotRemoved: DECL.map((f) => ({ name: f.name, reason: OUT_OF_BOUNDS })),
      declared: DECL,
      stillOnDisk: DECL.map((f) => f.path),
      expectCleanRemoval: true,
    },
  ],
  [
    '★ 嘴上说拒绝、照删不误（越界检查是摆设）—— 只查②的判据会放它过去',
    {
      status: 200,
      filesNotRemoved: [{ name: 'ggml-cpu.so', reason: OUT_OF_BOUNDS }],
      declared: DECL,
      stillOnDisk: [],
    },
  ],
  [
    '拒绝了一个，另一个也没删（没被点名的必须没了）',
    {
      status: 200,
      filesNotRemoved: [{ name: 'ggml-cpu.so', reason: OUT_OF_BOUNDS }],
      declared: DECL,
      stillOnDisk: DECL.map((f) => f.path),
    },
  ],
  [
    '拒绝说不出理由（#107 补 reason 就是为了这个）',
    {
      status: 200,
      filesNotRemoved: [{ name: 'ggml-cpu.so', reason: '' }],
      declared: DECL,
      stillOnDisk: [P('ggml-cpu.so')],
    },
  ],
  [
    '204 却同时带着 filesNotRemoved —— 两句话互相矛盾',
    {
      status: 204,
      filesNotRemoved: [{ name: 'ggml-cpu.so', reason: OUT_OF_BOUNDS }],
      declared: DECL,
      stillOnDisk: [P('ggml-cpu.so')],
    },
  ],
  [
    '200 却没有 filesNotRemoved —— 契约漂了',
    { status: 200, filesNotRemoved: [], declared: DECL, stillOnDisk: [] },
  ],
];

for (const [why, input] of UNINSTALL_GOOD) {
  const r = checkUninstallReachedDisk(input);
  if (r.ok) ok(`「${why}」→ 判绿`);
  else bad(`「${why}」应当判绿`, `判据把一个合法现场判红了：${r.reason}`);
}
assert.ok(UNINSTALL_BAD.length >= 7, 'BAD 样本少于 7 个 —— 覆盖不到两个方向各自的绕过法');
for (const [why, input] of UNINSTALL_BAD) {
  const r = checkUninstallReachedDisk(input);
  if (r.ok) bad(`「${why}」应当判红`, '判据放它过去了 —— 这条绕过法此刻是活的');
  else if (r.undecidable)
    bad(`「${why}」应当判红`, `判成了 UNKNOWN，而这是一个确定的失败：${r.reason}`);
  else ok(`「${why}」→ 判红`);
}

/*
 * ★ 前提缺失必须是 UNKNOWN，不是绿也不是红。
 *   bundled 包的记录按设计不带任何可解析路径（让"删掉应用本体"形状上不可能），
 *   这时"字节还在不在"问不出来。报绿 = 又一句关于空集的废话（PR #52 拆的就是这个）。
 */
{
  const r = checkUninstallReachedDisk({
    status: 204,
    filesNotRemoved: null,
    declared: [],
    stillOnDisk: [],
  });
  if (r.undecidable && !r.ok) ok('★ 记录没点名任何可解析文件 → UNKNOWN（不是绿，也不是红）');
  else
    bad(
      '前提缺失时应当 UNKNOWN',
      `实际 ok=${String(r.ok)} undecidable=${String(r.undecidable)} —— 关于空集的废话又回来了`,
    );
}

/*
 * 契约漂移守卫，与 ④ 同一种理由：`.mjs` 拿不到 TS 的类型检查。
 * `filesNotRemoved` 这个字段名一旦在 daemon 那侧改名，本判据会把
 * 「有拒绝」永远读成「没拒绝」，而上面 GOOD/BAD 全用夹具、一条都不会红。
 */
{
  const src = readFileSync(
    join(REPO, 'apps', 'daemon', 'src', 'http', 'rest', 'backends.ts'),
    'utf8',
  );
  const hits = src.split('filesNotRemoved:').length - 1;
  if (hits === 1) ok('backends.ts 里恰好一处 `filesNotRemoved:`（DELETE 那条 200 的路）');
  else
    bad(
      'backends.ts 里应当恰好有一处 `filesNotRemoved:`',
      `实际 ${hits} 处 —— 字段被改名/删掉/复制了，而判据里的字面量没跟上`,
    );
  const nonsense = `filesNotRemoved_definitely_not_real_${Date.now()}:`;
  if (src.includes(nonsense)) bad('前提检查', '不可能的字段名竟然命中了 —— 这条守卫是恒真的');
  else ok('前提检查：不存在的字段名确实匹配不到（上一条不是恒真）');
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('─'.repeat(78));
if (failures > 0) {
  say(`✘ selftest-e2e-runtime：${cases} 条里 ${failures} 条不成立`);
  process.exit(1);
}
say(`✔ selftest-e2e-runtime：${cases} 条断言全部成立`);
assert.equal(failures, 0);
