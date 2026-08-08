/**
 * F3 录音会话：浏览器麦克风 → WS → `AsrStream` → 落库 → 停止后自动排离线重跑。
 *
 * 严格按 D-06 §15.1 的**冻结契约**接线。那 8 条调用语义不是建议，是踩过的坑：
 *
 * | # | 语义 | 我这里怎么依赖它 |
 * |---|---|---|
 * | 1 | `write()` 同步返回、内部排队 | WS 的 message 回调里直接调，不 await |
 * | 2 | `close()` 先排空再封死 | 收到 stop 后先 `close()` 再收尾，不会丢最后一句 |
 * | 3 | `close()` 幂等 | WS 断线与显式 stop 都会调，重复安全 |
 * | 4 | `partial` 的 text 单调增长 | 直接整句替换推给前端，不做 diff |
 * | 5 | 时间戳是相对录音开始的绝对毫秒 | 直接落 `start_ms`，无需再偏移 |
 * | 6 | `final` 的 chunkIdx 从 0 递增 | 直接落 `chunk_idx` |
 * | 7 | `close()` 后 `write()` 静默忽略 | 不用自己加关闭判断 |
 *
 * **停止后的动作**（D-06 §15.2 给 daemon 的调度要求）：
 * 排一个 `priority = PRIORITY.INTERACTIVE` 的离线重跑 job；完成后 `mergeTranscripts`
 * 把用户编辑过的段落保住，再把 `formatMergeSummary` 推给前端。
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AsrStream, TranscriptSegment } from '@openmemo/pipeline';
import { PRIORITY } from '@openmemo/pipeline';
import { canonicalAssetRelPath } from '@openmemo/runtime';
import { makeEvent, topics, ulid, type SseEvent } from '@openmemo/shared';

import type { Repos } from '../db/repos.js';
import type { SseHub } from '../http/sse.js';
import type { JobQueue } from '../jobs/queue.js';
import { generatePeaksAsset } from '../media/peaksAsset.js';

/** 16 kHz 单声道 int16 —— 与 `AsrStream.write()` 的契约一致。 */
export const RECORD_SAMPLE_RATE = 16_000;

/**
 * 上行背压上限（D-01 §3.4）：积压超过 3 秒就丢最老的帧。
 * 实时转写**宁可丢也不能无限缓冲把内存吃爆**。
 */
export const MAX_BACKLOG_MS = 3000;
const MAX_BACKLOG_SAMPLES = (RECORD_SAMPLE_RATE * MAX_BACKLOG_MS) / 1000;

export interface RecorderDeps {
  readonly repos: Repos;
  readonly queue: JobQueue;
  readonly sse: SseHub;
  readonly mediaDir: string;
  /**
   * 数据目录本身。**只用来把落盘路径换算成 `media_assets.rel_path` 的规范形态**
   * （`canonicalAssetRelPath`），不用来拼任何输出路径 —— 录音仍只写 `mediaDir` 底下。
   *
   * 为什么不由 `dirname(mediaDir)` 推：那是"两个地方各自约定 media 目录叫什么"，
   * 而这个字段一旦与 `paths.mediaDir` 脱钩就会静默算错基准 —— T-136 的病根正是
   * 「同一列每个人各挑各的基准」。让调用方把两个都传进来，两者的关系只在 `paths.ts` 定义一次。
   */
  readonly dataDir: string;
  /** 打开一路流式识别；引擎不可用时返回 undefined（**不要**调 openStream）。 */
  readonly openStream: (req: { language?: string; signal: AbortSignal }) => AsrStream | undefined;
  readonly streamModelId: string;
}

export interface RecorderSessionInit {
  readonly language?: string | undefined;
  readonly title?: string | undefined;
}

interface Ready {
  type: 'ready';
  recordingUid: string;
  noteUid: string;
  transcriptUid: string;
  sampleRate: number;
}

export type ServerMessage =
  | Ready
  | { type: 'partial'; utteranceId: string; text: string; startMs: number }
  | { type: 'final'; seq: number; startMs: number; endMs: number; text: string }
  | { type: 'overrun'; droppedSamples: number }
  | { type: 'stopped'; segmentCount: number; rerunJobUid: string | null }
  | { type: 'error'; code: string; messageZh: string };

