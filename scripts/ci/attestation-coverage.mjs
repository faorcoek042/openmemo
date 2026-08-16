/**
 * 凭证「覆盖面」那几格**怎么念** —— 抽出来是为了能对它写证明。
 *
 * ## 为什么非抽不可
 *
 * `verify-e2e-attestation.mjs` 会下 artifact、要网络、最后 `process.exit()`，
 * **import 不进来**。于是"闸门到底把这几格念成了什么"从来没有被喂过输入 ——
 * 而 #103 那道门正是栽在这里：**字段写进了文件，却没有任何用例钉住它出现在
 * 闸门的输出里**，于是"念出来"这件事悄悄没了也没人知道。
 *
 * 这份文件只做纯字符串，`selftest-attestation-mutations.mjs` 对着它逐条断言。
 *
 * ## 🔴 `mutations` 的三态，以及**老凭证怎么读**
 *
 * `schemaVersion >= 2` 起：
 *   · `ran`             —— 跑了，且**每一条变异都有结论**；
 *   · `ran-unverified`  —— 跑了，但至少一条什么都没证明（`unverifiedMutations` 列出是哪几条）；
 *   · `skipped`         —— 整轮没跑；
 *   · `null`            —— 这条腿没接这个字段。
 *
 * `schemaVersion < 2`（或缺失）的老凭证里，`ran` 是**另一句话**：它当时的含义是
 * 「跑了且没红」，而退出码 3（跑了但什么都没证明）**不判红** —— 所以老 `ran`
 * 把两种结局合在了一起。
 *
 * ⇒ 老凭证的 `ran` 一律念成 **`legacy-ran`**：「旧语义，分不清有没有未验证的」。
 *
 * ⚠️ 这**不只是保守**，对本仓已经发出去的凭证来说它是**准确的**：
 *   `--mutations` 至今只有 `e2e-runtime.yml` 一条腿在传，而那条腿的 darwin 格
 *   从 2026-08-10 起**每一轮**都是 `M-driver-lie` 退出码 3（`libggml-metal.so`
 *   随 macOS 核心包发 ⇒ `metal.probed` 恒为 true ⇒ 前提在任何一台 Mac 上都不存在）。
 *   也就是说：**现存的每一张写着 `ran` 的老凭证，实际上都是 `ran-unverified`。**
 *   把它念成"每条都有结论"才是错的那一边。
 */

/**
 * ## 🔴 这一轴今天到底走到哪了（一句不两头夸大的话）
 *
 * > 这条轴从「**在每一条腿上都对机器消费者不可见**」，变成
 * > 「**在变异跑在独立 job 的那条腿（runtime）上仍不可见；在 browser 和 notes 上
 * > 已经落进覆盖面数、但与另一种未决混在一起，而那两条腿的 `mutations` 字段仍写着
 * > null**」—— 这是本轮开工时的状态。本轮把后半句也补上了：三条腿现在都传
 * > `mutations`，runtime 那条也把「哪几条没证明」跨过了 job 边界。
 *
 * ## ⚠️ 仍然没拆开的那一格（已知限制，别以为它是单一含义的）
 *
 * `undecided: 5` **分不出**「五条**断言**没被评估」和「五条**变异**什么都没证明」：
 * `e2e-browser-audit.mjs` / `e2e-notes-audit.mjs` 的覆盖面数把 `UNDECIDED` 与
 * `MUT-UNKNOWN` **加在了一个整数里**。而两者的补救**完全不同**：
 *   · crash 那支 ⇒ 去修**测试**（选择器 / 超时预算 / 端口）；
 *   · premise 那支 ⇒ 这台机器没条件，本来就构造不出来。
 * **控制台把它们分开列了，凭证把它们加成了一个数。**
 * `mutations` / `unverifiedMutations` 这两格补回了"哪几条变异没证明"，
 * 但 `undecided` 那个整数本身仍然是混的 —— 拆开要动 schema 更多，不在这一轮。
 */

/** 老凭证的分界线：>= 2 的 `ran` 才是「每一条都有结论」。 */
export const STRICT_RAN_SCHEMA = 2;

/**
 * 把一张凭证的 `mutations` 归一成**读得懂的那一档**。
 *
 * 返回 `'none' | 'ran' | 'ran-unverified' | 'skipped' | 'legacy-ran' | 'unknown'`。
 */
