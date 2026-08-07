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
  ParaformerEngine,
  SherpaOnnxEngine,
  TranscribePipeline,
  WhisperCppEngine,
  buildCandidates,
  buildDefaultRegistry,
  discoverTools,
  findWhisperVadWeights,
  resolveBackendTool,
  resolveStoreRoot,
  selectEngine,
  type ResolvedBackendTool,
  type AsrEngine,
  type AsrStream,
  type EngineCandidate,
  type EngineId,
  type ParaformerModel,
  type PunctuationModel,
  type SherpaTransducerModel,
  type StreamRequest,
  type ManagedDirs,
  type MediaSourceRegistry,
  type ToolPaths,
} from '@openmemo/pipeline';

import { isGgmlModelFile } from '@openmemo/downloader';

import type { AppPaths } from '../config/paths.js';
import { whisperCliName } from '../runtime/setup.js';
import {
  listInstalledModelRecords,
  materializeModelDir,
  resolveActiveModel,
  scanByName,
} from './modelStore.js';

export interface PipelineBundle {
  readonly tools: ToolPaths;
  readonly dirs: ManagedDirs;
  readonly registry: MediaSourceRegistry;
  readonly pipeline: TranscribePipeline;
  /** 缺哪些工具 —— 用于 /api/health 与 job 的 `blocked` 状态（D-01 §4.1）。 */
  readonly missing: readonly string[];
  readonly modelPath: string | null;
  /**
   * 切分方式的真实状态。**必须一路露到界面上**：
   * VAD 不可用时转写仍会完成（退回固定窗口），断句变差却一个字都不提示 ——
   * 那是「假绿灯」的镜像：结果给了，但系统在悄悄用较差的路径。
   */
  readonly vad: VadModelResolution;
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
  /** 按语言取流水线（内部按引擎缓存）。中文会走 Paraformer（ADR-013 决策 1）。 */
  pipelineFor(
    language: string | undefined,
    /** 用户为这一次转写显式指定的引擎/模型。不传 = 自动选择（老行为不变）。 */
    override?: { engineId?: string | undefined; modelPath?: string | undefined },
  ): {
    pipeline: TranscribePipeline;
    engineId: string;
    reason: string;
    /** **该引擎自己的**模型路径 —— 传错会让 sherpa 拿 ggml .bin 当 ONNX 加载而崩。 */
    modelPath: string | null;
  };
  /**
   * F3 流式：打开一路会话。**引擎不可用时返回 undefined** ——
   * D-06 §15.1 明确要求"`isAvailable()` 为假时不要调用 `openStream()`"，
   * 所以这里先判可用性，把这条契约收口在一处。
   */
  openStream(req: { language?: string; signal: AbortSignal }): AsrStream | undefined;
  readonly streamModelId: string;
  readonly streamAvailable: boolean;
  /** 离线中文引擎是否可用（ADR-013 决策 1）。 */
  readonly paraformerAvailable: boolean;
  /**
   * **没能构造出来的引擎，以及原因** —— 必须一路露到界面（T-160）。
   *
   * `candidates` 只装得下**构造成功**的引擎。于是 sherpa / Paraformer 解析不到模型时，
   * 它们在 `/api/health` 的 `engines` 里**根本不出现**，前端只能显示一个没有理由的
   * "未安装"，而真实原因（模型没装 / 装了但文件不全）一个字都到不了用户面前。
   * 那正是"静默不可用"本身 —— 与 VAD 那次降级同族：**结果给了，代价没说**。
   *
   * 这里补上缺席的那几条，`main.ts` 把它们并进 health 的 `engines`，
   * 前端 `AsrEngineStatus` 现成就会渲染 `reason` + 「去装运行时」按钮，一行前端代码都不用改。
   */
  readonly unavailableEngines: readonly { id: EngineId; reasonZh: string }[];
  /**
   * **这次跑的 whisper-cli 是哪个后端包给的**（T-162）。
   *
   * `null` = 它不是从后端包里解析出来的（`OPENMEMO_WHISPER_CLI` 覆盖 / 系统 PATH /
   * 根本没找到）。在此之前"用哪个包"取决于 `readdir` 返回顺序，
   * **用户既无法知道也无法影响** —— 这个字段是"能知道"的那一半，
   * `/api/selfcheck` 的 `backend.selection` 把它露出去。
   */
  readonly whisperCliOrigin: ResolvedBackendTool | null;
}

