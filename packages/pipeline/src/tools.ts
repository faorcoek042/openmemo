/**
 * Tool resolution.
 *
 * Every native tool this package drives is an absolute path supplied by the caller —
 * never a bare command name resolved through PATH. Two reasons:
 *   1. D-01 §8.4 L2: a PATH lookup is an injection vector (a hostile `ffmpeg` earlier in
 *      PATH wins). We always spawn an absolute path we chose.
 *   2. ADR-001 class C: these binaries are runtime downloads under our managed runtime
 *      directory, not system packages. Their location is ours to know.
 *
 * `discoverTools` exists for tests and local development only; production wiring passes
 * paths explicitly from the installed-pack records.
 */

import { access, constants, cp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, relative } from 'node:path';

import { isGgmlModelFile } from '@openmemo/downloader';

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  /** whisper.cpp CLI, from the L1 core pack built by scripts/build-whisper.sh. */
  whisperCli: string | null;
  /** whisper.cpp VAD segmenter, also from the L1 core pack. */
  whisperVad: string | null;
  /**
   * Silero VAD weights **in ggml format** — the only thing whisper.cpp's VAD can load.
   *
   * NOT "any installed model whose role is vad": the catalog also ships
   * `silero_vad.onnx` for sherpa-onnx, and its own description says whisper.cpp cannot
   * load it. Whoever fills this field owes the reader that guarantee (T-148).
   */
  vadModel: string | null;
  /**
   * yt-dlp. Nullable BY DESIGN — TD-002 requires the product to work without it.
   * Nothing outside media/sources/ytdlp.ts may read this field.
   */
  ytDlp: string | null;
}

export interface ManagedDirs {
  /** Scratch space for downloads and intermediate audio. Never the user's home. */
  tempDir: string;
  /** Where installed runtime packs live. */
  runtimesDir: string;
  /** Where models live. */
  modelsDir: string;
}

export async function isExecutable(path: string | null | undefined): Promise<boolean> {
  if (path === null || path === undefined || path.length === 0) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fileExists(path: string | null | undefined): Promise<boolean> {
  if (path === null || path === undefined || path.length === 0) return false;
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE single definition of where installed artifacts live.
 *
 * ── Why this takes an explicit `dataDir` (D-08 D4) ────────────────────────────────────
 * The earlier version derived everything from environment variables. That works when the
 * daemon is started via `OPENMEMO_DATA_DIR`, and silently breaks when it is started with
 * `--data-dir`: the daemon installs into `<flag-dir>/models` while `discoverTools()` goes
 * looking under the platform default and finds nothing. The user sees "installed
 * successfully" followed by "not installed" — the exact bug T-042 fixed for the default
 * directory and did NOT fix for a non-default one.
 *
 * So callers that know the data directory MUST pass it. The env/platform fallback is only
 * for standalone use (CLI tools, tests) where nobody knows better.
 *
 * ── Windows: APPDATA, not LOCALAPPDATA (D-08 D3) ──────────────────────────────────────
 * There were three derivations of this path and they disagreed: the daemon's
 * `config/paths.ts` used `%APPDATA%` while this file and `@openmemo/downloader`'s
 * `store.ts` used `%LOCALAPPDATA%`. On Windows that means the downloader writes to
 * `…\Local\OpenMemo\models` and the pipeline searches `…\Roaming\OpenMemo\models` —
 * an installed pack could never be found, on every Windows machine, always.
 *
 * The daemon's `paths.ts` is canonical (D-02 §6.1 defines the data dir), so this now
 * follows APPDATA. Note that with `resolveStoreRoot(dataDir)` wired through, this
 * fallback is not reached on the daemon path at all — which is the real fix; matching the
 * constant is belt and braces.
 */
export function resolveStoreRoot(dataDir?: string): string {
  const explicit = process.env['OPENMEMO_MODELS'];
  if (explicit !== undefined && explicit.length > 0) return explicit;

  if (dataDir !== undefined && dataDir.length > 0) return join(dataDir, 'models');

  const envDataDir = process.env['OPENMEMO_DATA_DIR'];
  if (envDataDir !== undefined && envDataDir.length > 0) return join(envDataDir, 'models');

  const home = homedir();
  if (process.platform === 'win32') {
    // APPDATA (Roaming) — matches apps/daemon/src/config/paths.ts, the canonical source.
    return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'OpenMemo', 'models');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'OpenMemo', 'models');
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'openmemo', 'models');
}