export function mutationState(cov) {
  const raw = cov?.mutations ?? null;
  if (raw === null) return 'none';
  const v = String(raw);
  if (v === 'skipped') return 'skipped';
  if (v === 'ran-unverified') return 'ran-unverified';
  if (v === 'ran') {
    const sv = Number(cov?.schemaVersion ?? 1);
    return Number.isFinite(sv) && sv >= STRICT_RAN_SCHEMA ? 'ran' : 'legacy-ran';
  }
  /*
   * 认不出来的值。**不许当成好消息** —— 一个读不懂的凭证和一张没有的凭证
   * 在"我们知道什么"这件事上是一样的。
   */
  return 'unknown';
}

/** 覆盖面那一行里 `变异=` 那一小段（`coverageText` 用）。 */
export function mutationText(cov) {
  switch (mutationState(cov)) {
    case 'none':
      return '';
    case 'skipped':
      return ' · 变异=**skipped（整轮没跑，跳过≠通过）**';
    case 'ran-unverified': {
      const n = (cov?.unverifiedMutations ?? []).length;
      return ` · 变异=**ran-unverified（${n} 条什么都没证明）**`;
    }
    case 'legacy-ran':
      return ' · 变异=**ran（旧语义凭证，分不清有没有未验证的）**';
    case 'unknown':
      return ` · 变异=**${String(cov?.mutations)}（读不懂的取值）**`;
    default:
      return ' · 变异=ran';
  }
}

/** ⚠️ `null`（没上报）与 `0`（报了，确实没有）必须说成两句不同的话。 */
export function coverageText(cov) {
  if (!cov?.ok) return `  〔覆盖面读不到：${cov?.why}〕`;
  const u =
    cov.undecided === null
      ? '未决未上报'
      : cov.undecided === 0
        ? '未决 0 条'
        : `**未决 ${cov.undecided} 条**`;
  const m =
    cov.mode === null
      ? ''
      : ` · 抽样=${cov.mode}${cov.mode === 'sample' ? '（**不是全量**）' : ''}`;
  return `  〔${u}${m}${mutationText(cov)}〕`;
}

/**
 * 「跑绿过 ≠ 全验过」那一段要念的每一行。
 *
 * ⚠️ 这里**只念，不拦**（Manager 2026-08-17 裁决：`ran-unverified` 不挡发布 ——
 * 「有一条变异在这台机器上构造不出前提」是**真实且合法**的状态，拦住它会让
 * darwin 那一格永远发不出凭证；而念出来才能让人**决定要不要去修**）。
 *
 * ⚠️ 但「不拦」的前提是**真的每一轮都念**。一个只写进文件、不出现在闸门输出里的
 * 字段，与没有这个字段是一回事 —— 所以 `selftest-attestation-mutations.mjs`
 * 钉的是**这个函数的返回值**，不是凭证文件的内容。
 */
export function coverageAdvisories(found) {
  const out = [];
  for (const f of found ?? []) {
    const cov = f?.cov;
    if (cov?.ok && typeof cov.undecided === 'number' && cov.undecided > 0) {
      out.push(`   · ${f.leg}：有 **${cov.undecided} 条断言没被验到**（无从判断）`);
    }
  }
  for (const f of found ?? []) {
    if (f?.cov?.ok && f.cov.mode === 'sample') {
      out.push(`   · ${f.leg}：抽样模式 sample —— **不是全量覆盖**`);
    }
  }
  for (const f of found ?? []) {
    const cov = f?.cov;
    if (!cov?.ok) continue;
    const st = mutationState(cov);
    if (st === 'skipped') {
      out.push(
        `   · ${f.leg}：**变异验证整轮没跑**（mutations=skipped）——` +
          ' 这条腿的断言"会不会红"本轮**没有被证明过**',
      );
    } else if (st === 'ran-unverified') {
      const ids = cov.unverifiedMutations ?? [];
      out.push(
        `   · ${f.leg}：变异跑了，但 **${ids.length} 条什么都没证明**（mutations=ran-unverified）：` +
          `${ids.join('、')} —— 它们既没被抓住、也不代表存活`,
      );
    } else if (st === 'legacy-ran') {
      out.push(
        `   · ${f.leg}：**旧语义凭证**（schemaVersion<${STRICT_RAN_SCHEMA}）——` +
          ' 那时的 `ran` 把"跑了但有条没结论"也算在内，**分不清**；' +
          '本仓现存的老凭证实测都属于后者，按"可能有未验证的"读',
      );
    } else if (st === 'unknown') {
      out.push(
        `   · ${f.leg}：**读不懂的 mutations 取值** \`${String(cov.mutations)}\` —— 别当成好消息`,
      );
    }
  }
  for (const f of found ?? []) {
    if (!f?.cov?.ok || f.cov.undecided === null) {
      out.push(`   · ${f.leg}：**没上报覆盖面**（未接线或读不到）—— 不知道等于没验过，别当成 0`);
    }
  }
  return out;
}
