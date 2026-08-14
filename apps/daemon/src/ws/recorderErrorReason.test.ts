/**
 * `/ws/recorder` 的 error 帧 —— **上了网线的那一份里不许有中文**（#112 第 19 处）。
 *
 * ## 为什么这一条非有不可
 *
 * 这条帧原来是 `{ type:'error'; code; messageZh }`：**帧上唯一的人话，而且只有中文**，
 * `RecorderPage` 直接 `setStreamError(msg.messageZh)`。也就是说英文用户那条横幅
 * **无论怎么改前端都救不了** —— 帧上没有别的东西可渲染。修复是把 `messageZh` 整格删掉、
 * 换成机器可读的 `reason: RecorderErrorReason`，措辞归 `apps/web` 的两份 locale。
 *
 * 而"删干净了没有"这件事，**只有把六个发出点真的跑一遍才知道**。所以下面不写字面量：
 * 每一条帧都由**产品自己的代码路径**产出（真 `RecorderSession`、真 `attachWebSocket`、
 * 真 WS 客户端），假的只有 `AsrStream` 桩 —— 与 `recorder.test.ts` 同一条边界。
 *
 * 形状抄 `packages/downloader/src/rateLimitReason.test.ts` 的第 ④ 组，
 * **包括它的前提检查**：正则本身抓不到汉字的话，这一整组就是空转，
 * 而"空转的守卫"正是这轮在猎的那个失败形态。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { openAppDatabase } from '@openmemo/db';
import type { AsrStream } from '@openmemo/pipeline';
import type { RecorderErrorReason } from '@openmemo/shared';
import WebSocket from 'ws';

import { Repos } from '../db/repos.js';
import { SessionStore } from '../http/auth.js';
import { SseHub } from '../http/sse.js';
import { attachWebSocket } from '../http/ws.js';
import { JobQueue } from '../jobs/queue.js';
import { RecorderSession, type RecorderDeps, type ServerMessage } from './recorder.js';

const made: string[] = [];
const closers: Array<() => void | Promise<void>> = [];
after(async () => {
  for (const c of closers.reverse()) await c();
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

type ErrorFrame = Extract<ServerMessage, { type: 'error' }>;

/**
 * 每一格由**哪个发出点**产出。**总 `Record`**：契约里加一格而没人在这里
 * 说清它从哪儿来，**编译当场就红**；说了却没真去驱动它，下面的条数断言会红。
 * 两道一起，这套样本才不会悄悄缩水成"只覆盖我当时想得起来的那几格"。
 */
const EMIT_SITES: Readonly<Record<RecorderErrorReason['kind'], string>> = {
  stream_engine_unavailable: 'ws/recorder.ts · openStream 返回 undefined（没装流式模型）',
  start_failed: 'http/ws.ts · session.start() 抛',
  engine_error: 'ws/recorder.ts · stream.on("error")',
  finalize_failed: 'http/ws.ts · finish() 捕到 stop() 抛',
  control_message_not_json: 'http/ws.ts · 上行文本帧不是合法 JSON',
  asr_worker_not_implemented: 'http/ws.ts · /ws/asr-worker',
};

/** 我扔进 `start()` 的那句原文 —— 下面要逐字对回来，证明 `detail` 真是原样串。 */
const START_ERROR_TEXT = 'OPENMEMO_SHERPA_STREAM_DIR points at a directory with no encoder';
/** 同上，引擎中途报错那一路。 */
const ENGINE_ERROR_TEXT = 'sherpa-onnx: decoder state is corrupt (code 7)';

/* ------------------------------ 桩与脚手架 -------------------------------- */

