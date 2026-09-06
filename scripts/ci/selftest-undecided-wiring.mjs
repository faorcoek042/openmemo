#!/usr/bin/env node
/**
 * 覆盖面（undecided）那条管道的**接线守卫** —— 五条腿一起查，秒级，不需要网络。
 *
 * ## 它治的病：**这条管道断掉时不会有任何东西变红**
 *
 * 一格未决计数要走完**八处手写、必须两两对齐**的东西才到得了凭证
 * （早先这里写的是"四个名字"，**数少了** —— 2026-08-17 复核逐处点出来）：
 *
 * ```
 *   审计脚本 --undecided-out e2e-<leg>-undecided-<label>.json     ①
 *        ↓
 *   upload-artifact  name: e2e-<leg>-undecided-<label>            ②
 *                    path: e2e-<leg>-undecided-<label>.json       ③
 *        ↓
 *   download-artifact pattern: e2e-<leg>-undecided-*              ④
 *        ↓
 *   sum-undecided.mjs --file-template 'e2e-<leg>-undecided-{label}.json'  ⑤
 *        ↓
 *   emit-e2e-attestation.mjs ${{ steps.sum.outputs.undecided_flag }}      ⑥
 * ```
 *
 * ①〜⑤ **任意两处对不上**，`sum-undecided.mjs` 会照它的裁决**只警告、收敛成 null、
 * 退出码 0**（那条裁决是对的：一个展示用的统计不该连累凭证本身）。后果是：
 *
 *   · 那一步**绿**；
 *   · 整条腿**绿**；
 *   · 凭证照发，只是 `undecided` 从一个数字变回 `null`；
 *   · 发布闸门把它印成「**没上报覆盖面**（未接线或读不到）」——
 *     和「这条腿从来没接过线」**一模一样**。
 *
 * 也就是说：**把线接好，和把线接错，在所有灯上长得一样。** 而这条管道存在的
 * 全部理由，就是把「查过了确实是 0」和「根本没查」分开说
 * （`emit-e2e-attestation.mjs` 里 `null` vs `0` 那段注释）。
 * 一条会悄悄退回 `null` 的管道，等于把那个区分又还回去了。
 *
 * ## ⚠️ 这一条是本轮 notes 接线时**顺手发现的，不是 notes 独有的**
 *
 * 五条腿（runtime / browser / record / allcomponents / notes）今天都靠
 * 「八处手写、人眼对齐」维持。它们**现在是对的** —— 这份文件把「现在是对的」
 * 变成「改坏了会红」。
 *
 * ## 判据（只查机械可判定的，不猜语义）
 *
 *   R1 ①⑤ 同模板：`--undecided-out` 的文件名（把 `${{ matrix.label }}` 归一成
 *      `{label}`）必须与 `--file-template` 逐字相同。同一条腿有多个
 *      `--undecided-out` 调用点（browser 有两处，两种模式各一）时，**每一处都要对**。
 *   R2 ②③ 与①同源：upload 的 `name` = 模板去掉 `.json`；`path` = 模板。
 *   R3 ④ 覆盖得住②：download 的 `pattern` = 模板里 `{label}` 之前那一截 + `*`。
 *   R4 ⑥ 真的在读求和结果：emit 那一行必须含 `${{ steps.<id>.outputs.undecided_flag }}`，
 *      且 `<id>` 真的是那个 sum 步骤的 `id:`。
 *   R5 🔴 **不许接了线还写死**：emit 那一行不许再出现字面量 `--undecided <数字>`。
 *   R6 ⑥ 那个插值**不许加引号**：`"${{ … }}"` 会把 `--undecided 3` 变成一个 argv
 *      词，`arg()` 找不到 `--undecided` ⇒ 静默退回 null（与断线同形）。
 *   R7 🔴 **JSON 键（第八个名字）**：审计脚本写进那个文件的键，必须就是
 *      `sum-undecided.mjs` 要读的那个（`--field` 的默认值 `unknowns`）。
 *      ⚠️ 这一处**R1–R6 一个都没守它** —— 复核点出来的洞：
 *      把审计脚本里的 `unknowns` 改成别的（比如 `undecidedCount`），
 *      五个文件名仍然逐字对齐、这份自测**全绿**，而 `sum-undecided.mjs` 会
 *      读不到字段 ⇒ 警告 ⇒ 收敛成 null ⇒ 退出码 0 ⇒ 凭证退回"没上报覆盖面"。
 *      **那正是这个文件存在要消灭的那一种失败。**
 *      ⚠️ 2026-08-17 收紧：判据从**整文件 grep** 改成**只认代码位置**
 *      （见下面 `keyAtCodePosition`）。整文件 grep 时代，`e2e-allcomponents.mjs`
 *      与 `e2e-notes-audit.mjs` 的文件头注释里各写着一句 `{ unknowns: N }` ——
 *      **五条腿里有两条，光靠那句注释就能满足 R7**，对它们这条判据等于不存在。
 *   R8 🔴 **第二个 JSON 键（第九个名字）**：`collect-unverified-mutations.mjs`
 *      读的那一格（`unverified`）。它与 R7 是同一种病：改了名 ⇒ 读不出 ⇒
 *      按它自己的裁决收敛成 `ran-unverified` / 空 ⇒ **没有任何东西变红**。
 *      接了这一轴的三条腿（runtime / browser / notes）都要过。
 *      ⚠️ **别把削减说成消除**：browser / notes 复用覆盖面那份 artifact，
 *      省下的是「另开一条管道要新添的五个会漂的名字」——
 *      结果不是"没有新增手抄的名字"，而是**五个收成了一个**；
 *      而收成的那一个（这个 JSON 键），在 R8 之前**一个守卫都没有**。
 *
 * ## 反向证明
 *
 * 光查「现状对不对」是**①空转**那一档：今天它必然全绿，而它是不是真的会红没人知道。
 * 所以下面每条判据都配一段**故意改坏的夹具**，逐条要求它当场红 ——
 * 抽掉哪一条判据，对应那段夹具就会溜过去。
 *
 * ⚠️ R7 / R8 守的那两处**不在 YAML 里**（它们在写文件的那个脚本、或那段内联
 * `node -e` 的源码里），所以"把键改个名"这件坏事改的是**源码**，不是 YAML
 * （第 ③ 节）。第一版没有这条路，于是那条名叫「审计脚本把 JSON 键改了名」的用例
 * 实际证的是**另一件事**（producer 指到了一个不存在的脚本）—— 名字说 A、证据是 B。
 *
 * ⚠️ **别把这份文件说成"N 条判据 × M 条腿"** —— 它跑出来是**一个扁平的用例数**：
 * 每条腿一条（把八条判据一次跑完、任一条不过就是这条腿红）+ 两条扫描地板
 * + 一条"键是抠出来的" + 每段坏夹具一条（含两份基准夹具各一条）。
 * 早先我在 PR 描述里写成"六条判据 × 五条腿"，
 * 那是一句听起来更大、而机器数不出来的话。**以脚本最后打印的那个数为准。**
 *
 * 用法：`node scripts/ci/selftest-undecided-wiring.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readFileSafe = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/**
 * 两个 JSON 键都**从消费方自己的源码里抠**，不在这里另抄一份 ——
 * 抄一份就又多了一处会漂的名字，而这份文件正是为此存在的。
 *
 * ⚠️ 抠不出来时**不许退回一个手写的默认值**（第一版的 `?? 'unknowns'` 就是）：
 *   消费方换个写法，这里会拿着一个自己编出来的键继续判绿 —— 那是"钉错了东西"。
 *   抠不出就返回 `null`，由 R7 / R8 当场说"查不了"。**查不了不是查过了。**
 */
