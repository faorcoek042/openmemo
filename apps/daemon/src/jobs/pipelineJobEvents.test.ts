/**
 * T-130 —— 流水线 job 的事件链路，**端到端**。
 *
 * ## 为什么这组测试必须起一个真 daemon
 *
 * 被修的缺陷是"三个各自正确的局部决策拼出一个错误的整体"：
 *   1. `JobCreatedEvent.job` 只描述得了下载 job，
 *   2. 于是 daemon 对转写/导图**不发 `job.created`**，
 *   3. 于是前端收到一串没被介绍过的 jobId，只能丢掉。
 * 每一环单独测都是绿的。**只有把真实的那条路整条走一遍才会红。**
 *
 * 这正是本项目栽过的那种跟头（`TranscribePipeline` 绕过探测回退链，
 * 而单测测的是另一条路，绿灯照亮）。所以这里：
 *   - 起**真的** `startDaemon()`（真 DB、真队列、真调度器、真 SSE）；
 *   - 走**真的** `POST /api/notes/upload`（F2 拖拽上传就是这个端点）；
 *   - 在**真的** `GET /api/events` 流上读回事件，断言的是**载荷字段名**，不只是事件类型。
 *
 * 最后一条尤其重要：上一版 `job.created` 是用 `as never` 发出去的
 * `{jobUid, kind, label}`，类型全对不上。端到端脚本当时**只断言了事件类型**，
 * 于是它一路发到浏览器，`ev.job.jobId` 每次上传都抛一次 TypeError。
 * 只断言类型的测试，挡不住这类错误。
 *
 * 数据目录是 `mkdtemp` 出来的空目录 → 没有任何 ASR 模型 → 转写 job 必然 `blocked`，
 * 也就是用户报的那个场景（没装模型时导入媒体）。**不跑任何真实转写。**
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { SESSION_COOKIE, CSRF_HEADER } from '../http/auth.js';
import { startDaemon } from '../main.js';

const ROOT = mkdtempSync(join(tmpdir(), 'omjobs-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let portCursor = 19510;
const nextPort = (): number => portCursor++;

interface Frame {
  type: string;
  data: Record<string, unknown>;
}

/**
 * 订阅 `/api/events` 并解析具名帧。
 *
 * 不用 `EventSource`（Node 22 才有、且没法带 Cookie 头），直接解析 SSE 线格式 ——
 * 也顺便证明我们发的确实是 `event: <type>` + `data: <json>` 的具名帧。
 */
function openStream(port: number, sid: string): { frames: Frame[]; close: () => void } {
  const frames: Frame[] = [];
  const req = request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/events',
      headers: { Cookie: `${SESSION_COOKIE}=${sid}`, Accept: 'text/event-stream' },
    },
    (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type && data) {
            try {
              frames.push({ type, data: JSON.parse(data) as Record<string, unknown> });
            } catch {
              /* keepalive 注释行等，忽略 */
            }
          }
          sep = buf.indexOf('\n\n');
        }
      });
    },
  );
  req.on('error', () => {
    /* 关流时的正常错误 */
  });
  req.end();
  return { frames, close: () => req.destroy() };
}

async function waitFor(
  frames: Frame[],
  type: string,
  timeoutMs = 8000,
): Promise<Frame | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = frames.find((f) => f.type === type);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

function multipart(boundary: string, filename: string, bytes: Buffer): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
  );
  return Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
}