/** @deprecated Pass the data directory explicitly via {@link resolveStoreRoot}. */
export function defaultStoreRoot(): string {
  return resolveStoreRoot();
}

/**
 * Find an executable inside an installed backend pack.
 *
 * Layout comes from `@openmemo/downloader`'s ArtifactStore:
 *     <storeRoot>/by-name/backend/<name>                              (pack = one binary)
 *     <storeRoot>/by-name/backend/<archive-basename>/[<nested>/]<binary>   (pack = archive)
 *
 * The nested level exists because upstream archives carry their own top-level directory
 * (whisper.cpp's Linux tarball unpacks to `whisper-bin-ubuntu-x64/`), so a fixed depth
 * would miss it. We scan two levels, newest first, and take the first hit.
 *
 * ── Why the FLAT case is checked too ──────────────────────────────────────────────────
 * `ArtifactStore.linkByName()` hardlinks every installed file to
 * `by-name/<kind>/<name>`, and only files with `unpack` set additionally get expanded
 * into a directory. So a pack whose payload is a standalone executable — yt-dlp ships
 * exactly that, one PyInstaller binary per platform with no archive — lands as a plain
 * file directly under `by-name/backend/`. An implementation that only enumerates
 * DIRECTORIES cannot see it: install succeeds, sha256 matches, the manifest is written,
 * and `discoverTools()` still reports the tool as missing. That is the T-093 /
 * media-tools failure shape again, and it is why this is a listed candidate rather than
 * a lucky side effect of the directory scan.
 */
export async function findInBackendPacks(
  storeRoot: string,
  binaryName: string,
): Promise<string | null> {
  const backendRoot = join(storeRoot, 'by-name', 'backend');
  // Flat first: it is the exact, unambiguous location the installer wrote to. The
  // directory scan below is a search; this is a lookup.
  const candidates: string[] = [join(backendRoot, binaryName)];

  const listDirs = async (dir: string): Promise<string[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };

  /*
   * `bin/` is checked at every level because the archive layout is upstream's choice,
   * not ours, and it differs per project: whisper.cpp's tarball puts `whisper-cli` at the
   * root of its top directory, while BtbN's ffmpeg build puts `ffmpeg`/`ffprobe` under
   * `<top>/bin/`. A scan that only walks bare directories finds the first and silently
   * misses the second — and "silently" is the whole problem here: a missing ffmpeg does
   * not fail loudly at install time, it fails much later as "every transcription is
   * blocked", because every audio file has to be normalised to 16 kHz mono first.
   */
  for (const packDir of await listDirs(backendRoot)) {
    candidates.push(join(packDir, binaryName), join(packDir, 'bin', binaryName));
    for (const nested of await listDirs(packDir)) {
      candidates.push(join(nested, binaryName), join(nested, 'bin', binaryName));
    }
  }

  for (const c of candidates) {
    if (await isExecutable(c)) return c;
  }
  return null;
}

/**
 * Find a NON-executable file (or directory) inside an installed backend pack.
 *
 * Same two-level scan as {@link findInBackendPacks}; split out because a `.so` has no
 * exec bit and a dictionary directory is not a file at all, so the `isExecutable`
 * test there rejects exactly the things we need here.
 */
export async function findFileInBackendPacks(
  storeRoot: string,
  name: string,
): Promise<string | null> {
  const backendRoot = join(storeRoot, 'by-name', 'backend');
  const listDirs = async (dir: string): Promise<string[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };

  const candidates: string[] = [];
  // Same `bin/` and `lib/` reasoning as findInBackendPacks: shared objects ship under
  // `lib/` in most upstream archives, next to the `bin/` the executables live in.
  for (const packDir of await listDirs(backendRoot)) {
    candidates.push(join(packDir, name), join(packDir, 'bin', name), join(packDir, 'lib', name));
    for (const nested of await listDirs(packDir)) {
      candidates.push(join(nested, name), join(nested, 'bin', name), join(nested, 'lib', name));
    }
  }
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return null;
}

