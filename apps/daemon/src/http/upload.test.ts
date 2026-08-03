/**
 * `POST /api/notes/upload` 与自研 multipart 解析器的测试。
 *
 * 重点（按"错了会出人命"排序）：
 *  1. **跨 chunk 的分隔符**：同一份报文分别按 1 / 7 / 64 字节喂进去，结果必须**逐字节相同**。
 *     这是手写 multipart 解析器最经典的 bug，也是唯一一个"本地测好好的、
 *     换台机器传大文件就随机坏"的错误来源。
 *  2. **二进制安全**：正文里塞 CRLF、`--`、以及分隔符本身作为子串，外加非 UTF-8 字节。
 *  3. 安全边界：扩展名白名单（415）、体积上限（413）、半成品文件必须被清理。
 */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { SseEvent } from '@openmemo/shared';

import type { Repos } from '../db/repos.js';
import type { EnqueueParams, JobQueue } from '../jobs/queue.js';
import type { SseHub } from './sse.js';
import {
  MultipartParser,
  createUploadRoutes,
  parseBoundary,
  safeExtension,
  type MultipartHandlers,
  type PartInfo,
  type UploadQueue,
  type UploadRepos,
  type UploadRoutesDeps,
  type UploadSse,
} from './upload.js';

// 编译期护栏：main.ts 里塞进来的是真 Repos / JobQueue / SseHub，
// 它们必须结构上满足这里收窄过的依赖接口，否则接线时才炸就太晚了。
type Assert<T extends true> = T;
type _ReposFits = Assert<Repos extends UploadRepos ? true : false>;
type _QueueFits = Assert<JobQueue extends UploadQueue ? true : false>;
type _SseFits = Assert<SseHub extends UploadSse ? true : false>;

// ---------------------------------------------------------------------------
// 构造 multipart 报文
// ---------------------------------------------------------------------------

interface TestPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly data: Buffer | string;
}

function buildBody(
  boundary: string,
  parts: readonly TestPart[],
  opts: { preamble?: string; epilogue?: string } = {},
): Buffer {
  const out: Buffer[] = [];
  if (opts.preamble) out.push(Buffer.from(opts.preamble, 'utf8'));
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += '\r\n';
    out.push(Buffer.from(head, 'utf8'));
    out.push(typeof p.data === 'string' ? Buffer.from(p.data, 'utf8') : p.data);
    out.push(Buffer.from('\r\n', 'utf8'));
  }
  out.push(Buffer.from(`--${boundary}--\r\n${opts.epilogue ?? ''}`, 'utf8'));
  return Buffer.concat(out);
}

interface Collected {
  readonly fields: Map<string, string>;
  readonly files: { info: PartInfo; data: Buffer }[];
  finished: boolean;
}

function collector(): { handlers: MultipartHandlers; out: Collected } {
  const out: Collected = { fields: new Map(), files: [], finished: false };
  let chunks: Buffer[] = [];
  const handlers: MultipartHandlers = {
    onField: (name, value) => void out.fields.set(name, value),
    onFileStart: (info) => {
      chunks = [];
      out.files.push({ info, data: Buffer.alloc(0) });
    },
    onFileChunk: (chunk) => void chunks.push(Buffer.from(chunk)),
    onFileEnd: () => {
      const last = out.files[out.files.length - 1];
      if (last) out.files[out.files.length - 1] = { info: last.info, data: Buffer.concat(chunks) };
    },
    onFinish: () => void (out.finished = true),
  };
  return { handlers, out };
}