/**
 * 一路录音会话。**一个 WS 连接对应一个实例**。
 */
export class RecorderSession {
  readonly recordingUid = ulid();
  #noteId = 0;
  #transcriptId = 0;
  #noteUid = '';
  #transcriptUid = '';
  #stream: AsrStream | undefined;
  #abort = new AbortController();
  #wav: WriteStream | undefined;
  #wavPath = '';
  #bytesWritten = 0;
  #startedAt = 0;
  #seq = 0;
  #backlogSamples = 0;
  #closed = false;
  #utterance = ulid();

  constructor(
    private readonly deps: RecorderDeps,
    private readonly send: (msg: ServerMessage) => void,
  ) {}

  get noteUid(): string {
    return this.#noteUid;
  }

  /**
   * 这一路会话有没有真的开起来。
   *
   * `start()` **正常 resolve 也可能什么都没开成**（引擎不可用那一支）。
   * 调用方（`http/ws.ts`）必须据此把 socket 关掉，否则浏览器会继续推流、
   * 用户会继续看着"录音中"，而服务端一帧都不收。
   */
  get active(): boolean {
    return this.#stream !== undefined;
  }

  async start(init: RecorderSessionInit): Promise<void> {
    const { repos, sse } = this.deps;
    this.#startedAt = Date.now();

    /*
     * ★ 引擎必须**先于任何落库/落盘**拿到（T-164 ②）。
     *
     * 原来的顺序是：建 note → 建 transcript → 建 WAV 文件 → 才去 openStream，
     * 拿不到引擎时只 `send(error)` + `#emitState('failed')` 然后 `return` ——
     * 但 `start()` **正常 resolve**，`ws.ts` 于是把 `started` 置真、socket 不关。
     * 用户点停止（或者仅仅关掉标签页 → `ws.on('close')` → `abandon()`）时
     * `stop()` 会**照常跑完整条收尾链**：回填 44 字节的空 WAV 头 → `createAsset` →
     * 对一个 0 采样的文件生成 peaks → `updateNote(status:'ready')`。
     *
     * 结果是列表里多一条 **0 秒、打不开、状态却是「就绪」**的死笔记。
     * 触发条件不是什么边角情形：**只要没装流式模型，任何人点一次「开始录音」就会中招。**
     *
     * 所以判据不是"要不要多发一条错误消息"，而是**失败时不许在库里留下任何行**：
     * 引擎拿不到 → 一行都不建、一个文件都不落、`#closed` 置真让 `stop()`/`abandon()`
     * 变成 no-op，然后由 `ws.ts` 关闭连接。
     */
    const stream = this.deps.openStream({
      ...(init.language ? { language: init.language } : {}),
      signal: this.#abort.signal,
    });
    if (!stream) {
      // 契约：isAvailable() 为假时**不要**调 openStream；这里已由 deps 层保证
      this.#closed = true; // ← stop()/abandon() 从此是 no-op，收尾链一步都不会走
      this.send({
        type: 'error',
        code: 'ASR_STREAM_UNAVAILABLE',
        messageZh: '流式识别引擎不可用（未安装流式模型）',
      });
      this.#emitState('failed');
      return;
    }

    /*
     * 落盘路径要**先算出来**（真正建目录/建流在下面），因为 `media_sources.input_url`
     * 需要它 —— 见紧接着 `createSource` 的那段说明。
     */
    const dir = join(this.deps.mediaDir, 'recordings');
    this.#wavPath = join(dir, `${this.recordingUid}.wav`);

    const note = repos.createNote({
      title: init.title ?? `录音 ${new Date().toLocaleString('zh-CN')}`,
      kind: 'recording',
      language: init.language ?? null,
    });
    this.#noteId = note.id;
    this.#noteUid = note.uid;
    /*
     * ★ `originalUrl` **必须存**，这里原来是不传（于是 `input_url` 恒为 NULL）。
     *
     * 这是**同一个缺陷的第三次**，前两次的修法和理由都已经写在隔壁：
     *   · `rest/notes.ts` 的本地导入分支：「本地路径**也要存**。D-02 对 `input_url`
     *     的定义是"用户原始输入"，不限于 URL。之前存 null，结果**取消后无法重跑**
     *     （不知道源文件在哪），续跑、换模型重跑、重新转写全都做不了。」
     *   · `http/upload.ts` 的拖拽上传分支：同一段话，标题写的是「**upload 没跟上**」。
     * **录音这条也没跟上。** 后果链一字不差地闭合在 F3 的每一条笔记上：
     *   `rest/notes.ts:648` 的 `canRetranscribe: input_url != null` → **恒 false**
     *   → 「重新转写」按钮在**每一条录音笔记**上永久禁用；
     *   绕过按钮直接打 `POST /api/notes/:uid/retranscribe`，`rest/content.ts:256`
     *   也回 409 `NO_SOURCE_INPUT`。换语言、换模型、失败重跑 —— 对录音一律不可用。
     *
     * 存的就是**停止录音时会写进去的那个 WAV**，与 `stop()` 里排离线重跑用的
     * `input: this.#wavPath` 是同一个值 —— 也就是说这条通道走的是一条
     * **产品已经在走**的路径，不是新开的。
     */
    repos.createSource({
      noteId: note.id,
      kind: 'recording',
      title: note.title,
      originalUrl: this.#wavPath,
    });

    // 流式稿标 kind='streaming'：后面离线重跑会产出 kind='final' 的新稿并接管 is_active
    const transcript = repos.createTranscript({
      noteId: note.id,
      engineId: 'sherpa-onnx',
      modelId: this.deps.streamModelId,
      language: init.language ?? null,
      kind: 'streaming',
    });
    this.#transcriptId = transcript.id;
    this.#transcriptUid = transcript.uid;

    // 原始 PCM 落盘 —— 离线重跑要用它，而且用户可能想保留录音
    // （路径在上面建 note 之前就算好了，`input_url` 要用同一个值）
    await mkdir(dir, { recursive: true });
    this.#wav = createWriteStream(this.#wavPath);
    this.#wav.write(wavHeaderPlaceholder());

    this.#stream = stream;

    stream.on('partial', (seg: TranscriptSegment) => {
      // 语义 4：同一句内 text 单调增长 → 前端整句替换，不必 diff
      this.send({
        type: 'partial',
        utteranceId: this.#utterance,
        text: seg.text,
        startMs: seg.startMs,
      });
      sse.publish(
        makeEvent('transcribe.partial', topics.transcript(this.#transcriptUid), {
          transcriptUid: this.#transcriptUid,
          noteUid: this.#noteUid,
          utteranceId: this.#utterance,
          text: seg.text,
          startMs: seg.startMs,
        }) as SseEvent,
      );
    });

    stream.on('final', (seg: TranscriptSegment) => {
      // 语义 5/6：时间戳已是绝对毫秒、chunkIdx 已从 0 递增，直接落库
      this.deps.repos.insertSegments(this.#transcriptId, [
        {
          startMs: seg.startMs,
          endMs: seg.endMs,
          text: seg.text,
          confidence: seg.confidence,
          noSpeechProb: seg.noSpeechProb,
          words: seg.words,
          chunkIdx: seg.chunkIdx,
          flags: seg.flags,
        },
      ]);
      const seq = this.#seq++;
      this.#utterance = ulid(); // 一句定稿 → 下一句换 utteranceId
      this.send({ type: 'final', seq, startMs: seg.startMs, endMs: seg.endMs, text: seg.text });
      sse.publish(
        makeEvent('transcribe.segment', topics.transcript(this.#transcriptUid), {
          transcriptUid: this.#transcriptUid,
          noteUid: this.#noteUid,
          seq,
          startMs: seg.startMs,
          endMs: seg.endMs,
          text: seg.text,
          speaker: seg.speakerLabel,
          confidence: seg.confidence,
        }) as SseEvent,
      );
    });