export interface MaterializedExtensions {
  /** Absolute paths that now exist under `extDir`, keyed by the name we created. */
  linked: Record<string, string>;
  /** Names we looked for and did not find in any installed pack. */
  missing: string[];
}

export interface SqliteExtensionSource {
  /**
   * The name that has to exist under `bin/ext` afterwards — i.e. exactly what
   * `@openmemo/db`'s `defaultExtensionPaths(root)` will `existsSync()` and hand to
   * `sqlite3_load_extension()`. This side of the mapping is OURS.
   */
  readonly dst: string;
  /**
   * The names to look for INSIDE the installed packs, in order. This side is UPSTREAM'S,
   * and upstream does not have to agree with us — see the win32 row below.
   */
  readonly candidates: readonly string[];
}

/**
 * What `bin/ext` must end up containing, and what to look for in the packs to get it.
 *
 * ── ★ Why this is a table and not `libsimple${suffix}` (measured, T-147) ───────────────
 * The upstream libsimple release archives do NOT use one naming rule across platforms:
 *
 * ```
 * libsimple-linux-ubuntu-22.04.zip → libsimple-linux-ubuntu-22.04/libsimple.so
 * libsimple-osx-arm64.zip          → libsimple-osx-arm64/libsimple.dylib
 * libsimple-windows-x64.zip        → libsimple-windows-x64/simple.dll     ← ★ no `lib`
 * ```
 * (`[实测]` v0.7.1, the three archives named in `vendor/manifests/sqlite-ext.json`,
 * unzipped and listed. MSVC does not prefix `lib`; the CMake target is `simple`.)
 *
 * The old code derived one name for all three (`libsimple` + platform suffix), so on
 * Windows it searched for a file that is not in any archive. Consequence measured on a
 * clean win32 cold start (CI `cold-start-audit`, D-11 §7): every pack installs and
 * verifies, `sqlite-vec` loads, and the daemon comes up
 * `tokenizer=trigram libsimple=false` — **Chinese two-character search silently does not
 * work, with no error anywhere**. That is T-093 reproduced on another platform, and it is
 * why the mapping is written down per platform instead of being computed.
 *
 * ── Why `dst` may differ from the name we found ────────────────────────────────────────
 * We copy `simple.dll` to `bin/ext/libsimple.dll` rather than teaching every consumer a
 * second name. That is safe, and the reason is specific: with no explicit entry point,
 * SQLite derives one from the FILE NAME — it strips the directory, skips a leading `lib`,
 * and takes the alphabetic characters up to the first `.` (`sqlite3.c`, the
 * `zAltEntry` block). Both `simple.dll` and `libsimple.dll` therefore derive
 * `sqlite3_simple_init`, which is the ONLY `sqlite3_*` symbol the DLL exports
 * (`[实测]` PE export table of v0.7.1 `simple.dll`: 2623 exports, exactly one matching
 * `sqlite3*`). Renaming it to anything else — `chinese.dll`, `tokenizer.dll` — would
 * break loading with "no entry point", which is what `__tests__/extensions.test.ts`
 * pins down.
 */
export function sqliteExtensionSources(
  platform: NodeJS.Platform = process.platform,
): SqliteExtensionSource[] {
  const suffix = platform === 'win32' ? '.dll' : platform === 'darwin' ? '.dylib' : '.so';
  return [
    {
      dst: `libsimple${suffix}`,
      // Canonical name first (that is what a future upstream may ship, and what our own
      // builds produce), the real Windows archive name second.
      candidates:
        platform === 'win32' ? [`libsimple${suffix}`, `simple${suffix}`] : [`libsimple${suffix}`],
    },
    { dst: `vec0${suffix}`, candidates: [`vec0${suffix}`] },
    // jieba dictionary — a directory, not a file. Same name on every platform.
    { dst: 'dict', candidates: ['dict'] },
  ];
}

