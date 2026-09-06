#!/usr/bin/env node
/**
 * 「**`lint-workflows.mjs` 的每一条规则，都有一个只有它会响的坏输入吗**」
 * —— 手动跑的工具，不是门禁。与 `leg-coverage.mjs` 同族，**判决方向相反**。
 *
 * ## 它治的病
 *
 * `lint-workflows.mjs` 在**推送门禁**上，每轮打印
 * `✔ lint-workflows: 1978 次断言全部通过`。而 `[实测 2026-09-06]`：
 *
 * > **那 1978 是 `must()` 的运行时调用次数，不是判据条数。静态调用点只有 89 个。**
 * > 前 6 个（键名扫描那几条）吃掉 1721 次 = **87%**；60 个调用点一辈子只跑 1 次。
 *
 * 更要紧的是它**没有自检**：全仓零个脚本 import 或 spawn 它（顶层执行 + 结尾
 * `process.exit()`，import 不进来）。所以「删掉其中一条会不会红」的字面答案是
 * **89/89 都不会红** —— 那只是「没有自检」的同义反复，没有信息量。
 *
 * ## ⇒ 所以把方向倒过来
 *
 * `leg-coverage.mjs` 的形状是「删掉判据 → 看自检红不红」。这里 **`lint-workflows`
 * 自己就是 PROVER**，被变异的是**它守的那些制品**：20 个 workflow YAML、
 * `build-whisper.sh` / `build-probe.sh` / `lib/baselines.sh`、
 * `release-upload.mjs` / `release-verify.mjs`、`package.json`。
 * 问的是：**这条规则守的东西退化了，它会不会红、红的是不是它。**
 *
 * ## 三档 —— ⚠️ 三栏一起念，只报第一栏就是假的
 *
 *   · **甲 有专属坏输入**：存在一个坏输入**只让它一条红**。
 *   · **乙 被相邻断言吞掉**：红了，但红的是别人（`SUBSUMED_RULES`，7 条，**可证**）。
 *     合法 —— 缺陷仍被邻格抓住，它守的是**那句报错说不说得清**。
 *   · **丙 空转**：任何输入都让它红不了（`SELF_SUBJECT_RULES`，1 条）。
 *
 * `[实测 2026-09-06，530d8f6]` **89 条 = 甲 81 · 乙 7 · 丙 1**，
 * 「判不了 / 崩掉」那一栏是**空的**（7048 个变异里 0 个让 lint-workflows 崩溃）。
 *
 * ⚠️ **甲的 81 条里只有 42 条是本工具的通用扫描直接给出的。** 另外 39 条
 * （`ADDITIVE_ONLY_RULES` 29 + `PRECISE_PROBE_RULES` 10）的坏输入通用族**造不出**：
 * 前者是加法型断言（「不许出现 X」），后者要**保留结构、只换掉其中一句**。
 * 它们都在**甲栏**、都逐条实测过；登记只是为了重跑时别把它们误报成空转 ——
 * **「扫描抓不到」不等于「没牙齿」，这两句话混起来两个方向都会失真。**
 *
 * ⚠️ 那 39 条各自只有**一个**手写坏输入 —— 那是有牙齿的**下界**，
 * 不是「这一类回归都抓得住」。
 *
 * ## ⚠️ 两道空转防线（缺一条，这个工具就会报出比没有它更坏的结论）
 *
 *   1. **基线闸**：每个沙箱**不变异**时必须 `1978 条全部通过`。红了说明沙箱没搭对
 *      ⇒ 每一格变异都会「红」⇒ 报出 89/89 全覆盖，一个彻底的假绿。
 *   2. ★ **往返闸**（`leg-coverage` 没有这一条，因为它不改 YAML）：YAML 变异走
 *      `parseDocument → String(doc)`，而 `[实测]` **20 个文件里 15 个不是字节级往返**
 *      （引号/缩进/折行会被规范化）。所以先单独验一次：**只往返、不做任何变异，
 *      20 个文件必须仍然 1978 绿**。不验这一条，排版差异会被整个读成「抓到了」。
 *
 * ## ⚠️ 为什么它**不是**门禁（刻意的，与 `leg-coverage` 同一条理由）
 *
 *   · **贵**：7082 个变异 × 一次 node 冷启动，8 并发跑 2.5 分钟。门禁要快速判决。
 *   · **有合法的 47 条不会被扫描独红**（乙 7 + 加法型 29 + 定点 10 + 自身常量 1）。做成门禁 =
 *     一盏为合法情况常亮的灯，两周内所有人学会无视它 —— 本仓反复吃的亏。
 *
 * ⇒ 它的**门禁那一半**在 `selftest-lintwf-coverage.mjs` 里，秒级、只有一条：
 *   **四张登记表里每条 `needle` 必须在 `lint-workflows.mjs` 源码里恰好出现 `count` 次。**
 *   有人动了这 47 条里的任何一条，自检当场红，把人领到这份记录跟前。
 *   **这份记录因此不会烂** —— 它不靠谁记得回来重跑。
 *
 * ⚠️ **登记的是「这条规则处于什么档」，不是它的行号** —— 行号会漂，`needle` 不会。
 *
 * ## 它**查不了**什么（明写，别把它读成比它更强）
 *
 *   · **「钉错东西」那一档看不见**。它只验「哪一行的 `must` 红了」，不验那句报错
 *     指的对象对不对。#82 那类「档位那句说了假话」的形状，逐格删除法**结构上**看不见。
 *   · **只做单点变异**。两处同时退化、互相掩盖的情形没查 —— 而乙栏那 7 条正说明
 *     这个仓里蕴含关系是真实存在的。
 *   · **不删整个文件**（除了 `files.length > 0` 那条的坏输入）。
 *   · 加法型只有「至少一个坏输入」的证据，没有穷举族。
 *
 * ## 用法
 *
 *   node scripts/ci/lintwf-coverage.mjs             # 扫一遍（约 2.5 分钟）
 *   node scripts/ci/lintwf-coverage.mjs --json out.json
 *
 * 退出码：0 = 扫完了（**不代表全覆盖**，看输出）；2 = 工具自己没跑起来。
 * ⚠️ 退出码刻意**不因为"有规则没被抓到"而变 1** —— 见上面"不是门禁"。
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

import { isDirectRun } from '../lib/entrypoint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const TARGET = 'lint-workflows.mjs';

/**
 * **被相邻断言在数学上吞掉**的那些规则。
 *
 * 「吞掉」= 这条红的时候，**必然**有另一条也红 —— 于是没有任何坏输入只让它一条红。
 * 所以它拿不到"专属坏输入"，**但它不是空转**（缺陷仍然会被相邻那条抓住）：
 * 它守的是**那句报错说得清不清楚**。一条 `build-backends.yml#linux: docker build
 * 没有显式传 BASE_IMAGE` 比 `没有一步用 buildbox.Dockerfile 造编译镜像` 难查得多。
 *
 * ⚠️ **这不是豁免名单。** 一份「这几条可以不管」的例外表，第二天就会变成下一个
 * 手抄名单（本仓在 `check-orphan-exports` 的裸名匹配、`selftest-launcher-path`
 * 的 LEGS 手写 4/8、`lint-workflows` 自己的 T-163 手抄 7 条上各栽过一次）。
 * 所以这里存的是**可核对的事实**：`needle` 必须在源码里恰好出现 `count` 次，
 * 由 `selftest-lintwf-coverage.mjs` 每轮验一遍。动了那一条 ⇒ 当场红 ⇒
 * 有人必须回来重跑这个工具，并更新这份记录。
 *
 * `implies` 里那条是**被它蕴含**的规则：本条红 ⇒ 那条**必然**也红。全部可证，
 * 证明写在 `why` 里，不是"跑了一次没见它单独红"。
 */
