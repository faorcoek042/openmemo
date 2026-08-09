/**
 * Backend pack applicability policy. ADR-014 decision 2.
 *
 * THE BUG THIS EXISTS TO FIX — a cold-start deadlock found in T-044:
 *
 *   `applicable` required `hardware.backends[<id>].available === true`.
 *   That flag comes from the probe. The probe executable ships INSIDE the backend pack.
 *   So on a clean machine:
 *       no pack installed -> no probe -> nothing reports available -> no pack installable
 *   Every one of the four linux/x64 packs was refused, CPU included, with
 *   `probe did not complete: probe executable not found`. Charter requirement 2.1 died
 *   at step one, and it stayed hidden for a dozen rounds because every earlier
 *   verification ran on an already-provisioned machine.
 *
 * THE RULE (ADR-014, following directly from ADR-003 decision 3's L1/L2 split):
 *
 *   L1 — the CPU pack is UNCONDITIONALLY applicable.
 *        ADR-003 calls CPU the "never-fails floor", and it is also *what makes probing
 *        possible at all*. A precondition must not be gated on its own consequence.
 *
 *   L2 — accelerator packs (cuda / vulkan / rocm / metal / coreml) stay probe-gated.
 *        Installing a 678 MB CUDA pack onto a machine with no NVIDIA driver helps
 *        nobody, and by the time we evaluate L2 the probe exists (L1 brought it).
 *
 * THE SECOND DEADLOCK — ADR-014 moved it, it did not open it (T-160):
 *
 *   The sentence above, "by the time we evaluate L2 the probe exists (L1 brought it)",
 *   is true and still not enough. `BackendStatus.available` is
 *
 *       "the probe enumerated >= 1 usable device FOR THIS BACKEND"
 *
 *   and the probe can only enumerate devices of backends whose ggml shared library is
 *   already on disk — ggml dlopens `libggml-cuda.so` from the backend directory, and
 *   that file ships INSIDE the CUDA pack. So on a machine with the CPU pack installed
 *   and a real RTX 4090 present:
 *
 *       cuda pack not installed -> no libggml-cuda -> probe enumerates no CUDA device
 *         -> cuda.available === false -> cuda pack refused as "not applicable"
 *
 *   `unavailableReason` even says it out loud: "backend package not installed".
 *   T-044's deadlock was "no probe"; this one is "no library". Installing the probe
 *   does not open it. MEASURED on the live instance: every accelerator pack refused,
 *   with the CPU pack already installed.
 *
 *   THE WAY OUT is not to drop the gate — an unconditional yes would offer a 678 MB
 *   CUDA download to a machine with no NVIDIA hardware. It is that a SECOND, INDEPENDENT
 *   source of evidence already exists and was being thrown away: the ADVISORY detection
 *   (nvidia-smi / sysfs DRM / system_profiler / DXGI, see detect/gpu.ts). It does not
 *   depend on any pack being installed, which is exactly the property that breaks the
 *   cycle: A no longer requires B.
 *
 *   So the L2 rule becomes, in order:
 *     1. probe confirms a usable device      -> applicable (unchanged, strongest evidence)
 *     2. the pack is NOT installed AND advisory detection lists this backend as a
 *        candidate for hardware it actually saw -> applicable
 *        ("not installed" can never be evidence against installing — that is the cycle)
 *     3. otherwise                            -> not applicable, with the probe's reason
 *
 *   Rule 2 is bounded on both sides: it requires real hardware evidence, and it stops
 *   applying the moment the pack IS installed (from then on the probe has had its chance
 *   and its verdict stands). It is also safe by the measurement recorded at the top of
 *   manager.ts: ggml degrades gracefully when an accelerator pack turns out to be
 *   unusable — "our job is not to prevent it; it is to explain it".
 *
 * Kept as a pure function in `packages/runtime` rather than inline in the daemon so the
 * policy is unit-testable without an HTTP server, and so there is exactly one place that
 * decides it.
 */

import type { Backend, BackendStatus, HardwareInfo, OsPlatform } from '@openmemo/shared';

/** The always-installable tier. */
export const L1_BACKENDS: readonly Backend[] = ['cpu'];

/**
 * Metal is a special case that looks like L2 but behaves like L1.
 *
 * Every Mac since 10.13 has Metal — there is no driver to install and no device to
 * detect — and whisper.cpp compiles the shaders into the binary
 * (GGML_METAL_EMBED_LIBRARY), so the "Metal pack" carries no extra payload. Gating it on
 * a probe that has not run yet would reproduce the same deadlock on macOS.
 */
