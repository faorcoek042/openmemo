/**
 * F1/F2 转写 job runner —— 把 `packages/pipeline` 接到真实 DB 与真实 SSE 上。
 *
 * 这是 T-028 的核心：此前所有部件都各自验证过，但没有一条真实链路把它们串起来。
 *
 * 链路：
 * ```
 * 导入请求 → notes/media_sources 落库 → TranscribePipeline
 *   ├─ fetch/probe/normalize → media_assets(original, audio16k) 落库 + media.ready
 *   ├─ vad → chunk 计划
 *   └─ asr（逐 chunk）
 *        └─ onChunkComplete → transcript_segments 落库（一个事务）→ transcribe.segment SSE
 * → transcripts 收尾（rtf/segment_count/status）→ transcribe.done
 * ```
 *
 * **`onChunkComplete` 必须在段落真正落盘后才 resolve** —— pipeline 把 resolve 当作
 * "这一块已安全持久化"，不会再重放（D-01 §4.5）。
 */
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';

import {
  jobBlockedEvent,
  jobProgressEvent,
  mediaReadyEvent,
  transcribeDoneEvent,
  transcribeSegmentEvent,
  transcribeStartedEvent,
} from '../events.js';
import { ASR_ENGINE_IDS, makeEvent, topics, type AsrEngineId } from '@openmemo/shared';
import {
  PLAN_VERSION,
  formatMergeSummary,
  mergeTranscripts,
  type MergeableSegment,
  type StepProgress,
  type TranscribePipeline,
} from '@openmemo/pipeline';

import { parseWordsJson, type Repos } from '../../db/repos.js';
import { generatePeaksAsset } from '../../media/peaksAsset.js';
import { mayRetitleNote } from './retitle.js';
import type { SseHub } from '../../http/sse.js';
import type { JobQueue, JobRow } from '../queue.js';
import {
  canEngineLoad,
  MODEL_FORMAT_BY_ENGINE,
  resolveModelById,
} from '../../pipeline/modelStore.js';
import { noteVadRuntimeFailure, noteVadRuntimeSuccess } from '../../pipeline/vadStatus.js';

export interface TranscribeRunnerDeps {
  readonly repos: Repos;
  readonly sse: SseHub;
  readonly queue: JobQueue;
  /** 按语言取流水线 —— 中文会切到 Paraformer（ADR-013 决策 1）。 */
  readonly pipelineFor: (
    language: string | undefined,
    override?: { engineId?: string | undefined; modelPath?: string | undefined },
  ) => {
    pipeline: TranscribePipeline;
    engineId: string;
    reason: string;
    modelPath: string | null;
  };
  readonly modelPath: string | null;
  readonly mediaRoot: string;
  /**
   * 数据目录本身。**只用来把落盘路径换算成 `media_assets.rel_path` 的规范形态**
   * （T-151 ①/③），不用来拼输出路径 —— 产物仍只写 `mediaRoot` 底下。
   */
  readonly dataDir: string;
  readonly modelId: string;
  /** 解析用户显式指定的 modelId 需要它。 */
  readonly modelsDir: string;
}

export interface TranscribePayload {
  readonly noteId: number;
  readonly input: string;
  readonly language?: string | null;
  /**
   * 用户为**这一次**转写显式指定的引擎 / 模型 / 初始 prompt。
   *
   * 不设时按原来的逻辑走（`pipelineFor(language)` 选引擎、`active.json` 定模型），
   * 所以老任务的行为一个字没变。
   *
   * `prompt` 是 whisper 的 initial prompt：实测中文初始 prompt 能纠正繁简（ADR-013）。
   * 之前 `TranscribeRequest.prompt` 这个字段**存在但从没有人填过** ——
   * 类型上看得见、实际永远是 undefined，属于"看起来支持其实没接"的那一类。
   */
  readonly engineId?: string | null;
  readonly modelId?: string | null;
  readonly prompt?: string | null;
  readonly sourceKind: string;
  /**
   * F3 两阶段：这是流式稿的离线重跑，跑完要与流式稿做 `mergeTranscripts`。
   * 不设时就是普通转写。
   */
  readonly mergeWithTranscriptId?: number;
}

