#!/usr/bin/env node
/**
 * 把 `pnpm -r --no-bail test` 的 TAP 输出解析成**失败用例集合**。
 *
 * 单独成文件是因为它要被两个地方用：`xplat-ratchet.mjs`（真判决）和
 * `selftest-xplat-ratchet.mjs`（反向验证，喂真实 CI 日志当夹具）。
 *
 * ## ⚠️ 自检那一半**不在这里** —— 刻意的
 *
 * `run-selftests-all.mjs` 现在直接吐一份 JSON（`--json <path>`），棘轮读 JSON。
 * 一开始这里是有一个"从汇总区刮结果"的解析器的，它**当场踩了自己要治的坑**：
 * `══ 汇总（` 这个锚点在 `selftest-ci-manifest` 的输出里也出现，于是刮到了
 * **另一个脚本的汇总**，报出 "16 环" 而真值是 37 —— 而且它不会红，只会少数几条。
 * 能自己产出结构化结果的东西，就不该去刮它的人类可读输出。
 *
 * ## 为什么只收**叶子**失败
 *
 * `node --test` 的 TAP 对一个失败用例会打印**多条** `not ok`：叶子一条，
 * 每一层祖先套件各一条。祖先那几条的 `failureType` 是 `subtestsFailed` ——
 * 不是新信息，是同一件事的回声。全收会让"一条用例坏了"在基线里变成三四条，
 * 修好它时又要一次删掉三四条，基线于是开始漂。
 *
 * 判据用 `failureType`：
 *   · `subtestsFailed`  ⇒ 祖先的回声，**丢掉**
 *   · 其它（`testCodeFailure` / `cancelledByParent` / `hookFailed` …）⇒ 叶子，**收**
 *
 * `[实测校准]` 对着两份真 CI 日志跑：win32 收到 42 条叶子，而 `# fail` 合计正好 42；
 * darwin 收到 5 条，`# fail` 合计正好 5。两边都对得上才算解析对了 ——
 * 这条交叉核对写成了 `selftest-xplat-ratchet.mjs` 的一条断言，不是一次性的手工比对。
 *
 * ## 为什么 id 是「包 › 祖先链 › 叶子名」
 *
 * 只用叶子名会撞（"★反向：exit 1" 这种名字满仓都是）。带上祖先链之后 id 既唯一
 * 又能被人一眼读懂 —— 基线是给人看的，不是给机器对哈希的。
 *
 * ⚠️ 祖先链要从 `# Subtest:` 行建，**不能**从 `ok` / `not ok` 行建：
 *    TAP 里套件的 `ok` 行打在它**所有子节点之后**，拿它当"入栈"会把上一个
 *    已经结束的兄弟当成父亲。第一版就是这么写的，于是把
 *    `#77 finding① self-lock` 底下那条记成了 `DB 与队列接入 › …`。
 */

/** `# Subtest: NAME` —— 这才是"进入一层"。 */
const SUBTEST = /^(?<indent>\s*)# Subtest: (?<name>.*)$/;
/** `ok N - NAME` / `not ok N - NAME` —— 这是"离开一层"。 */
const RESULT = /^(?<indent>\s*)(?<not>not )?ok \d+ - (?<name>.*)$/;
const FAILURE_TYPE = /^\s*failureType:\s*'?(?<t>[A-Za-z]+)'?\s*$/;
/** `pnpm -r` 给每一行加的前缀：`packages/pipeline test: `。 */
const PKG_PREFIX = /^(?<pkg>[\w./@-]+) test:\s?/;
const PASS_COUNT = /^# pass (?<n>\d+)$/;
const FAIL_COUNT = /^# fail (?<n>\d+)$/;
/** CI 日志每行前面那截时间戳。 */
const TS = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/;

/**
 * @param {string} text `pnpm -r --no-bail test` 的完整输出（可含 CI 时间戳前缀）
 * @returns {{failures:string[], packages:Record<string,{pass:number,fail:number}>, totalPass:number, totalFail:number}}
 */
export function parseTestLog(text) {
  const lines = String(text).split(/\r?\n/);
  /** @type {string[]} */
  const failures = [];
  /** @type {Record<string,{pass:number,fail:number}>} */
  const packages = {};
  // pnpm 会把多个包的行交错输出，所以每个包各有自己的一棵树。
  /** @type {Map<string, {indent:number,name:string}[]>} */
  const stacks = new Map();
  /** @type {{pkg:string,id:string}|null} */
  let pending = null;

  for (const raw of lines) {
    const line = raw.replace(TS, '');
    const pm = PKG_PREFIX.exec(line);
    if (!pm) {
      pending = null;
      continue;
    }
    const pkg = pm.groups.pkg;
    const body = line.slice(pm[0].length);

    const pc = PASS_COUNT.exec(body);
    if (pc) {
      packages[pkg] ??= { pass: 0, fail: 0 };
      packages[pkg].pass += Number(pc.groups.n);
      pending = null;
      continue;
    }
    const fc = FAIL_COUNT.exec(body);
    if (fc) {
      packages[pkg] ??= { pass: 0, fail: 0 };
      packages[pkg].fail += Number(fc.groups.n);
      pending = null;
      continue;
    }

    // 还在等 failureType 的那条 not ok：这一行可能是它的诊断块。
    if (pending && pending.pkg === pkg) {
      const ft = FAILURE_TYPE.exec(body);
      if (ft) {
        if (ft.groups.t !== 'subtestsFailed') failures.push(pending.id);
        pending = null;
        continue;
      }
    }

    const st = SUBTEST.exec(body);
    if (st) {
      const indent = st.groups.indent.length;
      const stack = stacks.get(pkg) ?? [];
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, name: st.groups.name.trim() });
      stacks.set(pkg, stack);
      pending = null;
      continue;
    }

    const rs = RESULT.exec(body);
    if (!rs) continue;
    const indent = rs.groups.indent.length;
    const stack = stacks.get(pkg) ?? [];
    // 祖先 = 比这一层更浅的那些（这条 `ok` 关掉的正是与它同深的那一层）。
    const chain = stack.filter((s) => s.indent < indent).map((s) => s.name);
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    stacks.set(pkg, stack);
    pending = rs.groups.not
      ? { pkg, id: [pkg, ...chain, rs.groups.name.trim()].join(' › ') }
      : null;
  }

  const totalPass = Object.values(packages).reduce((a, b) => a + b.pass, 0);
  const totalFail = Object.values(packages).reduce((a, b) => a + b.fail, 0);
  return { failures, packages, totalPass, totalFail };
}