const fieldFrom = (file, re) =>
  readFileSafe(join(REPO, 'scripts', 'ci', file))?.match(re)?.[1] ?? null;

/** `sum-undecided.mjs --field` 的默认值（今天是 `unknowns`）。 */
const SUM_FIELD = fieldFrom('sum-undecided.mjs', /arg\('--field',\s*'([^']+)'\)/);

/**
 * `collect-unverified-mutations.mjs` 读的那一格（今天是 `unverified`）——
 * 抠的是它 `readOne()` 里那句 `Array.isArray(j.<键>)`，即**真正被读的那个名字**。
 */
const COLLECT_FIELD = fieldFrom(
  'collect-unverified-mutations.mjs',
  /Array\.isArray\(j\.([A-Za-z_$][\w$]*)\)/,
);

/**
 * 「这段源码**真的把 `<键>` 写进了一个对象字面量**」—— 而不是只在一句注释里提过它。
 *
 * ## 为什么必须分开（R7 此前是整文件 grep，五条腿里有两条因此是空转的）
 *
 * `e2e-allcomponents.mjs` 与 `e2e-notes-audit.mjs` 的文件头注释里都逐字写着
 * `{ unknowns: N }`。整文件 grep 时代，把这两条腿**代码里的键改掉、只留那句注释**，
 * R7 照样绿 —— 一句注释满足了一条本该盯着代码的判据（"注释型断言"那一档）。
 *
 * ## 判据两层，都刻意是"笨"的
 *
 *   ① **只留代码行**：行首（缩进之后）是 `*` / `/` / `#` 的行整行丢掉。
 *      照 `scripts/ci/mutation-verdict.mjs` 的 `extractMutationIds` 那条先例
 *      （"只认语句位置：行首缩进之后紧跟着调用"）—— 那里明确否决过"先剥注释再找"：
 *      剥块注释的正则会把字符串里长得像块注释开头的东西当真，一路吞掉真代码
 *      （PR #66 实测，被它自己的非空地板当场抓住）。行首判断不需要理解字符串。
 *      `#` 那一档是给 workflow 里内联的 shell / `node -e` 用的（R8 要看的是 run 文本）。
 *   ② **必须长得像对象键**：前面得有 `{` 或 `,`，且那个 `{` 不许跟在 `$` 后面。
 *      少了这一层，shell 的 `${unverified:-（无）}` 会**逐字满足** `unverified:` ——
 *      `e2e-runtime.yml` 的「逐条变异」那一步里就有这么一句 `echo`，
 *      于是 runtime 那条腿的 R8 会被一句与落盘无关的 echo 喂饱（钉错了东西）。
 *
 * 丢掉注释行之后**再整体匹配**（不是逐行），这样跨行写的
 * `JSON.stringify({\n  unknowns: n,\n })` 一样认得出来。
 *
 * ⚠️ 代价（诚实边界，方向是漏检不是误伤，与本仓其它判据同侧）：
 *   · 行尾注释里的 `{ 键: …}`（`foo(); // { unknowns: 3 }`）仍会被算成代码；
 *   · 块注释里**不带 `*` 前缀**的续行也会；
 *   · 反过来，`'{"unknowns": 3}'` 这种手写 JSON 串**认不出来**（键上有引号）——
 *     真有人这么写，这里会红，而红的方向是"来解释一下"，不是悄悄放过。
 */
const keyAtCodePosition = (src, field) => {
  const codeOnly = String(src ?? '')
    .split('\n')
    .filter((line) => {
      const head = line.trimStart().charAt(0);
      return head !== '*' && head !== '/' && head !== '#';
    })
    .join('\n');
  return new RegExp(`(?<!\\$)[{,]\\s*${field}\\s*:`).test(codeOnly);
};

