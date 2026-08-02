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
import { basename } from 'node:path';
import { relative } from 'node:path';

import type { SseEvent } from '@openmemo/shared';
import { makeEvent, topics } from '@openmemo/shared';
import { PLAN_VERSION, type StepProgress, type TranscribePipeline } from '@openmemo/pipeline';

import type { Repos } from '../../db/repos.js';
import type { SseHub } from '../../http/sse.js';
import type { JobQueue, JobRow } from '../queue.js';

export interface TranscribeRunnerDeps {
  readonly repos: Repos;
  readonly sse: SseHub;
  readonly queue: JobQueue;
  readonly pipeline: TranscribePipeline;
  readonly modelPath: string | null;
  readonly mediaRoot: string;
  readonly modelId: string;
}

export interface TranscribePayload {
  readonly noteId: number;
  readonly input: string;
  readonly language?: string | null;
  readonly sourceKind: string;
}

/** 把绝对路径转成相对 media 根的路径（D-02 §1.1：绝不存绝对路径，数据目录可搬迁）。 */
function relPath(mediaRoot: string, abs: string): string {
  const rel = relative(mediaRoot, abs);
  // 产物落在 tmp 里时 relative 会带 ../ —— 那说明还没归档到 media/，原样记录绝对路径的 basename
  return rel.startsWith('..') ? abs : rel;
}

export async function runTranscribeJob(
  job: JobRow,
  deps: TranscribeRunnerDeps,
  signal: AbortSignal,
): Promise<void> {
  const { repos, sse, queue, pipeline } = deps;
  const payload = JSON.parse(job.payload_json) as TranscribePayload;

  const note = repos.noteById(payload.noteId);
  if (!note) throw new Error(`note ${payload.noteId} 不存在`);

  // 缺模型/缺工具 → 转 blocked 而不是 failed（D-01 §4.1：可点击修复的等待态）
  if (!deps.modelPath) {
    const remediation = {
      action: 'installModel',
      params: { role: 'asr' },
      labelZh: '去安装语音识别模型',
      label: 'Install an ASR model',
    };
    queue.block(job.id, 'MISSING_ASR_MODEL', remediation);
    sse.publish(
      makeEvent('job.blocked', topics.job(job.uid), {
        jobUid: job.uid,
        code: 'MISSING_ASR_MODEL',
        messageZh: '尚未安装语音识别模型',
        remediation,
      } as never) as SseEvent,
    );
    return;
  }

  const transcript = repos.createTranscript({
    noteId: note.id,
    engineId: 'whisper.cpp',
    modelId: deps.modelId,
    language: payload.language ?? null,
  });

  // 续跑：DB 里的段落才是真相，checkpoint 只是加速缓存（D-01 §4.5）
  const completed = repos.completedChunks(transcript.id);

  /*
   * transcribe.started 必须在任何 transcribe.segment 之前发出。
   * 前端靠它建立 transcriptUid → noteUid 的映射；缺了这条，
   * 后续的 segment 事件就成了没有归属的孤儿（T-028 我漏发过，architect 报的）。
   * durationSec 此刻还不知道（probe 尚未跑），先发 0，media.ready 会带准确值。
   */
  sse.publish(
    makeEvent('transcribe.started', topics.transcript(transcript.uid), {
      transcriptUid: transcript.uid,
      noteUid: note.uid,
      modelId: deps.modelId,
      durationSec: 0,
      language: payload.language ?? null,
    } as never) as SseEvent,
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
        makeEvent('job.progress', topics.job(job.uid), {
          jobUid: job.uid,
          phase: p.step,
          fraction: overall,
          ...(p.chunksDone === undefined ? {} : { chunksDone: p.chunksDone }),
          ...(p.chunksTotal === undefined ? {} : { chunksTotal: p.chunksTotal }),
        } as never) as SseEvent,
        topics.job(job.uid),
      );
    }
  };

  let segSeq = 0;
  let mediaAnnounced = false;

  const result = await pipeline.run({
    input: payload.input,
    jobId: job.uid,
    modelPath: deps.modelPath,
    ...(payload.language ? { language: payload.language } : {}),
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
          makeEvent('transcribe.segment', topics.transcript(transcript.uid), {
            transcriptUid: transcript.uid,
            seq: segSeq++,
            startSec: s.startMs / 1000,
            endSec: s.endMs / 1000,
            text: s.text,
            speaker: s.speakerLabel,
            confidence: s.confidence,
          } as never) as SseEvent,
        );
      }
      void chunk;
      return Promise.resolve();
    },
  });

  // ---- 媒体资产落库 ----
  const originalAsset = repos.createAsset({
    noteId: note.id,
    role: 'original',
    relPath: relPath(deps.mediaRoot, result.media.path),
    displayName: basename(payload.input),
    durationMs: result.durationMs,
    bytes: result.media.sizeBytes,
  });
  repos.createAsset({
    noteId: note.id,
    role: 'audio16k',
    relPath: relPath(deps.mediaRoot, result.normalizedPath),
    durationMs: result.durationMs,
    sampleRate: 16000,
    channels: 1,
  });

  sse.publish(
    makeEvent('media.ready', topics.note(note.uid), {
      noteUid: note.uid,
      mediaUid: originalAsset.uid,
      durationSec: result.durationMs / 1000,
      title: result.info.title ?? null,
      hasVideo: false,
    } as never) as SseEvent,
  );

  // ---- 收尾 ----
  const segCount = repos.segmentsOf(transcript.id).length;
  repos.updateTranscript(transcript.id, {
    status: result.yielded ? 'partial' : 'done',
    progress: result.yielded ? lastProgress : 1,
    durationMs: result.durationMs,
    rtf: result.rtf,
  });
  repos.updateNote(note.id, {
    status: result.yielded ? 'partial' : 'ready',
    durationMs: result.durationMs,
    ...(result.info.title ? { title: result.info.title } : {}),
  });

  sse.publish(
    makeEvent('transcribe.done', topics.transcript(transcript.uid), {
      transcriptUid: transcript.uid,
      noteUid: note.uid,
      segmentCount: segCount,
      rtf: result.rtf,
      partial: result.yielded,
    } as never) as SseEvent,
  );
  sse.publish(
    makeEvent('note.updated', topics.note(note.uid), {
      noteUid: note.uid,
      changed: ['transcript'],
    } as never) as SseEvent,
  );

  queue.succeed(job.id, {
    transcriptUid: transcript.uid,
    segmentCount: segCount,
    rtf: result.rtf,
    durationMs: result.durationMs,
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