/** 按固定 chunk 大小喂完整份报文 —— 模拟 TCP 的任意切分。 */
function feed(body: Buffer, boundary: string, chunkSize: number): Collected {
  const { handlers, out } = collector();
  const parser = new MultipartParser(boundary, handlers);
  for (let i = 0; i < body.length; i += chunkSize) {
    parser.push(body.subarray(i, Math.min(i + chunkSize, body.length)));
  }
  parser.end();
  return out;
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

describe('MultipartParser', () => {
  const boundary = '----OpenMemoFormBoundary7MA4YWxk';

  it('往返：文件字节与输入逐字节相同', () => {
    const payload = Buffer.from('hello 世界 audio bytes');
    const body = buildBody(boundary, [
      { name: 'title', data: '我的录音' },
      { name: 'file', filename: 'a.mp3', contentType: 'audio/mpeg', data: payload },
    ]);

    const out = feed(body, boundary, body.length);
    assert.equal(out.finished, true);
    assert.equal(out.fields.get('title'), '我的录音');
    assert.equal(out.files.length, 1);
    assert.equal(out.files[0]?.info.filename, 'a.mp3');
    assert.equal(out.files[0]?.info.contentType, 'audio/mpeg');
    assert.deepEqual(out.files[0]?.data, payload);
  });

  it('**跨 chunk 分隔符**：1 / 7 / 64 字节切分结果完全一致', () => {
    // 4KB 伪随机内容 —— 足够长到分隔符必然被切开，且内容可复现
    const payload = Buffer.alloc(4096);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31 + 7) & 0xff;
    const body = buildBody(
      boundary,
      [
        { name: 'title', data: 'chunked' },
        { name: 'file', filename: 'b.wav', data: payload },
        { name: 'language', data: 'zh' },
      ],
      { preamble: 'ignored preamble\r\n', epilogue: 'trailing junk\r\n' },
    );

    const whole = feed(body, boundary, body.length);
    assert.deepEqual(whole.files[0]?.data, payload);

    for (const size of [1, 7, 64, 999]) {
      const out = feed(body, boundary, size);
      assert.equal(out.finished, true, `chunk=${size} 应正常收尾`);
      assert.equal(out.files.length, 1, `chunk=${size}`);
      assert.deepEqual(out.files[0]?.data, payload, `chunk=${size} 文件字节必须一致`);
      assert.deepEqual([...out.fields], [...whole.fields], `chunk=${size} 字段必须一致`);
    }
  });

  it('二进制安全：CRLF / `--` / 分隔符子串 / 非 UTF-8 字节都原样保留', () => {
    const payload = Buffer.concat([
      Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a]),
      Buffer.from('--\r\n--not-the-end'),
      // 分隔符**作为子串**出现：前面没有 CRLF，不构成真分隔符
      Buffer.from(`X--${boundary}`),
      // 前面有 CRLF、但后面既不是 CRLF 也不是 `--` → 同样只是数据
      Buffer.from(`\r\n--${boundary}XX\r\n`),
      Buffer.from([0xfe, 0xff, 0x00, 0x0d]),
      Buffer.from(`\r\n--${boundary.slice(0, 10)}`), // 分隔符的前缀
      Buffer.from([0x0a, 0x2d, 0x2d]),
    ]);
    const body = buildBody(boundary, [
      { name: 'file', filename: 'c.flac', data: payload },
      { name: 'note', data: '尾随字段' },
    ]);

    for (const size of [1, 7, 64, body.length]) {
      const out = feed(body, boundary, size);
      assert.equal(out.files.length, 1, `chunk=${size}`);
      assert.deepEqual(out.files[0]?.data, payload, `chunk=${size} 二进制必须原样保留`);
      assert.equal(out.fields.get('note'), '尾随字段', `chunk=${size}`);
    }
  });

  it('没有 filename 的部件是字段，不是文件', () => {
    const body = buildBody(boundary, [
      { name: 'title', data: 'plain text' },
      { name: 'language', contentType: 'text/plain', data: 'ja' },
    ]);
    for (const size of [1, 13, body.length]) {
      const out = feed(body, boundary, size);
      assert.equal(out.files.length, 0, `chunk=${size} 不该产生文件部件`);
      assert.deepEqual(
        [...out.fields],
        [
          ['title', 'plain text'],
          ['language', 'ja'],
        ],
      );
    }
  });

  it('空文件（0 字节）也能正确收尾', () => {
    const body = buildBody(boundary, [
      { name: 'file', filename: 'empty.mp3', data: Buffer.alloc(0) },
    ]);
    const out = feed(body, boundary, 3);
    assert.equal(out.files.length, 1);
    assert.equal(out.files[0]?.data.length, 0);
  });

  it('报文被截断时 end() 必须抛错，不能当成功', () => {
    const body = buildBody(boundary, [{ name: 'file', filename: 'a.mp3', data: 'abc' }]);
    const parser = new MultipartParser(boundary, collector().handlers);
    parser.push(body.subarray(0, body.length - 10));
    assert.throws(() => parser.end(), /unexpected end/);
  });

  it('parseBoundary 只认 multipart/form-data', () => {
    assert.equal(parseBoundary('multipart/form-data; boundary=abc'), 'abc');
    assert.equal(parseBoundary('multipart/form-data;boundary="a b c"'), 'a b c');
    assert.equal(parseBoundary('MULTIPART/FORM-DATA; charset=utf-8; boundary=xyz'), 'xyz');
    assert.equal(parseBoundary('application/json'), undefined);
    assert.equal(parseBoundary('multipart/form-data'), undefined);
    assert.equal(parseBoundary(undefined), undefined);
  });

  it('safeExtension 只放行白名单形态，且不受目录成分影响', () => {
    assert.equal(safeExtension('a.MP3'), '.mp3');
    assert.equal(safeExtension('../../etc/passwd'), undefined);
    assert.equal(safeExtension('x/y/z.mp4'), '.mp4');
    assert.equal(safeExtension('C:\\evil\\a.wav'), '.wav');
    assert.equal(safeExtension('noext'), undefined);
    assert.equal(safeExtension('.mp3'), undefined);
  });
});