const WF_DIR = join(REPO, '.github', 'workflows');

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

/** `${{ matrix.label }}` / `${{matrix.label}}` → `{label}`，好让两侧可以逐字比。 */
const normLabel = (s) => String(s ?? '').replace(/\$\{\{\s*matrix\.label\s*\}\}/g, '{label}');

/** 把一个 job 的所有 step 摊平（含它们的 `run` / `with` / `id` / `name`）。 */
function stepsOf(doc) {
  const out = [];
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    for (const s of job?.steps ?? []) out.push({ jobName, ...s });
  }
  return out;
}

/**
 * 从一份 workflow 里把那条管道的六个名字抠出来。
 * 抠不到就返回 `null` —— 调用方据此判断"这条腿根本没接这条管道"（不是失败）。
 */
export function extractWiring(text) {
  const doc = parse(text);
  const steps = stepsOf(doc);

  const sumStep = steps.find((s) => /sum-undecided\.mjs/.test(String(s.run ?? '')));
  if (!sumStep) return null;

  const run = String(sumStep.run);
  const tpl = run.match(/--file-template\s+'([^']+)'/)?.[1] ?? null;

  /*
   * ⚠️ **按行取，不要用一个正则去啃。** `--undecided-out` 的值里合法地含空格：
   *   `e2e-runtime.yml:259` 写的是**不带引号**的
   *   `--undecided-out e2e-runtime-undecided-${{ matrix.label }}.json \`
   *   —— `${{ matrix.label }}` 内部有空格，`[^\s]+` 会在 `${{` 后面就断掉，
   *   于是抠出半个文件名、和模板永远对不上 ⇒ 这个守卫会**恒红**。
   *   （恒红的守卫和恒绿的一样没用，只是让人更快学会无视它。）
   */
  const outs = [];
  const FLAG = '--undecided-out';
  for (const s of steps) {
    for (const line of String(s.run ?? '').split('\n')) {
      const i = line.indexOf(FLAG);
      if (i < 0) continue;
      let v = line.slice(i + FLAG.length).trim();
      v = v.replace(/\\\s*$/, '').trim(); // 行尾的续行反斜杠
      v = v.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
      outs.push(normLabel(v));
    }
  }

  const uploads = steps
    .filter((s) => /upload-artifact/.test(String(s.uses ?? '')))
    .map((s) => ({
      name: normLabel(s.with?.name),
      path: normLabel(s.with?.path),
      ifNoFiles: s.with?.['if-no-files-found'],
      cond: String(s.if ?? ''),
    }))
    .filter((u) => /undecided/.test(u.name));

  const download = steps
    .filter((s) => /download-artifact/.test(String(s.uses ?? '')))
    .map((s) => String(s.with?.pattern ?? ''))
    .find((p) => /undecided/.test(p));

  const emitStep = steps.find((s) => /emit-e2e-attestation\.mjs/.test(String(s.run ?? '')));

  /*
   * ★ R7 用：`--undecided-out` 是哪个脚本写的 —— 从同一条 `run` 里把
   *   `node scripts/ci/<x>.mjs` 抠出来。抠不到就返回 null，R7 会说"查不了"
   *   （而不是默默跳过：查不了和查过了是两回事）。
   */
  let producer = null;
  for (const st of steps) {
    const run = String(st.run ?? '');
    if (!run.includes('--undecided-out')) continue;
    producer = run.match(/node\s+(scripts\/ci\/[\w.-]+\.mjs)/)?.[1] ?? null;
    if (producer) break;
  }

  /*
   * ★ R8 用：`collect-unverified-mutations.mjs` 那一步读的是哪份文件，
   *   以及**谁写的那份文件**。两种形状必须都收得到：
   *     · browser / notes：复用覆盖面那份 artifact（模板与 sum 相同），
   *       写它的是审计脚本 —— 键在那个 `.mjs` 的源码里；
   *     · runtime：另有一份 `e2e-runtime-unverified-{label}.json`，
   *       写它的是 workflow 里**内联的 `node -e`** —— 键在 YAML 的 `run` 文本里，
   *       仓里没有任何一个脚本文件装着它。
   *   所以这里收的是**写这份文件的那一步的 run 文本**，两种形状同一条路走
   *   （只按"找到 .mjs 再进它源码里翻"写，runtime 会静默地不被覆盖）。
   */
  const collectStep = steps.find((s) =>
    /collect-unverified-mutations\.mjs/.test(String(s.run ?? '')),
  );
  const collectTpl = collectStep
    ? (String(collectStep.run).match(/--file-template\s+'([^']+)'/)?.[1] ?? null)
    : null;
  const unverifiedWriters = [];
  if (collectTpl) {
    for (const s of steps) {
      const stepRun = normLabel(String(s.run ?? ''));
      if (!stepRun.includes(collectTpl)) continue;
      // 读方不是写方：sum / collect 那两步也逐字提到这个文件名。
      if (/sum-undecided\.mjs|collect-unverified-mutations\.mjs/.test(stepRun)) continue;
      unverifiedWriters.push({ where: `${s.jobName}/${s.name ?? '(无名步骤)'}`, run: stepRun });
    }
  }

  return {
    producer,
    tpl,
    outs,
    uploads,
    download,
    sumId: sumStep.id ?? null,
    emitRun: emitStep ? String(emitStep.run) : null,
    collectTpl,
    unverifiedWriters,
  };
}

/**
 * 八条判据（R1–R8）。返回一个问题清单（空 = 这条腿接线是通的）。
 *
 * `readSrc(相对路径)` 只为**反向证明**留的注入口：R7 / R8 要看的是仓里真实脚本的
 * 源码，而"把那个键改个名"这件坏事没法用改 YAML 表达出来。默认就是读真文件。
 */
