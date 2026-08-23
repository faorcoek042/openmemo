/**
 * 运行时页上那几句「为什么不可用 / 为什么装不了」的**措辞总表**。
 *
 * ## 为什么这两张表住在一起，而且住在组件之外
 *
 * 它们回答的是**同一台机器上同一件事的两个问法**：
 *   · `UNAVAILABLE_REASON_KEYS` —— 硬件卡上那句「这个后端为什么用不了」；
 *   · `INAPPLICABILITY_KEYS`    —— 后端包卡片上那句「这个包为什么装不了」，
 *     而它的 `backend_unavailable` 那一档**直接复用上面那张表**（#106）。
 *
 * 复用不是省事：这两句话此前**各说各的**，一句走 `BackendUnavailableKind`
 * 的词条（#105 ③ 给七档各写了一句），另一句原样渲染 daemon 拼的中文散文
 * （`applicability.ts` 里那三句）。同一个成因在同一页上有两种说法，
 * 其中一种在英文界面上还是中文。
 *
 * ## ★★ 为什么是 `Record<全部 kind, string>`
 *
 * **总表**：契约里加一档而没人给它写话，**编译当场就红**。
 * 换成 `switch` + `default` 或 `KEYS[k] ?? ''`，新档位会静默渲染成一段空白 ——
 * 而"不可用却一个字的原因都没有"正是本仓反复清过的那一族。
 */

import type { BackendUnavailableKind, Inapplicability } from '@openmemo/shared';

/**
 * 「为什么这些后端不可用」里，每一种成因该说哪句话。**总 `Record`** ——
 * `BackendUnavailableKind` 加一档而没人给它写话，**编译当场就红**。
 *
 * ── ★★ #105 ③：为什么这一格非有不可 ─────────────────────────────────────────────
 *
 * `[闸门实测 2026-08-12，中文界面]` 这个列表逐字是：
 * ```
 * cuda：backend package not installed
 * vulkan：backend package not installed
 * rocm：backend package not installed
 * ```
 * ——**中文界面上的三条英文机器串**。而同一个列表里 metal / coreml 两条是完整中文、
 * 而且说得对（闸门逐条确认过）：那两条走的是 `platform_unsupported`，**它早就有词条**。
 * 所以这不是"没想到要翻译"，是 T-196 只给当时手上那一档写了人话，
 * 其余六档一直原样甩英文原文。
 *
 * ── 判据为什么是 `unavailableKind` 而不是那句英文 ──────────────────────────────
 * `unavailableReason` 是给排障的人看的**英文自由文本**，`manager.ts` 一共会写 7 种，
 * 改一个词、加一个括号，任何按文案分档的写法都会静默失效。
 * `BACKEND_UNAVAILABLE_KINDS` 正是 daemon 为此单列的机器可判字段，这里逐格读它。
 *
 * ── ⚠️ 「package not installed」还有第二个毛病，也在这里治 ──────────────────────
 * 那句话**召唤的动作在这台机器上到不了**：唯一对应的包就在同页折叠区里、按钮是禁用的。
 * 所以 `not_installed` 那一格不能只是把英文译成中文，它必须回答「那我现在能做什么」——
 * 指向那张卡片，并预先说清"如果那里也是灰的，卡片上写着为什么"。
 * **一句翻得很好但通向死路的话，和一句英文一样没用。**
 */
export const UNAVAILABLE_REASON_KEYS: Readonly<Record<BackendUnavailableKind, string>> = {
  platform_unsupported: 'runtime.hw.reasonPlatformUnsupported',
  probe_failed: 'runtime.hw.reasonProbeFailed',
  disabled_after_failures: 'runtime.hw.reasonDisabledAfterFailures',
  not_installed: 'runtime.hw.reasonNotInstalled',
  not_probed_this_run: 'runtime.hw.reasonNotProbedThisRun',
  no_usable_devices: 'runtime.hw.reasonNoUsableDevices',
  enumerated_none: 'runtime.hw.reasonEnumeratedNone',
};

/**
 * 「这个后端包为什么装不了」的每一种成因该说哪句话。**总 `Record`**（#106）。
 *
 * `backend_unavailable` **不在这张表里**：它整档转交给
 * {@link UNAVAILABLE_REASON_KEYS}，因为那正是同一个 `BackendUnavailableKind`。
 * 给它在这里再写一句，就是让同一个成因在同一页上有两种说法。
 */
export const INAPPLICABILITY_KEYS: Readonly<
  Record<Exclude<Inapplicability['kind'], 'backend_unavailable'>, string>
> = {
  platform_mismatch: 'runtime.pack.inapplicable.platformMismatch',
  hardware_not_probed_yet: 'runtime.pack.inapplicable.hardwareNotProbedYet',
  backend_status_missing: 'runtime.pack.inapplicable.backendStatusMissing',
};

/** `t()` 的最小形状 —— 这个模块不引 React，方便直接对它写用例。 */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * 一条 `Inapplicability` → 用户读得懂的那句话（当前语言）。
 *
 * ⚠️ **`detail` 是 daemon 的英文技术原话，这里不假装它是我们的话。**
 * 它被单独包进 `runtime.pack.inapplicable.verbatimDetail` 那句词条里
 * （「探针原文：…」），读者一眼看得出哪一段是原文。
 * 直接拼在句尾会让一段没有 i18n 的字符串冒充成产品文案 ——
 * 那与 `UpstreamFailure.upstream_error_text` 是同一条纪律。
 */
export function inapplicabilityText(t: Translate, r: Inapplicability): string {
  switch (r.kind) {
    case 'platform_mismatch':
      return t(INAPPLICABILITY_KEYS[r.kind], { os: r.packOs, arch: r.packArch });
    case 'hardware_not_probed_yet':
    case 'backend_status_missing':
      return t(INAPPLICABILITY_KEYS[r.kind]);
    case 'backend_unavailable': {
      const head = t(UNAVAILABLE_REASON_KEYS[r.unavailableKind]);
      return r.detail === null
        ? head
        : `${head} ${t('runtime.pack.inapplicable.verbatimDetail', { detail: r.detail })}`;
    }
    default:
      return assertNeverInapplicability(r);
  }
}

/**
 * 编译期穷尽性检查；**运行期不 throw**。
 *
 * 少写一条腿时 `tsc` 当场红（那是我们要的），但真跑到这一行（产品与 daemon
 * 版本错配）时，让整张运行时页崩掉是更坏的结果。返回空串 ⇒ 这张卡少一行解释，
 * 而**上面那张总表保证了这一行在编译得过的代码里不可达**。
 */
function assertNeverInapplicability(x: never): string {
  void x;
  return '';
}
