/**
 * ⚠️⚠️  MOCK DAEMON —— 不是真实后端  ⚠️⚠️
 *
 * `apps/daemon` 由 `oss-scout` 负责，尚未实现转写流水线。
 * 为了让前端能被看到、被评审、被端到端验证，这里用内存实现同形状的 API 与 SSE 事件流。
 *
 * **诚实规则**：启用时 UI 顶部会常驻一条醒目的 MOCK 条幅，且本文件所有产出
 * 都标了 `__mock: true`。**绝不允许把 mock 的运行结果说成"跑通了"。**
 *
 * 事件序列严格遵循 D-05 §11 的规格 —— 所以 daemon 真的实现后，
 * 只要删掉 mock，分发层与 UI 一行都不用改。这既是演示，也是对规格的一次自测。
 */

import type { AnyJob, ListNotesResponse, PipelineJob } from '@openmemo/shared';
/*
 * ★ #90 顺带记一笔：本文件的 `emit()` 签名是
 * `(type: string, payload: Record<string, unknown>)` —— **不受契约类型约束**。
 * 所以 mock 发的 `job.progress` 一直与 `JobProgressEvent` 对不上（它发的字段名当时
 * 就叫 `progress`，而契约那时叫 `pct`，还多带 jobType/noteUid/stepIndex/stepCount）。
 * 契约把刻度升格成 `ProgressReading` 之后名字碰巧对上了，但**形状仍要走唯一构造点**，
 * 否则 mock 模式下每条进度都会被 `fractionOf()` 判成「报不出进度」、画成脉动条。
 */
import { progressFraction } from '@openmemo/shared';

import { bus } from '../events/bus';
import { ApiError, registerMockFetcher, type ApiOptions, type Fetcher } from './client';
import type {
  ImportUrlRequest,
  MediaAssetDto,
  NoteDetail,
  NoteSummary,
  ProbeResult,
  TranscriptDto,
} from './types';
import type { TranscriptSegmentDto } from '../events/types';
import { SEGMENT_FLAG } from '../events/types';

export const MOCK_ENABLED_KEY = 'openmemo.mock';

let seq = 0;
const nextId = (p: string) => `${p}_${(++seq).toString(36).padStart(6, '0')}`;

const SAMPLE_TEXT = [
  '好，我们上节课讲到了前向传播的基本流程。',
  '那么今天要解决的核心问题是：损失怎么反向传回去。',
  '先看这个最简单的两层网络，输入是 x，中间有一个隐藏层。',
  '这里的关键在于梯度的方向 —— 它告诉我们参数该往哪边调。',
  '我们可以把它理解成一个下降的过程，沿着最陡的方向往下走。',
  '所以我们对损失函数求偏导，得到每个参数的梯度。',
  '注意这里链式法则的应用，它是整个反向传播的数学基础。',
  '老师，那如果网络很深，梯度会不会消失？',
  '很好的问题。这正是我们下节课要讲的梯度消失问题。',
  '简单说，连乘很多个小于 1 的数，结果会趋近于零。',
  '解决办法有残差连接、批归一化，还有换激活函数。',
  '我们先把基础的反向传播推导完整走一遍。',
];

/**
 * mock 里的一条笔记 —— **同时要当详情响应和列表响应用**。
 *
 * ⚠️ T-151 ②：`NoteDetail` 现在直接是 `@openmemo/shared` 的那一份（= daemon 真发的东西）。
 * 这一行本身就是那次收敛的收获之一：它把「mock 造得出、真 daemon 造不出」这件事
 * 摆到了类型上。mock 之外从未渲染过的东西（T-139 A1 的 `<audio>` 是同一族），
 * 靠的正是"mock 的形状比真响应宽"这条缝。
 *
 * ★ T-150 又收窄了一次：`NoteSummary` 现在也是共享契约（`NoteListItem`），
 * 而 `coverAssetUid` / `source` **daemon 的列表端点从来不发** ——
 * 于是它们从这里彻底去掉了。留着的话，mock 会继续比真响应宽一圈，
 * 而"只有 mock 造得出来"的字段正是站点徽章从未渲染过的成因。
 *
 * `folderUid` 保留，但**明确标成 mock 内部字段**：daemon 的文件夹筛选发生在
 * SQL 那一层（`?folder=` 查询串），响应体里没有这个键。mock 也得有个东西
 * 让 `?folder=` 筛得动，但它**不进任何响应**（见 `/notes` 那一段的投影）。
 */