/**
 * 站点提取器（yt-dlp）开关 —— **默认开，用 `OPENMEMO_ENABLE_SITE_EXTRACTOR=0` 关**。
 *
 * ## 为什么翻过来了（T-132）
 *
 * 这里原来写的是 `env['OPENMEMO_ENABLE_SITE_EXTRACTOR'] === '1'`，即**默认关闭**。
 * 后果是：即使 yt-dlp 已经装好，`YtDlpSource` 也**根本不会被注册进 registry**，
 * 于是粘贴一个 watch 页链接永远得到 `422 NO_MEDIA_SOURCE`。
 * 装得上但产品路径走不到 —— 与 ⑤D「后端做好了、前端还关着」同族。
 *
 * 而 ADR-002「用户决定 2」原文是：
 *   > **F1 直接内置 yt-dlp，不做双路径区分。粘贴链接即用。**
 * 这是**用户决定，agent 不得推翻**。默认关闭直接与它冲突。
 *
 * ## 这不是把 TD-002 的逃生口拆掉
 *
 * TD-002 要求的是「**可以**不依赖 GPL 组件」，不是「默认不依赖」：
 *   · 环境变量仍在，只是极性反过来 —— `=0` 一秒关掉，无需改代码；
 *   · `buildDefaultRegistry()` 自己的默认值本来就是 `?? true`，
 *     真正的偏差只在 daemon 这一处；
 *   · `packages/pipeline` 的 TD-002 回归用例传的是显式 `enableSiteExtractor: false`，
 *     不受本默认值影响，「关掉后播客/RSS/HLS/直链/本地文件照常」依旧被钉住；
 *   · 没装 yt-dlp 时 `YtDlpSource.isAvailable()` 返回 false，
 *     registry 会跳过它并给出可操作的 remediation —— 打开开关不会凭空造出一个假适配器。
 *
 * `docs/SECURITY.md` 写着「风险敏感的用户应关闭它」：关闭方式从
 * 「什么都不做」变成「设 `OPENMEMO_ENABLE_SITE_EXTRACTOR=0`」，能力没有消失。
 */
export function siteExtractorEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['OPENMEMO_ENABLE_SITE_EXTRACTOR'] !== '0';
}

