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

import { access, constants } from 'node:fs/promises';
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
 * Best-effort discovery for development and tests.
 *
 * NOT for production: it searches PATH, which §8.4 L2 forbids for real invocations.
 * Production reads paths from the installed-pack manifest instead.
 */
export async function discoverTools(overrides: Partial<ToolPaths> = {}): Promise<ToolPaths> {
  const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

  const fromPath = async (name: string): Promise<string | null> => {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = join(dir, exe(name));
      if (await isExecutable(candidate)) return candidate;
    }
    return null;
  };

  return {
    ffmpeg: overrides.ffmpeg ?? (await fromPath('ffmpeg')) ?? '',
    ffprobe: overrides.ffprobe ?? (await fromPath('ffprobe')) ?? '',
    whisperCli: overrides.whisperCli ?? (await fromPath('whisper-cli')),
    whisperVad: overrides.whisperVad ?? (await fromPath('whisper-vad-speech-segments')),
    vadModel: overrides.vadModel ?? null,
    ytDlp: overrides.ytDlp ?? (await fromPath('yt-dlp')),
  };
}