/** 能开起来、但什么都不识别的 `AsrStream` 桩。唯一被顶替掉的东西。 */
function idleStream(onErrorHandler?: (fire: (err: Error) => void) => void): AsrStream {
  return {
    write(): void {
      /* 这一组不关心识别结果，只关心错误帧 */
    },
    on(event, handler): void {
      if (event === 'error') onErrorHandler?.(handler as (err: Error) => void);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

interface Harness {
  readonly port: number;
  readonly sid: string;
}

/**
 * 起一台真服务器 + 真 `attachWebSocket`。
 *
 * `mediaOutsideDataDir` 是**收尾失败在产品里的真实形状**：录音落盘路径算不出
 * 规范相对路径时 `stop()` 会抛（写绝对路径进 `media_assets.rel_path` =
 * 数据目录一搬家录音就找不回来，T-151 ①），那条 reject 正好落进 `finish()`。
 */
async function harness(opts: {
  openStream: RecorderDeps['openStream'];
  mediaOutsideDataDir?: boolean;
}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'om-recerr-'));
  made.push(dataDir);
  let mediaDir = join(dataDir, 'media');
  if (opts.mediaOutsideDataDir) {
    mediaDir = await mkdtemp(join(tmpdir(), 'om-recerr-media-'));
    made.push(mediaDir);
  }

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
  const { sid } = sessions.create();
  const wss = attachWebSocket(server, {
    sessions,
    port: () => port,
    recorder: {
      repos,
      queue: new JobQueue(handle.db, 'test-instance', () => undefined),
      sse: new SseHub(),
      mediaDir,
      dataDir,
      openStream: opts.openStream,
      streamModelId: 'fake-stream-model',
    },
  });
  closers.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  return { port, sid };
}

/** 真闸门：Host 是 IP 字面量 + 端口相符，Origin 严格同源，且带凭据。 */
function connect(h: Harness, path: string): { ws: WebSocket; seen: ServerMessage[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}${path}`, {
    headers: {
      host: `127.0.0.1:${h.port}`,
      origin: `http://127.0.0.1:${h.port}`,
      cookie: `om_sid=${h.sid}`,
    },
  });
  const seen: ServerMessage[] = [];
  ws.on('message', (raw: Buffer) => seen.push(JSON.parse(raw.toString('utf8')) as ServerMessage));
  // 客户端侧的 socket 错误不该把整个测试进程带走（服务端会主动关连接）
  ws.on('error', () => undefined);
  return { ws, seen };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到 `pick()` 给出东西为止；等不到就**响亮地失败**，不要静默返回 undefined。 */
async function waitFor<T>(pick: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const got = pick();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`等不到${what}`);
    await sleep(5);
  }
}

const errorIn = (seen: readonly ServerMessage[]): ErrorFrame | undefined =>
  seen.find((m): m is ErrorFrame => m.type === 'error');

const readyIn = (seen: readonly ServerMessage[]): ServerMessage | undefined =>
  seen.find((m) => m.type === 'ready');

/* ---------------------------- 六个发出点，逐个跑 --------------------------- */

interface Collected {
  readonly site: string;
  readonly frame: ErrorFrame;
}

/** 六条帧只采一次（每条都要起服务器 / 落库），后面几个用例共用。 */
let collecting: Promise<Collected[]> | null = null;
const frames = (): Promise<Collected[]> => (collecting ??= collectEveryFrame());

