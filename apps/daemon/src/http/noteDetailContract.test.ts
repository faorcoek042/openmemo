/**
 * T-139 —— `GET /api/notes/:uid` 的**响应形状**契约，端到端（真 daemon、真 HTTP、真 SQLite）。
 *
 * ## 为什么这个文件必须存在
 *
 * 盘点做了 45 个变异实验，其中一条是这样的：**把 `GET /api/notes/:uid` 的整段实现
 * 换成 `throw new Error(...)`，`apps/daemon` 的 196 个用例全绿。**
 * 逐字段删掉 `tags` / `starred` / `assets` 也全绿。也就是说这个端点
 * **在测试里从来没有被执行过一次** —— 而它正是两个 P0 的所在地：
 *
 * - **A1**：`assets[].state` 从来没被发出去过。前端筛的是 `a.state === 'ready'`，
 *   于是恒 false → `<audio>` 元素**根本不进 DOM** → 播放键点了什么都不发生、
 *   点转写段落也不跳。F5 的招牌能力「转写稿 ↔ 音频时间轴联动」因此从未工作过，
 *   而波形还照画（那份波形是编的），**看起来一切正常**。
 * - **A1b**：`bodyJson` 从来没被发出去过。TipTap 的自动保存是真的（PATCH 真落库，
 *   响应甚至回 `hasBody:true`），但 GET 不带它 → **刷新一次，用户写的正文就"没了"**。
 *   ⑤C「写得进读不回」的第七例，与该族第一例 `textRaw` 完全同形。
 *
 * 所以这里的用例不是"多加几条形状断言"，而是**让这个端点第一次被执行**。
 * 判据（可自己复现）：把 `rest/notes.ts` 里 `// ---- GET /api/notes/:uid ----`
 * 那一段整个删掉或改成 `throw`，本文件必须变红。
 *
 * ## ⚠️ 与 `http/rest/noteDetail.test.ts` 重叠（给合并者）
 *
 * 本文件写完之后，另一路（`test-gaps`）**独立地**为同一个端点写了
 * `http/rest/noteDetail.test.ts` —— 两边都是冲着 E1 那条"整个端点没被执行过"去的，
 * 因此 `state` / `bodyJson` 两组断言重复。我**不动别人的交付物**，所以两份都留着，
 * 由 Manager 决定并成一个文件。
 *
 * 并的时候请保留本文件独有的三条（那边没有）：
 *   ① `state:'ready'` 说了就要兑现 —— 按它自己给的 `url` **真的取回字节**
 *      （"字段在"不等于"能用"，T-136 的 `media/media` 双层路径就是这么骗过所有人的）；
 *   ② `GET` 的输出**原样喂回 `PATCH`** 必须幂等（⑤C 立的规矩，settings 那次的教训）；
 *   ③ 顶层键的完整清单。
 *
 * ## 不跑转写、不调 LLM
 *
 * 资产与转写稿直接用 `Repos` 塞进临时库 —— 我们要验的是**序列化那一层**，
 * 而不是 whisper 能不能跑（用户已明令不跑本地转写）。
 * 媒体文件也是真写到临时目录里的，这样 `url` 那一条不是纸上谈兵。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { SESSION_COOKIE, CSRF_HEADER } from './auth.js';
import { Repos } from '../db/repos.js';
import { startDaemon, type RunningDaemon } from '../main.js';

const ROOT = mkdtempSync(join(tmpdir(), 'omdetail-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let portCursor = 19860;

interface Fixture {
  d: RunningDaemon;
  base: string;
  sid: string;
  csrf: string;
  noteUid: string;
  audioUid: string;
  peaksUid: string;
}

/** 一条"长得像真笔记"的笔记：音轨 + 波形 + 转写稿，文件真的存在于 dataDir 里。 */
async function makeNote(name: string): Promise<Fixture> {
  const port = portCursor++;
  const dataDir = join(ROOT, name);
  const d = await startDaemon({ port, dataDir, maxPort: port });

  const res = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${d.token}` },
  });
  const sid = /om_sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const { csrf } = (await res.json()) as { csrf: string };
  assert.ok(sid && csrf, '握手失败，后面的断言就没意义了');

  const repos = new Repos(d.database.db);
  const note = repos.createNote({ title: '一节课的录音', kind: 'media', language: 'zh' });
  repos.createSource({
    noteId: note.id,
    kind: 'local',
    adapterId: 'local',
    originalUrl: join(dataDir, 'src.wav'),
    title: '一节课的录音',
  });
  repos.updateNote(note.id, { durationMs: 3000, status: 'ready' });

  const mediaDir = join(dataDir, 'media', note.uid);
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(mediaDir, 'audio16k.wav'), Buffer.alloc(64));
  writeFileSync(join(mediaDir, 'peaks.ompk'), Buffer.alloc(32));

  const audio = repos.createAsset({
    noteId: note.id,
    role: 'audio16k',
    relPath: `${note.uid}/audio16k.wav`,
    mime: 'audio/wav',
    bytes: 64,
    durationMs: 3000,
  });
  const peaks = repos.createAsset({
    noteId: note.id,
    role: 'peaks',
    relPath: `${note.uid}/peaks.ompk`,
    mime: 'application/octet-stream',
    bytes: 32,
  });

  const tr = repos.createTranscript({ noteId: note.id, assetId: audio.id, engineId: 'fixture' });
  repos.insertSegments(tr.id, [
    {
      startMs: 0,
      endMs: 1000,
      text: '第一段',
      confidence: null,
      noSpeechProb: null,
      words: null,
      chunkIdx: 0,
      flags: 0,
    },
  ]);

  return {
    d,
    base: `http://127.0.0.1:${d.port}`,
    sid,
    csrf,
    noteUid: note.uid,
    audioUid: audio.uid,
    peaksUid: peaks.uid,
  };
}