    stream.on('error', (err: Error) => {
      this.send({ type: 'error', code: 'ASR_STREAM_ERROR', messageZh: `识别出错：${err.message}` });
    });

    this.send({
      type: 'ready',
      recordingUid: this.recordingUid,
      noteUid: this.#noteUid,
      transcriptUid: this.#transcriptUid,
      sampleRate: RECORD_SAMPLE_RATE,
    });
    this.#emitState('recording');
  }

  /**
   * 送入一帧音频。**必须同步返回** —— 浏览器 AudioWorklet 回调不能被阻塞（语义 1）。
   */
  writeAudio(buf: Buffer): void {
    if (this.#closed || !this.#stream) return;

    const samples = Math.floor(buf.length / 2);
    // 背压：积压超过 3 秒就丢这一帧并告警，而不是无限缓冲
    if (this.#backlogSamples + samples > MAX_BACKLOG_SAMPLES) {
      this.send({ type: 'overrun', droppedSamples: samples });
      return;
    }
    this.#backlogSamples += samples;

    const pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i++) pcm[i] = buf.readInt16LE(i * 2);
    this.#stream.write(pcm);
    this.#backlogSamples = Math.max(0, this.#backlogSamples - samples);

    this.#wav?.write(buf);
    this.#bytesWritten += buf.length;
  }

  /**
   * 停止录音。**幂等**（语义 3）。
   *
   * 顺序有讲究：先 `close()` 让引擎排空并吐出最后一句（语义 2），
   * 再收尾 WAV、再排离线重跑 job。反过来会丢最后一句。
   */
  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#emitState('finalizing');

    // 语义 2：先排空再封死 —— 不能先置 closed 再排空（早期版本因此整段零输出）
    try {
      await this.#stream?.close();
    } catch {
      /* close 失败不该阻止收尾 */
    }

    await this.#finalizeWav();

    const segments = this.deps.repos.segmentsOf(this.#transcriptId);
    this.deps.repos.updateTranscript(this.#transcriptId, {
      status: 'done',
      progress: 1,
      durationMs: Date.now() - this.#startedAt,
    });

    /*
     * 录音本身作为媒体资产落库（F5 时间轴要用它回放）。
     *
     * ★ `relPath` 必须是**规范形态的相对路径**（T-151 ①）。
     *
     * 这里原来写的是 `relPath: this.#wavPath` —— 一个**绝对路径**。
     * 它就是 T-095 在 `transcribe.ts` 修掉的那个缺陷（见 `archiveIntoMedia` 的注释），
     * 录音这条路径**漏了**，而且比那次更难发现：读取侧的候选式解析对绝对路径也认，
     * 所以在**不搬家**的机器上它一直是好的 —— 宽容的读取把不一致的写入藏了起来。
     *
     * 藏不住的那一刻是数据目录搬家：老的绝对路径不在新根的任何一个之内，
     * `assetCandidates` 返回**空数组**，播放 404、自检报「读不出来」，
     * 而那个 wav 明明跟着搬过去了。用户看到的是"我的录音没了"。
     * `media_assets.rel_path` 这一列存在的**全部理由**就是让数据目录可以搬迁（D-02 §1.1）。
     *
     * 算不出相对路径（文件不在 dataDir 内）时**宁可抛也不写绝对路径**：
     * 写下去就是把这个缺陷静默地重新放进库里一次。录音永远写在 `mediaDir` 底下，
     * 走到这一步只可能是有人改坏了 `mediaDir` 的来源，那是必须响亮失败的情形。
     */
    const relPath = canonicalAssetRelPath(this.deps.dataDir, this.#wavPath);
    if (relPath === null) {
      throw new Error(
        `录音落盘路径不在数据目录内，拒绝把绝对路径写进 media_assets.rel_path：` +
          `${this.#wavPath}（dataDir=${this.deps.dataDir}）`,
      );
    }
    const asset = this.deps.repos.createAsset({
      noteId: this.#noteId,
      role: 'original',
      relPath,
      displayName: `${this.recordingUid}.wav`,
      mime: 'audio/wav',
      bytes: this.#bytesWritten + 44,
      durationMs: Date.now() - this.#startedAt,
      sampleRate: RECORD_SAMPLE_RATE,
      channels: 1,
    });

    /*
     * ★ 波形峰值（T-151 ③）。录音落的就是 16 kHz 单声道 PCM16 WAV，直接能算。
     *
     * 为什么录音这条也要自己算，而不是等离线重跑那一遍：
     * 重跑要几十秒到几分钟，而**录完就能回放**是 F3 的基本预期 ——
     * 那段时间里波形是空的，用户会以为"这条录音坏了"。
     * 落点与重跑那一遍**完全相同**（`<mediaRoot>/<noteUid>/peaks.ompk`），
     * 而 `createAsset` 对 rel_path 幂等，所以重跑只会刷新内容、不会长出第二条资产。
     *
     * 段落数为 0（一句话都没识别出来）时**照样生成** —— 有没有转写稿和有没有波形无关，
     * 而"什么都没识别出来"恰恰是最需要让用户自己看波形去核对的时候。
     */
    await generatePeaksAsset(
      {
        repos: this.deps.repos,
        sse: this.deps.sse,
        mediaRoot: this.deps.mediaDir,
        dataDir: this.deps.dataDir,
      },
      { noteId: this.#noteId, noteUid: this.#noteUid, wavPath: this.#wavPath },
    );

    // D-06 §15.2：停止后自动排离线重跑，priority = INTERACTIVE（用户正盯着看）
    let rerunJobUid: string | null = null;
    if (segments.length > 0) {
      const job = this.deps.queue.enqueue({
        type: 'transcribe',
        lane: 'gpu.asr',
        priority: PRIORITY.INTERACTIVE,
        noteId: this.#noteId,
        payload: {
          noteId: this.#noteId,
          input: this.#wavPath,
          sourceKind: 'recording',
          // 让 runner 知道这是重跑：完成后要与流式稿做 mergeTranscripts
          mergeWithTranscriptId: this.#transcriptId,
        },
      });
      rerunJobUid = job.uid;
    }

    this.deps.repos.updateNote(this.#noteId, { status: 'ready' });
    this.deps.sse.publish(
      makeEvent('media.ready', topics.note(this.#noteUid), {
        noteUid: this.#noteUid,
        mediaUid: asset.uid,
        durationMs: Date.now() - this.#startedAt,
        title: null,
        hasVideo: false,
      }) as SseEvent,
    );
    this.send({ type: 'stopped', segmentCount: segments.length, rerunJobUid });
    this.#emitState('stopped');
  }

  /** WS 断线：等同于 stop（语义 3 幂等保证这里安全）。 */
  async abandon(): Promise<void> {
    this.#abort.abort();
    await this.stop();
  }

  #emitState(
    state: 'starting' | 'recording' | 'paused' | 'finalizing' | 'stopped' | 'failed',
  ): void {
    this.deps.sse.publish(
      makeEvent('record.state', topics.recording(this.recordingUid), {
        recordingUid: this.recordingUid,
        state,
        elapsedMs: this.#startedAt ? Date.now() - this.#startedAt : 0,
        bytesWritten: this.#bytesWritten,
      }) as SseEvent,
    );
  }

  /** 回填 WAV 头的长度字段（录音结束才知道总长）。 */
  async #finalizeWav(): Promise<void> {
    const ws = this.#wav;
    if (!ws) return;
    await new Promise<void>((resolve) => ws.end(() => resolve()));
    const { open } = await import('node:fs/promises');
    try {
      const fh = await open(this.#wavPath, 'r+');
      await fh.write(wavHeader(this.#bytesWritten), 0, 44, 0);
      await fh.close();
    } catch {
      /* 头回填失败不影响已落盘的 PCM，重跑时 ffmpeg 仍能按原始 PCM 处理 */
    }
  }
}

/** 44 字节 WAV 头占位（长度先写 0，结束时回填）。 */
function wavHeaderPlaceholder(): Buffer {
  return wavHeader(0);
}

export function wavHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); // PCM fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(RECORD_SAMPLE_RATE, 24);
  b.writeUInt32LE(RECORD_SAMPLE_RATE * 2, 28); // byte rate
  b.writeUInt16LE(2, 32); // block align
  b.writeUInt16LE(16, 34); // bits per sample
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}
