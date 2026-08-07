/**
 * F3/F5「重新转写」**不许把词级时间戳整份丢掉**（T-164 ④）。
 *
 * ## 缺陷长什么样
 *
 * `jobs/runners/transcribe.ts` 的两阶段合并把 DB 行映射回 `MergeableSegment` 时，
 * **两处都写死 `words: null`**：
 *
 * ```ts
 * const draft: MergeableSegment[] = draftRows.map((r) => ({ …, words: null, … }));
 * const rerun = rerunRows.map((r) => ({ …, words: null, … }));
 * ```
 *
 * 而 `words_json` 明明就在库里（`insertSegments` 真写、`rest/notes.ts` 真发）。
 * 合并的结果经 `replaceSegments` **整表覆盖**回去 —— 于是该稿**所有**段的 `words` 变 NULL。
 *
 * 用户侧：`TranscriptList` 的 `hasWordLevel` 翻假 → 卡拉 OK 逐字高亮退化成整句高亮，
 * 而 `WordLevelBadge` 还会告诉他"这个引擎只有句级"。**他会以为是引擎不行。**
 * 触发它的是两个常规动作：点「重新转写」、或任何一次 F3 离线重跑。而且**不可逆**。
 *
 * ## 这个文件同时补上另一件事：`runTranscribeJob` 此前**零测试引用**
 *
 * `progress-audit §4⑬`：F1/F2/F3 的最终执行者一条用例都没有，只被手动触发的
 * `cold-start-audit` 端到端跑过 —— **改坏 `transcribe.ts`，CI 一片绿**。
 * 所以这里不测那两行映射的"局部纯函数"，而是**真的把 runner 跑一遍**：
 * 真 SQLite、真 `Repos`、真 `JobQueue`、真 `SseHub`、真落盘归档。
 *
 * **唯一被顶替掉的是 `TranscribePipeline`**（它要 ffmpeg / whisper / 真模型，
 * 而用户明确禁止在本机跑转写）。这与 `recorder.test.ts` 顶替 `AsrStream` 是同一条边界：
 * 除了引擎，其余全是产品自己的路径。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { openAppDatabase } from '@openmemo/db';
import type { TranscribePipeline, TranscriptSegment, WordTimestamp } from '@openmemo/pipeline';

import { Repos } from '../db/repos.js';
import { SseHub } from '../http/sse.js';
import { JobQueue } from './queue.js';
import { runTranscribeJob } from './runners/transcribe.js';

const made: string[] = [];
const closers: Array<() => void | Promise<void>> = [];
after(async () => {
  for (const c of closers.reverse()) await c();
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/** 44 字节头 + 一点 PCM —— `generatePeaksAsset` 会真的去读它。 */
function tinyWav(): Buffer {
  const data = Buffer.alloc(3200); // 0.1 s @ 16 kHz mono int16
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(((i * 37) % 20000) - 10000, i);
  const b = Buffer.alloc(44 + data.length);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data.length, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(data.length, 40);
  data.copy(b, 44);
  return b;
}

function seg(startMs: number, endMs: number, text: string, words: WordTimestamp[] | null): TranscriptSegment {
  return {
    startMs,
    endMs,
    text,
    confidence: 0.9,
    noSpeechProb: null,
    words,
    chunkIdx: 0,
    flags: 0,
    speakerLabel: null,
  };
}

interface RerunOutcome {
  rows: Array<{ start_ms: number; end_ms: number; text: string; words_json: string | null; edited_at: number | null }>;
  dataDir: string;
}

/**
 * 建一份「流式草稿」（用户改过其中一段），再跑一次**带 `mergeWithTranscriptId` 的**
 * 离线重跑 job —— 这正是 F3 停止录音后自动排的那个 job，以及 F5「重新转写」走的那条路。
 */