export function checkWiring(w, readSrc = (rel) => readFileSafe(join(REPO, rel))) {
  const problems = [];
  if (!w.tpl) {
    problems.push("R1 求和步骤里找不到 `--file-template '…'`");
    return problems;
  }
  const prefix = w.tpl.includes('{label}') ? w.tpl.slice(0, w.tpl.indexOf('{label}')) : null;
  if (prefix === null) problems.push(`R1 --file-template 里没有 {label} 占位符：${w.tpl}`);

  // R1：每一个 --undecided-out 都必须与模板同名
  if (w.outs.length === 0) problems.push('R1 没有任何一步传 `--undecided-out` —— 管道的源头是空的');
  for (const o of w.outs) {
    if (o !== w.tpl) problems.push(`R1 --undecided-out 与 --file-template 对不上：${o} ≠ ${w.tpl}`);
  }

  // R2：upload 的 name / path
  if (w.uploads.length === 0) problems.push('R2 没有上传那份覆盖面计数的 upload-artifact 步骤');
  for (const u of w.uploads) {
    const wantName = w.tpl.replace(/\.json$/, '');
    if (u.name !== wantName) problems.push(`R2 upload name 对不上：${u.name} ≠ ${wantName}`);
    if (u.path !== w.tpl) problems.push(`R2 upload path 对不上：${u.path} ≠ ${w.tpl}`);
    if (u.ifNoFiles !== 'warn') {
      problems.push(
        `R2 覆盖面那份 artifact 的 if-no-files-found 应当是 warn（实得 ${u.ifNoFiles}）——` +
          ' error 会让"脚本没来得及写这个文件"在这里再红一次，而它该由下游收敛成 null',
      );
    }
    if (!/!cancelled\(\)/.test(u.cond)) {
      problems.push(
        'R2 覆盖面那份 artifact 的上传必须带 `if: ${{ !cancelled() }}` ——' +
          ' 一次红跑的未决清单恰恰是最想看的东西',
      );
    }
  }

  // R3：download 的 pattern 必须覆盖得住 upload 的 name
  if (prefix !== null) {
    const wantPattern = `${prefix}*`;
    if (w.download !== wantPattern) {
      problems.push(`R3 download pattern 对不上：${w.download} ≠ ${wantPattern}`);
    }
  }

  // R4/R5/R6：emit 那一行
  if (!w.emitRun) {
    problems.push('R4 找不到 emit-e2e-attestation.mjs 那一步');
  } else {
    if (!w.sumId)
      problems.push('R4 求和那一步没有 `id:` —— 下游取不到它的 outputs（会静默传空串）');
    const wantExpr = new RegExp(
      `\\$\\{\\{\\s*steps\\.${w.sumId ?? '\\w+'}\\.outputs\\.undecided_flag\\s*\\}\\}`,
    );
    if (!wantExpr.test(w.emitRun)) {
      problems.push(`R4 emit 那一行没有读 steps.${w.sumId}.outputs.undecided_flag`);
    }
    if (/--undecided\s+\d/.test(w.emitRun)) {
      problems.push(
        'R5 🔴 emit 那一行还写死着 `--undecided <数字>` —— 接了线就不许再写死，' +
          '否则那个数字永远不会跟着实际情况变（「恒为 N」是一句会过期的话）',
      );
    }
    if (/"\$\{\{\s*steps\.\w+\.outputs\.undecided_flag\s*\}\}"/.test(w.emitRun)) {
      problems.push(
        'R6 那个插值被加了引号 —— `"--undecided 3"` 会变成一个 argv 词，' +
          '`arg()` 找不到 `--undecided`，于是**静默**退回 null（与断线同形）',
      );
    }
  }

  /*
   * R7：JSON 键。`sum-undecided.mjs` 默认读 `unknowns`；写文件的那个审计脚本
   * 必须真的写这个键。两边任一侧改名 ⇒ 读不到 ⇒ 警告 ⇒ null ⇒ 退出码 0，
   * **而 R1–R6 全绿**。这是第八处手写，也是此前唯一没人守的那处。
   *
   * ⚠️ 判据是「**代码位置**上写着这个键」，不是"整个文件里出现过这个字符串"：
   *   五条腿里有两条（allcomponents / notes）的文件头注释里就写着 `{ unknowns: N }`，
   *   整文件 grep 对那两条腿等于不存在（见 `keyAtCodePosition` 的说明）。
   */
  if (!SUM_FIELD) {
    problems.push(
      "R7 抠不出 `sum-undecided.mjs` 读的是哪个键（`arg('--field', '…')` 的形状变了）——" +
        ' 查不了不是查过了；这里**不许**退回一个手写的默认键继续判绿',
    );
  } else if (!w.producer) {
    problems.push(
      'R7 抠不出是哪个脚本写的那份文件（`--undecided-out` 那条 run 里没有 node 脚本名）',
    );
  } else {
    const src = readSrc(w.producer);
    if (src === null) {
      problems.push(`R7 找不到写文件的脚本：${w.producer}`);
    } else if (!keyAtCodePosition(src, SUM_FIELD)) {
      problems.push(
        `R7 ${w.producer} 的**代码位置**上写不出 \`${SUM_FIELD}:\` 这个键 —— ` +
          `而 sum-undecided.mjs 读的就是它。改了名两边就对不上了，` +
          '表现是"警告 + 收敛成 null + 退出码 0"，五个文件名却仍然逐字对齐。' +
          '（注释里还写着这个键**不算**：注释不写文件。）',
      );
    }
  }

  /*
   * R8 🔴 **第二个 JSON 键**：`collect-unverified-mutations.mjs` 读的那一格
   * （今天叫 `unverified`）—— 与 R7 是同一种病的另一半。
   *
   * 改了名之后：collect 读不出那一格 ⇒ 照它自己的裁决**向"有未验证的"收敛** ⇒
   * 凭证每轮写 `ran-unverified`（外加一条 `<label>:(覆盖面读不到)`）⇒
   * 闸门只是多念一句，**没有任何东西变红**，而"每条变异都有结论"这句话从此没人验。
   *
   * ⚠️ 这一格是 browser / notes 复用同一份 artifact 换来的：省掉的是"另开一条管道
   *   要新添的五个会漂的名字"，**五个收成了一个**，而不是"没有新增手抄的名字"。
   *   在 R8 之前，收成的这一个**一个守卫都没有**。别把削减说成消除。
   */
  if (w.collectTpl) {
    if (!COLLECT_FIELD) {
      problems.push(
        'R8 抠不出 `collect-unverified-mutations.mjs` 读的是哪个键' +
          '（`Array.isArray(j.<键>)` 的形状变了）—— 查不了不是查过了',
      );
    } else if (w.unverifiedWriters.length === 0) {
      problems.push(
        `R8 找不到谁写 \`${w.collectTpl}\` 这份文件（collect 那一步要读它）—— ` +
          '要么它根本没人写（那 collect 每轮都读不到），要么这里的提取漂了。两种都得有人看。',
      );
    } else {
      const wrote = w.unverifiedWriters.some(({ run }) => {
        // ① 就写在这段 run 里（runtime：内联的 `node -e`）
        if (keyAtCodePosition(run, COLLECT_FIELD)) return true;
        // ② 或者写在这段 run 调的那个脚本里（browser / notes：审计脚本）
        const script = run.match(/node\s+(scripts\/ci\/[\w.-]+\.mjs)/)?.[1] ?? null;
        const src = script ? readSrc(script) : null;
        return src !== null && keyAtCodePosition(src, COLLECT_FIELD);
      });
      if (!wrote) {
        problems.push(
          `R8 写 \`${w.collectTpl}\` 的那一步（${w.unverifiedWriters.map((u) => u.where).join(' / ')}）` +
            `**代码位置**上写不出 \`${COLLECT_FIELD}:\` 这个键 —— 而 ` +
            'collect-unverified-mutations.mjs 读的就是它。改了名的表现是' +
            '"每轮虚报 ran-unverified + 退出码 0"，没有任何一盏灯会红。',
        );
      }
    }
  }
  return problems;
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('── ① 仓里每条接了这条管道的腿，八条判据（R1–R8）都必须过 ────────────────');

/*
 * ⚠️ 「用没用这条管道」的判据是**有没有一个 step 真的在跑 `sum-undecided.mjs`**，
 *   不是"文件里提没提到它"。按"提到就算"去查，会给一条只在注释里提过它的腿判一个
 *   **它没有犯的错**（R5）—— 而对着正确的东西报红，比不报还坏。
 *
 * ⚠️ 这段话原来点名 `e2e-import.yml`，说那条腿「**刻意不走这条管道**」，
 *   因为它的 `--undecided` 由 `inputs.skipF1` 推出来、且有一整段仍然成立的论证。
 *   **那已经过期了**：2026-09-06 起 import 也接上了真管道 ——
 *   #98 在它里面抓到一条真的空转（`media.ready` 收不到时那一格只 say 不 fail），
 *   修法是给它第三态，于是「这条腿绿跑里不可能有未决」这个前提当场不成立。
 *   ⇒ 今天六条腿都在这条管道上，这里不再有"刻意例外"那一档。
 *   （判据本身一个字没改：它从来就是"有没有 step 真的在跑"，所以 import 接上的
 *     那天它自己就把那条腿收了进来 —— 这正是不写手抄名单的回报。）
 */
const wfFiles = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));
const wired = [];
const mutWired = []; // 其中还接了变异那一轴（R8 管得着）的那几条
for (const f of wfFiles.sort()) {
  const w = extractWiring(readFileSync(join(WF_DIR, f), 'utf8'));
  if (w === null) continue; // 这条腿没接这条管道 —— 不是失败
  wired.push(f);
  if (w.collectTpl) mutWired.push(f);
  const problems = checkWiring(w);
  if (problems.length === 0) ok(`${f}（模板 ${w.tpl}${w.collectTpl ? ' · 含变异那一格' : ''}）`);
  else bad(f, problems.join('\n      '));
}