interface MockNote extends NoteDetail {
  __mock: true;
  /** ⚠️ **mock 内部用，绝不出现在响应里。** daemon 在 SQL 层筛，不发这个字段。 */
  folderUid: string | null;
  /** daemon 的**列表**端点发它，详情端点不发 —— 所以它不在 `NoteDetail` 里。 */
  updatedAt: string;
}

const notes = new Map<string, MockNote>();

interface MockProvider {
  id: string;
  kind: 'openai-compatible' | 'anthropic';
  label: string;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  hasKey: boolean;
  keyMask: string | null;
}

/**
 * 演示用的持久任务。
 *
 * ⚠️ 这仍然是 mock —— 它证明的是**任务中心的数据源已经改成服务端列表**
 * （而不是内存里的 `progressStore`），**不证明**真的持久化了。
 * 真持久化要等 `/api/jobs` 上线；那时按面切换会自动接过去。
 */
const mockJobs: AnyJob[] = [
  {
    jobId: 'job_demo_1',
    kind: 'model',
    type: 'download.model',
    targetId: 'asr/whisper-large-v3-turbo-q5_0',
    displayName: 'Whisper large-v3-turbo (Q5_0)',
    state: 'running',
    step: 'downloading',
    provider: 'modelscope',
    totalBytes: 574_041_195,
    completedBytes: 412_000_000,
    speedBps: 8_200_000,
    etaSeconds: 20,
    parts: [],
    currentFile: 'ggml-large-v3-turbo-q5_0.bin',
    fileIndex: 0,
    fileCount: 1,
    attempt: 0,
    maxAttempts: 5,
    error: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    jobId: 'job_demo_2',
    kind: 'model',
    type: 'download.model',
    targetId: 'llm/qwen3-4b-q4_k_m',
    displayName: 'Qwen3 4B (Q4_K_M)',
    state: 'blocked',
    step: null,
    provider: null,
    totalBytes: 2_500_000_000,
    completedBytes: 0,
    speedBps: 0,
    etaSeconds: null,
    parts: [],
    currentFile: null,
    fileIndex: 0,
    fileCount: 1,
    attempt: 1,
    maxAttempts: 5,
    error: {
      code: 'RESOURCE_DISK_FULL',
      message: '需要 2.5 GB，可用 1.1 GB',
      messageZh: '需要 2.5 GB，可用 1.1 GB',
      retryable: false,
    },
    startedAt: new Date(Date.now() - 300_000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

/**
 * 把一条**流水线**任务放进 mock 的任务列表（T-138 ②）。
 *
 * ⚠️ 这里以前不是这么做的：mock 在 `note.activeJobId` 上记了一个 job id，
 * 而 daemon 的笔记响应**从来没有这个字段**。于是 mock 里进度行好好的、真实环境里
 * 一次都没出现过 —— **mock 比真后端多长了一个字段，正是这个 bug 藏了这么久的原因。**
 * 现在 mock 与 daemon 走同一条路：任务在 `GET /api/jobs` 里，笔记 DTO 里没有它。
 */
function startMockPipelineJob(jobUid: string, kind: PipelineJob['kind'], note: MockNote): void {
  const now = new Date().toISOString();
  mockJobs.unshift({
    jobId: jobUid,
    kind,
    type: kind,
    displayName: note.title,
    noteUid: note.uid,
    state: 'queued',
    step: null,
    progress: 0,
    attempt: 0,
    maxAttempts: 5,
    error: null,
    blockedCode: null,
    createdAt: now,
    updatedAt: now,
  });
}

function finishMockPipelineJob(jobUid: string): void {
  const j = mockJobs.find((x) => x.jobId === jobUid);
  if (j) {
    j.state = 'succeeded';
    j.updatedAt = new Date().toISOString();
  }
}

const mockFolders: {
  uid: string;
  name: string;
  parentUid: string | null;
  color: string | null;
  noteCount: number;
}[] = [
  { uid: 'fld_course', name: '课程', parentUid: null, color: null, noteCount: 1 },
  { uid: 'fld_dl', name: '深度学习', parentUid: 'fld_course', color: null, noteCount: 1 },
  { uid: 'fld_podcast', name: '播客', parentUid: null, color: null, noteCount: 1 },
];

let mockActiveProvider: string | null = 'ollama';
const mockProviders: MockProvider[] = [
  {
    id: 'ollama',
    kind: 'openai-compatible',
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:8b',
    isLocal: true,
    hasKey: false,
    keyMask: null,
  },
];
const transcripts = new Map<string, TranscriptDto>();
const timers = new Set<ReturnType<typeof setTimeout>>();

function later(fn: () => void, ms: number) {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
}

function emit(type: string, payload: Record<string, unknown>) {
  // mock 源与真 SSE 同属"运行时才知道类型"的那一档（见 bus.ts 的说明）
  bus.emitFromWire(type, { type, ...payload });
}

function seedNote(partial: Partial<MockNote> & { title: string }): MockNote {
  const uid = partial.uid ?? nextId('note');
  const note: MockNote = {
    __mock: true,
    uid,
    title: partial.title,
    kind: partial.kind ?? 'media',
    status: partial.status ?? 'ready',
    folderUid: null,
    durationMs: partial.durationMs ?? 6_452_000,
    starred: partial.starred ?? false,
    tags: partial.tags ?? [],
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(),
    summaryMd: partial.summaryMd ?? null,
    bodyJson: null,
    /*
     * ⚠️ 这里原来还有一个 `bodyText: ''`。**删掉了，不是改名**（T-151 ②）：
     * daemon 的 `GET /api/notes/:uid` **从来不发 `bodyText`**，全仓也没有任何一处读它 ——
     * 唯一"提供"它的就是这个 mock。留着它只会让下一个人以为真实响应里也有。
     * （`bodyText` 是 `bodyJson` 的纯文本投影，只在 **PATCH 请求体**里往上送、供 FTS5 索引。）
     */
    language: 'zh',
    assets: partial.assets ?? [],
    transcriptUid: partial.transcriptUid ?? null,
    segmentCount: partial.segmentCount ?? 0,
    canRetranscribe: partial.canRetranscribe ?? true,
    /*
     * 默认 `null` 与 `canRetranscribe: true` 是**一对**（#95）：契约规定"能重跑 ⇔ 理由为
     * null"。mock 默认造的是"能重跑"那一档，所以这里只能是 null ——
     * 给个非空理由会造出一个契约上不存在的状态，而 mock 的全部价值就是形状与真响应一致。
     */
    retranscribeBlocked: partial.retranscribeBlocked ?? null,
    /*
     * 默认 `null` = 这条笔记上没有需要用户处理的失败（#98）。
     * mock 造的是"一切正常"那一档；编一条假的失败会让形状对上、语义对不上，
     * 而 mock 存在的全部价值就是这两件事都对得上。
     */
    lastFailure: partial.lastFailure ?? null,
  };
  notes.set(uid, note);
  return note;
}

/**
 * 造一条 mock 资产。**`url` 必须由 uid 算出来，不许手写、更不许留空**（T-151 ②）。
 *
 * daemon 的 `GET /api/notes/:uid` **一直在发** `url: /media/asset/<ulid>` ——
 * 而 web 那份手抄 DTO 里从前连这个键都没声明，于是前端只好自己再拼一次路径，
 * 「路径规则应该只有一处、且那一处在服务端」这条就此破掉。
 * mock 也照同一条规则产出，才不会让"在 mock 下能播、真环境下不能"这类差异再冒出来。
 */
function mockAsset(a: {
  role: string;
  mime: string | null;
  bytes: number | null;
  durationMs: number | null;
}): MediaAssetDto {
  const uid = nextId('as');
  /* `replacedAt: null` —— mock 里的原件没有被「重新转写」覆盖过（#96②）。 */
  return { uid, url: `/media/asset/${uid}`, state: 'ready', replacedAt: null, ...a };
}

function makeSegments(count: number, startSeq = 0): TranscriptSegmentDto[] {
  const out: TranscriptSegmentDto[] = [];
  for (let i = 0; i < count; i += 1) {
    const s = startSeq + i;
    const startMs = s * 8200;
    const text = SAMPLE_TEXT[s % SAMPLE_TEXT.length];
    out.push({
      seq: s,
      startMs,
      endMs: startMs + 7600,
      text,
      speakerLabel: text.startsWith('老师') ? 'SPEAKER_01' : 'SPEAKER_00',
      confidence: s % 9 === 5 ? 0.42 : 0.93,
      noSpeechProb: 0.01,
      words: null,
      chunkIdx: Math.floor(s / 4),
      flags:
        s % 9 === 5
          ? SEGMENT_FLAG.LOW_CONFIDENCE
          : s % 17 === 13
            ? SEGMENT_FLAG.HALLUCINATION
            : s % 23 === 7
              ? SEGMENT_FLAG.CONFIRMED // 演示"已保留（无对应更新）"这一态
              : 0,
      editedAt: s % 23 === 7 ? Date.now() - 3_600_000 : null,
      textRaw: s % 23 === 7 ? '这里是识别原文，用户改过。' : null,
    });
  }
  return out;
}

function seedDemoData() {
  const n1 = seedNote({
    title: '深度学习导论 第 3 讲：反向传播',
    tags: [{ uid: 't1', name: '机器学习', color: null }],
    summaryMd: '本讲从前向传播回顾出发，推导反向传播的链式法则，并引出梯度消失问题。',
    starred: true,
  });
  const tUid = nextId('tr');
  n1.transcriptUid = tUid;
  n1.assets = [
    mockAsset({
      role: 'audio16k',
      mime: 'audio/wav',
      bytes: 103_232_000,
      durationMs: n1.durationMs,
    }),
    mockAsset({
      role: 'peaks',
      mime: 'application/octet-stream',
      bytes: 451_000,
      durationMs: null,
    }),
  ];
  transcripts.set(tUid, {
    uid: tUid,
    noteUid: n1.uid,
    engineId: 'whisper.cpp',
    modelId: 'asr/whisper-large-v3-turbo-q5_0',
    backend: 'cpu',
    language: 'zh',
    status: 'done',
    progress: 1,
    durationMs: n1.durationMs,
    rtf: 0.42,
    speakers: [
      { label: 'SPEAKER_00', displayName: '张老师', color: null },
      { label: 'SPEAKER_01', displayName: '学生 A', color: null },
    ],
    segments: makeSegments(48),
  });

  seedNote({
    title: '播客 EP.42 — 本地优先软件的未来',
    durationMs: 3_180_000,
  });
  seedNote({
    title: '周会录音 2026-07-29',
    kind: 'recording',
    durationMs: 2_640_000,
  });
}

/**
 * F1 全流程：严格按 D-05 §11 的事件序列与顺序发。
 * 时间被压缩过（真实是几十分钟），但**事件的种类、顺序、字段一模一样**。
 */
function runImportPipeline(note: MockNote, jobId: string) {
  const totalChunks = 12;
  const transcriptUid = nextId('tr');
  const step = (name: string, progress: number, at: number, extra: Record<string, unknown> = {}) =>
    later(() => {
      emit('job.progress', {
        jobId,
        state: 'running',
        jobType: 'import.url',
        noteUid: note.uid,
        progress: progressFraction(progress, 'mock:step'),
        step: name,
        completedBytes: null,
        totalBytes: null,
        speedBps: null,
        etaSeconds: Math.round((1 - progress) * 360),
        ...extra,
      });
    }, at);

  // probe 秒级返回 → 先回填标题/时长/封面，用户立刻知道"认对了没有"
  later(() => {
    note.title = '深度学习导论 第 4 讲：梯度消失与残差连接';
    note.durationMs = 5_120_000;
    emit('note.updated', { noteUid: note.uid, fields: ['title', 'durationMs', 'coverAssetUid'] });
  }, 400);

  step('fetch', 0.08, 600, {
    completedBytes: 12_000_000,
    totalBytes: 148_000_000,
    speedBps: 8_200_000,
  });
  step('fetch', 0.32, 1400, {
    completedBytes: 64_000_000,
    totalBytes: 148_000_000,
    speedBps: 9_100_000,
  });
  step('demux', 0.44, 2200);

  later(() => {
    const asset = mockAsset({
      role: 'peaks',
      mime: 'application/octet-stream',
      bytes: 380_000,
      durationMs: null,
    });
    note.assets = [
      ...note.assets,
      mockAsset({
        role: 'audio16k',
        mime: 'audio/wav',
        bytes: 81_920_000,
        durationMs: note.durationMs,
      }),
      asset,
    ];
    // 波形就绪前前端不能去拉，否则 404 —— 这就是这个事件存在的理由
    emit('media.asset.ready', {
      noteUid: note.uid,
      assetUid: asset.uid,
      role: 'peaks',
      bytes: asset.bytes,
    });
  }, 2400);

  step('vad', 0.5, 2600);

  later(() => {
    transcripts.set(transcriptUid, {
      uid: transcriptUid,
      noteUid: note.uid,
      engineId: 'whisper.cpp',
      modelId: 'asr/whisper-large-v3-turbo-q5_0',
      backend: 'cpu',
      language: 'zh',
      status: 'running',
      progress: 0,
      durationMs: note.durationMs,
      rtf: null,
      speakers: [{ label: 'SPEAKER_00', displayName: null, color: null }],
      segments: [],
    });
    note.transcriptUid = transcriptUid;
    note.status = 'processing';
    emit('transcribe.started', {
      transcriptUid,
      noteUid: note.uid,
      jobId,
      engineId: 'whisper.cpp',
      modelId: 'asr/whisper-large-v3-turbo-q5_0',
      backend: 'cpu',
      language: 'zh',
      durationMs: note.durationMs,
      totalChunks,
    });
  }, 2800);

  // ★ 每个 chunk 落库即发 —— "边转边看"，14 秒后就有字，而不是等 40 分钟
  for (let c = 0; c < totalChunks; c += 1) {
    later(
      () => {
        const segs = makeSegments(4, c * 4);
        const tr = transcripts.get(transcriptUid);
        if (tr) {
          tr.segments = [...tr.segments, ...segs];
          tr.progress = (c + 1) / totalChunks;
        }
        // data 类：seq 单调、不节流、必达有序
        emit('transcribe.segment', {
          transcriptUid,
          noteUid: note.uid,
          seq: c,
          chunkIdx: c,
          segments: segs,
        });
        // 进度另发一条 hint，与内容流分开 → 节流不会拖累内容
        emit('transcribe.chunk', {
          transcriptUid,
          noteUid: note.uid,
          doneChunks: c + 1,
          totalChunks,
          lastEndMs: (c * 4 + 4) * 8200,
        });
        emit('job.progress', {
          jobId,
          state: 'running',
          jobType: 'import.url',
          noteUid: note.uid,
          progress: progressFraction(0.5 + 0.45 * ((c + 1) / totalChunks), 'mock:asr'),
          step: 'asr',
          stepIndex: 5,
          stepCount: 7,
          completedBytes: null,
          totalBytes: null,
          speedBps: null,
          etaSeconds: Math.round((totalChunks - c - 1) * 26),
        });
      },
      3200 + c * 900,
    );
  }

  const doneAt = 3200 + totalChunks * 900 + 400;
  later(() => {
    const tr = transcripts.get(transcriptUid);
    if (tr) {
      tr.status = 'done';
      tr.progress = 1;
      tr.rtf = 0.38;
    }
    note.status = 'ready';
    finishMockPipelineJob(jobId);
    emit('transcribe.done', {
      transcriptUid,
      noteUid: note.uid,
      segmentCount: totalChunks * 4,
      rtf: 0.38,
      durationMs: note.durationMs,
      speakers: [
        { label: 'SPEAKER_00', totalMs: 4_100_000 },
        { label: 'SPEAKER_01', totalMs: 1_020_000 },
      ],
    });
    emit('note.status', { noteUid: note.uid, status: 'ready' });
    emit('job.progress', {
      jobId,
      state: 'succeeded',
      jobType: 'import.url',
      noteUid: note.uid,
      progress: progressFraction(1, 'mock:done'),
      step: null,
      completedBytes: null,
      totalBytes: null,
      speedBps: null,
      etaSeconds: null,
    });
  }, doneAt);

  // 结构化：summary 与 mindmap 的 delta 流
  later(() => {
    emit('summary.delta', { noteUid: note.uid, seq: 0, textDelta: '本讲承接反向传播，' });
    emit('summary.delta', {
      noteUid: note.uid,
      seq: 1,
      textDelta: '重点讨论深层网络中的梯度消失问题，',
    });
    emit('summary.delta', {
      noteUid: note.uid,
      seq: 2,
      textDelta: '并给出残差连接与批归一化两条解决路径。',
    });
    emit('summary.done', { noteUid: note.uid, chars: 46 });
  }, doneAt + 600);
}

const mockFetcher: Fetcher = async <T>(path: string, opts: ApiOptions = {}): Promise<T> => {
  await new Promise((r) => setTimeout(r, 60)); // 模拟本地往返
  const method = (opts.method ?? 'GET').toUpperCase();

  /*
   * ⚠️ 匹配时**必须先切掉查询串**：`api()` 传进来的 path 带着 `?starred=1`，
   * 而 `path === '/notes'` 会漏判，落到文件末尾的"未实现"分支直接抛错 ——
   * 表现是"离线/回落状态下笔记列表整页报错"，而真正的原因只是少写了一次 split。
   */
  const [pathname = path, queryString = ''] = path.split('?');
  const query = new URLSearchParams(queryString);

  if (method === 'GET' && pathname === '/notes') {
    const starredOnly = query.get('starred') === '1' || query.get('starred') === 'true';
    const folderUid = query.get('folder');
    const list: NoteSummary[] = [...notes.values()]
      // 与 daemon 一致：筛选发生在**取数那一层**，不是取完再过滤（T-138 ③/④）
      .filter((n) => !starredOnly || n.starred)
      // mock 的文件夹是平的（没有子文件夹），所以这里只比自身；
      // daemon 那边是含子孙的递归 —— **这一点不一样，写出来免得被当成契约**
      .filter((n) => !folderUid || n.folderUid === folderUid)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      /*
       * ★ T-150：**逐字段投影，不是把整条 MockNote 直接扔出去。**
       *
       * `MockNote` 身上还挂着详情端点的字段（`segments` / `assets` / `bodyJson` …）
       * 与一个 mock 内部的 `folderUid`。原来这里 `as T` 一转，它们全都进了列表响应 ——
       * 于是「mock 比真响应宽」这条缝又开着：任何一个前端只要读到了它们，
       * 在 mock 下工作正常、接上真 daemon 就恒 undefined，**而且不报错**。
       * 这正是站点徽章从未渲染过的形状。
       *
       * 写成显式对象之后，`NoteListItem` 加字段这里会编译失败，多发字段也过不去。
       */
      .map((n): NoteSummary => ({
        uid: n.uid,
        title: n.title,
        status: n.status,
        kind: n.kind,
        language: n.language,
        durationMs: n.durationMs,
        starred: n.starred,
        tags: n.tags,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      }));
    /*
     * ★ T-157 ③：mock 也必须**真的翻页**。
     *
     * 只回 `{notes}` 的话，回落状态下 `hasMore` 恒 undefined → "加载更多"永远不出现，
     * 而真 daemon 上它是出现的 —— 又一次"mock 比真响应窄/宽"造成的分叉。
     * 这里照 `ListNotesResponse` 逐字段构造，少一个键就编译失败。
     */
    const limit = Math.min(200, Number(query.get('limit') ?? 50) || 50);
    const offset = Number(query.get('offset') ?? 0) || 0;
    const page = list.slice(offset, offset + limit);
    const body: ListNotesResponse = {
      notes: page,
      total: list.length,
      limit,
      offset,
      hasMore: offset + page.length < list.length,
    };
    return body as T;
  }

  if (method === 'GET' && path.startsWith('/notes/')) {
    const uid = path.split('/')[2];
    if (path.endsWith('/transcript')) {
      const note = notes.get(uid);
      const tr = note?.transcriptUid ? transcripts.get(note.transcriptUid) : null;
      return (tr ?? null) as T;
    }
    const n = notes.get(uid);
    if (!n) throw Object.assign(new Error('not found'), { code: 'NOTE_NOT_FOUND' });
    return n as T;
  }

  if (method === 'POST' && path === '/import/probe') {
    const { url } = opts.body as { url: string };
    const probe: ProbeResult = {
      title: '深度学习导论 第 4 讲：梯度消失与残差连接',
      author: '某某大学',
      durationMs: 5_120_000,
      thumbnailUrl: null,
      site: url.includes('bilibili') ? 'bilibili' : 'youtube',
      adapterId: url.match(/\.(mp3|m4a|wav)(\?|$)/) ? 'direct-http' : 'ytdlp',
      requiresAuth: false,
    };
    return probe as T;
  }

  if (method === 'POST' && path === '/import/url') {
    const req = opts.body as ImportUrlRequest;
    const note = seedNote({ title: req.url, status: 'processing', durationMs: null, assets: [] });
    const jobUid = nextId('job');
    startMockPipelineJob(jobUid, 'transcribe', note);
    emit('note.created', { noteUid: note.uid, title: note.title, kind: 'media', folderUid: null });
    emit('note.status', { noteUid: note.uid, status: 'processing' });
    runImportPipeline(note, jobUid);
    return { jobUid, noteUid: note.uid } as unknown as T;
  }

  if (method === 'GET' && path === '/settings/llm') {
    return {
      providers: mockProviders,
      activeProviderId: mockActiveProvider,
      secretsPath: '~/.local/share/openmemo/openmemo.db',
      secretsEncryption: 'plain',
    } as T;
  }

  if (method === 'PUT' && path === '/settings/llm/providers') {
    const b = opts.body as {
      id: string;
      label: string;
      baseUrl: string;
      model: string;
      kind: string;
      isLocal: boolean;
      apiKey?: string;
    };
    const existing = mockProviders.find((p) => p.id === b.id);
    const next = {
      id: b.id,
      kind: b.kind as 'openai-compatible' | 'anthropic',
      label: b.label,
      baseUrl: b.baseUrl,
      model: b.model,
      isLocal: b.isLocal,
      hasKey: b.apiKey ? b.apiKey.trim().length > 0 : (existing?.hasKey ?? false),
      // 只留尾四位：Key 明文永不回前端
      keyMask: b.apiKey?.trim() ? `sk-…${b.apiKey.trim().slice(-4)}` : (existing?.keyMask ?? null),
    };
    if (existing) Object.assign(existing, next);
    else mockProviders.push(next);
    return { ok: true } as T;
  }

  if (method === 'POST' && path === '/settings/llm/active') {
    mockActiveProvider = (opts.body as { id: string }).id;
    return { ok: true } as T;
  }

  if (method === 'POST' && path === '/settings/llm/test') {
    const id = (opts.body as { id: string }).id;
    const p = mockProviders.find((x) => x.id === id);
    const ok = Boolean(p && (p.isLocal || p.hasKey));
    return {
      ok,
      latencyMs: ok ? 180 + Math.floor(Math.random() * 300) : null,
      model: p?.model ?? null,
      errorCode: ok ? null : 'MISSING_LLM_CONFIG',
      errorMessage: ok ? null : '未设置 API Key',
    } as T;
  }

  if (method === 'GET' && path === '/folders') {
    return { folders: mockFolders } as T;
  }

  if (method === 'POST' && path === '/folders') {
    const b = opts.body as { name: string; parentUid?: string | null };
    const f = {
      uid: nextId('fld'),
      name: b.name,
      parentUid: b.parentUid ?? null,
      color: null,
      noteCount: 0,
    };
    mockFolders.push(f);
    return f as T;
  }

  if (method === 'DELETE' && path.startsWith('/folders/')) {
    const uid = path.split('/')[2];
    const i = mockFolders.findIndex((f) => f.uid === uid);
    if (i >= 0) mockFolders.splice(i, 1);
    return { ok: true } as T;
  }

  if (method === 'GET' && path === '/jobs') {
    return { jobs: mockJobs, concurrencyLimit: 2 } as T;
  }

  if (method === 'POST' && /^\/jobs\/[^/]+\/(cancel|pause|resume|retry)$/.test(path)) {
    const [, , jobId, action] = path.split('/');
    const j = mockJobs.find((x) => x.jobId === jobId);
    if (j) {
      if (action === 'cancel') j.state = 'cancelled';
      else if (action === 'pause') j.state = 'paused';
      else if (action === 'resume') j.state = 'running';
      else if (action === 'retry') j.state = 'queued';
    }
    return { ok: true } as T;
  }

  // 未实现的接口显式抛 ApiError（而不是裸 Error）——
  // 只有 ApiError 才带 `code`，ErrorBlock 才能查到本地文案，
  // 否则用户看到的是"发生了未知错误"，等于把信息丢了。
  throw new ApiError(501, {
    code: 'MOCK_NOT_IMPLEMENTED',
    message: `[MOCK] not implemented: ${method} ${path}`,
    messageZh: `[MOCK] 尚未实现的接口：${method} ${path}`,
    retryable: false,
  });
};

let installed = false;

/**
 * 注册 mock 作为**回落**（T-029）。
 *
 * 注意语义变化：它不再全局替换 fetcher。真假选择现在按 **surface** 决定
 * （见 `client.ts` 的 `api()`）—— daemon 实现了哪个端点，那个面就自动走真的。
 */
export function installMockApi(): () => void {
  if (installed) return () => {};
  installed = true;
  seedDemoData();
  registerMockFetcher(mockFetcher);
  console.info('[OpenMemo] mock 回落已注册；具体哪个面用真/假由 surface 状态决定。');
  return () => {
    timers.forEach(clearTimeout);
    timers.clear();
    notes.clear();
    transcripts.clear();
    installed = false;
  };
}

export function isMockEnabled(): boolean {
  return installed;
}