export const SUBSUMED_RULES = Object.freeze([
  {
    needle: 'must(!!s, ',
    count: 2, // 假依赖组与真依赖组各一处，两行**逐字相同**，所以按出现次数锚定
    implies: 'ci.yml gate 那两组的 `if:` 断言',
    why:
      "`byId.get(id)` 是 undefined ⇒ 后面每一条 `.test(String(s?.if ?? ''))` " +
      '都在空串上求值 ⇒ 恒假 ⇒ 必然跟着红',
  },
  {
    needle: 'linux != null',
    implies: '⑤ 那整组（COMPILE_MARKERS / buildbox.Dockerfile / --report / check-elf-glibc …）',
    why: 'linux job 不在 ⇒ `steps = []` ⇒ 所有扫描面为空 ⇒ 那一组"没东西可查"的断言全响',
  },
  {
    needle: 'imgStep != null',
    implies: '`--build-arg BASE_IMAGE=` 那条',
    why: "imgStep 是 undefined ⇒ `('').includes('--build-arg BASE_IMAGE=')` 恒假",
  },
  {
    needle: 'ci.on?.push !== undefined',
    implies: '`on.push.branches` 必须含 master 那条',
    why: '`Array.isArray(undefined?.branches)` 恒假',
  },
  {
    needle: '!hasSuppress || hasRatchet',
    implies: '`hasRatchet` 那条',
    why:
      '**纯布尔包含**：本条红 ⟺ `hasSuppress ∧ ¬hasRatchet`，而那条红 ⟺ `¬hasRatchet`，' +
      '前者是后者的子集。这一条是七条里最硬的，不依赖任何 JS 取值细节',
  },
  {
    needle: 'verify != null',
    implies: '`verify 必须 needs: [upload]` 那条',
    why: "`[].concat(undefined ?? []).includes('upload')` 恒假",
  },
]);

/**
 * **加法型**规则：坏输入是「多出来一个东西」，而本工具的变异族是
 * 删节点 / 改标量 / 加坏键 —— **结构上造不出**它们的坏输入。
 *
 * ⚠️ **它们不是空转。** `[实测 2026-09-06]` 每一条都单独写了一个定点坏输入跑过，
 * 结果记在 `probe` 里；除注明外全部**只让它一条红**。把这一栏读成「空转」，
 * 就是把"没覆盖"混进"有覆盖"的反方向错误 —— 两个方向都失真。
 *
 * 这里同样存**可核对的事实**（needle 恰好出现 count 次），不是豁免。
 * 重跑本工具时，这一栏会被原样列出来并标成「删/改族够不着，见登记」。
 */