/*
 * ★ 扫描不是空集的地板。本仓已有多种"对空集返回绿"的形态，
 *   守卫的第一条断言必须是"我真的看到东西了"。
 */
cases += 1;
/*
 * ⚠️ 地板从 5 提到 6（2026-09-06，import 接线那一轮）：地板只准往上抬。
 *   留在 5 的话，import 这条**刚接上**的线被谁摘掉时，这里照样绿 ——
 *   而它是本仓唯一一条在**绿跑里**真的会产生未决的 e2e 腿。
 */
if (wired.length >= 6) {
  say(`  ✔ 扫到 ${wired.length} 条接了这条管道的腿（地板 6）：${wired.join(', ')}`);
} else {
  failures += 1;
  say(`  ✘ 只扫到 ${wired.length} 条腿（地板 6）—— 扫描本身坏了，不是"真的没有腿在用它"`);
}

/*
 * ★ R8 自己的地板。R8 只在"这条腿接了变异那一轴"时才有话说 ——
 *   `collectTpl` 的提取一漂，R8 会对**零条腿**生效，而表现是**全绿**
 *   （又一个"对空集返回绿"）。三条：runtime / browser / notes。
 */
cases += 1;
if (mutWired.length >= 3) {
  say(`  ✔ 其中 ${mutWired.length} 条还接了变异那一格（地板 3）：${mutWired.join(', ')}`);
} else {
  failures += 1;
  say(
    `  ✘ 只扫到 ${mutWired.length} 条接了变异那一格的腿（地板 3）——` +
      ' R8 这一轮什么都没管到，而它的表现是全绿',
  );
}

