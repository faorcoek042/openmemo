/**
 * 流水线装配：工具发现 → 媒体源注册表 → ASR 引擎。
 *
 * daemon 只做装配，纯逻辑在 `packages/pipeline`（D-01 §1.2）。
 *
 * ⚠️ 工具路径解析：生产环境应当读「已安装 pack 的 manifest」，
 * `discoverTools()` 会搜 PATH，那在 D-01 §8.4 L2 里是被禁止的注入面。
 * 因此这里**优先用环境变量显式指定的绝对路径**，只有在开发/自检时才回退到 PATH 搜索。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  SherpaOnnxEngine,
  TranscribePipeline,
  WhisperCppEngine,
  buildCandidates,
  buildDefaultRegistry,
  discoverTools,
  selectEngine,
  type AsrEngine,
  type AsrStream,
  type EngineCandidate,
  type EngineId,
  type SherpaTransducerModel,
  type StreamRequest,
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
  /** 可选引擎候选（已探测可用性）。用于 selectEngine 与 /api/health 展示。 */
  readonly candidates: readonly EngineCandidate[];
  /**
   * 按语言挑引擎（`gpu-runtime` 的 `selectEngine`，T-033 接线）。
   *
   * 为什么要按语言挑：中文场景下 sherpa/paraformer 明显优于 whisper base，
   * 但代价是失去词级时间戳。`selectEngine` 会把**理由与代价**一起返回，
   * 这样 UI 能解释"为什么用了这个引擎"，而不是黑盒切换。
   */
  pickEngine(language: string | undefined): {
    engine: AsrEngine;
    engineId: string;
    reason: string;
  } | null;
  /**
   * F3 流式：打开一路会话。**引擎不可用时返回 undefined** ——
   * D-06 §15.1 明确要求"`isAvailable()` 为假时不要调用 `openStream()`"，
   * 所以这里先判可用性，把这条契约收口在一处。
   */
  openStream(req: { language?: string; signal: AbortSignal }): AsrStream | undefined;
  readonly streamModelId: string;
  readonly streamAvailable: boolean;
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

  const whisper = new WhisperCppEngine({
    tools,
    cwd: paths.tmpDir,
    nice: true, // CPU 推理会吃满核，降优先级避免饿死 daemon（D-01 §4.2）
  });

  // sherpa-onnx 作为中文/流式的候选。模型没装时 buildCandidates 会把它标 unavailable，
  // **不会抛** —— 缺引擎是正常状态，不该让 daemon 起不来。
  /*
   * sherpa-onnx（中文/流式候选）**当前不构造**。
   *
   * 它的 `SherpaOnnxEngineOptions` 要的是一个 `SherpaTransducerModel`（encoder/decoder/joiner
   * 三个文件的具体路径），不是一个目录。要接它必须先有模型安装记录
   * （ADR-004 的模型目录 → `model_installs`），那是 `model-mgmt` 的领域。
   *
   * 这里刻意**不编一个假配置**：宁可候选里只有 whisper，也不要让 selectEngine
   * 在一个不存在的引擎上做出"看起来对"的选择。等模型管理接通后在这里加回来。
   */
  /*
   * sherpa-onnx：F3 流式引擎（中文主场景）。
   *
   * 它要的是 encoder/decoder/joiner/tokens 四个**具体文件路径**，不是一个目录。
   * 目前从环境变量 `OPENMEMO_SHERPA_STREAM_DIR` 指向的目录里按约定文件名解析；
   * ⚠️ 正式做法是从**模型安装记录**（ADR-004 的 `model_installs`）读出来 ——
   * 等 `model-mgmt` 的模型目录接通后换成那条路径，这里只是过渡。
   * 解析不到就**不构造引擎**（宁可没有流式，也不要编一个假配置）。
   */
  const engines: AsrEngine[] = [whisper];
  let sherpa: SherpaOnnxEngine | undefined;
  const streamDir = env['OPENMEMO_SHERPA_STREAM_DIR'];
  if (streamDir) {
    const model = resolveSherpaModel(streamDir);
    if (model) {
      sherpa = new SherpaOnnxEngine({ model, provider: 'cpu' });
      engines.push(sherpa);
    } else {
      missing.push('sherpa-stream-model');
    }
  }
  const candidates = await buildCandidates(engines);
  const sherpaAvailable =
    candidates.find((c) => c.engine === sherpa)?.available ?? false;

  const pickEngine = (
    language: string | undefined,
  ): { engine: AsrEngine; engineId: string; reason: string } | null => {
    const raw = env['OPENMEMO_ASR_ENGINE'];
    // EngineId 是字面量联合，环境变量是任意字符串 —— 必须先收窄再传
    const preferred: EngineId | undefined =
      raw === 'whisper.cpp' || raw === 'paraformer' || raw === 'sherpa-onnx' ? raw : undefined;
    const sel = selectEngine({
      candidates: [...candidates],
      mode: 'batch',
      ...(language ? { language } : {}),
      ...(preferred ? { preferredEngineId: preferred } : {}),
    });
    if (!sel) return null;
    return { engine: sel.engine, engineId: sel.engineId, reason: sel.reason };
  };

  // 默认引擎仍是 whisper；按语言切换发生在 job 层（见 transcribe runner）
  const pipeline = new TranscribePipeline({ tools, dirs, registry, asr: whisper });

  const streamModelId = sherpa ? 'streaming-zipformer-zh-14M' : 'none';

  const openStream = (req: { language?: string; signal: AbortSignal }): AsrStream | undefined => {
    // 契约：引擎不可用时不要调 openStream
    if (!sherpa || !sherpaAvailable || !sherpa.openStream) return undefined;
    const streamReq: StreamRequest = {
      modelPath: streamDir ?? '',
      ...(req.language ? { language: req.language } : {}),
      signal: req.signal,
    };
    return sherpa.openStream(streamReq);
  };

  return {
    tools,
    dirs,
    registry,
    pipeline,
    missing,
    modelPath,
    candidates,
    pickEngine,
    openStream,
    streamModelId,
    streamAvailable: sherpaAvailable,
  };
}

/**
 * 从一个 sherpa 模型目录解析出四个文件路径。
 * 官方发布包的命名是 `encoder-epoch-XX-avg-Y[.int8].onnx` 这种，所以按前缀匹配。
 * **优先 int8**（体积小、CPU 上更快），没有再退回 fp32。
 */
function resolveSherpaModel(dir: string): SherpaTransducerModel | undefined {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  const pick = (prefix: string): string | undefined => {
    const cands = files.filter((f) => f.startsWith(prefix) && f.endsWith('.onnx'));
    return cands.find((f) => f.includes('.int8.')) ?? cands[0];
  };
  const encoder = pick('encoder');
  const decoder = pick('decoder');
  const joiner = pick('joiner');
  const tokens = files.find((f) => f === 'tokens.txt');
  if (!encoder || !decoder || !joiner || !tokens) return undefined;
  return {
    encoder: join(dir, encoder),
    decoder: join(dir, decoder),
    joiner: join(dir, joiner),
    tokens: join(dir, tokens),
    modelId: 'streaming-zipformer-zh-14M',
    languages: ['zh', 'en'],
  };
}
