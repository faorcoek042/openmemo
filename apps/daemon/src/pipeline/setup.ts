/**
 * 流水线装配：工具发现 → 媒体源注册表 → ASR 引擎。
 *
 * daemon 只做装配，纯逻辑在 `packages/pipeline`（D-01 §1.2）。
 *
 * ⚠️ 工具路径解析：生产环境应当读「已安装 pack 的 manifest」，
 * `discoverTools()` 会搜 PATH，那在 D-01 §8.4 L2 里是被禁止的注入面。
 * 因此这里**优先用环境变量显式指定的绝对路径**，只有在开发/自检时才回退到 PATH 搜索。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  TranscribePipeline,
  WhisperCppEngine,
  buildDefaultRegistry,
  discoverTools,
  type ManagedDirs,
  type MediaSourceRegistry,
  type ToolPaths,
} from '@openmemo/pipeline';

import type { AppPaths } from '../config/paths.js';

export interface PipelineBundle {
  readonly tools: ToolPaths;
  readonly dirs: ManagedDirs;
  readonly registry: MediaSourceRegistry;
  readonly pipeline: TranscribePipeline;
  /** 缺哪些工具 —— 用于 /api/health 与 job 的 `blocked` 状态（D-01 §4.1）。 */
  readonly missing: readonly string[];
  readonly modelPath: string | null;
}

function firstExisting(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/**
 * 组装流水线。
 *
 * 环境变量（供开发与本机验收用；生产走 runtime pack manifest）：
 *   OPENMEMO_FFMPEG / OPENMEMO_FFPROBE / OPENMEMO_WHISPER_CLI /
 *   OPENMEMO_WHISPER_VAD / OPENMEMO_VAD_MODEL / OPENMEMO_ASR_MODEL / OPENMEMO_YTDLP
 */
export async function buildPipeline(paths: AppPaths): Promise<PipelineBundle> {
  const env = process.env;

  const dirs: ManagedDirs = {
    tempDir: paths.tmpDir,
    runtimesDir: join(paths.dataDir, 'bin', 'runtime'),
    modelsDir: paths.modelsDir,
  };

  // 显式路径优先；找不到才退回 PATH 搜索（仅开发期）
  const discovered = await discoverTools({
    ...(env['OPENMEMO_FFMPEG'] ? { ffmpeg: env['OPENMEMO_FFMPEG'] } : {}),
    ...(env['OPENMEMO_FFPROBE'] ? { ffprobe: env['OPENMEMO_FFPROBE'] } : {}),
    ...(env['OPENMEMO_WHISPER_CLI'] ? { whisperCli: env['OPENMEMO_WHISPER_CLI'] } : {}),
    ...(env['OPENMEMO_WHISPER_VAD'] ? { whisperVad: env['OPENMEMO_WHISPER_VAD'] } : {}),
    ...(env['OPENMEMO_YTDLP'] ? { ytDlp: env['OPENMEMO_YTDLP'] } : {}),
  });

  const tools: ToolPaths = {
    ...discovered,
    vadModel: firstExisting(env['OPENMEMO_VAD_MODEL'], join(dirs.modelsDir, 'ggml-silero-v6.2.0.bin')),
  };

  const missing: string[] = [];
  if (!tools.ffmpeg) missing.push('ffmpeg');
  if (!tools.ffprobe) missing.push('ffprobe');
  if (!tools.whisperCli) missing.push('whisper-cli');

  const modelPath = firstExisting(
    env['OPENMEMO_ASR_MODEL'],
    join(dirs.modelsDir, 'ggml-base.en.bin'),
    join(dirs.modelsDir, 'ggml-base.bin'),
  );
  if (!modelPath) missing.push('asr-model');

  const registry = buildDefaultRegistry({
    tools,
    cwd: paths.tmpDir,
    // 本地导入只允许落在数据目录内 —— 防路径穿越（D-01 §8.5）
    allowedRoot: paths.dataDir,
    // TD-002 的开关：默认关闭 GPL 站点提取器，需要时显式打开
    enableSiteExtractor: env['OPENMEMO_ENABLE_SITE_EXTRACTOR'] === '1',
  });

  const asr = new WhisperCppEngine({
    tools,
    cwd: paths.tmpDir,
    nice: true, // CPU 推理会吃满核，降优先级避免饿死 daemon（D-01 §4.2）
  });

  const pipeline = new TranscribePipeline({ tools, dirs, registry, asr });

  return { tools, dirs, registry, pipeline, missing, modelPath };
}