/*
 * ★ 两个 JSON 键都必须是**从消费方源码里抠出来的**。抠不出来时上面刻意不给默认值，
 *   所以这里正面钉一次：否则"抠不出 ⇒ null ⇒ R7/R8 每条腿都报同一句话"这种
 *   恒红也好、被谁顺手加回一个手写默认值也好，都该在这里先被说破。
 */
cases += 1;
if (SUM_FIELD && COLLECT_FIELD) {
  say(`  ✔ 两个 JSON 键都是抠出来的：sum=\`${SUM_FIELD}\` · collect=\`${COLLECT_FIELD}\``);
} else {
  failures += 1;
  say(
    `  ✘ 抠不出键（sum=${SUM_FIELD ?? 'null'} · collect=${COLLECT_FIELD ?? 'null'}）——` +
      ' 消费方换了写法，这份守卫已经不知道自己该盯什么了',
  );
}

say('');
say('── ② 反向证明：每条判据配一段故意改坏的 YAML，必须当场红 ──────────────────');

/** 一份**最小**的、接线正确的 workflow —— 下面每个用例只改坏它的一处。 */
const GOOD = `
name: fixture
on: { workflow_dispatch: {} }
jobs:
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - name: 跑审计
        run: |
          node scripts/ci/e2e-browser-audit.mjs \\
            --undecided-out "e2e-fix-undecided-\${{ matrix.label }}.json"
      - name: 留档
        if: \${{ !cancelled() }}
        uses: actions/upload-artifact@v6
        with:
          name: e2e-fix-undecided-\${{ matrix.label }}
          path: e2e-fix-undecided-\${{ matrix.label }}.json
          if-no-files-found: warn
  attest:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@v7
        with:
          pattern: e2e-fix-undecided-*
          path: undecided
          merge-multiple: true
      - name: 求和
        id: sum
        run: |
          node scripts/ci/sum-undecided.mjs --dir undecided \\
            --expect-labels "$PLATFORMS" \\
            --file-template 'e2e-fix-undecided-{label}.json' \\
            --github-output "$GITHUB_OUTPUT"
      - name: 汇总未验证的变异
        id: mut
        run: |
          node scripts/ci/collect-unverified-mutations.mjs --dir undecided \\
            --expect-labels "$PLATFORMS" \\
            --file-template 'e2e-fix-undecided-{label}.json' \\
            --github-output "$GITHUB_OUTPUT"
      - name: 写凭证
        run: |
          node scripts/ci/emit-e2e-attestation.mjs --leg fix \\
            \${{ steps.sum.outputs.undecided_flag }} --out dist/e2e-attest.json
`;

cases += 1;
{
  const problems = checkWiring(extractWiring(GOOD));
  if (problems.length === 0) say('  ✔ 基准夹具（接线正确）是绿的 —— 否则下面每条红都不作数');
  else {
    failures += 1;
    say(`  ✘ 基准夹具就红了，这份反向证明什么都证不了：\n      ${problems.join('\n      ')}`);
  }
}

/** [名字, 把 GOOD 改坏的替换, 期望命中的判据（编号前缀，或一条更具体的正则）] */
const BREAKAGES = [
  [
    'R1 审计写的文件名与求和模板差一个字（最常见的手滑）',
    (s) => s.replace('--undecided-out "e2e-fix-undecided-', '--undecided-out "e2e-fixx-undecided-'),
    'R1',
  ],
  [
    'R1 干脆没传 --undecided-out（源头是空的）',
    (s) => s.replace(/--undecided-out[^\n]*\n/, '\n'),
    'R1',
  ],
  [
    'R2 upload 的 name 漂了（artifact 名与文件名不同源）',
    (s) => s.replace('name: e2e-fix-undecided-', 'name: e2e-fix-cov-'),
    'R2',
  ],
  [
    'R2 覆盖面 artifact 写成 if-no-files-found: error（会为下游本该收敛的情况再红一次）',
    (s) => s.replace('if-no-files-found: warn', 'if-no-files-found: error'),
    'R2',
  ],
  [
    'R2 上传丢了 !cancelled()（红跑的未决清单从此看不到）',
    (s) => s.replace('if: ${{ !cancelled() }}\n        ', ''),
    'R2',
  ],
  [
    'R3 download pattern 与 upload name 对不上（下不到任何一格）',
    (s) => s.replace('pattern: e2e-fix-undecided-*', 'pattern: e2e-fix-coverage-*'),
    'R3',
  ],
  ['R4 求和那一步丢了 id:（下游静默拿到空串）', (s) => s.replace('        id: sum\n', ''), 'R4'],
  [
    'R5 🔴 接了线还写死 --undecided 0',
    (s) => s.replace('${{ steps.sum.outputs.undecided_flag }}', '--undecided 0'),
    'R5',
  ],
  /*
   * ⚠️ 这条用例**改过名字**（2026-08-17）。它此前叫「审计脚本把 JSON 键改了名」，
   *   而它做的事是把 producer 换成一个**仓里不存在的脚本** —— 命中的是
   *   "找不到写文件的脚本"那条分支，**跟改名一个字的关系都没有**。
   *   名字说 A、证据是 B，恰恰是这份文件存在要消灭的东西。
   *   用例保留（这条分支确实该有人守：查不了 ≠ 查过了），只是叫它真的在证的事；
   *   真正的"改名"反向证明在下面第 ③ 节，那里改的是源码不是 YAML。
   */
  [
    'R7 ⓘ 抠到的 producer 脚本在仓里不存在（查不了 ≠ 查过了）',
    (t) => t.replace('scripts/ci/e2e-browser-audit.mjs', 'scripts/ci/__no_such_producer__.mjs'),
    /^R7 找不到写文件的脚本/,
  ],
  [
    'R6 那个插值被加了引号（--undecided 3 变成一个 argv 词，静默退回 null）',
    (s) =>
      s.replace(
        '${{ steps.sum.outputs.undecided_flag }}',
        '"${{ steps.sum.outputs.undecided_flag }}"',
      ),
    'R6',
  ],
];