export const ADDITIVE_ONLY_RULES = Object.freeze([
  { needle: 'files.length > 0', probe: '清空 .github/workflows/ ⇒ 独红' },
  {
    needle: '!/always\\s*\\(\\s*\\)/.test(ifExpr)',
    probe: '给 ci.yml#gate 加 `if: always()` ⇒ 独红',
  },
  {
    needle: "job?.['continue-on-error'] !== true",
    probe: 'gate 上加 continue-on-error: true ⇒ 独红',
  },
  {
    needle: "step?.['continue-on-error'] !== true",
    probe: 'gate 的 lint 步加 continue-on-error ⇒ 独红',
  },
  {
    needle: "!/always\\s*\\(\\s*\\)/.test(String(step?.if ?? ''))",
    probe: 'gate 的 checkout 步加 if: always() ⇒ 独红',
  },
  { needle: 'bb.on?.push === undefined', probe: 'build-backends 加 on.push ⇒ 独红' },
  { needle: 'bb.jobs?.manifest?.if === undefined', probe: 'manifest 加一个 if: ⇒ 独红' },
  {
    needle: "!JSON.stringify(bb.jobs?.manifest ?? {}).includes('node -e')",
    probe: 'manifest 里塞回 inline node -e ⇒ 独红',
  },
  {
    needle: '!/\\.build\\/whisper-/.test(allText)',
    probe: '塞回硬编码 .build/whisper- 路径（C7）⇒ 独红',
  },
  { needle: '!/choco install ninja/.test(allText)', probe: '塞回 choco install ninja（C6）⇒ 独红' },
  {
    needle: "h.code.includes('scripts/ci/buildbox.sh')",
    probe: '把 build-whisper.sh 的 buildbox 前缀拿掉 ⇒ 独红',
  },
  { needle: '/--max\\s+2\\.34\\b/.test(g.code)', probe: '把 --max 2.34 抬成 2.35 ⇒ 独红' },
  {
    needle: '!/scripts\\/build-probe\\.sh/.test(s.code)',
    probe: 'workflow 里又单独编一次探针 ⇒ 独红',
  },
  { needle: '/--max\\s+13\\.3\\b/.test(g.code)', probe: '把 --max 13.3 抬成 13.4 ⇒ 独红' },
  { needle: "g.code.includes('stage_dir')", probe: 'minos 守卫只盯探针、不盯 stage_dir ⇒ 独红' },
  {
    needle: '/-mmacosx-version-min=\\$\\{OPENMEMO_MACOS_DEPLOYMENT_TARGET\\}/.test(bp)',
    probe: '删掉 build-probe.sh 里**两处** -mmacosx-version-min ⇒ 独红（只删一处不够，它有两行）',
  },
  {
    needle: "ci.on?.push?.paths === undefined && ci.on?.push?.['paths-ignore'] === undefined",
    probe: '给 ci.yml 的 on.push 加 paths 过滤 ⇒ 独红',
  },
  { needle: '!/pnpm -r build/.test(runs)', probe: 'ci 门禁改用 pnpm -r build ⇒ 独红' },
  {
    needle: '!/pnpm -r test(?!\\S)/.test(xpRuns)',
    probe: '探针端多一条短路版 pnpm -r test ⇒ 独红',
  },
  {
    needle: '!/pnpm test:ci-scripts(?!\\S)/.test(xpRuns)',
    probe: '探针端多一条短路版 pnpm test:ci-scripts ⇒ 独红',
  },
  { needle: '!/pnpm -r build/.test(xpRuns)', probe: '探针端用 pnpm -r build ⇒ 独红' },
  {
    needle: '!(hasNotCancelled && blocksMerge)',
    probe: '给探针加 on.pull_request（转合并门禁）⇒ 独红',
  },
  {
    needle: "Object.values(verify?.permissions ?? {}).every((v) => v !== 'write')",
    probe: 'verify 拿到 actions: write ⇒ 独红',
  },
  {
    needle:
      '!/GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|github\\.token|secrets\\./.test(verifyText)',
    probe: 'verify 被喂 GH_TOKEN ⇒ 独红',
  },
  {
    needle:
      'ru.on?.push === undefined && ru.on?.release === undefined && ru.on?.schedule === undefined',
    probe: 'release-upload 变成 push 触发 ⇒ 独红',
  },
  { needle: '!text.includes(bad)', probe: 'YAML 里出现 `gh release create` ⇒ 独红' },
  {
    needle: "m === 'POST'",
    probe: "release-upload.mjs 里多一个 method: 'DELETE'（POST 那次保留）⇒ 独红",
  },
  {
    needle: "!/method:/.test(code['release-verify.mjs'])",
    probe: "release-verify.mjs 里出现 method: 'POST' ⇒ 独红",
  },
  {
    needle: 'statusFnJobsSeen > 0',
    probe: '把 #102 的**两个**主语都退回去 ⇒ 独红（只退一个不够，它有两个主语）',
  },
]);

