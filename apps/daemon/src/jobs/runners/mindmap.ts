/**
 * F4 job runner：转写稿 → LLM → 思维导图 → 落库 → SSE。
 *
 * `packages/mindmap` 的生成链路在 T-023 已跑通（38 段 → 12 节点，7.5s），
 * 但**没有 job runner、没有端点**，从 UI 到不了。这里把它接进 daemon。
 *
 * LLM provider 的选取顺序（对应 ADR-003 的三档）：
 *   1. 用户在设置里配置的（`settings.llm.*` + `secrets`）—— 档 1 BYO Key
 *   2. 本机探测到的 Ollama / LM Studio / llama-server —— 档 2（**真发请求确认**，不只看端口）
 * 都没有 → job 转 `blocked` + remediation，而不是 failed（D-01 §4.1）。
 */
import {
  OpenAiCompatibleProvider,
  detectLocalBackends,
  type LlmProvider,
} from '@openmemo/llm';
import { generateMindMap, validate, type TranscriptSegment } from '@openmemo/mindmap';
import type { SseEvent } from '@openmemo/shared';
import { makeEvent, topics } from '@openmemo/shared';

import type { MindMapRepo } from '../../db/mindmapRepo.js';
import type { Repos } from '../../db/repos.js';
import type { SseHub } from '../../http/sse.js';
import type { JobQueue, JobRow } from '../queue.js';

export interface MindmapRunnerDeps {
  readonly repos: Repos;
  readonly mindmaps: MindMapRepo;
  readonly sse: SseHub;
  readonly queue: JobQueue;
  /** 从设置里读 LLM 配置；没配就返回 undefined。 */
  readonly resolveProvider: () => Promise<LlmProvider | undefined>;
}

export interface MindmapPayload {
  readonly noteId: number;
  readonly transcriptUid?: string;
}

/** 档 2 探测：本机已装的 LLM 服务。 */
export async function detectProvider(): Promise<LlmProvider | undefined> {
  const found = await detectLocalBackends({ timeoutMs: 2500 });
  const first = found[0];
  if (!first) return undefined;
  return new OpenAiCompatibleProvider({
    id: first.id,
    label: first.label,
    baseUrl: first.baseUrl,
    model: first.models[0] as string,
    isLocal: true,
    timeoutMs: 300_000,
    // Qwen3 系列默认是 thinking 模型，会把 token 预算烧在 reasoning_content 上（T-023 实测）
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  });
}

export async function runMindmapJob(
  job: JobRow,
  deps: MindmapRunnerDeps,
  signal: AbortSignal,
): Promise<void> {
  const { repos, mindmaps, sse, queue } = deps;
  const payload = JSON.parse(job.payload_json) as MindmapPayload;

  const note = repos.noteById(payload.noteId);
  if (!note) throw new Error(`note ${payload.noteId} 不存在`);

  const transcript = repos.activeTranscriptOfNote(note.id);
  if (!transcript) {
    const remediation = {
      action: 'transcribeFirst',
      params: { noteUid: note.uid },
      labelZh: '先转写这条笔记',
      label: 'Transcribe this note first',
    };
    queue.block(job.id, 'NO_TRANSCRIPT', remediation);
    sse.publish(
      makeEvent('job.blocked', topics.job(job.uid), {
        jobUid: job.uid,
        code: 'NO_TRANSCRIPT',
        messageZh: '这条笔记还没有转写稿，无法生成思维导图',
        remediation,
      } as never) as SseEvent,
    );
    return;
  }

  const rows = repos.segmentsOf(transcript.id);
  if (rows.length === 0) {
    throw new Error('转写稿为空，无法生成导图');
  }
  const segments: TranscriptSegment[] = rows.map((s) => ({
    startMs: s.start_ms,
    endMs: s.end_ms,
    text: s.text,
  }));

  // ---- 选 provider（档 1 → 档 2）----
  const provider = (await deps.resolveProvider()) ?? (await detectProvider());
  if (!provider) {
    const remediation = {
      action: 'configureLlm',
      params: { section: 'llm' },
      labelZh: '去配置 LLM',
      label: 'Configure an LLM',
    };
    queue.block(job.id, 'LLM_NOT_CONFIGURED', remediation);
    sse.publish(
      makeEvent('job.blocked', topics.job(job.uid), {
        jobUid: job.uid,
        code: 'LLM_NOT_CONFIGURED',
        messageZh: '尚未配置 LLM。可以填一个 API Key，或安装本地模型。',
        remediation,
      } as never) as SseEvent,
    );
    return;
  }

  const result = await generateMindMap(provider, segments, {
    transcriptUid: transcript.uid,
    uid: note.uid,
    title: note.title || '思维导图',
    windowChars: 2200,
    maxTopicsPerWindow: 5,
    signal,
    onProgress: (fraction, stage) => {
      queue.setProgress(job.id, fraction, stage);
      sse.publish(
        makeEvent('job.progress', topics.job(job.uid), {
          jobUid: job.uid,
          phase: stage,
          fraction,
        } as never) as SseEvent,
        topics.job(job.uid),
      );
    },
    onPartial: (partial) => {
      // 渐进式：每生成完一个窗口就推一次，前端可以边生成边看
      sse.publish(
        makeEvent('mindmap.delta', topics.note(note.uid), {
          noteUid: note.uid,
          nodeCount: Object.keys(partial.nodes).length,
        } as never) as SseEvent,
        topics.note(note.uid),
      );
    },
  });

  // 写库前必校验（LLM 会生成环和悬空引用，D-02 §2.2 约束 5）
  const v = validate(result.doc);
  if (!v.ok) {
    throw new Error(`生成的导图未通过校验：${v.issues.map((i) => i.code).join(', ')}`);
  }

  const row = mindmaps.save({
    noteId: note.id,
    doc: result.doc,
    generatedBy: `llm:${provider.id}`,
  });

  sse.publish(
    makeEvent('mindmap.done', topics.note(note.uid), {
      noteUid: note.uid,
      mindmapUid: row.uid,
      nodeCount: Object.keys(result.doc.nodes).length,
    } as never) as SseEvent,
  );
  sse.publish(
    makeEvent('note.updated', topics.note(note.uid), {
      noteUid: note.uid,
      changed: ['mindmap'],
    } as never) as SseEvent,
  );

  queue.succeed(job.id, {
    mindmapUid: row.uid,
    nodeCount: Object.keys(result.doc.nodes).length,
    windows: result.windows,
    attempts: result.attempts,
    elapsedMs: result.elapsedMs,
  });
}