function firstExisting(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** VAD 权重的解析结果 —— 带上"为什么"，因为没有它时这条降级是完全静默的。 */
export interface VadModelResolution {
  /** whisper.cpp 真的能加载的 ggml VAD 权重；`null` = 本次一定走固定窗口切分。 */
  readonly path: string | null;
  /**
   * 存在、但 whisper.cpp 加载不了的候选（典型：sherpa 专用的 `silero_vad.onnx`）。
   * **非空 + `path === null` 是最要命的那一格**：用户以为自己装了 VAD，实际没装上能用的。
   */
  readonly rejected: readonly string[];
  readonly reasonZh: string;
}

/**
 * 挑一份 **whisper.cpp 能加载** 的 VAD 权重（T-148）。
 *
 * ## 修的是什么
 *
 * 旧代码是 `resolveActiveModel(modelsDir, 'vad')` —— 只按 role 挑，谁先装谁赢。
 * 而 `role: 'vad'` 底下有两个**互相加载不了**的文件：
 * `silero_vad.onnx`（sherpa 专用）与 `ggml-silero-v6.2.0.bin`（whisper.cpp 专用）。
 * 目录里 onnx 排在前面 → 冷装 `required-core` 后 `active.json.vad` 恒为 onnx →
 * 这里把 ONNX 交给 `whisper-vad-speech-segments` → `bad magic` →
 * `error: failed to initialize whisper context` → **exit 2，整单转写死**。
 *
 * `[本机实测]` 用仓库自带的同一份权重（`vendor/whisper.cpp/models/for-tests-silero-v6.2.0-ggml.bin`，
 * sha256 与清单逐字符一致）+ CI 用的同一个上游二进制复现过：喂 ONNX 的输出与
 * CI 日志逐字节相同。
 *
 * ## 判据为什么是"读头四字节"
 *
 * 见 `isGgmlModelFile` 的注释：老安装记录里没有 `engines` 字段，按字段过滤会误伤；
 * 按内容判则新旧记录、手工拷进来的文件一视同仁，而且钉的正是 whisper 自己会检查的东西。
 */
export async function resolveWhisperVadModel(
  modelsDir: string,
  env: NodeJS.ProcessEnv,
): Promise<VadModelResolution> {
  const rejected: string[] = [];
  const consider = async (p: string | null | undefined): Promise<string | null> => {
    if (!p) return null;
    if (await isGgmlModelFile(p)) return p;
    if (existsSync(p)) rejected.push(p);
    return null;
  };

  const fromRecords = await resolveActiveModel(modelsDir, 'vad', {
    accept: (p) => isGgmlModelFile(p),
    onRejected: (recs) => {
      for (const r of recs) rejected.push(r.path);
    },
  });

  /*
   * ★ T-166：by-name 兜底**改成调 `@openmemo/pipeline` 的那一份**，不再在这里自己扫。
   *
   * 原因是 `runner-migrate` 在 CI 上照出来的 `meta.sameSource` 红线：
   * `model.vad 本地=warn 端点=ok`（三平台一模一样）。成因是 T-149 把 `role=vad`
   * 挪进 `by-name/vad/` 之后**只改了这一边** —— `discoverTools()` 那一侧还在
   * 只按三个写死的文件名翻 `by-name/asr/`。daemon 出口用的是这里的答案（ok），
   * CLI 出口用的是 `discoverTools()` 的答案（warn）。
   *
   * 只把那边的桶名改对是不够的：两边的**规则**当时也不一样（这里是"后缀+关键词"，
   * 那边是固定名单），下一次上游发 `v7` 时会再分叉一次，而且仍然只有一边哑掉。
   * 所以规则收成一份，这里只保留本侧独有的两层证据：
   * 环境变量覆盖、以及按 `role` 读安装记录 —— 它们都排在兜底之前。
   */
  const path =
    (await consider(firstExisting(env['OPENMEMO_VAD_MODEL']))) ??
    fromRecords?.path ??
    (await findWhisperVadWeights(modelsDir, (p) => rejected.push(p)));

  const reasonZh =
    path !== null
      ? 'VAD 可用：按静音切分'
      : rejected.length > 0
        ? `已安装的 VAD 权重 whisper.cpp 加载不了（${rejected
            .map((p) => p.split(/[\\/]/).pop() ?? p)
            .join('、')}）—— 切分降级为固定窗口，转写仍可完成但断句会变差`
        : '未安装 VAD 模型 → 切分降级为固定窗口';

  return { path, rejected, reasonZh };
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

  /*
   * 单一来源（D-08 D4）：制品根目录只在 `resolveStoreRoot` 里定义一次。
   *
   * 之前这里用 `paths.modelsDir`、RestState 用 `OPENMEMO_MODELS ?? dataDir/models`、
   * 而 `discoverTools()` 什么都不传 —— 三处各算各的。用 `--data-dir` 启动时前两处对、
   * 第三处退回平台默认目录，于是"装成功了仍报没装"。
   */
  const storeRoot = resolveStoreRoot(paths.dataDir);

  const dirs: ManagedDirs = {
    tempDir: paths.tmpDir,
    runtimesDir: join(paths.dataDir, 'bin', 'runtime'),
    modelsDir: storeRoot,
  };

  // 显式路径优先；找不到才退回 PATH 搜索（仅开发期）
  const discovered = await discoverTools({
    // ← D-08 D4：必须显式传，否则非默认 dataDir 下找不到已装的包
    storeRoot,
    ...(env['OPENMEMO_FFMPEG'] ? { ffmpeg: env['OPENMEMO_FFMPEG'] } : {}),
    ...(env['OPENMEMO_FFPROBE'] ? { ffprobe: env['OPENMEMO_FFPROBE'] } : {}),
    ...(env['OPENMEMO_WHISPER_CLI'] ? { whisperCli: env['OPENMEMO_WHISPER_CLI'] } : {}),
    ...(env['OPENMEMO_WHISPER_VAD'] ? { whisperVad: env['OPENMEMO_WHISPER_VAD'] } : {}),
    ...(env['OPENMEMO_YTDLP'] ? { ytDlp: env['OPENMEMO_YTDLP'] } : {}),
  });

  /*
   * VAD 模型：先读安装记录（role='vad'），再退到 by-name 扫描，最后才是环境变量/旧路径。
   * **不写死 `ggml-silero-v6.2.0.bin`** —— 版本一变就找不到了（ADR-014 ②）。
   *
   * ★ T-148：候选还必须**真的能被 whisper.cpp 加载**。只按 role 挑会把 sherpa 专用的
   *   `silero_vad.onnx` 交出去，那是 CI 上三平台一个都转不出字来的直接原因。
   */
  const vad = await resolveWhisperVadModel(dirs.modelsDir, env);
  const tools: ToolPaths = { ...discovered, vadModel: vad.path };
  if (vad.rejected.length > 0) {
    // 这条**必须**出声：它的形态是"用户装了 VAD，结果比没装更糟"。
    console.warn(`[daemon] ⚠️ ${vad.reasonZh}`);
  }

  const missing: string[] = [];
  if (!tools.ffmpeg) missing.push('ffmpeg');
  if (!tools.ffprobe) missing.push('ffprobe');
  if (!tools.whisperCli) missing.push('whisper-cli');

  /*
   * ★ T-162：**这次跑的 whisper-cli 是哪个包给的**。
   *
   * 只在解析结果与 `tools.whisperCli` 逐字相同时才认 —— 否则那条路径来自
   * `OPENMEMO_WHISPER_CLI` 或系统 PATH，报一个"它来自 whispercpp-cpu-linux-x64"
   * 就是在为另一个二进制作证。（`hw.probe` 与 `/runtime` 上那行 CPU 型号串
   * 刚在同一天犯过这个错：两件事被当成了一件。）
   */
  const resolvedWhisper = await resolveBackendTool(storeRoot, whisperCliName());
  const whisperCliOrigin =
    resolvedWhisper !== null && resolvedWhisper.path === tools.whisperCli ? resolvedWhisper : null;
  if (whisperCliOrigin?.degraded === true) {
    /*
     * 必须出声，理由与上面那条 VAD 警告一样：形态是"用户选了加速后端、装上了、
     * 跑的却是另一个包"，而**每一层都不会报错**。静默降级是本仓最贵的一类 bug。
     */
    console.warn(
      `[daemon] ⚠️ 已选中后端 ${whisperCliOrigin.preferred ?? '(无)'}，但 whisper-cli 来自 ` +
        `${whisperCliOrigin.packId ?? '(来源不明)'}（backend=${whisperCliOrigin.backend ?? '未知'}）` +
        ` —— 选中的那个包里没有 ${whisperCliName()}，已退回。加速不会生效。`,
    );
  }

  /*
   * ASR 模型：**读安装记录**，不猜文件名（ADR-014 ②）。
   *
   * 冷启动实测：网页装好 `whisper-base-q5_1` → 硬链到 `by-name/asr/ggml-base-q5_1.bin`，
   * 而旧代码只找 `ggml-base.en.bin` / `ggml-base.bin`，于是"装成功了仍然找不到"。
   * 顺序：环境变量（开发用）> active.json 指定的 > 任意已装且完好的 > by-name 扫描。
   */
  const asrInstalled = await resolveActiveModel(dirs.modelsDir, 'asr');
  const modelPath =
    firstExisting(env['OPENMEMO_ASR_MODEL']) ??
    asrInstalled?.path ??
    // **排除 silero**：没有安装记录时这里会把 by-name/asr 下任意 .bin 交出去，
    // 而 VAD 权重历史上就躺在这个桶里 —— 不排除就等于把 VAD 当 ASR 发出去。
    scanByName(dirs.modelsDir, 'asr', { ext: '.bin', excludes: 'silero' }) ??
    null;

  /*
   * 最后一道闸：**ASR 与 VAD 绝不可以是同一个文件**。
   *
   * 这个 bug 的杀伤力全在"静默"上 —— whisper 拿 VAD 网络去转写，
   * 而 pipeline.missing 是空的、健康检查全绿，用户只看到转写结果是垃圾。
   * 与其相信上面每一层都挑对了，不如在这里直接否掉这个不可能成立的状态：
   * 宁可显式报 `asr-model` 缺失（用户会看到安装引导），也不要绿着跑错模型。
   */
  const asrIsActuallyVad =
    modelPath !== null && tools.vadModel !== undefined && modelPath === tools.vadModel;
  if (asrIsActuallyVad) {
    console.warn(
      `[daemon] ⚠️ ASR 模型解析到了 VAD 权重（${modelPath}）—— 拒绝使用，按"未安装 ASR 模型"处理`,
    );
  }
  const asrModelPath = asrIsActuallyVad ? null : modelPath;
  if (!asrModelPath) missing.push('asr-model');

  const registry = buildDefaultRegistry({
    tools,
    cwd: paths.tmpDir,
    // 本地导入只允许落在数据目录内 —— 防路径穿越（D-01 §8.5）
    allowedRoot: paths.dataDir,
    // TD-002 的开关。**默认开**，理由见 siteExtractorEnabled()。
    enableSiteExtractor: siteExtractorEnabled(env),
  });

  const whisper = new WhisperCppEngine({
    tools,
    cwd: paths.tmpDir,
    nice: true, // CPU 推理会吃满核，降优先级避免饿死 daemon（D-01 §4.2）
  });

  /*
   * ─────────────────────────────────────────────────────────────────────────────
   * sherpa-onnx（F3 流式中文）与 Paraformer（ADR-013 决策 1 定的离线中文默认）
   *
   * ## 这里修的是什么（T-160）
   *
   * 这两个引擎**都是真实现**（`packages/pipeline/src/asr/sherpaOnnx.ts` 真调 sherpa 的
   * online recognizer、真做 endpoint 断句与词级时间戳），但它们此前各自被一个
   * 环境变量闸死：
   *
   * ```
   * const streamDir = env['OPENMEMO_SHERPA_STREAM_DIR'];  // 剥注释后全仓 1 读 0 写
   * if (streamDir) { … 才构造引擎 … }                       // 于是永远不构造
   * ```
   *
   * `[本机实测]` 两个变量都是**只有这一处读、全仓 0 处写**：没有任何产品路径、脚本、
   * workflow 设置它们。后果：
   *   · F3 录音转文字**在三个平台上一样死**，live `streamAvailable:false`，
   *     点录音直接 `ASR_STREAM_UNAVAILABLE`；
   *   · ADR-013「中文默认引擎 = Paraformer / 84x 实时」**从落笔到今天一次都没生效过**。
   * 而且它**不报错、也不显示"未启用"** —— 装好模型也一样死，因为这里根本不看安装记录。
   *
   * ## 判据换成"已安装的模型库里有没有它"
   *
   * 上面 VAD 与 ASR 权重早就是这么做的（`resolveActiveModel` / `scanByName`），
   * 这一段的旧注释自己也写着「正式做法是从**模型安装记录**读出来…这里只是过渡」。
   * 过渡没人回来收，就是永久 —— 现在换成正式做法：
   *
   *   环境变量（开发/自检的**覆盖**手段，保留）> 已安装模型记录 > 不构造 + 说明原因
   *
   * **绝不编一个假配置**：解析不到就不构造，但必须把原因交出去（`unavailableEngines`），
   * 否则就又变成"静默不可用"。
   * ─────────────────────────────────────────────────────────────────────────────
   */
  const engines: AsrEngine[] = [whisper];
  const unavailableEngines: { id: EngineId; reasonZh: string }[] = [];

  const stream = await resolveStreamingModel(dirs.modelsDir, env);
  let sherpa: SherpaOnnxEngine | undefined;
  if (stream.model) {
    sherpa = new SherpaOnnxEngine({ model: stream.model, provider: 'cpu' });
    engines.push(sherpa);
  } else {
    unavailableEngines.push({ id: 'sherpa-onnx', reasonZh: stream.reasonZh });
  }

  const para = await resolveOfflineChineseModel(dirs.modelsDir, env);
  let paraformer: ParaformerEngine | undefined;
  let paraformerModelPath: string | null = null;
  if (para.model) {
    paraformerModelPath = para.model.model;
    const punctuation = await resolvePunctuation(dirs.modelsDir, env);
    paraformer = new ParaformerEngine({
      tools,
      cwd: paths.tmpDir,
      model: para.model,
      ...(punctuation ? { punctuation } : {}),
      provider: 'cpu',
    });
    engines.push(paraformer);
  } else {
    unavailableEngines.push({ id: 'paraformer', reasonZh: para.reasonZh });
  }

  const candidates = await buildCandidates(engines);
  const sherpaAvailable = candidates.find((c) => c.engine === sherpa)?.available ?? false;
  const paraformerAvailable = candidates.find((c) => c.engine === paraformer)?.available ?? false;

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

  // 默认引擎 whisper；**按语言切换发生在 job 层** —— 见 pipelineFor()
  const pipeline = new TranscribePipeline({ tools, dirs, registry, asr: whisper });

  /*
   * 按语言取一条流水线。
   *
   * `TranscribePipeline` 的引擎是构造期注入的，没有 per-run 覆盖，
   * 所以这里为选中的引擎现建一条（构造很轻，只是把几个引用装进对象）。
   * 缓存一下避免每个 job 都重建。
   */
  const pipelineCache = new Map<string, TranscribePipeline>();
  const pipelineFor = (
    language: string | undefined,
    /**
     * 用户为这一次转写显式指定的覆盖项。
     * 不传 = 完全按原来的自动选择走（老行为一个字不变）。
     */
    override?: { engineId?: string | undefined; modelPath?: string | undefined },
  ): {
    pipeline: TranscribePipeline;
    engineId: string;
    reason: string;
    modelPath: string | null;
  } => {
    /*
     * 显式指定引擎时**必须真的用它**，而且必须是**可用**的候选 ——
     * 指定了却悄悄回退到别的引擎，就是 architect 说的"第二个假选择器"：
     * 界面上选了 Paraformer，实际跑 whisper，用户永远不知道。
     * 所以指定的引擎不可用时宁可让它落到下面的正常选择并在 reason 里说清楚。
     */
    const forced = override?.engineId
      ? candidates.find((c) => c.engine.id === override.engineId && c.available)
      : undefined;
    const sel = forced
      ? {
          engineId: forced.engine.id,
          engine: forced.engine,
          reason: `用户指定引擎 ${forced.engine.id}`,
        }
      : pickEngine(language);
    if (!sel) {
      return {
        pipeline,
        engineId: 'whisper.cpp',
        reason: 'fallback: 无可用候选',
        modelPath: asrModelPath,
      };
    }
    let p = pipelineCache.get(sel.engineId);
    if (!p) {
      p = new TranscribePipeline({ tools, dirs, registry, asr: sel.engine });
      pipelineCache.set(sel.engineId, p);
    }
    /*
     * ⚠️ **模型路径必须跟着引擎走**。
     *
     * `TranscribeChunkRequest.modelPath` 会**覆盖**引擎构造时的默认模型
     * （上游刻意这么设计，为了支持"换模型重跑"）。
     * 所以切到 Paraformer 却仍传 whisper 的 `ggml-*.bin`，
     * sherpa 会拿它当 ONNX 加载并直接报
     * `Please pass *.onnx ... Given '.../ggml-base.en.bin'` —— 实测踩过。
     */
    const enginePaths: Record<string, string | null> = {
      'whisper.cpp': asrModelPath,
      paraformer: paraformerModelPath,
      'sherpa-onnx': stream.dir ?? null,
    };
    return {
      pipeline: p,
      engineId: sel.engineId,
      reason: sel.reason,
      // 用户显式指定的模型路径优先于按引擎推导的默认值
      modelPath: override?.modelPath ?? enginePaths[sel.engineId] ?? asrModelPath,
    };
  };

  const streamModelId = stream.model?.modelId ?? 'none';

  const openStream = (req: { language?: string; signal: AbortSignal }): AsrStream | undefined => {
    // 契约：引擎不可用时不要调 openStream
    if (!sherpa || !sherpaAvailable || !sherpa.openStream) return undefined;
    const streamReq: StreamRequest = {
      modelPath: stream.dir ?? '',
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
    modelPath: asrModelPath,
    vad,
    candidates,
    pickEngine,
    pipelineFor,
    openStream,
    streamModelId,
    streamAvailable: sherpaAvailable,
    paraformerAvailable,
    /*
     * 只装**没构造出来**的那些。构造成功但 `isAvailable()` 为假的（典型：
     * `sherpa-onnx-node` 加载不了）已经在 `candidates` 里带着 `unavailableReason`，
     * main.ts 会把两份并进 health 的 `engines` —— 重复列同一个 id 只会互相盖掉。
     */
    unavailableEngines,
    whisperCliOrigin,
  };
}

/* ==========================================================================
 * 多文件中文模型的发现（T-160）
 *
 * 判据一律是 **"engine 真正需要的那几个文件在不在"**，不是"环境变量设没设"，
 * 也不是"目录叫什么名字"。同一条原则在 VAD 那次修复里写过：
 * `role` 只说"它是干什么用的"，不说"谁能加载它" —— 所以钉后果。
 * ========================================================================== */

const HAS_ONNX = (names: readonly string[], prefix: string): boolean =>
  names.some((n) => n.startsWith(prefix) && n.endsWith('.onnx'));

/**
 * 这条记录长得像一个 **sherpa 流式 transducer** 吗？
 *
 * encoder + decoder + joiner + tokens 四件套 —— 这正是 `OnlineRecognizer` 的
 * `modelConfig.transducer` 要的东西。用**文件形状**判而不是用 id/family 判：
 * 老安装记录里根本没有 `family` 字段，而契约明写「`undefined` = 未知，不得当成空集」。
 */
function looksLikeTransducer(names: readonly string[]): boolean {
  return (
    HAS_ONNX(names, 'encoder') &&
    HAS_ONNX(names, 'decoder') &&
    HAS_ONNX(names, 'joiner') &&
    names.includes('tokens.txt')
  );
}

/** 离线 Paraformer：一个（非 transducer 的）ONNX + tokens.txt。 */
function looksLikeParaformer(names: readonly string[]): boolean {
  if (looksLikeTransducer(names)) return false;
  return names.some((n) => n.endsWith('.onnx')) && names.includes('tokens.txt');
}

interface ResolvedEngineModel<T> {
  readonly model: T | undefined;
  /** 摊出来的模型目录（引擎自己不需要，但 `pipelineFor` 的 modelPath 要）。 */
  readonly dir: string | undefined;
  /** 不可用时给用户的话。可用时是空串。 */
  readonly reasonZh: string;
}

/**
 * F3 流式中文模型。
 *
 * 顺序：`OPENMEMO_SHERPA_STREAM_DIR`（覆盖，开发/自检用）> 已安装模型记录 > 无。
 * **环境变量保留为覆盖手段，不再是唯一开关** —— 它是这条功能死了一整轮的直接原因。
 */
async function resolveStreamingModel(
  modelsDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedEngineModel<SherpaTransducerModel>> {
  const override = env['OPENMEMO_SHERPA_STREAM_DIR'];
  if (override) {
    const model = resolveSherpaModel(override);
    return model
      ? { model, dir: override, reasonZh: '' }
      : {
          model: undefined,
          dir: undefined,
          reasonZh: `OPENMEMO_SHERPA_STREAM_DIR 指向 ${override}，但那里没有 encoder/decoder/joiner/tokens.txt`,
        };
  }

  const records = await listInstalledModelRecords(modelsDir, 'asr');
  const candidates = records.filter((r) => looksLikeTransducer(r.fileNames));
  for (const rec of candidates) {
    const dir = await materializeModelDir(modelsDir, rec);
    const model = dir ? resolveSherpaModel(dir) : undefined;
    if (dir && model) return { model, dir, reasonZh: '' };
  }
  return {
    model: undefined,
    dir: undefined,
    reasonZh:
      candidates.length === 0
        ? '未安装流式中文模型 —— 去「模型」页装 “sherpa 流式中文 zh-14M” 即可启用录音转文字'
        : `已安装 ${candidates.map((c) => c.id).join('、')}，但文件不完整（缺 encoder/decoder/joiner/tokens.txt 之一）`,
  };
}

/** 离线中文引擎（ADR-013 决策 1 的中文默认）。顺序同上。 */
async function resolveOfflineChineseModel(
  modelsDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedEngineModel<ParaformerModel>> {
  const override = env['OPENMEMO_PARAFORMER_DIR'];
  if (override) {
    const model = resolveParaformerModel(override);
    return model
      ? { model, dir: override, reasonZh: '' }
      : {
          model: undefined,
          dir: undefined,
          reasonZh: `OPENMEMO_PARAFORMER_DIR 指向 ${override}，但那里没有 *.onnx + tokens.txt`,
        };
  }

  const records = await listInstalledModelRecords(modelsDir, 'asr');
  const candidates = records.filter((r) => looksLikeParaformer(r.fileNames));
  for (const rec of candidates) {
    const dir = await materializeModelDir(modelsDir, rec);
    const model = dir ? resolveParaformerModel(dir) : undefined;
    if (dir && model) return { model, dir, reasonZh: '' };
  }
  return {
    model: undefined,
    dir: undefined,
    reasonZh:
      candidates.length === 0
        ? '未安装离线中文模型 —— 去「模型」页装 “Paraformer 中文 small” 即可启用（ADR-013：中文默认引擎）'
        : `已安装 ${candidates.map((c) => c.id).join('、')}，但文件不完整（缺 *.onnx 或 tokens.txt）`,
  };
}

/**
 * 标点模型（可选）。
 *
 * 可选不等于不重要：没有它中文转写稿**一个标点都没有**，读起来难受，
 * 作为 F4 的 LLM 输入质量也明显更差。所以能配就配上，但缺了不阻止引擎启用。
 */
async function resolvePunctuation(
  modelsDir: string,
  env: NodeJS.ProcessEnv,
): Promise<PunctuationModel | undefined> {
  const override = env['OPENMEMO_PUNCT_DIR'];
  if (override) return resolvePunctuationModel(override);
  for (const rec of await listInstalledModelRecords(modelsDir, 'punctuation')) {
    const dir = await materializeModelDir(modelsDir, rec);
    const model = dir ? resolvePunctuationModel(dir) : undefined;
    if (model) return model;
  }
  return undefined;
}

/** 从 Paraformer 发布目录解析模型文件。**优先 int8**（CPU 上更快、体积更小）。 */
function resolveParaformerModel(dir: string): ParaformerModel | undefined {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  const onnx =
    files.find((f) => f === 'model.int8.onnx') ??
    files.find((f) => f.endsWith('.int8.onnx')) ??
    files.find((f) => f.endsWith('.onnx'));
  const tokens = files.find((f) => f === 'tokens.txt');
  if (!onnx || !tokens) return undefined;
  return {
    model: join(dir, onnx),
    tokens: join(dir, tokens),
    modelId: 'paraformer-zh-small',
    languages: ['zh', 'en'],
  };
}

/** 标点模型（CT-Transformer）。可选 —— 没有它转写稿零标点。 */
function resolvePunctuationModel(dir: string): PunctuationModel | undefined {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  const onnx = files.find((f) => f.endsWith('.onnx'));
  if (!onnx) return undefined;
  return { model: join(dir, onnx), modelId: 'ct-punct-zh-en' };
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