export function isAlwaysApplicable(backend: Backend, os: OsPlatform): boolean {
  if (L1_BACKENDS.includes(backend)) return true;
  return backend === 'metal' && os === 'darwin';
}

export interface PackDescriptor {
  id: string;
  backend: Backend;
  os: OsPlatform;
  arch: string;
}

export interface ApplicabilityInput {
  pack: PackDescriptor;
  /** Current machine. */
  platform: { os: OsPlatform; arch: string };
  /**
   * Probe-derived backend statuses. `null` means the probe has never successfully run —
   * which is the normal state of a brand-new install, not an error.
   */
  backends: BackendStatus[] | null;
  /**
   * Backends that ADVISORY detection considers plausible for hardware it actually saw
   * (`AdvisoryGpu.candidateBackends`, union over all detected GPUs).
   *
   * This is deliberately a separate input from `backends`: it is the one signal that does
   * NOT depend on any pack being installed, which is what makes it able to break the
   * install-before-you-can-detect cycle described in the file header. It is advisory in
   * the strict sense — it may never be reported as "backend X works", only as "this
   * machine has hardware for which X is a candidate".
   *
   * Omitted / empty means "we have no independent evidence", NOT "there is no GPU": with
   * no evidence the old, strict behaviour applies.
   */
  advisoryCandidates?: readonly Backend[] | undefined;
}

export interface ApplicabilityResult {
  applicable: boolean;
  reason: string | null;
  /** Which tier decided it — surfaced so the UI can explain, and so tests can assert. */
  tier: 'l1' | 'l2';
}

export function evaluateApplicability(input: ApplicabilityInput): ApplicabilityResult {
  const { pack, platform, backends } = input;
  const advisory = input.advisoryCandidates ?? [];

  // Platform match is non-negotiable for either tier: a Windows binary cannot run here
  // no matter what the probe says.
  if (pack.os !== platform.os || pack.arch !== platform.arch) {
    return {
      applicable: false,
      reason: `适用于 ${pack.os}/${pack.arch}，与本机不符`,
      tier: isAlwaysApplicable(pack.backend, pack.os) ? 'l1' : 'l2',
    };
  }

  // ---- L1: unconditional. This is the deadlock fix. ----
  if (isAlwaysApplicable(pack.backend, pack.os)) {
    return { applicable: true, reason: null, tier: 'l1' };
  }

  // ---- L2: probe-gated, with the advisory escape hatch (see file header). ----
  if (backends === null) {
    /*
     * The probe has never run. Advisory detection does not need it, so if it saw hardware
     * for which this backend is a candidate, that is real evidence and the pack is
     * installable right now — the user should not have to install the CPU pack first just
     * to be allowed to install the one they actually want.
     */
    if (advisory.includes(pack.backend)) {
      return { applicable: true, reason: null, tier: 'l2' };
    }
    /*
     * ★★ T-191：原文是「尚未探测到硬件能力；请先安装 CPU 基础包，安装后会自动重新探测」，
     *   `[用户真机实测 2026-08-09，:10000]` **两个分句在那台机器上都是假的**：
     *
     *   ① 「请先安装 CPU 基础包」—— 他早就装了（`whispercpp-cpu-linux-x64`，`integrity: ok`），
     *      照做无事可发生。真原因是他 08-02 装的是当时目录指向的**上游归档**，
     *      而**上游的包里没有我们的探针**；T-167 把同一个 id 换成了自建的那份（带探针），
     *      可"已安装"按 **id** 算，于是没人告诉他手里那份是旧的。
     *   ② 「安装后会自动重新探测」—— 当时**不会**：硬件快照的指纹只认 pack id，
     *      重装同一个 id 不改变指纹（实测：装完探针在盘上，接口照旧报
     *      `probe executable not found`，`?refresh=1` 一发才对）。
     *      这一条已由 T-191 ① 修好（指纹改成按内容），所以下面**保留**了它。
     *
     * 这里**刻意不新增输入去判断"装没装"**：本模块是纯策略函数，输入只有
     * 「探针说了什么」+「advisory 说了什么」。塞进"装了哪些包"会让它变成第二份
     * 安装状态的事实来源，而 `backends[].installed` 已经是那一份 —— 两份必然漂移。
     * 改的是措辞本身：让它在**两种状态下都成立、且都指向一个真能点的控件**。
     */
    return {
      applicable: false,
      reason:
        '尚未探测到硬件能力 —— 需要一个带 openmemo-probe 的后端包。' +
        '还没装过就先装 CPU 基础包；已经装了却仍是这一句，说明手里那份是旧版，' +
        '去「本机组件」页对它点「更新」。装好后会自动重新探测',
      tier: 'l2',
    };
  }

  const status = backends.find((b) => b.id === pack.backend);
  if (status?.available === true) return { applicable: true, reason: null, tier: 'l2' };

  /*
   * ★ THE CYCLE BREAKER.
   *
   * `available === false` while the pack is NOT installed carries no information: the
   * probe cannot enumerate a backend whose library it does not have. Refusing here is
   * refusing to install B because B is not installed. So fall back to the independent
   * signal — and only to it, so a machine with no matching hardware still gets a no.
   *
   * ★ T-168 widened the condition, and the file header above says why in its own words:
   * rule 2 "stops applying the moment the pack IS installed (from then on the probe has
   * had its chance and its verdict stands)". That premise is FALSE for an installed pack
   * the probe never loaded — `backendDir` is single-valued, so with two packs installed
   * the unselected one never gets its chance no matter how many times detection runs.
   * `probed === false` is exactly "no verdict exists", which is the same epistemic state
   * as "not installed" and must break the cycle the same way. Gating on `installed`
   * alone let a perfectly good Vulkan pack be marked not-applicable, citing a driver
   * fault that was never measured.
   */
  if ((status?.installed !== true || status.probed !== true) && advisory.includes(pack.backend)) {
    return { applicable: true, reason: null, tier: 'l2' };
  }

  return {
    applicable: false,
    reason: status?.unavailableReason ?? '该后端在本机不可用',
    tier: 'l2',
  };
}