for (const [name, breakIt, wantRule] of BREAKAGES) {
  const broken = breakIt(GOOD);
  if (broken === GOOD) {
    bad(name, '这段替换什么都没改到 —— 用例本身失效了（夹具改过而替换串没跟）');
    continue;
  }
  const problems = checkWiring(extractWiring(broken));
  const hit = problems.some((p) =>
    wantRule instanceof RegExp ? wantRule.test(p) : p.startsWith(wantRule),
  );
  if (hit) ok(name);
  else {
    bad(
      name,
      `期望命中 ${wantRule}，实得：${problems.length === 0 ? '（全绿 —— 这条判据没有牙齿）' : problems.join(' / ')}`,
    );
  }
}

say('');
say('── ③ 反向证明（键改名）：这一节改的不是 YAML，是**源码里那个键** ────────────');

/*
 * ⚠️ R7 / R8 守的那两处**不在 YAML 里**：它们在写文件的那个脚本、或那段内联
 *   `node -e` 的源码里。"把键改个名"这件坏事根本没法用一段坏 YAML 表达出来 ——
 *   上一节那条叫「审计脚本把 JSON 键改了名」的用例之所以名实不符，就是因为
 *   它只能改 YAML，于是改成了"指向一个不存在的脚本"。
 *   这里改真东西：`checkWiring` 的第二个参数把源码换掉。
 */
const BROWSER_AUDIT = 'scripts/ci/e2e-browser-audit.mjs';
const REAL_PRODUCER = readFileSafe(join(REPO, BROWSER_AUDIT));

/**
 * 把源码里**代码位置**上的 `<键>:` 改个名，注释里那句原样留着 ——
 * `e2e-allcomponents.mjs` / `e2e-notes-audit.mjs` 今天就是"注释里也写着这个键"的样子。
 */
const renameKeyInCode = (src, field, to) =>
  String(src)
    .split('\n')
    .map((line) => {
      const head = line.trimStart().charAt(0);
      if (head === '*' || head === '/' || head === '#') return line;
      return line.replace(new RegExp(`([{,]\\s*)${field}(\\s*:)`, 'g'), `$1${to}$2`);
    })
    .join('\n');

/** 只替换指定路径的源码，其余照读真文件。 */
const inject = (overrides) => (rel) =>
  rel in overrides ? overrides[rel] : readFileSafe(join(REPO, rel));

const isR7Rename = (p) => p.startsWith('R7') && p.includes(`写不出 \`${SUM_FIELD}:\``);
const isR8Rename = (p) => p.startsWith('R8') && p.includes(`写不出 \`${COLLECT_FIELD}:\``);

/** 一条用例：跑一遍，要求问题清单里**有**满足 `want` 的那条。 */
const expectHit = (name, problems, want) => {
  if (problems.some(want)) ok(name);
  else {
    bad(
      name,
      `没红成期望的那条，实得：${problems.length === 0 ? '（全绿 —— 这条判据没有牙齿）' : problems.join(' / ')}`,
    );
  }
};

if (REAL_PRODUCER === null) {
  cases += 1;
  failures += 1;
  say(`  ✘ 读不到 ${BROWSER_AUDIT} —— 这一节的夹具全是空的，什么都证不了`);
} else {
  // ① 真的把 `unknowns` 改名（这正是老用例名字上说、而证据里没有的那件事）
  cases += 1;
  expectHit(
    `R7 🔴 审计脚本真的把 \`${SUM_FIELD}\` 改了名（五个文件名仍逐字对齐，R1–R6 全绿）`,
    checkWiring(
      extractWiring(GOOD),
      inject({ [BROWSER_AUDIT]: renameKeyInCode(REAL_PRODUCER, SUM_FIELD, 'undecidedCount') }),
    ),
    isR7Rename,
  );

  /*
   * ② 改了名，但**文件头注释里还写着这个键** —— 这是仓里真实存在的形状：
   *    `e2e-allcomponents.mjs:103` 与 `e2e-notes-audit.mjs:135` 的头注释里
   *    各有一句 `{ unknowns: N }`。整文件 grep 时代 R7 对这两条腿**等于不存在**。
   *    所以这条用例同时钉两件事：老判据会放过它，新判据必须红。
   */
  cases += 1;
  {
    const commented = `/**\n * 文件形状 \`{ ${SUM_FIELD}: N }\` —— 与另外几条腿逐字相同。\n */\n${renameKeyInCode(REAL_PRODUCER, SUM_FIELD, 'undecidedCount')}`;
    const naiveWouldPass = new RegExp(`\\b${SUM_FIELD}\\s*:`).test(commented); // 老的整文件 grep
    const problems = checkWiring(extractWiring(GOOD), inject({ [BROWSER_AUDIT]: commented }));
    const name = `R7 🔴 改了名、但注释里还写着 \`${SUM_FIELD}:\`（老的整文件 grep 会放过它）`;
    if (naiveWouldPass && problems.some(isR7Rename)) ok(name);
    else if (!naiveWouldPass) {
      bad(name, '夹具没搭成：那句注释连老判据都满足不了，这条用例证不了"收紧"有意义');
    } else {
      bad(name, `新判据没红 —— 一句注释仍然能喂饱 R7：${problems.join(' / ') || '（全绿）'}`);
    }
  }

  // ③ `unverified` 改名（脚本那一路：browser / notes 复用覆盖面文件）
  cases += 1;
  expectHit(
    `R8 🔴 审计脚本把 \`${COLLECT_FIELD}\` 改了名（\`${SUM_FIELD}\` 仍然对得上，R1–R7 全绿）`,
    checkWiring(
      extractWiring(GOOD),
      inject({
        [BROWSER_AUDIT]: renameKeyInCode(REAL_PRODUCER, COLLECT_FIELD, 'mutationsWithoutProof'),
      }),
    ),
    isR8Rename,
  );
}