/**
 * Make `<dataDir>/bin/ext` actually contain the SQLite extensions.
 *
 * ── Why this function has to exist ───────────────────────────────────────────────
 * Every consumer assumes ONE directory holding `libsimple.so`, `vec0.so` and `dict/`:
 * `@openmemo/db`'s `defaultExtensionPaths(root)` takes a single root, `AppPaths.
 * extensionsDir` is `<dataDir>/bin/ext`, `OPENMEMO_EXT_DIR` overrides that one dir, and
 * the sqlite-ext manifests literally declare `linkInto: "bin/ext"`.
 *
 * Reality after ADR-015 (upstream prebuilts instead of our own build) is the opposite:
 * each upstream archive lands in its OWN `by-name/backend/<archive>/` directory, with its
 * own internal layout — libsimple's zip nests one more level (`libsimple-…/libsimple-…/
 * libsimple.so`), sqlite-vec's tarball is flat. So the two extensions are never in the
 * same directory, which is precisely why `linkInto` is a LINK target and not an unpack
 * target: linking adds files to a shared directory, unpacking would replace it.
 *
 * Measured consequence on a clean cold start (T-093): all packs download and verify OK,
 * yet the daemon comes up `tokenizer=trigram, vec=off` — i.e. **Chinese two-character
 * search silently does not work**, which is the single most important feature for this
 * product's users. Nothing reports an error, because "extension not found" is a designed
 * graceful degradation.
 *
 * Fixing it by teaching every consumer to resolve per-file would spread pack-layout
 * knowledge across three packages. Instead we make the shared assumption TRUE: after
 * install, link the real files into the one directory everybody already looks in.
 *
 * Symlinks (not copies) on POSIX so an uninstall/upgrade of the pack is visible
 * immediately and `du` does not double-count ~10 MB of jieba dictionary. Windows
 * symlinks need elevation or developer mode, so there we copy.
 *
 * The name mapping (what to look for vs what to create) lives in
 * {@link sqliteExtensionSources} — read the comment there before touching it, the Windows
 * row is not guessable.
 *
 * `platform` is injectable so the Windows mapping and the copy branch are reachable from
 * a test on any host. Production always calls it with two arguments.
 *
 * Idempotent: safe to call on every startup, and re-linking after an upgrade is the point.
 */