function get(f: Fixture, path: string): Promise<Response> {
  return fetch(`${f.base}${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${f.sid}` } });
}

function patch(f: Fixture, path: string, body: unknown): Promise<Response> {
  return fetch(`${f.base}${path}`, {
    method: 'PATCH',
    headers: {
      Cookie: `${SESSION_COOKIE}=${f.sid}`,
      [CSRF_HEADER]: f.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('T-139 A1 —— GET /api/notes/:uid 的 assets 必须带 state', () => {
  it('★ 每条资产都要有 state，且值是 media_assets 那一列的真值', async () => {
    const f = await makeNote('a1');
    try {
      const res = await get(f, `/api/notes/${f.noteUid}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        assets: { uid: string; role: string; state?: string; url?: string }[];
      };

      const audio = body.assets.find((a) => a.role === 'audio16k');
      assert.ok(audio, '响应里没有 audio16k 资产');
      assert.equal(
        Object.prototype.hasOwnProperty.call(audio, 'state'),
        true,
        '资产不带 state 字段 —— 前端筛的正是它（a.state === "ready"），' +
          '缺了就恒 false，<audio> 元素根本不进 DOM，点播放毫无反应且零报错',
      );
      assert.equal(audio.state, 'ready');
      // url 也一起钉住：前端拿它去取 .ompk，路径规则只该有服务端一处
      assert.equal(audio.url, `/media/asset/${f.audioUid}`);

      const peaks = body.assets.find((a) => a.role === 'peaks');
      assert.equal(peaks?.state, 'ready');
      assert.equal(peaks?.url, `/media/asset/${f.peaksUid}`);
    } finally {
      await f.d.stop();
    }
  });

  it('state 说 ready 时，那个 url 必须真的取得回字节（"存在" 不等于 "能用"）', async () => {
    const f = await makeNote('a1url');
    try {
      const body = (await (await get(f, `/api/notes/${f.noteUid}`)).json()) as {
        assets: { role: string; url: string }[];
      };
      const audio = body.assets.find((a) => a.role === 'audio16k');
      const media = await get(f, audio!.url);
      assert.equal(
        media.status,
        200,
        'state=ready 的资产按它自己给的 url 取回来却不是 200 —— ' +
          '那 state 就是在撒谎（T-136 的 media/media 双层路径正是这个形状）',
      );
      assert.equal((await media.arrayBuffer()).byteLength, 64);
    } finally {
      await f.d.stop();
    }
  });
});

describe('T-139 A1b —— 正文写得进，必须读得回', () => {
  it('★ PATCH 写的 bodyJson，GET 必须原样还回来（⑤C 的第七例）', async () => {
    const f = await makeNote('a1b');
    try {
      const doc = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '用户亲手写的一行字' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'timeAnchor', attrs: { anchorKey: 'a1', startMs: 1200, quote: '第一段' } },
            ],
          },
        ],
      };
      assert.equal((await patch(f, `/api/notes/${f.noteUid}`, { bodyJson: doc })).status, 200);

      const body = (await (await get(f, `/api/notes/${f.noteUid}`)).json()) as {
        bodyJson?: unknown;
      };
      assert.equal(
        Object.prototype.hasOwnProperty.call(body, 'bodyJson'),
        true,
        'GET 里没有 bodyJson —— 用户写的正文真落库了，但刷新一次界面就是空的，' +
          '而且没有任何报错。数据一个字节没丢，用户却只会认为"它没保存"',
      );
      assert.deepEqual(
        body.bodyJson,
        doc,
        'bodyJson 回来的东西和写进去的不一样 —— 编辑器会拿它当初值，差一点就是丢内容',
      );
    } finally {
      await f.d.stop();
    }
  });

  it('★ 发的必须是对象，不是那一列的 JSON 字符串（编辑器把它直接当文档喂进去）', async () => {
    const f = await makeNote('a1bshape');
    try {
      await patch(f, `/api/notes/${f.noteUid}`, {
        bodyJson: { type: 'doc', content: [{ type: 'paragraph' }] },
      });
      const body = (await (await get(f, `/api/notes/${f.noteUid}`)).json()) as { bodyJson: unknown };
      assert.equal(
        typeof body.bodyJson,
        'object',
        '回了一根字符串 —— TipTap 会把它当成一段"内容就是 JSON 源码"的正文显示给用户',
      );
    } finally {
      await f.d.stop();
    }
  });

  it('从没写过正文时是 null，不是缺字段（"没有正文"与"这条响应不带这个键"是两回事）', async () => {
    const f = await makeNote('a1bnull');
    try {
      const body = (await (await get(f, `/api/notes/${f.noteUid}`)).json()) as { bodyJson?: unknown };
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'bodyJson'), true);
      assert.equal(body.bodyJson, null);
    } finally {
      await f.d.stop();
    }
  });

  it('★ GET 的输出原样喂回 PATCH 必须幂等（⑤C 立的规矩：读写形状可互换）', async () => {
    const f = await makeNote('roundtrip');
    try {
      const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '往返' }] }] };
      await patch(f, `/api/notes/${f.noteUid}`, { bodyJson: doc });

      const first = (await (await get(f, `/api/notes/${f.noteUid}`)).json()) as {
        bodyJson: unknown;
        title: string;
      };
      // 把 GET 回来的东西原样送回去 —— 不许因此产生第二种形状（settings 那次的教训）
      assert.equal(
        (await patch(f, `/api/notes/${f.noteUid}`, { bodyJson: first.bodyJson, title: first.title }))
          .status,
        200,
      );
      const second = (await (await get(f, `/api/notes/${f.noteUid}`)).json()) as { bodyJson: unknown };
      assert.deepEqual(second.bodyJson, first.bodyJson);
      assert.deepEqual(second.bodyJson, doc);
    } finally {
      await f.d.stop();
    }
  });
});

describe('T-139 —— 这个端点整体（E1：此前一次都没被执行过）', () => {
  it('★ 顶层键必须齐（少一个前端就少一块功能，而且不会报错）', async () => {
    const f = await makeNote('shape');
    try {
      const body = (await (await get(f, `/api/notes/${f.noteUid}`)).json()) as Record<string, unknown>;
      /*
       * 钉的是**结构**不是关键词：逐个 hasOwnProperty，不做整体 deepEqual ——
       * 后者会让"新增一个字段"变成红灯，那种红灯只会训练人去改断言。
       */
      for (const key of [
        'uid',
        'title',
        'status',
        'kind',
        'language',
        'durationMs',
        'summaryMd',
        'bodyJson',
        'tags',
        'starred',
        'folderUid',
        'assets',
        'transcriptUid',
        'segmentCount',
        'canRetranscribe',
        'createdAt',
      ]) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(body, key),
          true,
          `响应里少了 ${key}`,
        );
      }
      assert.equal(Array.isArray(body['tags']), true, 'tags 必须永远是数组（少了它详情页整页崩）');
      assert.equal(Array.isArray(body['assets']), true);
      assert.equal(body['segmentCount'], 1);
      assert.equal(typeof body['transcriptUid'], 'string');
    } finally {
      await f.d.stop();
    }
  });

  it('笔记不存在时 404 NOTE_NOT_FOUND', async () => {
    const f = await makeNote('missing');
    try {
      const res = await get(f, '/api/notes/01ARZ3NDEKTSV4RRFFQ69G5FAV');
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'NOTE_NOT_FOUND');
    } finally {
      await f.d.stop();
    }
  });
});
