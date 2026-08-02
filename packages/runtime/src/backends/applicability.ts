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
}

export interface ApplicabilityResult {
  applicable: boolean;
  reason: string | null;
  /** Which tier decided it — surfaced so the UI can explain, and so tests can assert. */
  tier: 'l1' | 'l2';
}

export function evaluateApplicability(input: ApplicabilityInput): ApplicabilityResult {
  const { pack, platform, backends } = input;

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

  // ---- L2: probe-gated. ----
  if (backends === null) {
    return {
      applicable: false,
      reason: '尚未探测到硬件能力；请先安装 CPU 基础包，安装后会自动重新探测',
      tier: 'l2',
    };
  }

  const status = backends.find((b) => b.id === pack.backend);
  if (status?.available !== true) {
    return {
      applicable: false,
      reason: status?.unavailableReason ?? '该后端在本机不可用',
      tier: 'l2',
    };
  }

  return { applicable: true, reason: null, tier: 'l2' };
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
): ApplicabilityResult {
  const probeNeverRan =
    hardware === null ||
    hardware.backends.every(
      (b) => !b.available && (b.unavailableReason ?? '').includes('probe'),
    );

  return evaluateApplicability({
    pack,
    platform,
    backends: probeNeverRan ? null : hardware.backends,
  });
}