export async function materializeSqliteExtensions(
  storeRoot: string,
  extDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<MaterializedExtensions> {
  const linked: Record<string, string> = {};
  const missing: string[] = [];

  for (const { dst: name, candidates } of sqliteExtensionSources(platform)) {
    let src: string | null = null;
    for (const candidate of candidates) {
      src = await findFileInBackendPacks(storeRoot, candidate);
      if (src !== null) break;
    }
    if (src === null) {
      missing.push(name);
      continue;
    }
    const dst = join(extDir, name);
    try {
      await mkdir(extDir, { recursive: true });
      // Replace unconditionally: a stale link from a previous pack version is worse
      // than no link, and `existsSync` on a dangling symlink is false anyway.
      await rm(dst, { recursive: true, force: true });
      if (platform === 'win32') {
        await cp(src, dst, { recursive: true });
      } else {
        /*
         * RELATIVE, not absolute.
         *
         * The data directory is movable (`/api/settings/data-dir`). An absolute link
         * survives the copy but keeps pointing at the OLD location, so after the user
         * moves their data and deletes the old path, Chinese search silently breaks
         * again — the exact failure this function exists to prevent, just delayed.
         * A relative link moves with the tree. Verified by an actual move in T-093.
         */
        await symlink(relative(extDir, src), dst);
      }
      linked[name] = dst;
    } catch {
      // Read-only or otherwise unwritable dataDir: degrade to "not linked" rather than
      // taking the daemon down. The caller still gets `missing` and can report it.
      missing.push(name);
    }
  }
  return { linked, missing };
}

/** Find an installed model file by name under `<storeRoot>/by-name/<kind>/`. */
export async function findInstalledModel(
  storeRoot: string,
  kind: 'asr' | 'llm',
  names: string[],
  /**
   * Extra requirement on the candidate. Defaults to "it exists and is readable".
   *
   * T-148: existence is NOT enough for the VAD model. `by-name/asr` legitimately holds
   * both `ggml-silero-v6.2.0.bin` (whisper.cpp) and `silero_vad.onnx` (sherpa-onnx), and
   * handing whisper.cpp the wrong one kills the whole transcription with a message that
   * says nothing about which file was wrong.
   */
  accept: (path: string) => Promise<boolean> = fileExists,
): Promise<string | null> {
  for (const name of names) {
    const p = join(storeRoot, 'by-name', kind, name);
    if (await accept(p)) return p;
  }
  // Fall back to any file in the directory matching a caller-supplied predicate shape.
  return null;
}

/** List everything installed under a by-name kind — used by the self-check report. */
export async function listInstalledModels(
  storeRoot: string,
  kind: 'asr' | 'llm' | 'backend',
): Promise<string[]> {
  try {
    return (await readdir(join(storeRoot, 'by-name', kind))).sort();
  } catch {
    return [];
  }
}

/**
 * Resolve the native tools.
 *
 * Search order, and the reasoning behind it:
 *   1. explicit override        — caller knows best (env vars, tests)
 *   2. installed backend packs  — THE PRODUCTION PATH (ADR-001 class C artifacts)
 *   3. PATH                     — development convenience ONLY
 *
 * Step 2 used to be missing entirely, which is why a correctly installed backend pack
 * still left the daemon reporting `pipeline.missing: ["whisper-cli"]`: nothing ever
 * looked in the place the installer writes to. D-01 §8.4 L2 forbids PATH lookups for
 * real invocations, so PATH stays last and is a development affordance, not the answer.
 */
export async function discoverTools(
  overrides: Partial<ToolPaths> & {
    /** Explicit store root. Wins over everything. */
    storeRoot?: string;
    /** The daemon's data directory — pass this whenever it is known (D-08 D4). */
    dataDir?: string;
  } = {},
): Promise<ToolPaths> {
  const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

  const storeRoot = overrides.storeRoot ?? resolveStoreRoot(overrides.dataDir);

  const fromPath = async (name: string): Promise<string | null> => {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = join(dir, exe(name));
      if (await isExecutable(candidate)) return candidate;
    }
    return null;
  };

  const resolve = async (name: string): Promise<string | null> =>
    (await findInBackendPacks(storeRoot, exe(name))) ?? (await fromPath(name));

  /*
   * VAD model ships as a ggml file inside the whisper.cpp pack's sibling model store.
   *
   * The acceptance test is the ggml magic, NOT the file name (T-148). Two reasons, both
   * measured rather than imagined:
   *   1. the name list below is a guess about upstream's release naming — it was written
   *      for `v5.1.2` and the catalog now pins `v6.2.0`; a third version breaks it again;
   *   2. `whisper-vad-speech-segments` reports EVERY load failure as the same sentence
   *      (`error: failed to initialize whisper context`, exit 2) — wrong file, missing
   *      file and empty path are indistinguishable downstream, so the check has to happen
   *      here, where we still know which candidate we picked.
   */
  const vadModel =
    overrides.vadModel ??
    (await findInstalledModel(
      storeRoot,
      'asr',
      ['ggml-silero-v6.2.0.bin', 'ggml-silero-v5.1.2.bin', 'silero-vad.bin'],
      isGgmlModelFile,
    ));

  return {
    ffmpeg: overrides.ffmpeg ?? (await resolve('ffmpeg')) ?? '',
    ffprobe: overrides.ffprobe ?? (await resolve('ffprobe')) ?? '',
    whisperCli: overrides.whisperCli ?? (await resolve('whisper-cli')),
    whisperVad: overrides.whisperVad ?? (await resolve('whisper-vad-speech-segments')),
    vadModel,
    ytDlp: overrides.ytDlp ?? (await resolve('yt-dlp')),
  };
}