/**
 * Convenience wrapper for callers holding a full `HardwareInfo`.
 *
 * Treats "the probe never completed" as `null` rather than as "everything unavailable":
 * the two are different states and conflating them is what produced the deadlock. A
 * `HardwareInfo` whose backends are all unavailable *with a probe failure reason* means
 * "we do not know yet", not "we know it will not work".
 */
export function isPackApplicable(
  pack: PackDescriptor,
  platform: { os: OsPlatform; arch: string },
  hardware: HardwareInfo | null,
  /**
   * Union of `AdvisoryGpu.candidateBackends`. See `ApplicabilityInput.advisoryCandidates`.
   *
   * Optional so existing callers keep compiling, but a caller that CAN supply it and does
   * not is choosing the deadlock: without it, rule 2 in the file header never fires.
   */
  advisoryCandidates?: readonly Backend[],
): ApplicabilityResult {
  /*
   * ★ 结构字段，不是字符串嗅探。
   *
   * 这里原本是 `(b.unavailableReason ?? '').includes('probe')` —— 拿**英文散文**当判据。
   * 它不是死代码（`manager.ts:217` 在 `probe.ok === false` 时确实给全部六个后端写
   * `probe did not complete: …`，`.every()` 能命中），所以它比死代码危险：**它活着，
   * 而且随时会静默失效**。
   *
   * 失效的触发条件已经在树上了：`manager.ts` 现在一共会写 7 种 `unavailableReason`，
   * **只有 1 种含 `probe` 这个词**。T-168 新增的那段（`manager.ts:237-245`，
   * "installed, but this detection run did not load it…"）就不含。任何一个后端落到
   * 新文案上，`.every()` 当场变 false，`probeNeverRan` 恒变 false。
   *
   * ⚠️ **后果有多大，是量出来的，不是推出来的**（`[实测]` 新旧两版并排跑同一组输入）：
   * **只有 `reason` 会变，`applicable` 一次都没变过。** 原因是下面那条 ★ 环打破器：
   * 探针没跑成时 `probed` 对每个后端都是 false，于是 `status.probed !== true` 恒真，
   * advisory 那条路**照样放行**。所以这不是"冷启动死锁原样回来"——
   * `closure-audit` ⛔#3 那句话高报了一格，这里按实测收窄。
   *
   * 真实后果是**用户看到的解释退化**：本该是
   * 「尚未探测到硬件能力；请先安装 CPU 基础包，安装后会自动重新探测」（可执行），
   * 退化成一串探针内部的英文（不可执行）。够格修，但不值得写成死锁。
   *
   * `probed` 是 T-168 为此加的结构字段（`shared/hardware.ts`：`available` 恒蕴含
   * `probed`），daemon 侧同族判据已经先改过了（`http/rest/backends.ts:113`
   * `status.probed !== true`），那里的注释写得很清楚：**判据必须独立于文案**。
   * 这一处是最后一个还在读散文的地方，现在两边对齐。
   */
  const probeNeverRan =
    hardware === null || hardware.backends.every((b) => !b.available && !b.probed);

  return evaluateApplicability({
    pack,
    platform,
    backends: probeNeverRan ? null : hardware.backends,
    ...(advisoryCandidates ? { advisoryCandidates } : {}),
  });
}