/**
 * 把一个路径规范化到**同一种写法**再拿去比较。
 *
 * `relative()` 是**纯字符串运算** —— 同一个文件在两种合法写法下算出来的相对路径
 * 完全不同，而两边都"对"。本仓已经为此付过账（见 `archiveIntoMedia` 里的说明）。
 * 两个真实来源：
 *   · macOS：`os.tmpdir()` 给的是 `/var/folders/…`，而 `/var` 是指向 `/private/var`
 *     的符号链接 —— 解析过的路径与没解析过的对不上；
 *   · Windows：`%TEMP%` 常常是 8.3 短名（`C:\Users\RUNNER~1\…`），长名是
 *     `C:\Users\runneradmin\…`。
 *
 * `realpathSync.native` 两种都能拉平（Windows 上它返回长名，POSIX 上它解符号链接），
 * 没有 native 就退回 JS 版；路径还不存在就原样返回 —— **绝不抛**，
 * 因为这个函数只是"把比较放到同一个坐标系里"，它失败不该让归档失败。
 */
function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }
}

/**
 * `pipelineFor()` 返回的 `engineId` 是 `string`，而格式表按 `AsrEngineId` 索引。
 *
 * 认不出来时返回 `undefined` 而**不是**抛 —— 这个函数是用来加固的，
 * 它自己不该成为一条新的失败路径。认不出的引擎 = 不做这层检查（与改动前同）。
 */
function asAsrEngineId(id: string): AsrEngineId | undefined {
  return (ASR_ENGINE_IDS as readonly string[]).includes(id) ? (id as AsrEngineId) : undefined;
}

/** 把绝对路径转成相对 media 根的路径（D-02 §1.1：绝不存绝对路径，数据目录可搬迁）。 */
/**
 * 把产物**归档进 media 根**，返回相对路径。
 *
 * ## 这里原来是个会丢数据的坑
 * 旧实现是「算相对路径，带 `..` 就原样存绝对路径」。后果两条叠加：
 * 1. 归一化音频落在 `<dataDir>/tmp/job-*`，于是 `audio16k` 存的是**绝对路径** ——
 *    用户一搬数据目录，路径失效，音频 403（`original` 因为在别处仍 200，更难察觉）。
 *    我在 `InstalledFile` 上做过 root+relPath 改造，`media_assets` 这条**没跟上**。
 * 2. `tmp/` 在设置页里被标成「可随时删」，而里面躺着**已入库的资产** ——
 *    用户照 UI 说的删一次，就删掉一个笔记的音频。
 *
 * 所以不再"存绝对路径兜底"，而是**真的把文件搬进 media/**：
 * 相对路径天然成立，`tmp/` 也重新变回名副其实的"可随时删"。
 */
export async function archiveIntoMedia(
  mediaRoot: string,
  noteUid: string,
  abs: string,
  name: string,
): Promise<string> {
  /*
   * ★ 比较之前**两边都要规范化**（CI run 31247843782 抓到的）。
   *
   * 事故形态：F3 录音停止后，WAV 就躺在 `<mediaRoot>/recordings/<ULID>.wav`，
   * 本该命中下面那句「已经在 media/ 里就别动它」。但在 **macOS 与 Windows** 上
   * 这句判断落空了（`/var` vs `/private/var`；8.3 短名 vs 长名），于是录音被
   * `rename()` **搬到** `<mediaRoot>/<noteUid>/` 下，并新插一条 `role='original'`。
   * 后果两条，都是用户可见的：
   *   ① 原来那条 `original` 资产的 `rel_path` 指向一个已经空掉的位置 ——
   *      `/media/asset/<uid>` **404**，笔记详情页的播放器当场废掉
   *      （实测：同一条笔记上出现两条 `role='original'`，先来的那条 404）；
   *   ② `media_sources.input_url` 记的也是那个老位置，于是**之后每一次
   *      「重新转写」都失败**：`no media source can handle this input`。
   *      实测 macOS/Windows 第一次重转成功、第二次起全挂；Linux 三次全过 ——
   *      因为 `/tmp` 既没有符号链接也没有短名，**这个 bug 在 Linux 上不可见**。
   *
   * 判据不是"记得传规范化过的路径进来"，是"**传什么写法进来结论都一样**"。
   */
  const rootC = canonical(mediaRoot);
  const absC = canonical(abs);
  const rel = relative(rootC, absC);
  // 已经在 media/ 里就别动它（重跑时会走到这里）
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;

  const destDir = join(mediaRoot, noteUid);
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, name);
  try {
    await rename(abs, dest);
  } catch (err) {
    // 跨设备或源已不在：复制兜底；再失败就让调用方看到真错误，不要静默留下坏路径
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') await copyFile(abs, dest);
    else throw err;
  }
  return relative(mediaRoot, dest);
}

