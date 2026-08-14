/**
 * `e2e-runtime-audit.mjs` 里**判据本身**的那几行 —— 抽出来是为了能对它写证明。
 *
 * ## 为什么非抽不可（#106 顺带抓到的一条）
 *
 * `e2e-runtime-audit.mjs` 有 2800 行、全程顶层执行、最后 `process.exit()`，
 * **import 不进来**。于是它内部的判据一条都没法被喂输入 —— 而这一轮抓到的正是
 * 那种后果：
 *
 * ```js
 * // e2e-runtime-audit.mjs（修复前）
 * /先安装 CPU/.test(String(p.inapplicableReason ?? ''))
 * ```
 *
 * 这个正则匹配的是 **T-191 之前**的文案。现文案是「还没装过就**先装** CPU 基础包」——
 * `先安装 CPU` ≠ `先装 CPU`，所以它**从 T-191 那天起就再也没有匹配过任何东西**。
 * 一条恒不触发的检测：产品真的退化回那个 bug，它也不会说一个字。
 *
 * ★ 这是本周在清的第①类失效：**断言的东西在缺陷状态下也成立** ——
 *   只不过这里的"成立"是"恒为假 ⇒ 恒不报告"。
 *
 * ## 判据现在读结构
 *
 * `inapplicability.kind === 'hardware_not_probed_yet'`（`packages/shared/src/hardware.ts`
 * 的 `Inapplicability`）。**不是改成读那句英文** —— 那只是把"读中文散文"换成
 * "读英文散文"，下次措辞一动照样漂。本仓在拿散文当判据上已经栽过两次
 * （`unavailableReason` 那两条，`applicability.ts` 与 `rest/backends.ts` 各一处）。
 *
 * 证明在 `scripts/ci/selftest-e2e-runtime.mjs`：把这里的结构判据抽掉，那边当场红。
 */

/**
 * `Inapplicability` 里「还没探测到硬件能力」那一格的 kind。
 *
 * ⚠️ 与 `packages/shared/src/hardware.ts` 是**同一个字面量**，而这份文件是
 * `.mjs`、拿不到 TS 的类型检查。所以 `selftest-e2e-runtime.mjs` 里有一条
 * **契约漂移守卫**：这个字面量必须真的还在那个联合类型里。
 * 少了它，这条检测就会退回"恒不触发"——正是本次要修的那个形状。
 */
export const NOT_PROBED_YET_KIND = 'hardware_not_probed_yet';

/**
 * 这条目录条目是不是在说「**先去装 CPU 基础包，装完才测得出来**」。
 *
 * 用途只有一个：`e2e-runtime-audit.mjs` 拿它找出**用户刚装完 CPU 基础包、
 * 目录却仍然叫他去装 CPU 基础包**的那些条目 —— 一句让人去做他刚做完的事的话。
 *
 * ⚠️ 只认结构，**一个字符串都不匹配**。
 */
export function saysHardwareNotProbedYet(pack) {
  return pack?.applicable === false && pack?.inapplicability?.kind === NOT_PROBED_YET_KIND;
}

/**
 * 上面那条 + 「daemon 已经明确把它归到『还没测出来』那一档」。
 *
 * 两格由 daemon 的**同一次判断**同时产出（`rest/backends.ts` 的 `applicability()`），
 * 所以同时要求它们并不是重复：`inapplicableKind` 是给界面分档 / 排序用的粗分，
 * `inapplicability.kind` 是「具体卡在哪」。重启之后那一问要的是**两格都还这么说**，
 * 只中一格说明其中一格漂了，那本身就值得看见。
 */