/**
 * 主语是 `lint-workflows.mjs` **自己的字面量常量**的规则。
 *
 * 对被守制品做**任何**变异都到不了它们（`[实测]` 7082 个变异零命中）。
 * 这不是缺陷本身，但**必须单独列一栏**：把它算进"有覆盖"是虚报，
 * 算进"空转"又抹掉了它确实有夹具这件事。
 */
export const SELF_SUBJECT_RULES = Object.freeze([
  {
    needle: 'ex.reasonOk',
    subject: 'lint-workflows.mjs 里的 REPORTER_ONLY 字面量',
    fixture: 'selftest-gha-expr.mjs I 组（空理由：新实现红、老实现不红）',
    why:
      '★ 它上一版是 `if (exemptReason) { must(…length > 10, "豁免必须带理由（**这条是空的**）") }` —— ' +
      '空串是 falsy ⇒ 那条 must 唯一进不去的分支恰恰是它声称要抓的形状。' +
      '2026-09-06 改判「键在不在」（`Object.hasOwn`）后空串/空白/null 都能红，' +
      '但**主语仍然是本文件的常量**，所以它永远进不了甲栏 —— 它的坏输入只能是夹具。',
  },
]);

/**
 * **有专属坏输入（甲栏），但那个坏输入必须是"定点"的** —— 通用的删/改/加坏键族
 * 造不出它，得精确地把某个片段换成另一个片段。
 *
 * 典型形状是「**必须仍然写着某句判断**」：把它整段删掉会让**上一条**先红
 * （于是它被吞掉，进不了扫描的独红），只有**保留结构、只换掉那一句**才让它单独红。
 * 例：`gate` 的某一步丢掉 `!cancelled()` 但保留 `steps.install.outcome == 'success'`。
 *
 * ⚠️ 它们**在甲栏**，不是空转、也不是被吞掉 —— `[实测 2026-09-06]` 逐条验过，
 * `probe` 里那个坏输入**只让它一条红**。放在单独一张表里，是因为本工具的
 * 通用变异族**结构上**造不出来；不登记的话每次重跑都会把它们误报成空转。
 */
export const PRECISE_PROBE_RULES = Object.freeze([
  {
    needle: 'new RegExp(String.raw`needs\\.${esc}\\.result`)',
    probe: 'attest 的 if 里把 needs.mutations.result 换成别的（#102 原形）⇒ 独红',
  },
  {
    needle: "/!\\s*cancelled\\s*\\(\\s*\\)/.test(String(s?.if ?? ''))",
    probe: 'gate 的 lint 步丢掉 !cancelled()、保留 install 判断 ⇒ 独红',
  },
  {
    needle: "/steps\\.install\\.outcome\\s*==\\s*'success'/.test(String(s?.if ?? ''))",
    probe: 'gate 的 lint 步丢掉 install 判断、保留 !cancelled() ⇒ 独红',
  },
  {
    needle:
      "/steps\\.test\\.outcome\\s*==\\s*'success'/.test(String(byId.get('mutation_anchors')?.if ?? ''))",
    probe: 'mutation_anchors 的 if 里去掉对 test 的依赖 ⇒ 独红',
  },
  {
    needle: "(imgStep?.code ?? '').includes('--build-arg BASE_IMAGE=')",
    probe: 'docker build 改成不传 BASE_IMAGE（Dockerfile 那步仍在）⇒ 独红',
  },
  {
    needle: "guards.some((g) => g.code.includes('dist/probe'))",
    probe: '探针那条 check-elf-glibc 的 --dir 改成别的目录（守卫仍在）⇒ 独红',
  },
  {
    needle: '没有跑 \\`scripts/ci/xplat-ratchet.mjs\\`',
    probe: '删掉棘轮**并且**删掉 `|| echo` 吞失败（只删棘轮会连上一条一起红）⇒ 独红',
  },
  {
    needle: '/--platform\\s+"\\$\\{\\{\\s*matrix\\.label\\s*\\}\\}"/.test(xpRuns)',
    probe: '棘轮的 --platform 写死成 "linux" ⇒ 独红',
  },
  { needle: 'posts === 1', probe: "release-upload.mjs 里多出第二处 method: 'POST' ⇒ 独红" },
  {
    needle: '/非 head 提交仍然拿不到任何判决/.test(ciSrc)',
    probe: '删掉 ci.yml 里那段说明文字 ⇒ 独红',
  },
]);

/**
 * 四张表合起来 = 「已知**不会被本工具的通用扫描独红**」的全集。
 *
 * ⚠️ **「扫描抓不到」不等于「没牙齿」** —— 这是这份登记最容易被读错的地方，
 *    所以 `bucket` 里带的是**三档判决**（甲/乙/丙），不是"它为什么没被扫到"：
 *
 *   · `ADDITIVE_ONLY_RULES` 与 `PRECISE_PROBE_RULES` 一共 39 条，**判决是甲** ——
 *     它们各有一个实测过的专属坏输入，只是通用的删/改/加坏键族造不出那个形状。
 *   · 真正的丙（空转）只有 `SELF_SUBJECT_RULES` 那 1 条。
 *
 * `[实测 2026-09-06]` 89 条 = **甲 81（42 扫描独红 + 29 加法型 + 10 定点）· 乙 7 · 丙 1**。
 */