/*
 * ★ runtime 那一种形状：变异那份清单**不是审计脚本写的**，是 workflow 里内联的
 *   `node -e` 写的，而且是**另一份文件**（`e2e-runtime.yml` 的「逐条变异」那一步）。
 *   R8 只按"找到 .mjs 再进它源码里翻"写的话，runtime 会静默地不被覆盖 ——
 *   而三条腿里只有它是这个形状。所以这份夹具单独证一次。
 */
const GOOD_INLINE = `
name: fixture-inline
on: { workflow_dispatch: {} }
jobs:
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - name: 跑审计
        run: |
          node scripts/ci/e2e-browser-audit.mjs \\
            --undecided-out "e2e-fix-undecided-\${{ matrix.label }}.json"
      - name: 落盘未验证的变异（内联 node -e，没有任何脚本文件装着这个键）
        run: |
          echo "  未验证：\${unverified:-（无）}"
          node -e '
            const fs = require("fs");
            fs.writeFileSync(process.argv[2], JSON.stringify({ ${COLLECT_FIELD}: ids }, null, 2));
          ' "\${unverified}" "e2e-fix-mut-\${{ matrix.label }}.json"
      - name: 留档
        if: \${{ !cancelled() }}
        uses: actions/upload-artifact@v6
        with:
          name: e2e-fix-undecided-\${{ matrix.label }}
          path: e2e-fix-undecided-\${{ matrix.label }}.json
          if-no-files-found: warn
  attest:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@v7
        with:
          pattern: e2e-fix-undecided-*
          path: undecided
          merge-multiple: true
      - name: 求和
        id: sum
        run: |
          node scripts/ci/sum-undecided.mjs --dir undecided \\
            --expect-labels "$PLATFORMS" \\
            --file-template 'e2e-fix-undecided-{label}.json' \\
            --github-output "$GITHUB_OUTPUT"
      - name: 汇总未验证的变异
        id: mut
        run: |
          node scripts/ci/collect-unverified-mutations.mjs --dir mut \\
            --expect-labels "$PLATFORMS" \\
            --file-template 'e2e-fix-mut-{label}.json' \\
            --github-output "$GITHUB_OUTPUT"
      - name: 写凭证
        run: |
          node scripts/ci/emit-e2e-attestation.mjs --leg fix \\
            \${{ steps.sum.outputs.undecided_flag }} --out dist/e2e-attest.json
`;

cases += 1;
{
  const problems = checkWiring(extractWiring(GOOD_INLINE));
  if (problems.length === 0) {
    say('  ✔ 内联 `node -e` 那种形状（runtime）的基准夹具是绿的 —— 否则下面两条红不作数');
  } else {
    failures += 1;
    say(`  ✘ 内联形状的基准夹具就红了：\n      ${problems.join('\n      ')}`);
  }
}

/*
 * ⚠️ 这一条同时守着那句 `echo "  未验证：${unverified:-（无）}"`：
 *   它逐字包含 `unverified:`。判据要是不认"对象键"这一层，光把 JSON 里的键改掉
 *   也不会红 —— R8 会被一句与落盘毫无关系的 echo 喂饱。
 */
cases += 1;
expectHit(
  `R8 🔴 内联 node -e 里的 \`${COLLECT_FIELD}\` 改了名（同一段 run 里还有个 \${${COLLECT_FIELD}:-…} 的 echo）`,
  checkWiring(
    extractWiring(
      GOOD_INLINE.replace(`{ ${COLLECT_FIELD}: ids }`, '{ mutationsWithoutProof: ids }'),
    ),
  ),
  isR8Rename,
);

cases += 1;
expectHit(
  `R8 🔴 改了名，只在一句 shell 注释里还写着 \`${COLLECT_FIELD}:\``,
  checkWiring(
    extractWiring(
      GOOD_INLINE.replace(`{ ${COLLECT_FIELD}: ids }`, '{ mutationsWithoutProof: ids }').replace(
        '          node -e ',
        `          # 落盘的形状：{ ${COLLECT_FIELD}: [...] }\n          node -e `,
      ),
    ),
  ),
  isR8Rename,
);

say('');
say(`── ${cases} 条，失败 ${failures} 条 ──`);
if (failures > 0) {
  say('');
  say('✘ 覆盖面管道的接线守卫**没有过关**。');
  process.exit(1);
}
say(
  `✔ 覆盖面管道：${wired.length} 条腿的九处手写都对得上` +
    `（含两个 JSON 键：\`${SUM_FIELD}\` ${wired.length} 条腿、\`${COLLECT_FIELD}\` ${mutWired.length} 条腿），` +
    '且每条判据都被证明会红。',
);