async function rerunOverDraft(): Promise<RerunOutcome> {
  const dataDir = await mkdtemp(join(tmpdir(), 'om-merge-'));
  made.push(dataDir);
  const mediaRoot = join(dataDir, 'media');
  const scratch = join(dataDir, 'tmp');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(scratch, { recursive: true });

  const handle = openAppDatabase({ filename: join(dataDir, 'openmemo.db') });
  closers.push(() => handle.close());
  const repos = new Repos(handle.db);
  repos.ensureDefaultFolder();
  const queue = new JobQueue(handle.db, 'test-instance', () => undefined);
  const sse = new SseHub();

  const note = repos.createNote({ title: '录音 2026-08-07', kind: 'recording', language: 'zh' });
  const draft = repos.createTranscript({
    noteId: note.id,
    engineId: 'sherpa-onnx',
    modelId: 'streaming-zipformer-zh-14M',
    language: 'zh',
    kind: 'streaming',
  });
  /*
   * 草稿两段，**都带词级时间戳**：
   *   0–1000ms  用户改过（editedAt 非空）→ 合并时必须原样保留，包括它的 words
   *   2000–3000ms 没改过           → 会被重跑那一段替换掉
   */
  repos.insertSegments(draft.id, [
    {
      startMs: 0,
      endMs: 1000,
      text: '我改过这一句',
      confidence: 0.9,
      noSpeechProb: null,
      words: [
        { w: '我', s: 0, e: 200 },
        { w: '改过', s: 200, e: 600 },
        { w: '这一句', s: 600, e: 1000 },
      ] satisfies WordTimestamp[],
      chunkIdx: 0,
      flags: 0,
      editedAt: Date.now(),
    },
    {
      startMs: 2000,
      endMs: 3000,
      text: '这一句没改',
      confidence: 0.9,
      noSpeechProb: null,
      words: [{ w: '这一句没改', s: 2000, e: 3000 }] satisfies WordTimestamp[],
      chunkIdx: 0,
      flags: 0,
    },
  ]);

  // 重跑的输出：与未编辑那段重叠（替换它），再加一段全新的
  const rerunSegments = [
    seg(2000, 3000, '这一句没改（离线版）', [
      { w: '这一句', s: 2000, e: 2500 },
      { w: '没改', s: 2500, e: 3000 },
    ]),
    seg(4000, 5000, '重跑新发现的一句', [{ w: '重跑新发现的一句', s: 4000, e: 5000 }]),
  ];

  const inputWav = join(scratch, 'source.wav');
  const normalizedWav = join(scratch, 'audio16k.wav');
  await writeFile(inputWav, tinyWav());
  await writeFile(normalizedWav, tinyWav());

  const fakePipeline = {
    async run(req: {
      onChunkComplete?: (c: unknown, s: TranscriptSegment[]) => Promise<void>;
    }): Promise<unknown> {
      // runner 靠 onChunkComplete 把段落落库 —— 走真路径，不直接写表
      await req.onChunkComplete?.({ index: 0 }, rerunSegments);
      return {
        info: { title: null },
        media: { path: inputWav, sizeBytes: 3244 },
        normalizedPath: normalizedWav,
        durationMs: 5000,
        chunks: [],
        segments: rerunSegments,
        speechMs: 5000,
        rtf: 0.1,
        timings: {},
        yielded: false,
        remainingChunks: [],
        chunking: 'vad',
        warningsZh: [],
      };
    },
  } as unknown as TranscribePipeline;

  const job = queue.enqueue({
    type: 'transcribe',
    lane: 'gpu.asr',
    priority: 10,
    noteId: note.id,
    payload: {
      noteId: note.id,
      input: inputWav,
      sourceKind: 'recording',
      language: 'zh',
      mergeWithTranscriptId: draft.id,
    },
  });

  await runTranscribeJob(
    job,
    {
      repos,
      sse,
      queue,
      pipelineFor: () => ({
        pipeline: fakePipeline,
        engineId: 'whisper.cpp',
        reason: 'test',
        modelPath: join(dataDir, 'ggml-base-q5_1.bin'),
      }),
      modelPath: null,
      mediaRoot,
      dataDir,
      modelId: 'ggml-base-q5_1.bin',
      modelsDir: join(dataDir, 'models'),
    },
    new AbortController().signal,
  );

  // 活跃稿 = runner 新建的那一份（不是 draft）
  const active = handle.db
    .prepare<{ id: number }>(
      `SELECT id FROM transcripts WHERE note_id = :n AND id != :d ORDER BY id DESC LIMIT 1`,
    )
    .get({ n: note.id, d: draft.id });
  assert.ok(active, 'runner 没有建出重跑稿');
  const rows = handle.db
    .prepare<{
      start_ms: number;
      end_ms: number;
      text: string;
      words_json: string | null;
      edited_at: number | null;
    }>(
      `SELECT start_ms, end_ms, text, words_json, edited_at FROM transcript_segments
       WHERE transcript_id = :t ORDER BY start_ms`,
    )
    .all({ t: active.id });

  return { rows, dataDir };
}