// ---------------------------------------------------------------------------
// HTTP 端点
// ---------------------------------------------------------------------------

interface Recorder {
  readonly notes: { title: string; language: string | null }[];
  readonly sources: { noteId: number; kind: string; title: string | null }[];
  readonly jobs: EnqueueParams[];
  readonly events: SseEvent[];
}

function makeDeps(
  dir: string,
  overrides: Partial<UploadRoutesDeps> = {},
): { deps: UploadRoutesDeps; rec: Recorder } {
  const rec: Recorder = { notes: [], sources: [], jobs: [], events: [] };
  let nextId = 0;
  const deps: UploadRoutesDeps = {
    repos: {
      createNote: (p) => {
        rec.notes.push({ title: p.title, language: p.language ?? null });
        nextId += 1;
        return { id: nextId, uid: `NOTE00000000000000000000${nextId}` };
      },
      createSource: (p) => {
        rec.sources.push({ noteId: p.noteId, kind: p.kind, title: p.title ?? null });
        return rec.sources.length;
      },
    },
    queue: {
      enqueue: (p) => {
        rec.jobs.push(p);
        return { uid: `JOB000000000000000000000${rec.jobs.length}` };
      },
    },
    sse: { publish: (e) => void rec.events.push(e) },
    uploadDir: dir,
    ...overrides,
  };
  return { deps, rec };
}

interface Resp {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function withServer(
  deps: UploadRoutesDeps,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const routes = createUploadRoutes(deps);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void routes.handle(req, res, url, req.method ?? 'GET').then(
      (handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404);
          res.end();
        }
      },
      (err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(String(err));
        }
      },
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function post(
  port: number,
  body: Buffer,
  opts: { contentType?: string; method?: string; chunked?: boolean; chunkSize?: number } = {},
): Promise<Resp> {
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string> = {};
    if (opts.contentType !== undefined) headers['content-type'] = opts.contentType;
    // 不给 content-length → node 自动用 chunked，能走到"流式过程中才发现超限"的分支
    if (!opts.chunked) headers['content-length'] = String(body.length);

    let settled = false;
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/notes/upload',
        method: opts.method ?? 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => void chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            parsed = { raw: text };
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });

    // 即使服务端已经提前回了 4xx，也把请求体写完再 end()：
    // 这样连接能正常收尾，不必等服务端那 2s 的 linger 超时（真实浏览器多半会直接 abort）
    const size = opts.chunkSize ?? body.length;
    void (async () => {
      for (let i = 0; i < body.length && !req.destroyed; i += size) {
        req.write(body.subarray(i, Math.min(i + size, body.length)));
        await new Promise((r) => setImmediate(r));
      }
      if (!req.destroyed) req.end();
    })().catch(() => {
      /* 服务端可能已经拒绝并断开 —— 响应已经拿到就无所谓了 */
    });
  });
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'openmemo-upload-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 上传目录里的正式文件（不含 .incoming 半成品目录）。 */
async function storedFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n !== '.incoming').sort();
}