export function stillSaysHardwareNotProbedYet(pack) {
  return saysHardwareNotProbedYet(pack) && pack?.inapplicableKind === 'undetermined';
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 卸载：把「记录没了」与「字节没了」分开问（#110）                              */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 卸载之后，**盘上的字节**与产品**自己那句话**对不对得上。
 *
 * ## 这条判据要补的洞
 *
 * `A-UNINSTALL-GONE` 钉的三格全是**记录**：DELETE 回没回 204、id 还在不在
 * `/api/backends/installed`、盘上那份 `manifests/backend/<id>.json` 还在不在。
 * PR #52 补的三条牙齿也都在这一层。**从头到尾没有一格问过"字节"。**
 *
 * 「记录点名的文件还在不在」与「models/ 树真的少了多少字节」其实**早就在量了**
 * （`e2e-runtime-audit.mjs` 的 `leftovers` / `realDelta`），但两者都只喂
 * `finding()` —— 那是一条**不改退出码**的通报。也就是说：一个包可以回 204、
 * 从列表里消失、连安装记录都删掉，而**一个字节都没走**，`A-UNINSTALL-GONE`
 * 照样绿，CI 照样过。量是量了，**没有任何东西拿它判过**。
 *
 * ## 为什么 PR #55 之后更要紧
 *
 * `#107`/`#55` 之后 DELETE 多了一条**合法**路径：记录删掉了、而某些文件因**越界**
 * 被拒绝删除 ⇒ `200 + filesNotRemoved`。于是「id 消失了」离「东西真的没了」
 * 比以前更远 —— 现在连产品自己都承认这两件事可以不一致。
 *
 * ## 判据是什么
 *
 * **不是**「盘上必须干净」，而是「**产品那句话必须与盘对得上**」：
 *
 *   · 204（干净卸载）⇒ 记录点名的文件**一个都不许还在**；
 *   · 200 + `filesNotRemoved` ⇒ 被点名的那些**必须还在**（说没删就得真没删），
 *     **没被点名的必须没了**（没说的就得真删掉），且每条拒绝都要**说得出理由**。
 *
 * 两个方向缺一不可，这也正是本条最容易被绕过的地方：
 *   · 只查①「该走的走了」⇒ 产品把所有文件都报成 `refused`、一个不删，照样过
 *     （`expectCleanRemoval` 就是为堵这一路而存在）；
 *   · 只查②「该留的留了」⇒ 产品什么都不删、什么都不报，照样过。
 *
 * ## 为什么用「对得上」而不是「盘上必须干净」
 *
 * `apps/daemon/src/http/rest/state.ts` 的 `dropInstalledFiles()` 里那句
 * `await fs.rm(abs, { force: true }).catch(() => undefined)` 把 **rm 的失败吞掉了**，
 * 而且吞掉之后照样 `removed += 1`。Windows 上一个被占住的句柄就足以走到
 * 「rm 静默失败 → 回 204 → 文件还在」。拿「盘上必须干净」当判据，在那台 runner 上
 * 会换来一条随机变红、然后没人再信的断言（`e2e-runtime-audit.mjs` 里那段注释
 * 说的就是这件事，它是对的）。
 *
 * 所以判据问的是**一致性**，并且调用方在 win32 上把结论降级成 `unknown()` ——
 * 三态里的第三态，不是绿。这不是把问题绕开：Linux 腿上判据全额生效，
 * 而变异矩阵（`.github/workflows/e2e-runtime.yml`）本来就只在 Linux 上跑全量变异。
 *
 * @param {object} a
 * @param {number} a.status        DELETE 的 HTTP 状态码
 * @param {Array<{name?: string, reason?: string}>|null|undefined} a.filesNotRemoved
 *        200 那条路的 `body.filesNotRemoved`；204 应当没有
 * @param {Array<{name: string, path: string}>} a.declared
 *        **删之前**盘上那份安装记录点名的文件（名字 + 解析出来的绝对路径）
 * @param {ReadonlyArray<string>} a.stillOnDisk
 *        卸载后仍然存在的那些绝对路径 —— 地面真相，`existsSync` 出来的，不是产品自述
 * @param {boolean} [a.expectCleanRemoval]
 *        这个包是不是**本来就该被干净删掉**（审计自己装进 store 的包按定义在界内）。
 *        为真时，任何拒绝、任何非 204 都是失败 —— 否则「把删除整个禁掉、
 *        再把每个文件都报成 refused」会满足上面所有一致性检查。
 * @returns {{ok: boolean, reason: string, undecidable?: boolean}}
 */
export function checkUninstallReachedDisk({
  status,
  filesNotRemoved,
  declared,
  stillOnDisk,
  expectCleanRemoval = false,
}) {
  const refused = Array.isArray(filesNotRemoved) ? filesNotRemoved : [];
  const decl = Array.isArray(declared) ? declared : [];

  /*
   * 前提：记录没点名任何**解析得出路径**的文件，这条判据就问不出东西来。
   * `source: 'bundled'` 的记录按设计就是这样（files[] 三个路径字段全缺，
   * 让"删掉应用本体"在形状上不可能）。这时候必须是 UNKNOWN —— 报绿等于
   * 又造一句关于空集的废话，而那正是 PR #52 花力气拆掉的东西。
   */
  if (decl.length === 0) {
    return {
      ok: false,
      undecidable: true,
      reason:
        '删之前那份安装记录没点名任何可解析路径的文件（bundled 包按设计就是这样）——' +
        '「字节还在不在」在这里问不出来，不是绿',
    };
  }

  const onDisk = new Set(stillOnDisk ?? []);
  const refusedNames = new Set(refused.map((r) => String(r?.name ?? '')));

  /* ── 形状先对：状态码与 filesNotRemoved 必须自洽 ────────────────────────── */
  if (status === 204 && refused.length > 0) {
    return {
      ok: false,
      reason: `DELETE 回 204（"全删干净了"）却同时带着 ${String(refused.length)} 条 filesNotRemoved —— 两句话互相矛盾`,
    };
  }
  if (status === 200 && refused.length === 0) {
    return {
      ok: false,
      reason:
        'DELETE 回 200 却没有 filesNotRemoved —— 200 这条路存在的理由就是"有东西没删成"，空着说明契约漂了',
    };
  }
  if (status !== 200 && status !== 204) {
    return { ok: false, reason: `DELETE 回 HTTP ${String(status)}，既不是干净卸载也不是"有拒绝"` };
  }

  /*
   * ★ 这一格堵的是「把删除整个禁掉」：一个界内的包不该有任何拒绝。
   *   没有它，产品只要把每个文件都塞进 filesNotRemoved，
   *   下面两个方向的一致性检查就全都**真的成立**了 —— 而一个字节都没删。
   */
  if (expectCleanRemoval && (status !== 204 || refused.length > 0)) {
    return {
      ok: false,
      reason:
        `这个包是审计自己装进 store 的（按定义在界内），本该被干净删掉，` +
        `实际 HTTP ${String(status)}、拒绝了 ${String(refused.length)} 个文件：` +
        refused
          .map((r) => `${String(r?.name ?? '?')}（${String(r?.reason ?? '没给理由')}）`)
          .join('；'),
    };
  }

  /* ── 每条拒绝都要说得出理由 ─────────────────────────────────────────────── */
  const mute = refused.filter((r) => !String(r?.reason ?? '').trim());
  if (mute.length > 0) {
    return {
      ok: false,
      reason:
        `filesNotRemoved 里有 ${String(mute.length)} 条没写 reason：` +
        `${mute.map((r) => String(r?.name ?? '(连名字都没有)')).join('、')} ——` +
        '「拒绝」说不出为什么，就跟没说一样（#107 补 reason 就是为了这个）',
    };
  }
  const nameless = refused.filter((r) => !String(r?.name ?? '').trim());
  if (nameless.length > 0) {
    return {
      ok: false,
      reason: `filesNotRemoved 里有 ${String(nameless.length)} 条没写 name —— 没法对到盘上任何一个文件`,
    };
  }

  /* ── 方向①：产品说删掉了的，盘上必须真的没了 ───────────────────────────── */
  const claimedGone = decl.filter((f) => !refusedNames.has(f.name));
  const stillThere = claimedGone.filter((f) => onDisk.has(f.path));
  if (stillThere.length > 0) {
    return {
      ok: false,
      reason:
        `产品没说这 ${String(claimedGone.length)} 个文件删不掉（HTTP ${String(status)}），` +
        `但其中 ${String(stillThere.length)} 个**字节还在盘上**：` +
        `${stillThere
          .slice(0, 5)
          .map((f) => f.path)
          .join('、')}` +
        `${stillThere.length > 5 ? ' …' : ''} —— ` +
        'T-192 的形状：记录走了、字节留着。`by-name/backend/` 还是 `findInBackendPacks()` 的发现路径，' +
        '一个"已卸载"的包仍然会被解析到并真的跑起来',
    };
  }

  /* ── 方向②：产品说没删的，盘上必须真的还在 ─────────────────────────────── */
  const claimedKept = decl.filter((f) => refusedNames.has(f.name));
  const vanished = claimedKept.filter((f) => !onDisk.has(f.path));
  if (vanished.length > 0) {
    return {
      ok: false,
      reason:
        `filesNotRemoved 声称这 ${String(claimedKept.length)} 个文件"没删"，` +
        `但其中 ${String(vanished.length)} 个**盘上已经不见了**：` +
        `${vanished
          .slice(0, 5)
          .map((f) => f.path)
          .join('、')} —— ` +
        '要么越界检查是摆设（照删不误，只是嘴上说拒绝），要么这份报告是编的。两种都比沉默更坏',
    };
  }

  const keptDesc =
    claimedKept.length > 0 ? `，另有 ${String(claimedKept.length)} 个如实报了"没删"且确实还在` : '';
  return {
    ok: true,
    reason:
      `记录点名 ${String(decl.length)} 个文件：产品声称删掉的 ${String(claimedGone.length)} 个` +
      `**盘上确实都没了**${keptDesc}`,
  };
}