async function collectEveryFrame(): Promise<Collected[]> {
  const out: Collected[] = [];

  /* ── ① 没装流式模型：`RecorderSession` 直驱，不经 WS ── */
  {
    const dataDir = await mkdtemp(join(tmpdir(), 'om-recerr-dead-'));
    made.push(dataDir);
    const handle = openAppDatabase({ filename: join(dataDir, 'openmemo.db') });
    closers.push(() => handle.close());
    const repos = new Repos(handle.db);
    repos.ensureDefaultFolder();
    const seen: ServerMessage[] = [];
    const session = new RecorderSession(
      {
        repos,
        queue: new JobQueue(handle.db, 'test-instance', () => undefined),
        sse: new SseHub(),
        mediaDir: join(dataDir, 'media'),
        dataDir,
        // ★ 这就是「没装流式模型」在产品里的真实形状（`setup.ts` 构造不出引擎）
        openStream: () => undefined,
        streamModelId: 'none',
      },
      (m) => seen.push(m),
    );
    await session.start({ title: '用户点了一次开始录音' });
    const frame = errorIn(seen);
    assert.ok(frame, `引擎不可用那一支没有发出 error 帧：${JSON.stringify(seen)}`);
    out.push({ site: EMIT_SITES.stream_engine_unavailable, frame });
  }

  /* ── ② 引擎开着、自己报错：同样直驱，因为要抓住桩的 error handler ── */
  {
    const dataDir = await mkdtemp(join(tmpdir(), 'om-recerr-engerr-'));
    made.push(dataDir);
    const handle = openAppDatabase({ filename: join(dataDir, 'openmemo.db') });
    closers.push(() => handle.close());
    const repos = new Repos(handle.db);
    repos.ensureDefaultFolder();
    const seen: ServerMessage[] = [];
    const fired: Array<(err: Error) => void> = [];
    const session = new RecorderSession(
      {
        repos,
        queue: new JobQueue(handle.db, 'test-instance', () => undefined),
        sse: new SseHub(),
        mediaDir: join(dataDir, 'media'),
        dataDir,
        openStream: () => idleStream((fire) => fired.push(fire)),
        streamModelId: 'fake-stream-model',
      },
      (m) => seen.push(m),
    );
    await session.start({ title: 'engine error' });
    assert.equal(
      fired.length,
      1,
      '会话没有给引擎挂上 error 处理器 —— 这一路根本没接通，下面测的就不是产品',
    );
    fired[0]?.(new Error(ENGINE_ERROR_TEXT));
    const frame = errorIn(seen);
    assert.ok(frame, `引擎报错没有转成 error 帧：${JSON.stringify(seen)}`);
    out.push({ site: EMIT_SITES.engine_error, frame });
  }

  /* ── ③ 启动失败：真 WS，`openStream` 直接抛 ── */
  {
    const h = await harness({
      openStream: () => {
        throw new Error(START_ERROR_TEXT);
      },
    });
    const { ws, seen } = connect(h, '/ws/recorder?title=start-failed');
    const frame = await waitFor(() => errorIn(seen), 'RECORD_START_FAILED');
    ws.close();
    out.push({ site: EMIT_SITES.start_failed, frame });
  }

  /* ── ④ 收尾失败：真 WS，落盘路径在数据目录之外 ⇒ `stop()` 抛 ── */
  {
    const h = await harness({ openStream: () => idleStream(), mediaOutsideDataDir: true });
    const { ws, seen } = connect(h, '/ws/recorder?title=finalize-failed');
    await waitFor(() => readyIn(seen), 'ready（会话没开起来就测不到收尾）');
    ws.send(JSON.stringify({ type: 'stop' }));
    const frame = await waitFor(() => errorIn(seen), 'RECORD_FINALIZE_FAILED');
    ws.close();
    out.push({ site: EMIT_SITES.finalize_failed, frame });
  }

  /* ── ⑤ 控制消息不是 JSON：真 WS，发一个坏文本帧 ── */
  {
    const h = await harness({ openStream: () => idleStream() });
    const { ws, seen } = connect(h, '/ws/recorder?title=bad-json');
    await waitFor(() => readyIn(seen), 'ready');
    ws.send('{ this is not json');
    const frame = await waitFor(() => errorIn(seen), 'BAD_JSON');
    ws.close();
    out.push({ site: EMIT_SITES.control_message_not_json, frame });
  }

  /* ── ⑥ /ws/asr-worker：v1 不实现 ── */
  {
    const h = await harness({ openStream: () => idleStream() });
    const { ws, seen } = connect(h, '/ws/asr-worker');
    const frame = await waitFor(() => errorIn(seen), '/ws/asr-worker 的 NOT_IMPLEMENTED');
    ws.close();
    out.push({ site: EMIT_SITES.asr_worker_not_implemented, frame });
  }

  // 服务端那侧的断线收尾（`abandon()`）跑完再交出去，免得撞上 after() 的清理
  await sleep(200);
  return out;
}

/* --------------------------------- 断言 ----------------------------------- */

