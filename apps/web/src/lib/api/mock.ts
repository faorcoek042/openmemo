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

import { bus } from '../events/bus';
import { registerMockFetcher, type ApiOptions, type Fetcher } from './client';
import type {
  ImportUrlRequest,
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

interface MockNote extends NoteDetail {
  __mock: true;
}

const notes = new Map<string, MockNote>();
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
  bus.emit(type, { type, ...payload });
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
    coverAssetUid: null,
    starred: partial.starred ?? false,
    tags: partial.tags ?? [],
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(),
    activeJobId: null,
    source: partial.source ?? {
      kind: 'url',
      adapterId: 'ytdlp',
      site: 'youtube',
      author: '某某大学',
      inputUrl: 'https://www.youtube.com/watch?v=demo',
    },
    summaryMd: partial.summaryMd ?? null,
    bodyText: '',
    language: 'zh',
    assets: partial.assets ?? [],
    transcriptUid: partial.transcriptUid ?? null,
  };
  notes.set(uid, note);
  return note;
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
    { uid: nextId('as'), role: 'audio16k', mime: 'audio/wav', bytes: 103_232_000, durationMs: n1.durationMs, state: 'ready' },
    { uid: nextId('as'), role: 'peaks', mime: 'application/octet-stream', bytes: 451_000, durationMs: null, state: 'ready' },
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
    source: { kind: 'url', adapterId: 'direct-http', site: 'podcast', author: 'Local First FM', inputUrl: 'https://example.com/ep42.mp3' },
  });
  seedNote({
    title: '周会录音 2026-07-29',
    kind: 'recording',
    durationMs: 2_640_000,
    source: { kind: 'recording', adapterId: null, site: null, author: null, inputUrl: null },
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
        progress,
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

  step('fetch', 0.08, 600, { completedBytes: 12_000_000, totalBytes: 148_000_000, speedBps: 8_200_000 });
  step('fetch', 0.32, 1400, { completedBytes: 64_000_000, totalBytes: 148_000_000, speedBps: 9_100_000 });
  step('demux', 0.44, 2200);

  later(() => {
    const asset = { uid: nextId('as'), role: 'peaks', mime: 'application/octet-stream', bytes: 380_000, durationMs: null, state: 'ready' as const };
    note.assets = [
      ...note.assets,
      { uid: nextId('as'), role: 'audio16k', mime: 'audio/wav', bytes: 81_920_000, durationMs: note.durationMs, state: 'ready' },
      asset,
    ];
    // 波形就绪前前端不能去拉，否则 404 —— 这就是这个事件存在的理由
    emit('media.asset.ready', { noteUid: note.uid, assetUid: asset.uid, role: 'peaks', bytes: asset.bytes });
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
      transcriptUid, noteUid: note.uid, jobId,
      engineId: 'whisper.cpp', modelId: 'asr/whisper-large-v3-turbo-q5_0',
      backend: 'cpu', language: 'zh', durationMs: note.durationMs, totalChunks,
    });
  }, 2800);

  // ★ 每个 chunk 落库即发 —— "边转边看"，14 秒后就有字，而不是等 40 分钟
  for (let c = 0; c < totalChunks; c += 1) {
    later(() => {
      const segs = makeSegments(4, c * 4);
      const tr = transcripts.get(transcriptUid);
      if (tr) {
        tr.segments = [...tr.segments, ...segs];
        tr.progress = (c + 1) / totalChunks;
      }
      // data 类：seq 单调、不节流、必达有序
      emit('transcribe.segment', { transcriptUid, noteUid: note.uid, seq: c, chunkIdx: c, segments: segs });
      // 进度另发一条 hint，与内容流分开 → 节流不会拖累内容
      emit('transcribe.chunk', {
        transcriptUid, noteUid: note.uid,
        doneChunks: c + 1, totalChunks, lastEndMs: (c * 4 + 4) * 8200,
      });
      emit('job.progress', {
        jobId, state: 'running', jobType: 'import.url', noteUid: note.uid,
        progress: 0.5 + 0.45 * ((c + 1) / totalChunks),
        step: 'asr', stepIndex: 5, stepCount: 7,
        completedBytes: null, totalBytes: null, speedBps: null,
        etaSeconds: Math.round((totalChunks - c - 1) * 26),
      });
    }, 3200 + c * 900);
  }

  const doneAt = 3200 + totalChunks * 900 + 400;
  later(() => {
    const tr = transcripts.get(transcriptUid);
    if (tr) { tr.status = 'done'; tr.progress = 1; tr.rtf = 0.38; }
    note.status = 'ready';
    note.activeJobId = null;
    emit('transcribe.done', {
      transcriptUid, noteUid: note.uid, segmentCount: totalChunks * 4,
      rtf: 0.38, durationMs: note.durationMs,
      speakers: [{ label: 'SPEAKER_00', totalMs: 4_100_000 }, { label: 'SPEAKER_01', totalMs: 1_020_000 }],
    });
    emit('note.status', { noteUid: note.uid, status: 'ready' });
    emit('job.progress', {
      jobId, state: 'succeeded', jobType: 'import.url', noteUid: note.uid,
      progress: 1, step: null, completedBytes: null, totalBytes: null, speedBps: null, etaSeconds: null,
    });
  }, doneAt);

  // 结构化：summary 与 mindmap 的 delta 流
  later(() => {
    emit('summary.delta', { noteUid: note.uid, seq: 0, textDelta: '本讲承接反向传播，' });
    emit('summary.delta', { noteUid: note.uid, seq: 1, textDelta: '重点讨论深层网络中的梯度消失问题，' });
    emit('summary.delta', { noteUid: note.uid, seq: 2, textDelta: '并给出残差连接与批归一化两条解决路径。' });
    emit('summary.done', { noteUid: note.uid, chars: 46 });
  }, doneAt + 600);
}

const mockFetcher: Fetcher = async <T,>(path: string, opts: ApiOptions = {}): Promise<T> => {
  await new Promise((r) => setTimeout(r, 60)); // 模拟本地往返
  const method = (opts.method ?? 'GET').toUpperCase();

  if (method === 'GET' && path === '/notes') {
    const list: NoteSummary[] = [...notes.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { notes: list } as T;
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
    note.activeJobId = jobUid;
    emit('note.created', { noteUid: note.uid, title: note.title, kind: 'media', folderUid: null });
    emit('note.status', { noteUid: note.uid, status: 'processing' });
    runImportPipeline(note, jobUid);
    return { jobUid, noteUid: note.uid } as unknown as T;
  }

  if (method === 'GET' && path === '/jobs') {
    return { jobs: [], concurrencyLimit: 2 } as T;
  }

  // 未实现的接口显式抛错，不静默返回空 —— 避免"看起来能用"的假象
  throw Object.assign(new Error(`[MOCK] 未实现的接口: ${method} ${path}`), {
    code: 'MOCK_NOT_IMPLEMENTED',
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