export async function runTranscribeJob(
  job: JobRow,
  deps: TranscribeRunnerDeps,
  signal: AbortSignal,
): Promise<void> {
  const { repos, sse, queue } = deps;
  const payload = JSON.parse(job.payload_json) as TranscribePayload;

  /*
   * 用**过滤版** `noteById`：与 mindmap runner 同一条理由 ——
   * 笔记在排队期间被删掉就该停，不为已删笔记转写（还会白白落一份媒体文件）。
   */
  const note = repos.noteById(payload.noteId);
  if (!note) throw new Error(`note ${payload.noteId} 不存在`);

  // 缺模型/缺工具 → 转 blocked 而不是 failed（D-01 §4.1：可点击修复的等待态）
  /*
   * 用户显式指定的模型 id → 真实权重路径。解析不到就**不静默忽略**：
   * 退回自动选择，但把这件事记进日志，否则"我选了 large-v3 却跑了 base"无从发现。
   */
  /*
   * ★ 先问一次「不给覆盖的话会用哪个引擎」，再拿这个引擎去解析用户指定的模型。
   *
   * 顺序不能反。模型能不能用**取决于谁来加载它** —— 在知道引擎之前，
   * 「这个 modelId 可用吗」这个问题没有答案。原来的代码先解析模型、再选引擎，
   * 于是一个 sherpa 的 ONNX 模型可以一路走到 whisper.cpp 手里
   * （`[CI 实测]` 那正是录音后自动重跑三平台全挂的成因）。
   * `pipelineFor` 只是把几个引用装进对象并带缓存，问两次是廉价的。
   */
  const baseline = deps.pipelineFor(payload.language ?? undefined, {
    ...(payload.engineId ? { engineId: payload.engineId } : {}),
  });
  const baselineEngine = asAsrEngineId(baseline.engineId);

  let overrideModelPath: string | undefined;
  if (payload.modelId) {
    const m = baselineEngine
      ? await resolveModelById(deps.modelsDir, {
          role: 'asr',
          engine: baselineEngine,
          id: payload.modelId,
        })
      : undefined;
    if (m) overrideModelPath = m.path;
    else {
      /*
       * 分两种情形说清楚 —— 它们的处置完全不同，混成一句"未安装"会把人带偏：
       * 装了但引擎读不了 ≠ 没装。
       */
      console.warn(
        `[transcribe] 指定的模型 ${payload.modelId} 不可用（未安装，` +
          `或 ${baseline.engineId} 加载不了它的格式），回退到自动选择`,
      );
    }
  }
  const chosenEarly = deps.pipelineFor(payload.language ?? undefined, {
    ...(payload.engineId ? { engineId: payload.engineId } : {}),
    ...(overrideModelPath ? { modelPath: overrideModelPath } : {}),
  });
  if (!chosenEarly.modelPath) {
    const remediation = {
      action: 'installModel',
      params: { role: 'asr' },
      labelZh: '去安装语音识别模型',
      label: 'Install an ASR model',
    };
    queue.block(job.id, 'MISSING_ASR_MODEL', remediation);
    sse.publish(
      jobBlockedEvent(
        job.uid,
        'MISSING_ASR_MODEL',
        '尚未安装语音识别模型',
        'ASR model not installed',
        remediation,
      ),
    );
    return;
  }

  // 按语言选引擎（ADR-013 决策 1：中文默认 Paraformer）。
  // engine_id 落库的是**实际用的**引擎，不是硬编码 —— 否则永远看不出选择有没有生效。
  const chosen = chosenEarly;

  /*
   * ★★ 最后一道闸：**引擎与模型在这里第一次真正碰面，就在这里对一次账。**
   *
   * 上游（`ModelQuery.engine` 必填 + `MODEL_FORMAT_BY_ENGINE`）已经让"拿到一个
   * 本引擎读不了的模型"在类型上表达不出来。这一条不是重复那件事，它守的是
   * **绕过解析器的那些路**：`OPENMEMO_ASR_MODEL` 环境变量、`scanByName` 兜底扫描、
   * 用户手工拷进 `by-name/` 的文件 —— 它们都不经过 `resolveActiveModel`。
   *
   * 判据是"失败得响亮且可诊断"。在此之前，这条路上的失败长这样：
   *     whisper-cli exited with code 3
   *     error: failed to initialize whisper context
   * 用户（和我们自己）对着它猜了三轮。现在直接说出是谁拿了谁的模型。
   */
  /*
   * ⚠️ **只在文件真的存在时才判**。
   *
   * `canEngineLoad` 对"文件不在"和"格式不对"都回 false —— 对**挑候选**来说这样很对
   * （两种都不该选它）。但在这里它们是两回事：
   *   · 格式不对 → 就是本闸要抓的那个，报出来
   *   · 文件不在 → 是另一条路上的失败（模型没装/被删），它有自己的处置
   *     （上游的 `MISSING_ASR_MODEL` blocked 态、或引擎自己的报错）
   * 不分开的话，本闸会把"没装模型"说成"引擎加载不了这个模型"，
   * 把人往完全错误的方向指 —— 而"失败得可诊断"正是这道闸存在的全部理由。
   * （`[实测]` 第一版没分，`mergeWords.test.ts` 里 3 条 T-164 回归用例当场红：
   *   它们的夹具声明了一个从不创建的 modelPath。那个红是对的，红的是我这道闸。）
   */
  const chosenEngine = asAsrEngineId(chosen.engineId);
  if (
    chosen.modelPath &&
    chosenEngine &&
    existsSync(chosen.modelPath) &&
    !(await canEngineLoad(chosenEngine, chosen.modelPath))
  ) {
    throw new Error(
      `引擎 ${chosen.engineId} 加载不了这个模型：${chosen.modelPath}` +
        `（它要的是 ${MODEL_FORMAT_BY_ENGINE[chosenEngine]} 格式）。` +
        `多半是 active.json 里该 role 指向了另一个引擎的模型，` +
        `或 OPENMEMO_ASR_MODEL 指到了别的格式。` +
        `请在「模型」页把 asr 切到一个 ${chosen.engineId} 能用的模型再重试。`,
    );
  }
  /*
   * 续跑（D-01 §4.5）：先找有没有同引擎同模型、还没跑完的稿。
   * 有就**接着写**，不新建 —— 新建会让 completedChunks 查到空表而全量重跑，
   * 并且把用户已经看到的旧稿置为非活跃。
   */
  const modelId = chosen.modelPath
    ? (chosen.modelPath.split('/').pop() ?? deps.modelId)
    : deps.modelId;
  const resumable = repos.resumableTranscript(note.id, chosen.engineId, modelId);
  const transcript =
    resumable ??
    repos.createTranscript({
      noteId: note.id,
      engineId: chosen.engineId,
      // modelId 也必须跟着引擎走 —— 否则 engine=paraformer 却记着 whisper 的 ggml 文件名，
      // 排障时会把人带偏（实测出现过 engine=paraformer / model=ggml-base.en.bin）
      modelId,
      language: payload.language ?? null,
    });
  if (resumable) {
    console.log(
      `[transcribe] 续跑 transcript=${transcript.uid}，已完成 chunk=${[...repos.completedChunks(transcript.id)].join(',') || '(无)'}`,
    );
  }

  // 续跑：DB 里的段落才是真相，checkpoint 只是加速缓存（D-01 §4.5）
  const completed = repos.completedChunks(transcript.id);

  /*
   * transcribe.started 必须在任何 transcribe.segment 之前发出。
   * 前端靠它建立 transcriptUid → noteUid 的映射；缺了这条，
   * 后续的 segment 事件就成了没有归属的孤儿（T-028 我漏发过，architect 报的）。
   * durationSec 此刻还不知道（probe 尚未跑），先发 0，media.ready 会带准确值。
   */
  sse.publish(
    transcribeStartedEvent({
      transcriptUid: transcript.uid,
      noteUid: note.uid,
      modelId: deps.modelId,
      durationMs: 0,
      language: payload.language ?? null,
    }),
  );

  let lastProgress = -1;
  const onProgress = (p: StepProgress): void => {
    const overall = stepFraction(p);
    queue.setProgress(job.id, overall, p.step);
    repos.updateTranscript(transcript.id, { progress: overall });
    // 进度类事件走节流（250ms 合并），避免刷爆 SSE
    if (Math.abs(overall - lastProgress) > 0.001) {
      lastProgress = overall;
      sse.publish(
        jobProgressEvent(job.uid, { step: p.step, fraction: overall, state: 'running' }),
        topics.job(job.uid),
      );
    }
  };

  let segSeq = repos.segmentsOf(transcript.id).length;
  let mediaAnnounced = false;

  const result = await chosen.pipeline.run({
    input: payload.input,
    jobId: job.uid,
    modelPath: chosen.modelPath as string, // 上面 chosenEarly.modelPath 已判空
    ...(payload.language ? { language: payload.language } : {}),
    // 用户指定的初始 prompt：真的传下去，不再是个永远为空的字段
    ...(payload.prompt ? { prompt: payload.prompt } : {}),
    priority: job.priority,
    signal,
    planVersion: PLAN_VERSION,
    completedChunkIndices: completed,
    onProgress: (p) => {
      // normalize 完成时就可以把媒体资产落库并广播 media.ready，让前端先出播放器
      if (!mediaAnnounced && (p.step === 'vad' || p.step === 'asr')) mediaAnnounced = true;
      onProgress(p);
    },
    onChunkComplete: async (chunk, segments) => {
      // ★ 必须真正落盘后才 resolve ★
      const written = repos.insertSegments(
        transcript.id,
        segments.map((s) => ({
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          confidence: s.confidence,
          noSpeechProb: s.noSpeechProb,
          words: s.words,
          chunkIdx: s.chunkIdx,
          flags: s.flags,
        })),
      );
      void written;
      // 增量结果**不能丢**，所以不传 throttleTopic（D-01 §3.3）
      for (const s of segments) {
        sse.publish(
          transcribeSegmentEvent({
            transcriptUid: transcript.uid,
            noteUid: note.uid,
            seq: segSeq++,
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
            speaker: s.speakerLabel,
            confidence: s.confidence,
          }),
        );
      }
      void chunk;
      return Promise.resolve();
    },
  });

  /*
   * ---- 切分方式：**只要不是无声无息地过去** ----------------------------------------
   *
   * T-148 之前，VAD 跑失败会让整单转写死掉。现在它退回固定窗口继续跑 ——
   * 那就必须在三个地方说出来，否则这个修复本身就是一次"把响亮的失败换成安静的降级"：
   *   ① daemon 日志（下面这行）
   *   ② `/api/health` → 诊断页那一行（靠 `vadStatus` 这一格）
   *   ③ job 的成功结果里带上原文（`queue.succeed` 的 payload）
   */
  if (result.warningsZh.length > 0) {
    noteVadRuntimeFailure(result.warningsZh[0] as string);
    for (const w of result.warningsZh) console.warn(`[transcribe] ⚠️ ${w}`);
  } else if (result.chunking === 'vad') {
    noteVadRuntimeSuccess();
  }

  // ---- 媒体资产落库 ----
  /*
   * 先归档再落库：**顺序不能反**。
   * 反过来会先写一条指向 tmp 的记录，万一归档失败就留下一条永远读不到的资产。
   */
  const originalRel = await archiveIntoMedia(
    deps.mediaRoot,
    note.uid,
    result.media.path,
    basename(result.media.path),
  );
  const normalizedRel = await archiveIntoMedia(
    deps.mediaRoot,
    note.uid,
    result.normalizedPath,
    'audio16k.wav',
  );

  /*
   * ★ `mime` **刻意不填**（判断，不是遗漏 —— 写在这里免得下一个人"顺手补上"）。
   *
   * `media_assets.mime` 对 original/audio16k 一直是 NULL，而 `/media/asset/:uid`
   * 在 mime 为空时按**扩展名** `guessMime(abs)` 兜底。`[CI 实测 run 31247374404]`
   * 三平台 × 四种容器（wav/mp3/m4a/mp4）的 Content-Type **全部正确**。
   *
   * 那"补上真值"不是更好吗？—— 不是，因为能拿到的那个值**更不可信**：
   *   · 上传那条路的 `contentType` 来自浏览器 multipart 里的一行字，
   *     本脚本发的就是 `application/octet-stream`；真填进去，`/media` 就会
   *     用它替掉现在这个正确答案，**mp3 反而变得不可播**（浏览器不认）。
   *   · 链接导入那条来自远端服务器的响应头，同样是对方说了算。
   * 也就是说：把一个"别人声称的类型"写进库，会挤掉一个"我们自己算得准的类型"。
   * D-01 §8.5 的原则也是这个方向 —— 信 ffprobe / 我们自己的判定，不信对端的声明。
   *
   * 所以结论是：**保持 NULL，由 `/media` 按扩展名判定**。将来真要用 mime 的消费者，
   * 应当调 `guessMime()`，不要读这一列。
   */
  const originalAsset = repos.createAsset({
    noteId: note.id,
    role: 'original',
    relPath: originalRel,
    displayName: basename(payload.input),
    durationMs: result.durationMs,
    bytes: result.media.sizeBytes,
  });
  repos.createAsset({
    noteId: note.id,
    role: 'audio16k',
    relPath: normalizedRel,
    durationMs: result.durationMs,
    sampleRate: 16000,
    channels: 1,
  });

  /*
   * ★ 波形峰值（T-151 ③）—— **daemon 这边第一次真的产出 `role='peaks'`**。
   *
   * 在这之前全仓零处写这个角色，而前端有一整套解码 + 绘制。后果不是"没有波形"，
   * 是 `NoteDetailPage` 用 `mockPeaks()` **凭空编了一条**，每个用户看到的每条波形都是假的
   * （T-139 A3 已把假的删掉，缺的就是这里）。D-07 #18 / D-08 #18 两次盘点都记的 🔴。
   *
   * **不需要再调一次 ffmpeg**：上面这个 `audio16k` 就是 16 kHz 单声道 PCM16 WAV，
   * 而且刚刚被归档进 media 根 —— 盘上躺着的已经是解码后的 PCM，
   * 再 spawn 一个 ffmpeg 去解一遍是把做完的事重做。所以这里直接读它。
   *
   * 放在转写**之后**：波形只用来看，稿子才是用户等的东西；
   * 而且这一步失败了也只降级成"无波形"（`generatePeaksAsset` 自己吞掉并打日志），
   * 绝不让一单已经转好的稿子因为画不出波形而失败。
   */
  const peaks = await generatePeaksAsset(
    { repos, sse, mediaRoot: deps.mediaRoot, dataDir: deps.dataDir },
    { noteId: note.id, noteUid: note.uid, wavPath: join(deps.mediaRoot, normalizedRel) },
  );
  if (peaks) {
    console.log(
      `[transcribe] 波形已生成：${peaks.relPath}（${peaks.buckets} 桶 / ${peaks.bytes} 字节）`,
    );
  }

  sse.publish(
    mediaReadyEvent({
      noteUid: note.uid,
      mediaUid: originalAsset.uid,
      durationMs: result.durationMs,
      title: result.info.title ?? null,
      /*
       * ★ 这里此前是写死的 `false`，**导入一个 mp4 也报"没有视频"**。
       *
       * 它一度被判成"零读者、可以删"——那个判断是错的，因为 `grep` 只扫了
       * `.ts/.tsx`：真正的读者在 e2e 侧和 `packages/shared/openapi.yaml` 里。
       *
       * ★ 2026-08-11 更新读者指向：原来指的 `apps/daemon/scripts/e2e-f2.mjs` **已删**
       *   （它要一个外部已经跑着的 daemon + 音频，从来没有任何自动调用方）。
       *   这条契约现在由 `scripts/ci/e2e-import-audit.mjs:1113` **真断言**
       *   （`ready.hasVideo !== wantVideo` → 判红「契约字段在说谎」），
       *   而那个脚本由 `.github/workflows/e2e-import.yml:202` 真的跑。
       *   **读者从"没人跑的脚本"换成了"CI 里会红的断言"——比原来强。**
       * 有读者的契约字段，就该给它**真值**，而不是删掉或继续说谎。
       *
       * `audioOnly` 是适配器**实际探到**的结果（`FetchedMedia.audioOnly`，由 ffprobe
       * 的流信息得出，不是靠扩展名猜的），所以取反就是"这份媒体有没有视频轨"。
       */
      hasVideo: result.media.audioOnly === false,
    }),
  );

  /*
   * F3 两阶段合并（D-06 §15.2 冻结契约）。
   *
   * `mergeTranscripts` 此前**零调用方** —— 录音会话在 payload 里塞了
   * `mergeWithTranscriptId`，但 runner 从来没读过它。于是"用户改过的段落在重跑后保留"
   * 这条被实测验证过的逻辑，在产品里根本走不到。
   *
   * 规则（冻结）：编辑过的一律保留（有无对应都不覆盖不删除），未编辑的用重跑替换/删除，
   * 重跑新发现的新增。匹配按**时间重叠**不按索引 —— 两遍模型切分天然不同。
   */
  let mergeSummary: string | undefined;
  /*
   * `!== transcript.id` 这个判断不能省：REST 重跑传的是"当前活跃稿"的 id，
   * 而 runner 可能通过 `resumableTranscript()` **复用同一份稿**继续写。
   * 那种情况下 draft 和 rerun 会是同一行集合，自己跟自己合并没有意义，
   * 还会把刚写进去的段落当成"草稿"再处理一遍。
   */
  if (
    payload.mergeWithTranscriptId !== undefined &&
    payload.mergeWithTranscriptId !== transcript.id
  ) {
    const draftRows = repos.segmentsOf(payload.mergeWithTranscriptId);
    const rerunRows = repos.segmentsOf(transcript.id);
    if (draftRows.length > 0) {
      const draft: MergeableSegment[] = draftRows.map((r) => ({
        id: r.id,
        startMs: r.start_ms,
        endMs: r.end_ms,
        text: r.text,
        confidence: r.confidence,
        noSpeechProb: r.no_speech_prob,
        words: parseWordsJson(r.words_json),
        chunkIdx: r.chunk_idx ?? 0,
        flags: r.flags,
        speakerLabel: null,
        editedAt: r.edited_at,
      }));
      const rerun = rerunRows.map((r) => ({
        startMs: r.start_ms,
        endMs: r.end_ms,
        text: r.text,
        confidence: r.confidence,
        noSpeechProb: r.no_speech_prob,
        words: parseWordsJson(r.words_json),
        chunkIdx: r.chunk_idx ?? 0,
        flags: r.flags,
        speakerLabel: null,
      }));
      const merged = mergeTranscripts(draft, rerun);
      /*
       * 从 decisions 里取出"被保留（因为用户编辑过）"的那些段的 editedAt。
       *
       * 不直接对 `merged.segments` 做类型断言：它的静态类型是 `TranscriptSegment[]`，
       * 上面并没有 `editedAt`。用 `as` 强行读一个类型上不存在的字段，
       * 正是我在 SSE 事件那次踩过的坑（编译器被消音，契约错位没人发现）。
       * `decisions` 是**类型上就带 `MergeableSegment` 的**，从它取是安全的。
       */
      const editedAtBySpan = new Map<string, number>();
      for (const d of merged.decisions) {
        if (d.action === 'preserved' && d.segment.editedAt != null) {
          editedAtBySpan.set(`${d.segment.startMs}:${d.segment.endMs}`, d.segment.editedAt);
        }
      }
      repos.replaceSegments(
        transcript.id,
        merged.segments.map((sg) => ({
          startMs: sg.startMs,
          endMs: sg.endMs,
          text: sg.text,
          confidence: sg.confidence,
          noSpeechProb: sg.noSpeechProb,
          words: sg.words,
          chunkIdx: sg.chunkIdx,
          flags: sg.flags,
          // ★ 把"用户改过"这个事实一起写回，否则下一次重跑会把它当新稿覆盖掉
          editedAt: editedAtBySpan.get(`${sg.startMs}:${sg.endMs}`) ?? null,
        })),
      );
      mergeSummary = formatMergeSummary(merged.stats);
      console.log(`[transcribe] 两阶段合并：${mergeSummary}`);
    }
  }

  // ---- 收尾 ----
  const segCount = repos.segmentsOf(transcript.id).length;
  repos.updateTranscript(transcript.id, {
    status: result.yielded ? 'partial' : 'done',
    progress: result.yielded ? lastProgress : 1,
    durationMs: result.durationMs,
    rtf: result.rtf,
  });
  /*
   * ⚠️ **绝不覆盖用户已有的标题**。
   *
   * 之前这里无条件用媒体元数据的标题覆盖 `notes.title`，后果是**用户数据被静默改写**：
   * F3 录音笔记（用户在 URL 里传了 title）转写完自己变成了 recordingUid，
   * 用户重命名过的笔记也会在离线重跑后被改回文件名。
   * 缺功能用户会报，静默改名用户只会觉得"这软件有鬼"。
   *
   * 规则：只有当笔记标题还是**导入时的占位值**（等于原始输入的文件名/URL basename）
   * 时，才允许用更好的媒体标题替换它。录音（kind='recording'）一律不覆盖。
   */
  const mayRetitle = mayRetitleNote({
    noteKind: note.kind,
    currentTitle: note.title,
    input: payload.input,
    mediaTitle: result.info.title,
  });

  repos.updateNote(note.id, {
    status: result.yielded ? 'partial' : 'ready',
    durationMs: result.durationMs,
    ...(mayRetitle ? { title: result.info.title as string } : {}),
  });

  sse.publish(
    transcribeDoneEvent({
      transcriptUid: transcript.uid,
      noteUid: note.uid,
      segmentCount: segCount,
      rtf: result.rtf,
      partial: result.yielded,
    }),
  );
  sse.publish(
    makeEvent('note.updated', topics.note(note.uid), {
      noteUid: note.uid,
      changed: ['transcript'],
    }),
  );

  queue.succeed(job.id, {
    transcriptUid: transcript.uid,
    segmentCount: segCount,
    rtf: result.rtf,
    durationMs: result.durationMs,
    chunking: result.chunking,
    ...(result.warningsZh.length > 0 ? { warningsZh: result.warningsZh } : {}),
    ...(mergeSummary === undefined ? {} : { mergeSummary }),
  });
}

/**
 * 把「步骤内进度」折算成整体进度。
 * 权重按实测耗时占比给（ASR 占绝大部分），这样进度条不会在 asr 阶段卡死不动。
 */
function stepFraction(p: StepProgress): number {
  const weights: Record<string, [number, number]> = {
    fetch: [0.0, 0.08],
    probe: [0.08, 0.1],
    normalize: [0.1, 0.2],
    vad: [0.2, 0.25],
    asr: [0.25, 0.99],
    done: [1, 1],
  };
  const [lo, hi] = weights[p.step] ?? [0, 1];
  return Math.min(1, Math.max(0, lo + (hi - lo) * Math.max(0, Math.min(1, p.fraction))));
}