describe('重新转写 / F3 离线重跑：词级时间戳不许被合并抹掉（T-164 ④）', () => {
  it('★ 合并写回后，每一段的 words_json 都还在（缺陷版本里整表变 NULL）', async () => {
    const r = await rerunOverDraft();

    assert.equal(r.rows.length, 3, `合并后段数不对：${JSON.stringify(r.rows.map((x) => x.text))}`);

    /*
     * 判据钉的是**后果**：三段各自的词级时间戳还在，而且内容对得上。
     *
     * 不写成 "words_json !== null" 就完事 —— 那样把 words 换成 `[]` 也能骗过去，
     * 而 `hasWordLevel` 用的是 `s.words && s.words.length > 0`，空数组照样降级。
     */
    for (const row of r.rows) {
      assert.equal(
        row.words_json !== null,
        true,
        `「${row.text}」的 words_json 是 NULL —— 逐字高亮从这一刻起永久降级成整句`,
      );
      const words = JSON.parse(row.words_json as string) as WordTimestamp[];
      assert.equal(
        Array.isArray(words) && words.length > 0,
        true,
        `「${row.text}」的 words 是空数组 —— 与 NULL 对用户是同一个后果`,
      );
      // 每个词的时间必须落在这一段的跨度里，证明读回来的是**这一段自己**的词表
      for (const w of words) {
        assert.equal(
          w.s >= row.start_ms && w.e <= row.end_ms,
          true,
          `「${row.text}」拿到的是别的段的词表：${JSON.stringify(w)} 不在 [${row.start_ms},${row.end_ms}]`,
        );
      }
    }
  });

  it('★ 用户改过的那一段：文本、编辑标记、以及它自己的 words 三者一起活下来', async () => {
    const r = await rerunOverDraft();
    const kept = r.rows.find((x) => x.start_ms === 0);
    assert.ok(kept, '用户编辑过的那一段整段没了');
    assert.equal(kept.text, '我改过这一句', '用户的编辑被重跑覆盖了');
    assert.equal(kept.edited_at !== null, true, 'edited_at 没写回 —— 下一次重跑就会把它当没人编辑过而覆盖');
    const words = JSON.parse(kept.words_json ?? 'null') as WordTimestamp[] | null;
    assert.equal(
      words?.length,
      3,
      '保留下来的编辑段丢了自己的词级时间戳 —— 文本活着、时间轴死了',
    );
  });

  it('重跑替换掉的那一段用的是重跑的新文本与新词表（证明合并真的发生了）', async () => {
    const r = await rerunOverDraft();
    const replaced = r.rows.find((x) => x.start_ms === 2000);
    assert.ok(replaced, '2000ms 那一段不见了');
    assert.equal(
      replaced.text,
      '这一句没改（离线版）',
      '未编辑段没有被重跑替换 —— 那这条用例根本没走到合并分支，上面两条也就不证明什么',
    );
    const words = JSON.parse(replaced.words_json ?? 'null') as WordTimestamp[] | null;
    assert.equal(words?.length, 2, '替换进来的段没有带上重跑那份词表');
  });
});
