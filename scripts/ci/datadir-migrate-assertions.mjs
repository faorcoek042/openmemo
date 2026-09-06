/**
 * datadir-migrate-assertions.mjs —— C4「界面说的和实际发生的必须一致」那条判据的**本体**。
 *
 * ## 为什么它必须住在这里，而不是住在 `datadir-migrate-audit.mjs` 里
 *
 * `datadir-migrate-audit.mjs` 是**顶层执行 + `process.exit()`** 的脚本：
 * import 不进来 ⇒ **没有任何东西能喂它一份"本该判红"的输入** ⇒ 判据烂了也没人知道。
 * 这正是 `coordination/inbox/ci-guard-ablation.md:114` 那条「结构上不可测」欠账，
 * 而这条判据**已经因为它吃过一次亏**：
 *
 *   `2676e90`(2026-08-10) 把 C4 写成读 `sourceResidue` **数组** —— 当时是对的。
 *   第二天 `f21ca78`(#87) 把产品侧的 `SourceResidue` 改成三态标签联合，这里没跟着改。
 *   `Array.isArray(对象)` 恒为 false ⇒ `honest` 恒为 false ⇒ **C4 无条件 FAIL**，
 *   而 `e2e-datadir` 最后一次运行在断裂**之前**（08-09）且只能手动触发
 *   —— 于是整整一个月没有任何人知道那一格已经不工作了。
 *
 * 抽出来之后 `selftest-datadir-residue.mjs` 才能把那次事故**当夹具重放**。
 * ⚠️ **纯函数，不许 import 产品代码、不许碰磁盘。** 需要产品的文案渲染时，
 *    由调用方把 `renderAsIfEmpty()` 传进来（见下）。
 */

/**
 * 把产品回的 `sourceResidue` 归一成三态之一，**认不出来就说认不出来**。
 *
 * ⚠️ 类型的事实来源是 `apps/daemon/src/storage/move.ts` 的 `SourceResidue`：
 *   `{kind:'read',entries:string[]} | {kind:'unreadable',reason:string}`
 * .mjs 拿不到 TS 类型，所以这里只能做**运行时**形状核对 —— 改那个类型的人不会被
 * 编译器提醒，只会被这条判据在 CI 上拦住。这是这一侧能给的最强保证。
 */
export function readResidue(v) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if (v.kind === 'read' && Array.isArray(v.entries)) {
      return { kind: 'read', entries: v.entries.map(String).sort() };
    }
    if (v.kind === 'unreadable' && typeof v.reason === 'string') {
      return { kind: 'unreadable', reason: v.reason };
    }
  }
  let shown;
  try {
    shown = JSON.stringify(v);
  } catch {
    shown = String(v);
  }
  return { kind: 'unknown-shape', shown: shown ?? String(v) };
}

/**
 * C4 的判据本体：**源没删干净时，界面说的必须和磁盘上真实剩下的一致。**
 *
 * @param {object}   a
 * @param {unknown}  a.residue           产品回的 `sourceResidue`（原样，不预处理）
 * @param {string}   a.msg               真正上屏的那句话
 * @param {string[]} a.onDisk            磁盘上**真实**剩下的顶层条目
 * @param {() => string} a.renderAsIfEmpty
 *        用产品自己的格式化函数渲染「我看了，是空的」那一句。
 *        只在 `unreadable` 分支用到 —— 判据不比措辞，比的是"这句话是不是那一句"。
 * @returns {{ kind: string, honest: boolean, why: string }}
 */
export function judgeResidueHonesty({ residue, msg, onDisk, renderAsIfEmpty }) {
  const res = readResidue(residue);
  const disk = [...onDisk].map(String).sort();

  if (res.kind === 'read') {
    /*
     * 「我看了」⇒ 名单要**同时**对得上磁盘和文案，三个方向都查：
     *   · 文案里没念到的  ⇒ 用户不知道旧位置还有东西（就是 2026-08-08 那次事故）
     *   · 报告里漏掉的    ⇒ 结构化字段自己就少报了
     *   · 报告里多说的    ⇒ 让用户去找一个**不在那里**的文件。
     *     `storage.ts` 的 `moveMessageZh` 注释里记着这个实例：那句话曾无条件写
     *     「其中包含 secrets.json」，而实际它已经被删掉了。**保守的假话仍然是假话。**
     */
    const unspoken = disk.filter((n) => !msg.includes(n));
    const unnamed = disk.filter((n) => !res.entries.includes(n));
    const overspoken = res.entries.filter((n) => !disk.includes(n));
    return {
      kind: res.kind,
      honest: unspoken.length === 0 && unnamed.length === 0 && overspoken.length === 0,
      why:
        `残留(产品报告)=${res.entries.join('、') || '(空)'}\n` +
        `残留(磁盘实况)=${disk.join('、') || '(空)'}\n` +
        `文案没念到的=${unspoken.join('、') || '无'}  ` +
        `报告漏掉的=${unnamed.join('、') || '无'}  ` +
        `报告多说的=${overspoken.join('、') || '无'}`,
    };
  }

  if (res.kind === 'unreadable') {
    /*
     * 「我没能看」⇒ **这不是缺陷，不许判红**。念不出残留在这种情形下正是**正确行为**，
     * 把它算成 FAIL 就是把「我们不知道」当成「产品坏了」—— 而那恰恰是 `f21ca78`(#87)
     * 当初改这个类型要治的病。别在治它的地方又犯一次。
     *
     * 但界面**必须说出它不知道**。判据不去比措辞（一改文案就假红），
     * 而是用产品自己的格式化函数**现算一句**「我看了，是空的」出来，
     * 要求真正上屏的那句**不等于**它。纯数据判据，句子怎么重写都成立。
     */
    const asIfEmpty = renderAsIfEmpty();
    return {
      kind: res.kind,
      honest: msg !== asIfEmpty,
      why:
        `旧目录读不到（${res.reason}）—— 「我不知道」本来就该被说出来，这不算缺陷。\n` +
        `判据：这句话不许和「我看了，是空的」那一句相同。\n` +
        `与「已经空了」那句相同吗=${
          msg === asIfEmpty ? '相同(!!这就是 #87 治的那个塌陷)' : '不同(正确)'
        }`,
    };
  }

  /*
   * 形状不认识 ⇒ **照样红**（把 `f21ca78` 重放一遍仍然会红，这一点没有放松），
   * 但红的那句话要指着**这个脚本**，而不是指着产品。
   * **判红和判红的理由是两件事** —— 一条说错了原因的红，会把下一个人送去修一个没坏的东西。
   */
  return {
    kind: res.kind,
    honest: false,
    why:
      `⚠️⚠️ **这条 FAIL 是本审计脚本的判据过时了，不是产品坏了。别去修产品。**\n` +
      `没见过的 sourceResidue 形状：${res.shown}\n` +
      `判据认的是 apps/daemon/src/storage/move.ts 里的 SourceResidue 三态：\n` +
      `  {kind:'read',entries:string[]} | {kind:'unreadable',reason:string}\n` +
      `谁改了那个类型，请同步改 scripts/ci/datadir-migrate-assertions.mjs 的 readResidue()。`,
  };
}
