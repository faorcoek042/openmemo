/**
 * Which backends did a probe run actually have the chance to load?
 *
 * ── The defect this exists to remove (T-168) ──────────────────────────────────────────
 *
 * `backendDir` is SINGLE-VALUED. One probe run calls
 * `ggml_backend_load_all_from_path(backendDir)` exactly once, and ggml only dlopens
 * `ggml-<name>-<variant>.{so,dll,dylib}` out of that one directory. So when two backend
 * packs are installed, the probe sees one of them and is structurally blind to the other.
 *
 * `buildHardwareInfo` used to read that blindness as evidence:
 *
 *     installed && no devices enumerated  ->  "driver missing or too old"
 *
 * which is only sound if the probe actually looked. MEASURED on this box with both Linux
 * packs really installed and `prefs.selectedBackend = "cpu"`:
 *
 *     $ openmemo-probe <cpu pack dir>     2>&1 >/dev/null
 *     load_backend: loaded CPU backend from .../libggml-cpu-zen4.so
 *                                                     ^ no Vulkan line: never loaded
 *     $ openmemo-probe <vulkan pack dir>  2>&1 >/dev/null
 *     ggml_vulkan: No devices found.
 *     load_backend: loaded Vulkan backend from .../libggml-vulkan.so
 *
 * Both runs reported `vulkan: available=false, "installed but enumerated no devices
 * (driver missing or too old)"`. In the first run that sentence is false — the Vulkan
 * pack is fine, it simply was not the selected one — and it is specific enough that the
 * user believes it and goes to fix a driver that was never broken.
 *
 * ── Why a directory listing is the right test ─────────────────────────────────────────
 *
 * It answers exactly the question the reason ladder needs, and nothing more:
 *
 *   library present, no devices  ->  the backend loaded (or failed to dlopen for a
 *                                    missing driver library like libcuda.so.1) and came
 *                                    back empty. A driver/hardware verdict is EARNED.
 *   library absent               ->  the backend could not possibly have been loaded.
 *                                    No verdict exists. Say that, and say nothing else.
 *
 * The alternative — teaching `probe.c` to report `ggml_backend_reg_name()` for every
 * loaded registry — is strictly better information, but it is not available today: the
 * probe binary ships INSIDE the published pack archives, so a probe change only reaches
 * users through a rebuild + a new release, and every already-shipped pack would still
 * answer the old way. A directory listing needs neither, and it is a superset in one
 * respect: it is also correct for a backend whose library is present but fails to dlopen.
 * If `ProbeOutput` ever grows a `backendsLoaded` field, prefer it and keep this as the
 * fallback for old packs.
 */

import { readdir } from 'node:fs/promises';
import type { Backend } from '@openmemo/shared';

import { backendFromRegName } from '../backends/manager.js';

/**
 * ggml backend library filename -> the ggml registry name it provides.
 *
 * Handles every shape actually observed in the shipped packs (verified against the real
 * archives, not guessed):
 *
 *   libggml-cpu-zen4.so       -> "cpu"      (variant suffix after the backend name)
 *   libggml-vulkan.so         -> "vulkan"
 *   libggml-base.so.0.15.1    -> "base"     (-> not a user-facing backend, dropped)
 *   ggml-cuda.dll             -> "cuda"     (Windows, no lib prefix)
 *   libggml-metal.dylib       -> "metal"
 *   libggml.so.0              -> null       (the core library, not a backend)
 *   libwhisper.so.1.9.1       -> null
 *
 * Deliberately NOT a fixed filename list: ggml backend libraries carry version numbers
 * and ISA variants, and this repo has already paid for hardcoded model/binary names four
 * separate times (`ggml-silero-v6.2.0.bin`, `probe` vs `openmemo-probe`, ...).
 */
export function ggmlRegNameFromFileName(fileName: string): string | null {
  const base = fileName.replace(/^lib/i, '');
  // Strip the extension and any trailing version segments: ".so.0.15.1", ".dylib", ".dll"
  const stem = base.replace(/\.(so|dylib|dll)(\.\d+)*$/i, '');
  if (stem === base) return null; // no recognised extension -> not a shared library
  const m = /^ggml-([A-Za-z0-9]+)/.exec(stem);
  return m === null ? null : m[1].toLowerCase();
}

/**
 * The backends whose ggml library sits in `backendDir` — i.e. the ones a probe run over
 * that directory could actually load.
 *
 * Returns an EMPTY set when the directory cannot be read. That is the honest answer:
 * "we have no evidence any backend was loadable", which downstream turns into "no
 * verdict", never into "your driver is broken".
 */
export async function probedBackendsInDir(backendDir: string): Promise<Set<Backend>> {
  const out = new Set<Backend>();
  let entries: string[];
  try {
    entries = await readdir(backendDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const reg = ggmlRegNameFromFileName(name);
    if (reg === null) continue;
    const backend = backendFromRegName(reg);
    if (backend !== null) out.add(backend);
  }
  return out;
}