/** 一段合法但极短的 WAV —— 只是为了让上传端点收下它，不会被真的转写。 */
function tinyWav(): Buffer {
  const data = Buffer.alloc(64);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(16000, 24);
  hdr.writeUInt32LE(32000, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

describe('T-130 流水线 job 的事件链路（真 daemon + 真 SSE + 真上传）', () => {
  it('★ 没装 ASR 模型时上传媒体：job.created 与 job.blocked 都要到达，且载荷字段名对得上契约', async () => {
    const port = nextPort();
    const dataDir = join(ROOT, `blocked-${port}`);
    const d = await startDaemon({ port, dataDir, maxPort: port });
    let stream: { frames: Frame[]; close: () => void } | undefined;
    try {
      const sess = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${d.token}` },
      });
      const setCookie = sess.headers.get('set-cookie') ?? '';
      const sid = /om_sid=([^;]+)/.exec(setCookie)?.[1] ?? '';
      const { csrf } = (await sess.json()) as { csrf: string };
      assert.ok(sid && csrf, '握手失败，后面的断言就没意义了');

      stream = openStream(d.port, sid);
      // 让 SSE 连上再发起上传（否则可能错过事件 —— 这也是真实前端的顺序）
      await new Promise((r) => setTimeout(r, 300));

      const boundary = '----T130Boundary';
      const res = await fetch(`http://127.0.0.1:${d.port}/api/notes/upload`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE}=${sid}`,
          [CSRF_HEADER]: csrf,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipart(boundary, 'meeting-notes.wav', tinyWav()),
      });
      // 先取文本再断言：`await res.text()` 作为断言消息会**无条件**消费掉 body，
      // 之后的 res.json() 必然抛 "Body is unusable"（第一次跑就踩到了）
      const bodyText = await res.text();
      assert.equal(res.status, 202, bodyText);
      const accepted = JSON.parse(bodyText) as { jobUid: string; noteUid: string };

      /* ── ① job.created 必须到达 ── */
      const created = await waitFor(stream.frames, 'job.created');
      assert.ok(
        created,
        '没有收到 job.created —— 这正是 T-130：后续的 job.state/job.blocked 只带 id，' +
          '全局消费方（toast 层 / 任务中心）无从认领，于是用户点了导入什么都看不见',
      );

      /* ── ② 载荷必须是契约里的形状，不是随便一个对象 ── */
      const job = created.data['job'] as Record<string, unknown> | undefined;
      assert.ok(
        job,
        'job.created 的载荷必须是 { job: … }（旧实现发的是 {jobUid,kind,label}，前端读 ev.job.jobId 直接 TypeError）',
      );
      assert.equal(job['jobId'], accepted.jobUid, 'jobId 必须与 202 响应里的 jobUid 一致');
      assert.equal(job['kind'], 'transcribe');
      assert.equal(job['type'], 'transcribe');
      assert.equal(
        job['displayName'],
        'meeting-notes.wav',
        'displayName 要给用户看得懂的名字（笔记标题），不是内部 uid',
      );
      assert.equal(job['noteUid'], accepted.noteUid);
      assert.equal(typeof job['state'], 'string');
      assert.equal(typeof job['progress'], 'number');
      // 字节计数**不该存在**：转写没有"下载了多少字节"，填 0 会渲染成 "0 B / 0 B" 像个卡死的下载
      assert.equal(job['totalBytes'], undefined, '流水线 job 不该有 totalBytes');
      assert.equal(job['parts'], undefined, '流水线 job 不该有 parts');

      /* ── ③ blocked 必须到达，且带可执行补救 ── */
      const blocked = await waitFor(stream.frames, 'job.blocked');
      assert.ok(blocked, '没装模型时必须发 job.blocked');
      assert.equal(blocked.data['jobId'], accepted.jobUid);
      assert.equal(blocked.data['blockedCode'], 'MISSING_ASR_MODEL');
      const remediation = blocked.data['remediation'] as Record<string, unknown> | null;
      assert.ok(remediation, 'blocked 必须带 remediation，否则用户不知道该干什么');
      assert.equal(remediation['action'], 'installModel');

      /* ── ④ 任务中心也必须能看见它（blocked 提示的第二个按钮就指向那里）── */
      const jobsRes = await fetch(`http://127.0.0.1:${d.port}/api/jobs`, {
        headers: { Cookie: `${SESSION_COOKIE}=${sid}` },
      });
      const listed = (await jobsRes.json()) as { jobs: Record<string, unknown>[] };
      const mine = listed.jobs.find((j) => j['jobId'] === accepted.jobUid);
      assert.ok(
        mine,
        'GET /api/jobs 里找不到这条转写任务 —— 而 blocked 提示上的「任务中心」按钮正是指向那里，' +
          '把用户送到一个空列表比不给按钮更糟',
      );
      assert.equal(mine['state'], 'blocked');
      assert.equal(mine['blockedCode'], 'MISSING_ASR_MODEL');
      assert.equal(mine['displayName'], 'meeting-notes.wav');
    } finally {
      stream?.close();
      await d.stop();
    }
  });

  it('★ 任务中心的「重试」对流水线任务真的有效（此前必定 409）', async () => {
    const port = nextPort();
    const dataDir = join(ROOT, `retry-${port}`);
    const d = await startDaemon({ port, dataDir, maxPort: port });
    try {
      const sess = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${d.token}` },
      });
      const setCookie = sess.headers.get('set-cookie') ?? '';
      const sid = /om_sid=([^;]+)/.exec(setCookie)?.[1] ?? '';
      const { csrf } = (await sess.json()) as { csrf: string };

      const boundary = '----T130Retry';
      const res = await fetch(`http://127.0.0.1:${d.port}/api/notes/upload`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE}=${sid}`,
          [CSRF_HEADER]: csrf,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipart(boundary, 'retry-me.wav', tinyWav()),
      });
      const { jobUid } = (await res.json()) as { jobUid: string };

      // 等它落到 blocked
      const deadline = Date.now() + 8000;
      let state = '';
      while (Date.now() < deadline && state !== 'blocked') {
        const one = await fetch(`http://127.0.0.1:${d.port}/api/jobs/${jobUid}`, {
          headers: { Cookie: `${SESSION_COOKIE}=${sid}` },
        });
        if (one.status === 200) state = ((await one.json()) as { state: string }).state;
        if (state !== 'blocked') await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(state, 'blocked', '前置条件没达成，后面的断言无意义');

      const retry = await fetch(`http://127.0.0.1:${d.port}/api/jobs/${jobUid}/retry`, {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=${sid}`, [CSRF_HEADER]: csrf },
      });
      assert.equal(
        retry.status,
        204,
        '流水线任务的重试必须被受理；此前只有下载队列认得 retry，一律 409 —— ' +
          '而任务中心对 blocked/failed 一定会显示重试按钮',
      );
    } finally {
      await d.stop();
    }
  });
});