export const REGISTERED_RULES = Object.freeze([
  ...SUBSUMED_RULES.map((r) => ({ ...r, bucket: '乙 被相邻断言吞掉' })),
  ...ADDITIVE_ONLY_RULES.map((r) => ({ ...r, bucket: '甲 加法型（通用族造不出坏输入）' })),
  ...PRECISE_PROBE_RULES.map((r) => ({ ...r, bucket: '甲 需要定点坏输入' })),
  ...SELF_SUBJECT_RULES.map((r) => ({ ...r, bucket: '丙 主语是自身常量' })),
]);

/**
 * ★ **门禁那一半**：登记表里每条 `needle` 必须在判据源码里恰好出现 `count` 次（默认 1）。
 *
 * 纯函数，不读盘 —— 这样 `selftest-lintwf-coverage.mjs` 才能拿夹具反向验证它
 * （少一条要红、多一条也要红）。一个只在真源码上跑过一次的审计函数，
 * 和一个永远返回 ok 的审计函数，在输出上分不开。
 */
export function auditRuleRegistry({ source, rules = REGISTERED_RULES } = {}) {
  const problems = [];
  const src = String(source ?? '');
  if (src.trim() === '') {
    problems.push('判据源码是空的 —— 这一条当场红：一个在空字符串上"全部通过"的审计等于没有审计。');
    return { ok: false, problems, checked: 0 };
  }
  for (const r of rules) {
    const want = r.count ?? 1;
    const got = src.split(r.needle).length - 1;
    if (got !== want) {
      problems.push(
        `登记表对不上判据源码：\`${r.needle}\` 期望出现 ${want} 次，实得 ${got} 次` +
          `（这条登记在「${r.bucket ?? '?'}」）。\n` +
          `      要么这条规则被改/被删了 —— 那就回去重跑 \`node scripts/ci/lintwf-coverage.mjs\`，\n` +
          `      按新的实测结果更新登记；要么 needle 抄错了。**两种都不许直接改这个数字了事。**`,
      );
    }
  }
  return { ok: problems.length === 0, problems, checked: rules.length };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 以下是**手动工具**那一半：造沙箱、插桩、穷举变异、跑 lint-workflows 收结果。
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 把 `must()` 改写成会记录**调用方行号**的版本。
 *
 * ⚠️ **行号必须严格不漂** —— 整个工具的归并键就是行号。所以每一处替换都要求
 * 前后行数相同，并在最后核一次总行数；对不上直接 exit 2，而不是报一份错位的结果。
 */
export function instrument(src) {
  const rep = (a, b) => {
    if (!src.includes(a)) throw new Error(`\`must()\` 的形状变了，插桩落空：\n${a}`);
    if (a.split('\n').length !== b.split('\n').length) throw new Error('替换前后行数不同');
    src = src.replace(a, b);
  };
  rep(
    `import { readdir, readFile } from 'node:fs/promises';`,
    `import { readdir, readFile } from 'node:fs/promises'; import { writeFileSync as __wfs } from 'node:fs';`,
  );
  rep(
    `const problems = [];\nlet checks = 0;`,
    `const problems = []; const __h = new Map(); const __f = new Map(); process.on('exit', () => { try { __wfs(process.env.LWCOV_OUT, JSON.stringify({ hits: [...__h], fails: [...__f] })); } catch {} });\nlet checks = 0;`,
  );
  const lo = src.split('\n').findIndex((l) => l.startsWith('function must(cond, msg)')) + 1;
  if (lo === 0) throw new Error('找不到 `function must(cond, msg)`');
  rep(
    `function must(cond, msg) {\n  checks += 1;\n  if (!cond) problems.push(msg);\n}`,
    `function must(cond, msg) {\n  checks += 1; const __fr = new Error().stack.split('\\n').map((l) => /lint-workflows[^:]*:(\\d+):\\d+/.exec(l)).filter(Boolean).map((m) => Number(m[1])); const __s = __fr.find((n) => n < ${lo} || n > ${lo + 3}) ?? -1; __h.set(__s, (__h.get(__s) ?? 0) + 1);\n  if (!cond) { problems.push(msg); __f.set(__s, (__f.get(__s) ?? 0) + 1); }\n}`,
  );
  return src;
}

/** 把 `all([…])` 之外的活都交给它：造一个只含被守制品的沙箱。 */
function makeSandbox(root) {
  mkdirSync(root, { recursive: true });
  for (const d of ['scripts', '.github']) cpSync(join(REPO, d), join(root, d), { recursive: true });
  cpSync(join(REPO, 'package.json'), join(root, 'package.json'));
  try {
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
  } catch {
    /* 已经有了 */
  }
  writeFileSync(
    join(root, 'scripts', 'ci', 'lint-workflows.INSTR.mjs'),
    instrument(readFileSync(join(HERE, TARGET), 'utf8')),
  );
}

const runIn = (root, out) =>
  new Promise((res) => {
    const ch = spawn('node', [join(root, 'scripts', 'ci', 'lint-workflows.INSTR.mjs')], {
      env: { ...process.env, LWCOV_OUT: out },
    });
    let s = '';
    ch.stdout.on('data', (d) => (s += d));
    ch.stderr.on('data', (d) => (s += d));
    ch.on('close', (status) => {
      let fails = null;
      try {
        fails = JSON.parse(readFileSync(out, 'utf8')).fails.map(([l]) => l);
      } catch {
        /* 崩在 import / 语法上时文件可能写不出来 */
      }
      res({ status, fails, out: s });
    });
  });

const BASELINE_RE = /✔ lint-workflows: (\d+) 次断言全部通过/;

/** 枚举变异：YAML 结构（删节点 / 改标量 / 加坏键）+ 被读脚本的逐行删 + 链条逐环摘。 */
function enumerate(root) {
  const muts = [];
  const wfDir = join(root, '.github', 'workflows');
  for (const f of readdirSync(wfDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const rel = join('.github', 'workflows', f);
    const doc = parseDocument(readFileSync(join(root, rel), 'utf8'));
    const paths = [];
    const walk = (node, p) => {
      if (isMap(node)) {
        paths.push({ p, kind: 'map' });
        for (const it of node.items) walk(it.value, [...p, String(it.key)]);
      } else if (isSeq(node)) {
        paths.push({ p, kind: 'seq' });
        node.items.forEach((it, i) => walk(it, [...p, i]));
      } else paths.push({ p, kind: isScalar(node) ? 'scalar' : 'other' });
    };
    walk(doc.contents, []);
    for (const { p, kind } of paths) {
      if (p.length > 0) muts.push({ file: rel, op: 'del', path: p });
      if (kind === 'map') muts.push({ file: rel, op: 'bogus', path: p });
      if (kind === 'scalar' && p.length > 0) muts.push({ file: rel, op: 'corrupt', path: p });
    }
  }
  for (const rel of [
    join('scripts', 'build-whisper.sh'),
    join('scripts', 'build-probe.sh'),
    join('scripts', 'lib', 'baselines.sh'),
    join('scripts', 'ci', 'release-upload.mjs'),
    join('scripts', 'ci', 'release-verify.mjs'),
  ]) {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n');
    lines.forEach((l, i) => l.trim() !== '' && muts.push({ file: rel, op: 'delline', line: i }));
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  String(pkg.scripts['test:ci-scripts'])
    .split('&&')
    .forEach((_, i) => muts.push({ file: 'package.json', op: 'unlink-chain', idx: i }));
  return muts;
}

function applyMutation(root, m) {
  const p = join(root, m.file);
  const raw = readFileSync(p, 'utf8');
  let next;
  if (m.op === 'del' || m.op === 'bogus' || m.op === 'corrupt') {
    const d = parseDocument(raw);
    if (m.op === 'del') d.deleteIn(m.path);
    else if (m.op === 'bogus') d.setIn([...m.path, 'zz_bogus_key'], 'x');
    else d.setIn(m.path, 'ZZBOGUS');
    next = String(d);
  } else if (m.op === 'delline') {
    const l = raw.split('\n');
    l.splice(m.line, 1);
    next = l.join('\n');
  } else {
    const pkg = JSON.parse(raw);
    const c = String(pkg.scripts['test:ci-scripts'])
      .split('&&')
      .map((s) => s.trim());
    c.splice(m.idx, 1);
    pkg.scripts['test:ci-scripts'] = c.join(' && ');
    next = `${JSON.stringify(pkg, null, 2)}\n`;
  }
  writeFileSync(p, next);
  return () => writeFileSync(p, raw);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'om-lintwf-cov-'));
  try {
    console.log(`══ lintwf-coverage ══ ${TARGET} × 它守的那些制品`);

    /* 登记表先自己核一遍 —— 表都对不上源码，后面的结论没有意义。 */
    const audit = auditRuleRegistry({ source: readFileSync(join(HERE, TARGET), 'utf8') });
    if (!audit.ok) {
      console.error('✘ 登记表与判据源码对不上，本次结果无效：');
      for (const p of audit.problems) console.error(`  - ${p}`);
      process.exit(2);
    }
    console.log(`   ✔ 登记表 ${audit.checked} 条 needle 全部对得上源码\n`);

    const NW = 8;
    const roots = [];
    for (let i = 0; i < NW; i += 1) {
      const r = join(tmp, `w${i}`);
      makeSandbox(r);
      roots.push(r);
    }

    /* ★ 防线 ①：基线闸 */
    console.log('   先跑一次**不变异**的，确认沙箱搭对了…');
    let expected = null;
    for (let i = 0; i < NW; i += 1) {
      const b = await runIn(roots[i], join(tmp, `w${i}.json`));
      const m = BASELINE_RE.exec(b.out);
      if (b.status !== 0 || !m) {
        console.error(
          '✘ lintwf-coverage: **没有变异的那一次就红了** —— 沙箱没搭对，本次结果无效。',
        );
        console.error(b.out.split('\n').slice(-25).join('\n'));
        process.exit(2);
      }
      expected ??= m[1];
      if (m[1] !== expected) {
        console.error(`✘ 沙箱之间条数不一致（${expected} vs ${m[1]}）—— 结果不可信`);
        process.exit(2);
      }
    }
    console.log(`   ✔ 基线绿，${expected} 条，结果可信。`);

    /* ★ 防线 ②：往返闸 —— 只重排 YAML、不做任何变异，必须仍然绿且条数不变 */
    console.log('   再验一次**只往返不变异**（20 个 YAML 里 15 个不是字节级往返）…');
    const wfDir = join(roots[0], '.github', 'workflows');
    for (const f of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
      const p = join(wfDir, f);
      const raw = readFileSync(p, 'utf8');
      const rt = String(parseDocument(raw));
      if (rt === raw) continue;
      writeFileSync(p, rt);
      const r = await runIn(roots[0], join(tmp, 'rt.json'));
      writeFileSync(p, raw);
      const m = BASELINE_RE.exec(r.out);
      if (r.status !== 0 || m?.[1] !== expected) {
        console.error(`✘ 往返闸：${f} 只重排一次就把判决改了 —— 本次结果无效。`);
        console.error('  （不拦住这一条，排版差异会被整个读成"抓到了"，报出一个假的满覆盖。）');
        console.error(r.out.split('\n').slice(-20).join('\n'));
        process.exit(2);
      }
    }
    console.log('   ✔ 往返闸过，YAML 重排本身不改变判决。\n');

    /* 静态规则全集 = 基线那一次跑到过的所有调用点 */
    const base = await runIn(roots[0], join(tmp, 'base.json'));
    const sites = JSON.parse(readFileSync(join(tmp, 'base.json'), 'utf8')).hits.map(([l]) => l);
    void base;
    const rawSrc = readFileSync(join(HERE, TARGET), 'utf8');
    const src = rawSrc.split('\n');

    /*
     * ★★ **调用点数不变式** —— 这个工具最容易被悄悄骗过去的那一处。
     *
     * 归并键是**调用方栈帧的行号**。只要有人给 `must()` 包一层助手
     * （`mustKeyName(cond, msg) { must(cond, msg) }` 这种），所有经它转发的规则
     * 就会**全部塌成助手内部那一行**，而这个工具**照常报绿**、只是总数悄悄变小。
     *
     * `[实测 2026-09-06]` 本轮真干过一次：为了给汇总行数「键名扫描占多少次」，
     * 包了一个 `mustKeyName()` ⇒ 本工具从 **89 掉到 87**、
     * `count-verdict-sites.mjs` 从 **90 掉到 88**，**两个计数器都没出声**。
     * 那正是本仓在清的那一族：坏掉的样子和"本来就这么多"长得一模一样。
     *
     * ⇒ 拿**文本调用点数**做交叉验证，对不上直接 exit 2。
     *   口径与 `count-verdict-sites.mjs` 一致，只多减掉 `function must(` 那处定义。
     */
    const stripped = rawSrc
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^([^\n]*?)\/\/[^\n]*$/gm, (_m, keep) => keep);
    const textualSites = new Set();
    for (const m of stripped.matchAll(/(^|[^A-Za-z0-9_.$])must\s*\(/gm)) {
      const line = stripped.slice(0, m.index + m[0].indexOf('must')).split('\n').length;
      if (!/function\s+must\s*\(/.test(src[line - 1] ?? '')) textualSites.add(line);
    }
    const onlyText = [...textualSites].filter((l) => !sites.includes(l));
    const onlyRun = sites.filter((l) => !textualSites.has(l));
    if (onlyText.length > 0 || onlyRun.length > 0) {
      console.error(
        `✘ 调用点数对不上：文本数出 ${textualSites.size} 处，插桩实际跑到 ${sites.length} 处 —— 本次结果无效。`,
      );
      console.error('  最常见的成因：有人给 `must()` 包了一层助手，于是好几条规则塌成了同一行。');
      for (const l of onlyText)
        console.error(`  · 有 must( 却没跑到  L${l}: ${src[l - 1]?.trim().slice(0, 90)}`);
      for (const l of onlyRun)
        console.error(`  · 跑到了却没数到    L${l}: ${src[l - 1]?.trim().slice(0, 90)}`);
      process.exit(2);
    }
    console.log(`   ✔ 调用点数不变式：文本与插桩都数出 ${sites.length} 处。\n`);

    const muts = enumerate(roots[0]);
    console.log(
      `   扫到 ${muts.length} 个变异；每个跑一遍 lint-workflows（8 并发，约 2.5 分钟）\n`,
    );

    const fired = new Map(); // 行号 → 让它红的变异数
    const soleFired = new Map(); // 行号 → 只让它一条红的变异数
    let broke = 0;
    let done = 0;
    await Promise.all(
      roots.map(async (root, wi) => {
        const out = join(tmp, `w${wi}.json`);
        for (let i = wi; i < muts.length; i += NW) {
          const restore = applyMutation(root, muts[i]);
          try {
            unlinkSync(out);
          } catch {
            /* 上一轮没写出来 */
          }
          const r = await runIn(root, out);
          restore();
          if (r.fails === null) broke += 1;
          else if (r.status !== 0) {
            const s = new Set(r.fails);
            for (const l of s) fired.set(l, (fired.get(l) ?? 0) + 1);
            if (s.size === 1) {
              const l = [...s][0];
              soleFired.set(l, (soleFired.get(l) ?? 0) + 1);
            }
          }
          done += 1;
          if (done % 1000 === 0) console.log(`   … ${done}/${muts.length}`);
        }
      }),
    );

    /*
     * ⚠️ needle 所在的行**不是**规则所在的行：`must(` 多半单独占一行，条件在下一行。
     *   所以把 needle 归到「不大于它、且最近的那个 `must()` 调用点」上 ——
     *   调用点全集来自基线那一次的插桩记录，是**实测**的，不是猜的。
     *   （早先这里用 `Math.abs(k - l) <= 3` 的模糊匹配，会把相邻规则算成同一条：
     *     `[实测]` 它把当时的 37 条登记摊成 39 个调用点，两条本该单列的规则被误吞。）
     */
    const sorted = [...sites].sort((a, b) => a - b);
    const siteOf = (line) => {
      let best = -1;
      for (const s of sorted) if (s <= line && s > best) best = s;
      return best;
    };
    const registered = new Set();
    for (const r of REGISTERED_RULES) {
      let from = 0;
      for (;;) {
        const i = rawSrc.indexOf(r.needle, from);
        if (i < 0) break;
        from = i + r.needle.length;
        registered.add(siteOf(rawSrc.slice(0, i).split('\n').length));
      }
    }

    const A = sites.filter((l) => (soleFired.get(l) ?? 0) > 0);
    const rest = sites.filter((l) => (soleFired.get(l) ?? 0) === 0);
    // 登记过的与没登记的分开 —— 只有后者是**今天新长出来的**
    const known = rest.filter((l) => registered.has(l));
    const novel = rest.filter((l) => !registered.has(l));

    const byBucket = new Map();
    for (const r of REGISTERED_RULES) {
      let from = 0;
      for (;;) {
        const i = rawSrc.indexOf(r.needle, from);
        if (i < 0) break;
        from = i + r.needle.length;
        byBucket.set(siteOf(rawSrc.slice(0, i).split('\n').length), r.bucket);
      }
    }
    const countIn = (b) => known.filter((l) => byBucket.get(l) === b).length;

    const nAdd = countIn('甲 加法型（通用族造不出坏输入）');
    const nPrecise = countIn('甲 需要定点坏输入');
    const nSubsumed = countIn('乙 被相邻断言吞掉');
    const nSelf = countIn('丙 主语是自身常量');

    console.log('');
    console.log(
      `── 静态规则总数：${sites.length}（动态 ${expected} 次 = \`must()\` 的调用次数，不是判据条数）`,
    );
    console.log('');
    console.log(`── 甲 有专属坏输入：${A.length + nAdd + nPrecise} / ${sites.length}`);
    console.log(`     · 本次扫描直接独红                      ${A.length}`);
    console.log(`     · 加法型，通用族造不出（登记，已实测）    ${nAdd}`);
    console.log(`     · 需要定点坏输入（登记，已实测）          ${nPrecise}`);
    console.log(`── 乙 被相邻断言吞掉（登记，可证）：${nSubsumed}`);
    console.log(`── 丙 空转 · 主语是自身常量（坏输入只能是夹具）：${nSelf}`);
    console.log(`── 判不了（删掉之后 lint-workflows 自己崩了）：${broke}`);
    console.log('');
    if (novel.length === 0) {
      console.log('   ✔ 没有**未登记**的「删了也绿」—— 与四张登记表一致。');
    } else {
      console.log(
        `   🔴 ${novel.length} 条**没有登记**、而且任何变异都不让它红 —— 今天新长出来的空转：`,
      );
      for (const l of novel) console.log(`      L${l}: ${src[l - 1]?.trim().slice(0, 100)}`);
      console.log('      要么补一个专属坏输入，要么想清楚它属于哪一栏再登记进本文件。');
    }

    const jsonAt = process.argv.indexOf('--json');
    if (jsonAt >= 0) {
      const outPath = process.argv[jsonAt + 1];
      if (!outPath) {
        console.error('✘ lintwf-coverage: --json 后面没给路径');
        process.exit(2);
      }
      writeFileSync(
        outPath,
        `${JSON.stringify({ target: TARGET, staticRules: sites.length, dynamic: Number(expected), sole: A, known, novel, broke, mutations: muts.length }, null, 2)}\n`,
      );
      console.log(`\n   （结果已写入 ${outPath}）`);
    }

    console.log('');
    console.log('⚠️ 这个工具**不判红绿**（退出码恒 0）：那 47 条合法地不会被扫描独红，');
    console.log('   做成门禁就是一盏常亮的灯。判决那一半在 selftest-lintwf-coverage.mjs 里 ——');
    console.log('   四张登记表的每条 needle 必须在判据源码里恰好出现 count 次。');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 被 selftest import 时不自动跑。
// ⚠️ 只许用 `isDirectRun()`（判据见 scripts/lib/entrypoint.mjs 文件头）。
if (isDirectRun(import.meta.url, process.argv[1])) await main();