describe('④ #112：/ws/recorder 的 error 帧里不许出现中文', () => {
  /**
   * CJK 表意文字 + CJK 标点（、。）+ 全角形式（（），）。
   *
   * ⚠️ **写 `\u` 转义，不写字面量**：范围首字符是 U+3000 全角空格，
   * 直接写进正则会被 eslint 的 `no-irregular-whitespace` 判红，
   * 而且在 diff 里根本看不出来。（同一条在 `rateLimitReason.test.ts` 里也记着。）
   */
  const CJK = /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/;

  it('前提检查：这条正则真的抓得到汉字与全角标点（否则本组全是空转）', () => {
    assert.equal(CJK.test('流式识别引擎不可用（未安装流式模型）'), true);
    assert.equal(CJK.test('录音收尾失败：路径不在数据目录内'), true);
    assert.equal(
      CJK.test('Live transcription cannot start: no streaming model is installed.'),
      false,
    );
  });

  it('★ 六个发出点一个不少，而且各自说的是哪一格都对得上', async () => {
    const got = await frames();
    /*
     * 条数与 `EMIT_SITES` 对齐：契约里加一格 ⇒ 那张总表编译期就逼人补一行 ⇒
     * 补了却没真去驱动它，这里当场少一条。样本集**缩不回去**。
     */
    assert.equal(
      got.length,
      Object.keys(EMIT_SITES).length,
      `采到 ${String(got.length)} 条，而契约有 ${String(Object.keys(EMIT_SITES).length)} 格 —— 有发出点没被跑到`,
    );
    assert.deepEqual(
      got.map((g) => g.frame.reason.kind).sort(),
      Object.keys(EMIT_SITES).sort(),
      '发出来的那几格与契约对不上',
    );
  });

  it('★★ 每一条帧序列化之后都不含 CJK（`detail` 那段原文除外，见注释）', async () => {
    const got = await frames();
    assert.ok(got.length >= 6, '样本少于六种，覆盖不到全部发出点');
    for (const { site, frame } of got) {
      const json = JSON.stringify(withoutVerbatimDetail(frame));
      assert.equal(CJK.test(json), false, `${site} 发出的帧里混进了中文：${json}`);
    }
  });

  it('★★ 帧上不许再有 `messageZh` —— 留着它，前端那张总表就是装饰品', async () => {
    const got = await frames();
    for (const { site, frame } of got) {
      /*
       * 直接钉这次删掉的那一格。同 #106 删 `pipeline.vad.reasonZh` 那一手：
       * 只要中文还在线上，前端就永远有一句可以回落的话，
       * 「新增一格没人写话就编译红」那道闸门便一次都不会真的拦住谁。
       */
      assert.equal(
        'messageZh' in frame,
        false,
        `${site} 又把中文句子放回帧上了：${JSON.stringify(frame)}`,
      );
    }
  });

  it('★ 三条 verbatim 腿的 `detail` 是**原样串**，没有被拼进任何句子', async () => {
    const got = await frames();
    const by = (kind: RecorderErrorReason['kind']): RecorderErrorReason => {
      const hit = got.find((g) => g.frame.reason.kind === kind);
      assert.ok(hit, `没采到 ${kind} 这一格`);
      return hit.frame.reason;
    };

    /*
     * 逐字相等，不是"包含" —— 原来那三处发的是 `录音启动失败：${err.message}`，
     * 也就是把原文拼进了一句中文散文里。前端想把原文单独取出来只能去劈那句话，
     * 而拿散文当结构正是本仓清过两次的形状。所以判据是：**一个字都不许多**。
     */
    const start = by('start_failed');
    assert.equal(start.kind === 'start_failed' && start.detail, START_ERROR_TEXT);

    const engine = by('engine_error');
    assert.equal(engine.kind === 'engine_error' && engine.detail, ENGINE_ERROR_TEXT);

    /*
     * 收尾这一路的原文由 `RecorderSession.stop()` 自己抛出，内容含临时目录，
     * 逐字对不了；判据退到「**是个非空串**」—— 空的 `detail` 会让界面上那句
     * 「…verbatim and not translated: 」以一个冒号收尾，看起来像被截断了。
     */
    const finalize = by('finalize_failed');
    assert.equal(finalize.kind, 'finalize_failed');
    assert.equal(
      finalize.kind === 'finalize_failed' && finalize.detail.length > 0,
      true,
      `收尾失败把成因丢了：${JSON.stringify(finalize)}`,
    );
  });
});

/**
 * 把 `detail` 换成占位符之后的那份结构 —— CJK 判据只落在**我们自己写的那部分**上。
 *
 * ## 这不是给判据开后门，是判据的边界
 *
 * `detail` 装的是 `err.message` 原样串：一个**我们没有解读过、也没有边界**的集合。
 * 一个带中文的文件名、一台中文 Windows 上 `fs` 抛回来的系统错误，都会原样进来。
 * 把 `detail` 也纳入「不许有 CJK」，**第一个中文路径就会让它红，
 * 而那时红的不是缺陷，是判据**。
 *
 * ⚠️ **但"原文不翻译"不是我们自己写中文散文的挡箭牌。**
 * `RecorderSession.stop()` 里那句「录音落盘路径不在数据目录内…」原来是中文，
 * 而它正是 `finalize_failed` 最真实的成因 —— 于是英文用户会拿到
 * 「…verbatim and not translated:」后面缀一句**我们自己写的**中文。
 * 那一句已经在本轮改成英文（见那里的注释）：`detail` 的契约是
 * 「我们没解读过的原文」，**我们自己的散文不在这个契约的保护范围内**。
 * 豁免管的是"别人给的串"，不是"我们偷懒写的中文"。
 *
 * ⚠️ 豁免只到 `detail` 为止。把这次的修复删掉（`messageZh` 加回帧上）时，
 * 上面那条**照样红** —— 那是另一格，不在豁免范围里；
 * 把中文塞进 `kind` 或任何新字段也一样。
 */
function withoutVerbatimDetail(frame: ErrorFrame): unknown {
  const reason: Record<string, unknown> = { ...frame.reason };
  if ('detail' in reason) reason['detail'] = '<verbatim err.message>';
  return { ...frame, reason };
}
