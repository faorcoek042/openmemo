/**
 * F3 录音落盘 —— **产品真实路径**的 harness（T-151 ①）。
 *
 * ## 为什么这个文件必须先于那一行修复存在
 *
 * `asset-check` 在 T-136 查出 `ws/recorder.ts` 把**绝对路径**写进
 * `media_assets.rel_path`（`relPath: this.#wavPath`），并**刻意没有改它**，
 * 理由是「recorder 没有任何测试可依托，改了没测就是又一次未验证的修复」。
 * 那个判断是对的：这条链上有 WS 握手、二进制/文本混帧、异步 `start()`、
 * WAV 头回填、幂等 `stop()`、以及一条会真的入队的离线重跑 job ——
 * 单改一行而不跑一遍，等于把"我觉得它还能跑"当成结论。
 *
 * ## 这个 harness 覆盖到哪，以及哪一段是假的（说清楚，别让人误以为全真）
 *
 * **真的**：`node:http` 服务器 + `attachWebSocket`（真 Origin/Host/cookie 闸门）→
 * 真 `ws` 客户端发**真二进制帧** → `RecorderSession.writeAudio` → 真 `createWriteStream`
 * 落盘 → 真 `{"type":"stop"}` → 真 `#finalizeWav()` 回填头 → 真 `Repos.createAsset`
 * 落进真 SQLite → 真 `JobQueue.enqueue`。
 *
 * **假的只有一个**：`openStream` 返回一个手写的 `AsrStream` 桩，而不是真 sherpa 引擎。
 * 不需要麦克风、不需要模型、不跑任何转写 —— 用户明确要求不在本机跑 whisper。
 * 这与 `notes-contract` 用假 LLM 顶替厂商是同一条边界：**除了引擎，其余全是产品自己的路径**。
 *
 * ## 判据钉的是**后果**，不是那一行长什么样
 *
 * 「`rel_path` 不许是绝对路径」是**形式**。形式在不搬家的机器上永远看不出区别 ——
 * 读取侧的候选式解析对绝对路径也认得，这正是这个缺陷能活到今天的原因：
 * **宽容的读取会把不一致的写入藏起来。**
 *
 * 藏不住的那一刻是**数据目录搬家**（`media_assets.rel_path` 这一列存在的全部理由，
 * D-02 §1.1）。所以主断言是：把整个数据目录**原样搬到另一个位置**，
 * 再用**播放端那份解析规则**（`probeAssetFile`，T-136 收敛成的唯一一份）去读同一条记录，
 * 必须**真的读回我送进去的那些字节**。绝对路径在新根之外 ⇒ `assetCandidates` 返回空数组
 * ⇒ 播放 404、自检报「读不出来」，而那个 wav 明明跟着搬过去了。
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { openAppDatabase } from '@openmemo/db';
import type { AsrStream, TranscriptSegment } from '@openmemo/pipeline';
import { mediaAssetRoots, probeAssetFile } from '@openmemo/runtime';
import WebSocket from 'ws';

import { Repos } from '../db/repos.js';
import { SessionStore } from '../http/auth.js';
import { SseHub } from '../http/sse.js';
import { attachWebSocket } from '../http/ws.js';
import { JobQueue } from '../jobs/queue.js';
import { RECORD_SAMPLE_RATE, RecorderSession, type ServerMessage } from './recorder.js';

const made: string[] = [];
const closers: Array<() => void | Promise<void>> = [];
after(async () => {
  for (const c of closers.reverse()) await c();
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/** 一个能把送进来的 PCM 变成 final 段的 `AsrStream` 桩 —— 唯一被顶替掉的东西。 */
function fakeStream(): AsrStream {
  const handlers: { final: Array<(s: TranscriptSegment) => void> } = { final: [] };
  let frames = 0;
  return {
    write(pcm: Int16Array): void {
      frames += 1;
      const seg = {
        startMs: (frames - 1) * 100,
        endMs: frames * 100,
        text: `第 ${frames} 帧 ${pcm.length} 采样`,
        confidence: 0.9,
        noSpeechProb: null,
        words: null,
        chunkIdx: frames - 1,
        flags: 0,
        speakerLabel: null,
      } as unknown as TranscriptSegment;
      for (const h of handlers.final) h(seg);
    },
    on(event, handler): void {
      if (event === 'final') handlers.final.push(handler as (s: TranscriptSegment) => void);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

interface Recorded {
  dataDir: string;
  messages: ServerMessage[];
  /** 我真正送上去的 PCM 字节（不含 WAV 头）—— 用来反查读回来的是不是同一份。 */
  pcm: Buffer;
  asset: { uid: string; rel_path: string; bytes: number | null; role: string };
  /** 库里全部资产（按 id）—— ③ 要看 `peaks` 那一条真的存在且只有一条。 */
  assets: Array<{ uid: string; rel_path: string; bytes: number | null; role: string }>;
  note: { uid: string; status: string };
  jobs: Array<{ type: string; payload_json: string }>;
  events: string[];
}

/**
 * 跑完整一次录音：连上 → 送 N 个二进制帧 → `{"type":"stop"}` → 收 `stopped`。
 *
 * 返回的是**库里真实落下的行**，不是会话对象自报的东西。
 */
async function record(frames: number): Promise<Recorded> {
  const dataDir = await mkdtemp(join(tmpdir(), 'om-rec-'));
  made.push(dataDir);
  const mediaDir = join(dataDir, 'media');

  const handle = openAppDatabase({ filename: join(dataDir, 'openmemo.db') });
  closers.push(() => handle.close());
  const repos = new Repos(handle.db);
  repos.ensureDefaultFolder();
  const queue = new JobQueue(handle.db, 'test-instance', () => undefined);
  const sse = new SseHub();
  // SSE 观察者（不影响广播）—— ③ 要证明 `media.asset.ready` 真的被发出去了
  const events: string[] = [];
  sse.observe((e) => events.push(e.type));

  const server: Server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const sessions = new SessionStore('boot-token-for-test');
  const session = sessions.create();

  const wss = attachWebSocket(server, {
    sessions,
    port: () => port,
    recorder: {
      repos,
      queue,
      sse,
      mediaDir,
      dataDir,
      openStream: () => fakeStream(),
      streamModelId: 'fake-stream-model',
    },
  });
  closers.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));

  // 真闸门：Host 必须是 IP 字面量 + 端口相符，Origin 必须严格同源，且必须带凭据
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/recorder?title=harness`, {
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      cookie: `om_sid=${session.sid}`,
    },
  });

  const messages: ServerMessage[] = [];
  const stopped = new Promise<void>((resolve, reject) => {
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString('utf8')) as ServerMessage;
      messages.push(msg);
      if (msg.type === 'stopped') resolve();
      if (msg.type === 'error') reject(new Error(`${msg.code}: ${msg.messageZh}`));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('录音会话超时，没有收到 stopped')), 15_000).unref();
  });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  // 等 ready —— ws.ts 在 start() 完成前会丢帧（`if (!started) return`），这是产品行为
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (messages.some((m) => m.type === 'ready')) {
        clearInterval(t);
        resolve();
      }
    }, 5);
    t.unref();
  });

  /*
   * 每帧 100 ms 的 16 kHz 单声道 int16。内容用**递增序号**而不是全零/静音：
   * 读回来的字节能逐一对上，才能证明读到的是"我写的那份文件"，
   * 而不是碰巧存在的另一个同名文件（T-128 立的那条：断言钉后果，不钉"组件存在"）。
   */
  const chunks: Buffer[] = [];
  for (let f = 0; f < frames; f += 1) {
    const samples = RECORD_SAMPLE_RATE / 10;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1)
      buf.writeInt16LE(((f * samples + i) % 30000) - 15000, i * 2);
    chunks.push(buf);
    ws.send(buf, { binary: true });
  }
  ws.send(JSON.stringify({ type: 'stop' }));
  await stopped;

  const assets = handle.db
    .prepare<{ uid: string; rel_path: string; bytes: number | null; role: string }>(
      'SELECT uid, rel_path, bytes, role FROM media_assets ORDER BY id',
    )
    .all();
  const asset = assets.find((a) => a.role === 'original');
  assert.ok(asset, `录音结束后没有 original 资产：${JSON.stringify(assets)}`);
  const note = handle.db
    .prepare<{ uid: string; status: string }>(
      'SELECT uid, status FROM notes ORDER BY id DESC LIMIT 1',
    )
    .get({});
  assert.ok(note, '录音结束后 notes 里一行都没有');
  const jobs = handle.db
    .prepare<{ type: string; payload_json: string }>('SELECT type, payload_json FROM jobs')
    .all();

  return { dataDir, messages, pcm: Buffer.concat(chunks), asset, assets, note, jobs, events };
}

describe('F3 录音落盘 —— 走真 WebSocket 的 harness', () => {
  it('★ 数据目录搬家后，录音仍然读得回来（rel_path 不许是绝对路径）', async () => {
    const r = await record(3);

    // ── ① 原地：产品自己的解析规则要能读到，且**内容逐字节等于我送上去的 PCM**
    const here = await probeAssetFile(mediaAssetRoots(r.dataDir), r.asset.rel_path);
    assert.equal(
      here.abs === null,
      false,
      `原地就读不到 ${r.asset.rel_path}（找过：${here.tried.join('、') || '一个候选都没有'}）`,
    );
    const wavHere = await readFile(here.abs as string);
    assert.equal(wavHere.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(
      wavHere.subarray(44).equals(r.pcm),
      true,
      '读回来的 PCM 与送上去的对不上 —— 说明读到的不是这次录的那个文件',
    );

    // ── ② 搬家：整个数据目录原样搬走，**只换根**，记录一个字不改
    const moved = await mkdtemp(join(tmpdir(), 'om-rec-moved-'));
    made.push(moved);
    await cp(r.dataDir, moved, { recursive: true });

    const there = await probeAssetFile(mediaAssetRoots(moved), r.asset.rel_path);
    assert.equal(
      there.abs === null,
      false,
      `数据目录搬到 ${moved} 之后就读不到了：rel_path=${r.asset.rel_path}\n` +
        `找过：${there.tried.join('、') || '一个候选都没有（记录指到了所有根之外 —— 典型的绝对路径）'}\n` +
        `这正是「用户搬了一次数据目录，录音全部播放 404」的形状：文件跟着搬过去了，记录却还指着老地方。`,
    );
    assert.equal(
      (there.abs as string).startsWith(moved),
      true,
      `搬家后解析出来的路径 ${there.abs} 不在新数据目录里 —— 它读的还是老位置的文件`,
    );
    const wavThere = await readFile(there.abs as string);
    assert.equal(wavThere.subarray(44).equals(r.pcm), true, '搬家后读到的内容对不上');
  });

  it('★ rel_path 落进 media 根这一档（与 transcribe.ts 同一种规范形态）', async () => {
    const r = await record(1);
    /*
     * 钉的是"它与另外两个写入方产出同一种形态"，不是"它长这样"。
     * 三种写法并存正是 T-136 的病根：读取方只要挑错基准，就会把好文件报成"已被删除"。
     */
    const probe = await probeAssetFile(mediaAssetRoots(r.dataDir), r.asset.rel_path);
    assert.equal(
      probe.tried[0],
      join(r.dataDir, 'media', r.asset.rel_path),
      `rel_path 不是"相对 media 根"这一档：${r.asset.rel_path}`,
    );
    assert.equal(probe.abs, probe.tried[0], '第一个候选就该是它，走到后面的根说明形态不规范');
  });

  it('WAV 头在停止时被回填成真实长度（否则播放器只认出 0 秒）', async () => {
    const r = await record(2);
    const probe = await probeAssetFile(mediaAssetRoots(r.dataDir), r.asset.rel_path);
    const wav = await readFile(probe.abs as string);
    assert.equal(wav.readUInt32LE(40), r.pcm.length, 'data chunk 长度还是占位的 0');
    assert.equal(wav.readUInt32LE(4), 36 + r.pcm.length, 'RIFF 长度还是占位的');
    assert.equal(wav.readUInt32LE(24), RECORD_SAMPLE_RATE, '采样率写错了');
    assert.equal(r.asset.bytes, r.pcm.length + 44, '落库的 bytes 与文件实际长度对不上');
  });

  it('★ 录完就有真波形：peaks 资产落库 + 文件能按 .ompk 解开（T-151 ③）', async () => {
    /*
     * 在这之前 daemon **零处**产出 `role='peaks'`，前端只好凭空造一条正弦波（T-139 A3）。
     * 这条用例钉的不是"有一行记录"，而是**那个文件真的是一份能解开的 .ompk，
     * 而且它描述的是我刚录的那段音频**（桶数由帧数算得出来）。
     */
    const frames = 3;
    const r = await record(frames);

    const peaks = r.assets.filter((a) => a.role === 'peaks');
    assert.equal(
      peaks.length,
      1,
      `peaks 资产应当恰好一条，实得 ${peaks.length}：${JSON.stringify(r.assets)}`,
    );
    const row = peaks[0] as { uid: string; rel_path: string; bytes: number | null };

    // 与音轨同一条解析规则（T-136 收敛的那一份），不走旁路
    const probe = await probeAssetFile(mediaAssetRoots(r.dataDir), row.rel_path);
    assert.equal(probe.abs === null, false, `波形文件读不到：${row.rel_path}`);
    const buf = await readFile(probe.abs as string);

    assert.equal(buf.toString('ascii', 0, 4), 'OMPK', 'magic 不对，前端会直接抛');
    assert.equal(buf.readUInt8(4), 1, '版本不是 1');
    assert.equal(buf.readUInt8(5), 1, '录音是单声道');
    const spp = buf.readUInt32LE(6);
    const totalFrames = r.pcm.length / 2;
    const buckets = Math.ceil(totalFrames / spp);
    assert.equal(
      buf.length,
      14 + buckets * 2,
      `文件长度与"帧数 / samplesPerPixel"算出来的桶数对不上（spp=${spp} frames=${totalFrames}）`,
    );
    assert.equal(row.bytes, buf.length, '落库的 bytes 与文件实际长度对不上');
    // 送的是递增序号 PCM（不是静音），所以峰值必须不全为 0
    assert.equal(
      buf.subarray(14).some((b) => b !== 0),
      true,
      '波形全是 0 —— 读到的不是我刚录的那段音频',
    );

    /*
     * `media.asset.ready` 契约里早就有、前端 `notesSse` 也早就订阅着，
     * 但**在这之前一次都没有被发布过**（没有异步产物）。
     * 少了它，用户得手动刷新才看得到波形。
     */
    assert.equal(
      r.events.includes('media.asset.ready'),
      true,
      `没有发 media.asset.ready，实际发了：${[...new Set(r.events)].join(',')}`,
    );
  });

  it('会话协议：ready → final × N → stopped，且离线重跑 job 真的入队了', async () => {
    const r = await record(3);
    const types = messagesOf(r.messages);
    assert.equal(types[0], 'ready', `第一条不是 ready：${types.join(',')}`);
    assert.equal(types[types.length - 1], 'stopped');
    assert.equal(
      r.messages.filter((m) => m.type === 'final').length,
      3,
      '送了 3 帧，final 不是 3 条',
    );

    const stopped = r.messages.find((m) => m.type === 'stopped');
    assert.equal(stopped?.type === 'stopped' && stopped.segmentCount, 3);
    assert.equal(
      stopped?.type === 'stopped' && typeof stopped.rerunJobUid === 'string',
      true,
      '有段落却没排离线重跑 —— F3 两阶段的第二阶段没接上',
    );

    assert.equal(r.jobs.length, 1, `入队的 job 数不对：${JSON.stringify(r.jobs)}`);
    assert.equal(r.jobs[0]?.type, 'transcribe');
    /*
     * ⚠️ job payload 里的 `input` **仍然是绝对路径**，这是**对的**，别顺手一起改：
     * 它是一次性的进程内交接（runner 立刻拿去 ffmpeg），不是要长期存活的记录。
     * `rel_path` 之所以必须相对，是因为它要在数据目录搬家之后还认得出来。
     * 两者判据不同，混为一谈会把 runner 弄坏。
     */
    const payload = JSON.parse(r.jobs[0]?.payload_json ?? '{}') as { input?: string };
    assert.equal(
      typeof payload.input === 'string' && payload.input.startsWith(r.dataDir),
      true,
      `重跑 job 的输入路径不对：${String(payload.input)}`,
    );

    assert.equal(r.note.status, 'ready', '录音结束后笔记状态没置 ready');
  });
});

/** 只取消息类型，避免把整个消息对象丢进断言的 diff（PROTOCOL §8 同族的省事写法）。 */
function messagesOf(msgs: readonly ServerMessage[]): string[] {
  return msgs.map((m) => m.type);
}

/* ========================================================================== *
 * T-164 ②：**引擎不可用时录一次音，不许在库里留下任何东西**
 * ========================================================================== */

/**
 * 起一个 `openStream` 恒返回 undefined 的会话（= 没装流式模型的真实状态）。
 *
 * 用**真 `RecorderSession`**，不走 WS —— 因为要断言的是"停止之后库里是什么"，
 * 而经 WS 的话 `stop()` 是由服务端在 `ws.on('close')` 里异步触发的：
 * 断言可能跑在它前面，于是**把缺陷放回去也照样绿**。
 * 这里全程 `await`，时序上不存在那个窗口。WS 那一半单独由下面一条钉。
 */
async function deadSession(): Promise<{
  dataDir: string;
  mediaDir: string;
  db: ReturnType<typeof openAppDatabase>['db'];
  messages: ServerMessage[];
  session: RecorderSession;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'om-rec-dead-'));
  made.push(dataDir);
  const mediaDir = join(dataDir, 'media');

  const handle = openAppDatabase({ filename: join(dataDir, 'openmemo.db') });
  closers.push(() => handle.close());
  const repos = new Repos(handle.db);
  repos.ensureDefaultFolder();
  const queue = new JobQueue(handle.db, 'test-instance', () => undefined);
  const sse = new SseHub();

  const messages: ServerMessage[] = [];
  const session = new RecorderSession(
    {
      repos,
      queue,
      sse,
      mediaDir,
      dataDir,
      // ★ 这就是「没装流式模型」在产品里的真实形状（`setup.ts` 构造不出引擎）
      openStream: () => undefined,
      streamModelId: 'none',
    },
    (m) => messages.push(m),
  );
  return { dataDir, mediaDir, db: handle.db, messages, session };
}

function countOf(db: ReturnType<typeof openAppDatabase>['db'], table: string): number {
  return db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get({})?.n ?? -1;
}

describe('F3 引擎不可用 —— 录一次音不许留下一条「就绪」的死笔记（T-164 ②）', () => {
  it('★ 开不起来 → 停止/断线之后 notes / transcripts / media_assets / jobs 全部一行都没有', async () => {
    const d = await deadSession();

    await d.session.start({ title: '用户点了一次开始录音' });

    // 前提：它确实走的是"引擎不可用"那一支，而不是碰巧什么都没做
    const err = d.messages.find((m) => m.type === 'error');
    assert.equal(
      err?.type === 'error' && err.code,
      'ASR_STREAM_UNAVAILABLE',
      `没有收到引擎不可用的错误，实际消息：${messagesOf(d.messages).join(',')}`,
    );

    /*
     * 用户接下来只可能做两件事之一，两条都要安全：
     *   · 点「停止」        → `stop()`
     *   · 关掉标签页/断线   → `ws.on('close')` → `abandon()`
     * 缺陷版本里这两条都会跑完整条收尾链，造出那条死笔记。
     */
    await d.session.stop();
    await d.session.abandon();

    /*
     * 判据钉的是**后果**：库里一行都不许有。
     *
     * 不钉"status 不等于 ready" —— 那样把状态改成 'failed' 就能骗过去，
     * 而用户仍然会看到一条 0 秒、打不开的笔记躺在列表里。
     */
    assert.equal(
      countOf(d.db, 'notes'),
      0,
      '引擎不可用却建了笔记 —— 这就是那条 0 秒打不开的「就绪」死笔记',
    );
    assert.equal(countOf(d.db, 'transcripts'), 0, '建了转写稿');
    assert.equal(countOf(d.db, 'media_assets'), 0, '落了媒体资产（对一个空文件）');
    assert.equal(countOf(d.db, 'jobs'), 0, '排了任务');

    // 盘上也不许留东西：44 字节的空 WAV 头同样是垃圾
    const recDir = join(d.mediaDir, 'recordings');
    // 目录压根没建出来是期望结果之一，所以读不到就是空集
    const left = await readdir(recDir).catch(() => [] as string[]);
    assert.deepEqual(left, [], `盘上留下了空录音文件：${left.join(',')}`);
  });

  it('★ 开不起来时 `active` 为假 —— WS 层据此关闭连接，不让前端对着死路推流', async () => {
    const d = await deadSession();
    await d.session.start({ title: 'x' });
    assert.equal(
      d.session.active,
      false,
      'start() 正常返回了，但 active 仍是真 —— ws.ts 会把 socket 留着，浏览器继续推流',
    );
  });

  it('★ 走真 WebSocket：引擎不可用时服务端主动关闭连接', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'om-rec-deadws-'));
    made.push(dataDir);
    const handle = openAppDatabase({ filename: join(dataDir, 'openmemo.db') });
    closers.push(() => handle.close());
    const repos = new Repos(handle.db);
    repos.ensureDefaultFolder();

    const server: Server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const sessions = new SessionStore('boot-token-for-test');
    const session = sessions.create();
    const wss = attachWebSocket(server, {
      sessions,
      port: () => port,
      recorder: {
        repos,
        queue: new JobQueue(handle.db, 'test-instance', () => undefined),
        sse: new SseHub(),
        mediaDir: join(dataDir, 'media'),
        dataDir,
        openStream: () => undefined,
        streamModelId: 'none',
      },
    });
    closers.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/recorder`, {
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        cookie: `om_sid=${session.sid}`,
      },
    });

    const seen: ServerMessage[] = [];
    ws.on('message', (raw: Buffer) => seen.push(JSON.parse(raw.toString('utf8')) as ServerMessage));

    /*
     * **客户端一个字都不发**。缺陷版本里 socket 会一直开着（`started = true`），
     * 于是这里超时 → 红。这一条不依赖任何 DB 状态，正好补上上面那条测不到的一半。
     */
    const closedByServer = await new Promise<boolean>((resolve) => {
      ws.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 5_000).unref();
    });
    ws.close();

    assert.equal(
      closedByServer,
      true,
      '引擎不可用，服务端却把 WS 留着 —— 浏览器会继续录、继续推，界面停在「录音中」',
    );
    assert.equal(
      seen.some((m) => m.type === 'error' && m.code === 'ASR_STREAM_UNAVAILABLE'),
      true,
      `关之前没有把原因说出来：${messagesOf(seen).join(',')}`,
    );
  });
});
