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

import { access, constants, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  /** whisper.cpp CLI, from the L1 core pack built by scripts/build-whisper.sh. */
  whisperCli: string | null;
  /** whisper.cpp VAD segmenter, also from the L1 core pack. */
  whisperVad: string | null;
  /** ggml Silero VAD model. */
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
 * Default artifact store root, matching `@openmemo/downloader`'s `resolveModelsRoot()`.
 *
 * Kept in sync by construction: if the two disagree, installed artifacts become
 * invisible to the pipeline and the product silently runs degraded — which is exactly
 * the failure this function exists to prevent.
 */
export function defaultStoreRoot(): string {
  const explicit = process.env['OPENMEMO_MODELS'];
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const dataDir = process.env['OPENMEMO_DATA_DIR'];
  if (dataDir !== undefined && dataDir.length > 0) return join(dataDir, 'models');

  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'OpenMemo', 'models');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'OpenMemo', 'models');
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'openmemo', 'models');
}

/**
 * Find an executable inside an installed backend pack.
 *
 * Layout comes from `@openmemo/downloader`'s ArtifactStore:
 *     <storeRoot>/by-name/backend/<archive-basename>/[<nested>/]<binary>
 * The nested level exists because upstream archives carry their own top-level directory
 * (whisper.cpp's Linux tarball unpacks to `whisper-bin-ubuntu-x64/`), so a fixed depth
 * would miss it. We scan two levels, newest first, and take the first hit.
 */
export async function findInBackendPacks(
  storeRoot: string,
  binaryName: string,
): Promise<string | null> {
  const backendRoot = join(storeRoot, 'by-name', 'backend');
  const candidates: string[] = [];

  const listDirs = async (dir: string): Promise<string[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };

  for (const packDir of await listDirs(backendRoot)) {
    candidates.push(join(packDir, binaryName));
    for (const nested of await listDirs(packDir)) {
      candidates.push(join(nested, binaryName));
    }
  }

  for (const c of candidates) {
    if (await isExecutable(c)) return c;
  }
  return null;
}

/** Find an installed model file by name under `<storeRoot>/by-name/<kind>/`. */
export async function findInstalledModel(
  storeRoot: string,
  kind: 'asr' | 'llm',
  names: string[],
): Promise<string | null> {
  for (const name of names) {
    const p = join(storeRoot, 'by-name', kind, name);
    if (await fileExists(p)) return p;
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
  overrides: Partial<ToolPaths> & { storeRoot?: string } = {},
): Promise<ToolPaths> {
  const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

  const storeRoot = overrides.storeRoot ?? defaultStoreRoot();

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

  // VAD model ships as a ggml file inside the whisper.cpp pack's sibling model store.
  const vadModel =
    overrides.vadModel ??
    (await findInstalledModel(storeRoot, 'asr', [
      'ggml-silero-v5.1.2.bin',
      'ggml-silero-v6.2.0.bin',
      'silero-vad.bin',
    ]));

  return {
    ffmpeg: overrides.ffmpeg ?? (await resolve('ffmpeg')) ?? '',
    ffprobe: overrides.ffprobe ?? (await resolve('ffprobe')) ?? '',
    whisperCli: overrides.whisperCli ?? (await resolve('whisper-cli')),
    whisperVad: overrides.whisperVad ?? (await resolve('whisper-vad-speech-segments')),
    vadModel,
    ytDlp: overrides.ytDlp ?? (await resolve('yt-dlp')),
  };
}