async function partialFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(join(dir, '.incoming'));
  } catch {
    return [];
  }
}

describe('POST /api/notes/upload', () => {
  const boundary = '----OpenMemoUploadTest';
  const ct = `multipart/form-data; boundary=${boundary}`;

  it('成功：202 + 落盘 + note/media_source/transcribe job', async () => {
    await withTmpDir(async (dir) => {
      const { deps, rec } = makeDeps(dir);
      // 内容里带 CRLF 与非 UTF-8 字节，确认落盘的是**原始字节**
      const payload = Buffer.concat([
        Buffer.from('RIFF....\r\n--fake\r\n'),
        Buffer.from([0x00, 0xff, 0xfe]),
        Buffer.alloc(200_000, 0x5a),
      ]);
      const body = buildBody(boundary, [
        { name: 'title', data: '会议录音' },
        { name: 'language', data: 'zh' },
        { name: 'file', filename: '我的 录音(1).MP3', contentType: 'audio/mpeg', data: payload },
      ]);

      await withServer(deps, async (port) => {
        // 4KB 一片写入，逼出真实的多 chunk + 背压路径
        const res = await post(port, body, { contentType: ct, chunkSize: 4096 });
        assert.equal(res.status, 202, JSON.stringify(res.body));
        assert.equal(res.body['bytes'], payload.length);
        assert.equal(res.body['filename'], '我的 录音(1).MP3', '原名只作为展示元数据回传');
        assert.equal(typeof res.body['noteUid'], 'string');
        assert.equal(typeof res.body['jobUid'], 'string');

        // 磁盘名 = ULID + 白名单扩展名，与客户端给的名字**毫无关系**
        const stored = res.body['storedAs'];
        assert.match(String(stored), /^[0-9A-HJKMNP-TV-Z]{26}\.mp3$/);
        assert.deepEqual(await storedFiles(dir), [String(stored)]);
        assert.deepEqual(await partialFiles(dir), [], '半成品目录必须是空的');

        const onDisk = await readFile(join(dir, String(stored)));
        assert.deepEqual(onDisk, payload, '落盘字节必须与上传字节完全一致');
      });

      assert.deepEqual(rec.notes, [{ title: '会议录音', language: 'zh' }]);
      assert.deepEqual(rec.sources, [{ noteId: 1, kind: 'local', title: '我的 录音(1).MP3' }]);
      assert.equal(rec.jobs.length, 1);
      assert.equal(rec.jobs[0]?.type, 'transcribe');
      assert.equal(rec.jobs[0]?.lane, 'gpu.asr');
      assert.equal(rec.jobs[0]?.noteId, 1);
      /*
       * 上传端点只发 `note.created`。
       *
       * 它以前还发了一条 `job.created` —— 用 `as never` 塞进去的 `{jobUid, kind, label}`，
       * 与契约里的 `{ job: … }` 完全对不上，前端读 `ev.job.jobId` 每次上传都抛 TypeError。
       * 而**这一行断言当时是绿的**：它只数了事件条数，没看载荷。
       * 现在 `job.created` 由 `JobQueue` 的 onCreated 钩子统一发（main.ts + T-130 的端到端测试
       * `jobs/pipelineJobEvents.test.ts` 断言其字段名），这里的假队列不会触发它。
       */
      assert.equal(rec.events.length, 1, '上传端点只负责 note.created');
      assert.equal(rec.events[0]?.type, 'note.created');
    });
  });

  it('没给 title 时用原始文件名兜底', async () => {
    await withTmpDir(async (dir) => {
      const { deps, rec } = makeDeps(dir);
      const body = buildBody(boundary, [{ name: 'file', filename: 'lecture.m4a', data: 'x' }]);
      await withServer(deps, async (port) => {
        const res = await post(port, body, { contentType: ct });
        assert.equal(res.status, 202);
      });
      assert.equal(rec.notes[0]?.title, 'lecture.m4a');
      assert.equal(rec.notes[0]?.language, null);
    });
  });

  it('扩展名不在白名单 → 415，且不留任何文件', async () => {
    await withTmpDir(async (dir) => {
      const { deps, rec } = makeDeps(dir);
      const body = buildBody(boundary, [
        { name: 'file', filename: 'payload.exe', data: Buffer.alloc(50_000, 1) },
      ]);
      await withServer(deps, async (port) => {
        const res = await post(port, body, { contentType: ct, chunkSize: 4096 });
        assert.equal(res.status, 415, JSON.stringify(res.body));
      });
      assert.deepEqual(await storedFiles(dir), []);
      assert.deepEqual(await partialFiles(dir), []);
      assert.equal(rec.notes.length, 0, '被拒的上传绝不能落库');
    });
  });

  it('非 multipart 的 Content-Type → 415', async () => {
    await withTmpDir(async (dir) => {
      const { deps } = makeDeps(dir);
      await withServer(deps, async (port) => {
        const res = await post(port, Buffer.from('{}'), { contentType: 'application/json' });
        assert.equal(res.status, 415);
      });
    });
  });

  it('超出上限 → 413（Content-Length 预检 + 流式中途两条路径），半成品被删除', async () => {
    await withTmpDir(async (dir) => {
      const { deps, rec } = makeDeps(dir, { maxBytes: 64 * 1024 });
      const body = buildBody(boundary, [
        { name: 'file', filename: 'big.wav', data: Buffer.alloc(300_000, 7) },
      ]);
      await withServer(deps, async (port) => {
        const declared = await post(port, body, { contentType: ct });
        assert.equal(declared.status, 413, `Content-Length 预检: ${JSON.stringify(declared.body)}`);

        // 不带 Content-Length（chunked）→ 只能在流式过程中发现超限
        const streamed = await post(port, body, {
          contentType: ct,
          chunked: true,
          chunkSize: 8192,
        });
        assert.equal(streamed.status, 413, `流式: ${JSON.stringify(streamed.body)}`);
      });
      assert.deepEqual(await storedFiles(dir), []);
      assert.deepEqual(await partialFiles(dir), [], '超限的半成品必须删干净');
      assert.equal(rec.notes.length, 0);
    });
  });

  it('没有 file 部件 → 400', async () => {
    await withTmpDir(async (dir) => {
      const { deps } = makeDeps(dir);
      const body = buildBody(boundary, [{ name: 'title', data: '只有字段' }]);
      await withServer(deps, async (port) => {
        const res = await post(port, body, { contentType: ct });
        assert.equal(res.status, 400);
        assert.equal((res.body['error'] as { code?: string })?.code, 'MISSING_FILE');
      });
    });
  });

  it('文件字段名不是 file → 400', async () => {
    await withTmpDir(async (dir) => {
      const { deps } = makeDeps(dir);
      const body = buildBody(boundary, [{ name: 'attachment', filename: 'a.mp3', data: 'x' }]);
      await withServer(deps, async (port) => {
        const res = await post(port, body, { contentType: ct });
        assert.equal(res.status, 400);
      });
      assert.deepEqual(await storedFiles(dir), []);
    });
  });

  it('报文截断 → 400，半成品被清理', async () => {
    await withTmpDir(async (dir) => {
      const { deps } = makeDeps(dir);
      const full = buildBody(boundary, [
        { name: 'file', filename: 'a.mp3', data: Buffer.alloc(9000, 3) },
      ]);
      await withServer(deps, async (port) => {
        const res = await post(port, full.subarray(0, full.length - 40), { contentType: ct });
        assert.equal(res.status, 400, JSON.stringify(res.body));
      });
      assert.deepEqual(await storedFiles(dir), []);
      assert.deepEqual(await partialFiles(dir), []);
    });
  });

  it('GET → 405；其它路径不拦截', async () => {
    await withTmpDir(async (dir) => {
      const { deps } = makeDeps(dir);
      const routes = createUploadRoutes(deps);
      await withServer(deps, async (port) => {
        const res = await post(port, Buffer.alloc(0), { method: 'GET', contentType: ct });
        assert.equal(res.status, 405);
      });
      // handle() 对非本端点的路径必须返回 false（让后面的路由继续尝试）
      const handled = await routes.handle(
        // 只用到 pathname/method，这里不需要真的 req/res
        undefined as unknown as Parameters<typeof routes.handle>[0],
        undefined as unknown as Parameters<typeof routes.handle>[1],
        new URL('http://127.0.0.1/api/notes'),
        'POST',
      );
      assert.equal(handled, false);
    });
  });
});
