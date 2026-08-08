/**
 * T-138 —— 笔记 REST 上两条「用户到不了」的修复，**端到端**。
 *
 * ## ③ `GET /api/notes?starred=1`
 *
 * 端点此前只认 `limit`，星标筛选是前端对**已取回的那一页**做 `filter(n => n.starred)`。
 * 代价不是"慢"，是 **超过一页之后无声地漏**：第 51 条之外的星标笔记不会出现，
 * 而页面上没有任何迹象说它少给了东西。
 *
 * 所以这里的判据必须是"**筛选发生在 limit 之前**"，而不是"筛出来的都带星标"——
 * 后者在前端过滤的实现下**同样是绿的**（它筛出来的确实都带星标，只是漏了）。
 * 做法：建 3 条笔记，只给**最早**那条加星，然后 `?starred=1&limit=2`。
 *   - 筛在 SQL 里 → 拿得到它 ✅
 *   - 筛在应用层（先 `listNotes(2)` 再过滤）→ 那两条最新的都没星标 → 返回空 ❌
 * 这就是 N=51 那个 bug 在 N=3 上的等价复现，跑起来只要几百毫秒。
 *
 * ## ① `POST /api/notes/:uid/mindmap`
 *
 * 端点与 runner 早就在了，但**界面上没有入口**（`features/mindmap/api.ts` 只有 GET/PATCH），
 * F4 因此在产品里点不出来。前端新加的生成按钮依赖三件事：
 * 202 里有 `jobUid`、这条 job 在 `GET /api/jobs` 里看得见、且带着 `kind:'mindmap'` 与 `noteUid`
 * （`useActiveNoteJob(noteUid, 'mindmap')` 就是靠这两个字段认领它的）。
 * 这里把这三件事一次性钉住 —— 少任何一个，按钮都会在生成期间保持"可点"，
 * 而生成要几秒，用户必然重复点击。
 *
 * **不跑任何真实转写、不调真实 LLM**：临时数据目录是空的，
 * 导图任务会因为没有转写稿而 `blocked`（`NO_TRANSCRIPT`），这正好也是我们要验的一条。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { SESSION_COOKIE, CSRF_HEADER } from './auth.js';
import { startDaemon } from '../main.js';

const ROOT = mkdtempSync(join(tmpdir(), 'omnotes-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let portCursor = 19610;
const nextPort = (): number => portCursor++;

interface Session {
  base: string;
  sid: string;
  csrf: string;
}

async function handshake(port: number, token: string): Promise<Session> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const sid = /om_sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const { csrf } = (await res.json()) as { csrf: string };
  assert.ok(sid && csrf, '握手失败，后面的断言就没意义了');
  return { base: `http://127.0.0.1:${port}`, sid, csrf };
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

async function upload(s: Session, filename: string): Promise<string> {
  const boundary = '----T138Boundary';
  const res = await fetch(`${s.base}/api/notes/upload`, {
    method: 'POST',
    headers: {
      Cookie: `${SESSION_COOKIE}=${s.sid}`,
      [CSRF_HEADER]: s.csrf,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: multipart(boundary, filename, tinyWav()),
  });
  const body = await res.text();
  assert.equal(res.status, 202, body);
  return (JSON.parse(body) as { noteUid: string }).noteUid;
}

async function star(s: Session, noteUid: string): Promise<void> {
  const res = await fetch(`${s.base}/api/notes/${noteUid}/star`, {
    method: 'PUT',
    headers: {
      Cookie: `${SESSION_COOKIE}=${s.sid}`,
      [CSRF_HEADER]: s.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ starred: true }),
  });
  assert.equal(res.status, 200, await res.text());
}

async function listNotes(s: Session, qs: string): Promise<Response> {
  return fetch(`${s.base}/api/notes${qs}`, { headers: { Cookie: `${SESSION_COOKIE}=${s.sid}` } });
}

describe('T-138 ③ GET /api/notes?starred=1', () => {
  it('★ 筛选必须发生在 limit 之前 —— 否则笔记一多，星标笔记就会无声地漏掉', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: join(ROOT, `starred-${port}`), maxPort: port });
    try {
      const s = await handshake(d.port, d.token);

      // 建 3 条：a 最早、c 最新。**只给最早的 a 加星。**
      const a = await upload(s, 'a.wav');
      await upload(s, 'b.wav');
      await upload(s, 'c.wav');
      await star(s, a);

      // limit=2 时，"最近两条"里根本没有 a —— 前端过滤那条路在这里必然返回空
      const res = await listNotes(s, '?starred=1&limit=2');
      assert.equal(res.status, 200);
      const { notes } = (await res.json()) as {
        notes: { uid: string; title: string; starred: boolean }[];
      };
      assert.deepEqual(
        notes.map((n) => n.uid),
        [a],
        '?starred=1&limit=2 没返回那条加了星的笔记 —— 说明 limit 先切、starred 后筛：' +
          '笔记数一旦超过一页，星标页就开始漏，而用户看不出少了什么',
      );
      assert.equal(notes[0]!.starred, true);
      assert.equal(notes[0]!.title, 'a.wav');

      // 另一半：不带参数时仍然是全部（别把筛选变成默认行为）
      const all = (await (await listNotes(s, '')).json()) as { notes: unknown[] };
      assert.equal(all.notes.length, 3, '不带 starred 时应返回全部 3 条');
    } finally {
      await d.stop();
    }
  });

  it('★ 认不出的取值一律 400，绝不静默当成"不筛"', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: join(ROOT, `starred400-${port}`), maxPort: port });
    try {
      const s = await handshake(d.port, d.token);
      await upload(s, 'a.wav');

      for (const bad of ['0', 'false', 'yes', '']) {
        const res = await listNotes(s, `?starred=${bad}`);
        assert.equal(
          res.status,
          400,
          `?starred=${JSON.stringify(bad)} 被静默忽略了 —— 它会返回**全部**笔记，` +
            '一个既不报错又和调用方意图相反的结果',
        );
        const body = (await res.json()) as { error?: { code?: string } };
        assert.equal(body.error?.code, 'BAD_QUERY_PARAM');
      }

      // 两种真值写法都要认（前端发 "1"，手敲 URL 的人会写 "true"）
      for (const ok of ['1', 'true']) {
        assert.equal((await listNotes(s, `?starred=${ok}`)).status, 200);
      }
    } finally {
      await d.stop();
    }
  });
});

/**
 * T-157 ③ —— 笔记超过一页之后，剩下的在界面上**永远看不到**。
 *
 * `GET /api/notes` 只有 `limit`（默认 50 / 上限 200），**没有 offset/cursor**，
 * 前端连 `limit` 都不传。于是列表恒定只有前 50 条：没有翻页、没有"加载更多"、
 * 没有总数、一个字的提示都没有。这与 `?starred=1` 是同一族 ——
 * 那两条的判据是「过滤发生在 limit 之前」，已经做对了；
 * **但如果总量就取不全，过滤对了也没用。**
 *
 * 判据取「翻完所有页拿到的 uid 集合 == 全部笔记，且一条不重复」——
 * 钉的是后果（第 N 条到底看不看得见），不是某个字段长什么样。
 * 单看某一页"有 2 条、看起来对"在缺陷状态下同样是绿的。
 */
describe('T-157 ③ GET /api/notes 的翻页', () => {
  it('★ 一页装不下时：total 说得出还有多少，offset 真的翻得到最后一条', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: join(ROOT, `page-${port}`), maxPort: port });
    try {
      const s = await handshake(d.port, d.token);
      const uids: string[] = [];
      for (let i = 0; i < 5; i++) uids.push(await upload(s, `n${i}.wav`));

      const first = (await (await listNotes(s, '?limit=2')).json()) as {
        notes: { uid: string }[];
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
      };
      assert.equal(first.total, 5, 'total 必须是筛选后的**总条数**，不是这一页的条数');
      assert.equal(first.notes.length, 2);
      assert.equal(first.hasMore, true, 'hasMore=false 会让"加载更多"永远不出现');

      // 一页页翻到底，收集全部 uid
      const seen: string[] = [];
      let offset = 0;
      let guard = 0;
      for (;;) {
        if (++guard > 20) throw new Error('翻页没有终止 —— hasMore 恒 true 会让 UI 无限加载');
        const page = (await (await listNotes(s, `?limit=2&offset=${offset}`)).json()) as {
          notes: { uid: string }[];
          hasMore: boolean;
        };
        seen.push(...page.notes.map((n) => n.uid));
        if (!page.hasMore) break;
        offset += page.notes.length;
      }

      assert.equal(
        new Set(seen).size,
        seen.length,
        `翻页翻出了重复条目（${seen.length} 条里只有 ${new Set(seen).size} 个不同的 uid）——` +
          '重复的另一面必然是漏掉，而两页各自看起来都正常',
      );
      assert.deepEqual(
        [...seen].sort(),
        [...uids].sort(),
        '翻完所有页拿到的不是全部笔记 —— 这就是"第 51 条起永远看不到"的等价复现',
      );
      // 最后一页必须诚实地说"没有了"
      const last = (await (await listNotes(s, '?limit=2&offset=4')).json()) as {
        notes: unknown[];
        hasMore: boolean;
        total: number;
      };
      assert.equal(last.hasMore, false);
      assert.equal(last.notes.length, 1);
    } finally {
      await d.stop();
    }
  });

  it('★ total 跟着筛选走：star 了 1 条时，星标页的 total 必须是 1 而不是 5', async () => {
    // total 与列表如果各写一份 WHERE，就会出现"说还有 4 条、翻过去是空的"。
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: join(ROOT, `pagestar-${port}`), maxPort: port });
    try {
      const s = await handshake(d.port, d.token);
      const uids: string[] = [];
      for (let i = 0; i < 5; i++) uids.push(await upload(s, `n${i}.wav`));
      await star(s, uids[0] as string);

      const all = (await (await listNotes(s, '?limit=1')).json()) as { total: number };
      const starred = (await (await listNotes(s, '?starred=1&limit=1')).json()) as {
        total: number;
        hasMore: boolean;
        notes: { uid: string }[];
      };
      assert.equal(all.total, 5);
      assert.equal(starred.total, 1);
      assert.equal(starred.hasMore, false);
      assert.deepEqual(
        starred.notes.map((n) => n.uid),
        [uids[0]],
      );
    } finally {
      await d.stop();
    }
  });

  it('★ 认不出的 offset 一律 400，绝不静默当成 0（那会返回第一页而调用方以为在看第三页）', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: join(ROOT, `page400-${port}`), maxPort: port });
    try {
      const s = await handshake(d.port, d.token);
      await upload(s, 'a.wav');
      for (const bad of ['abc', '-1', '1.5', '']) {
        const res = await listNotes(s, `?offset=${bad}`);
        assert.equal(res.status, 400, `?offset=${JSON.stringify(bad)} 被静默忽略了`);
        const body = (await res.json()) as { error?: { code?: string } };
        assert.equal(body.error?.code, 'BAD_QUERY_PARAM');
      }
      assert.equal((await listNotes(s, '?offset=0')).status, 200);
    } finally {
      await d.stop();
    }
  });
});

describe('T-138 ① POST /api/notes/:uid/mindmap 的生成入口', () => {
  it('★ 202 的 jobUid 必须能在 /api/jobs 里认领到，且带 kind=mindmap 与 noteUid', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: join(ROOT, `mindmap-${port}`), maxPort: port });
    try {
      const s = await handshake(d.port, d.token);
      const noteUid = await upload(s, 'lecture.wav');

      const res = await fetch(`${s.base}/api/notes/${noteUid}/mindmap`, {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=${s.sid}`, [CSRF_HEADER]: s.csrf },
      });
      const text = await res.text();
      assert.equal(res.status, 202, text);
      const accepted = JSON.parse(text) as { jobUid: string; noteUid: string };
      assert.ok(accepted.jobUid, '202 里没有 jobUid，前端连"我刚提交了什么"都不知道');
      assert.equal(accepted.noteUid, noteUid);

      const listed = (await (
        await fetch(`${s.base}/api/jobs`, { headers: { Cookie: `${SESSION_COOKIE}=${s.sid}` } })
      ).json()) as { jobs: Record<string, unknown>[] };
      const mine = listed.jobs.find((j) => j['jobId'] === accepted.jobUid);
      assert.ok(
        mine,
        'GET /api/jobs 里找不到这条导图任务 —— 前端的「正在生成」正是从这里认领的，' +
          '认不到的话按钮会一直保持可点，而生成要几秒，用户必然重复点击',
      );
      assert.equal(
        mine!['kind'],
        'mindmap',
        '按 kind 收窄的那一步会失效：转写任务会被当成导图任务',
      );
      assert.equal(mine!['noteUid'], noteUid, '没有 noteUid 就无从判断它属于哪条笔记');
      assert.equal(mine!['displayName'], 'lecture.wav', 'displayName 要给用户看得懂的名字');
      assert.equal(
        mine!['totalBytes'],
        undefined,
        '流水线 job 不该有字节计数（会渲染成卡死的下载条）',
      );
    } finally {
      await d.stop();
    }
  });

  it('★ 没有转写稿时任务转 blocked 并给出可执行补救，而不是失败或静默', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: join(ROOT, `mmblocked-${port}`), maxPort: port });
    try {
      const s = await handshake(d.port, d.token);
      const noteUid = await upload(s, 'lecture.wav');
      const accepted = (await (
        await fetch(`${s.base}/api/notes/${noteUid}/mindmap`, {
          method: 'POST',
          headers: { Cookie: `${SESSION_COOKIE}=${s.sid}`, [CSRF_HEADER]: s.csrf },
        })
      ).json()) as { jobUid: string };

      // 调度器要跑一轮才会把它标成 blocked
      let job: Record<string, unknown> | undefined;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const listed = (await (
          await fetch(`${s.base}/api/jobs`, { headers: { Cookie: `${SESSION_COOKIE}=${s.sid}` } })
        ).json()) as { jobs: Record<string, unknown>[] };
        job = listed.jobs.find((j) => j['jobId'] === accepted.jobUid);
        if (job?.['state'] === 'blocked') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(
        job?.['state'],
        'blocked',
        '导图任务既没跑起来也没被挂起 —— 前端的按钮会一直显示"正在生成"，永远不回来',
      );
      assert.equal(
        job?.['blockedCode'],
        'NO_TRANSCRIPT',
        '前端按 blockedCode 说明原因（mindmap.blocked.<code>）；没有它就只剩一个不说话的禁用按钮',
      );
    } finally {
      await d.stop();
    }
  });
});

/**
 * T-138 ④ —— `?folder=` 真的筛，且**计数与筛选结果同源**。
 *
 * ## 为什么这组测试的重点是「两个数字必须相等」
 *
 * 这个端点此前根本没人读（`[实测]` 点开一条笔记都没有的文件夹，页面照常列出全部）。
 * 补上它本身不难，难的是**别造出第二个真相**：
 * 侧栏那个 `课程 2` 与 `?folder=` 的返回如果各算各的，
 * 就会出现「侧栏写 2、点进去 3」——**两个数字各自都算对了，没有任何一处会报错**，
 * 只有用户觉得这软件有点怪。
 *
 * 所以判据不是"筛出来的都在这个文件夹里"（那条在两边分叉时照样绿），
 * 而是 **侧栏计数 == 筛选返回条数 == 3**。
 * 造一棵父子树、父级 1 条、子级 2 条：任一侧改成"不含子孙"，这条就会红。
 */
describe('T-138 ④ GET /api/notes?folder=', () => {
  async function folder(s: Session, name: string, parentUid?: string): Promise<string> {
    const res = await fetch(`${s.base}/api/folders`, {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE}=${s.sid}`,
        [CSRF_HEADER]: s.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify(parentUid === undefined ? { name } : { name, parentUid }),
    });
    const body = await res.text();
    assert.equal(res.status, 201, body);
    return (JSON.parse(body) as { uid: string }).uid;
  }

  async function moveNote(s: Session, noteUid: string, folderUid: string): Promise<void> {
    const res = await fetch(`${s.base}/api/notes/${noteUid}/folder`, {
      method: 'PUT',
      headers: {
        Cookie: `${SESSION_COOKIE}=${s.sid}`,
        [CSRF_HEADER]: s.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folderUid }),
    });
    assert.equal(res.status, 200, await res.text());
  }

  it('★ 侧栏计数 == 筛选返回条数（父 1 + 子 2 = 3）—— 两边分叉就红', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: join(ROOT, `folder-${port}`), maxPort: port });
    try {
      const s = await handshake(d.port, d.token);

      const parent = await folder(s, '课程');
      const child = await folder(s, '深度学习', parent);
      const a = await upload(s, 'a.wav');
      const b = await upload(s, 'b.wav');
      const c = await upload(s, 'c.wav');
      await moveNote(s, a, parent);
      await moveNote(s, b, child);
      await moveNote(s, c, child);

      // ① 侧栏计数（GET /api/folders 里那个 noteCount）
      const tree = (await (
        await fetch(`${s.base}/api/folders`, { headers: { Cookie: `${SESSION_COOKIE}=${s.sid}` } })
      ).json()) as {
        folders: { uid: string; name: string; noteCount: number; children?: unknown[] }[];
      };
      const flat: { uid: string; noteCount: number }[] = [];
      const walk = (ns: { uid: string; noteCount: number; children?: unknown[] }[]) => {
        for (const n of ns) {
          flat.push(n);
          walk((n.children ?? []) as typeof ns);
        }
      };
      walk(tree.folders);
      const counted = flat.find((f) => f.uid === parent)?.noteCount;

      // ② 筛选返回条数
      const listed = (await (
        await fetch(`${s.base}/api/notes?folder=${parent}`, {
          headers: { Cookie: `${SESSION_COOKIE}=${s.sid}` },
        })
      ).json()) as { notes: { uid: string }[] };

      assert.equal(
        listed.notes.length,
        3,
        '按文件夹筛应含子孙（父 1 + 子 2 = 3）—— 只筛直属的话用户会看到"父级空、子级有货"',
      );
      assert.equal(
        counted,
        listed.notes.length,
        `侧栏计数(${String(counted)}) 与筛选返回条数(${listed.notes.length}) 不一致 —— ` +
          '两处各算各的，于是侧栏写一个数、点进去是另一个数，而且没有任何一处会报错',
      );
      assert.deepEqual(
        [...listed.notes.map((n) => n.uid)].sort(),
        [a, b, c].sort(),
        '返回的应当正好是这三条',
      );

      // 子文件夹自己只算自己那两条（"含子孙"不等于"含兄弟"）
      const childListed = (await (
        await fetch(`${s.base}/api/notes?folder=${child}`, {
          headers: { Cookie: `${SESSION_COOKIE}=${s.sid}` },
        })
      ).json()) as { notes: { uid: string }[] };
      assert.equal(childListed.notes.length, 2);
      assert.equal(
        flat.find((f) => f.uid === child)?.noteCount,
        2,
        '子文件夹的计数与它自己的筛选结果同样必须一致',
      );
    } finally {
      await d.stop();
    }
  });

  it('★ 筛选发生在 limit 之前（与 ?starred=1 同一条判据）', async () => {
    const port = nextPort();
    const d = await startDaemon({
      port,
      dataDir: join(ROOT, `folderlimit-${port}`),
      maxPort: port,
    });
    try {
      const s = await handshake(d.port, d.token);
      const f = await folder(s, '课程');
      const a = await upload(s, 'a.wav'); // 最早
      await upload(s, 'b.wav');
      await upload(s, 'c.wav'); // 最新两条都不在这个文件夹里
      await moveNote(s, a, f);

      const listed = (await (
        await fetch(`${s.base}/api/notes?folder=${f}&limit=2`, {
          headers: { Cookie: `${SESSION_COOKIE}=${s.sid}` },
        })
      ).json()) as { notes: { uid: string }[] };
      assert.deepEqual(
        listed.notes.map((n) => n.uid),
        [a],
        '?folder=…&limit=2 没返回那条笔记 —— limit 先切、folder 后筛：' +
          '文件夹里的笔记一多就开始漏，而用户看不出少了什么',
      );
    } finally {
      await d.stop();
    }
  });

  it('★ 认不出的 folder uid 一律 400，绝不静默返回全部', async () => {
    const port = nextPort();
    const d = await startDaemon({ port, dataDir: join(ROOT, `folder400-${port}`), maxPort: port });
    try {
      const s = await handshake(d.port, d.token);
      await upload(s, 'a.wav');
      for (const bad of ['01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'not-a-ulid', '']) {
        const res = await fetch(`${s.base}/api/notes?folder=${encodeURIComponent(bad)}`, {
          headers: { Cookie: `${SESSION_COOKIE}=${s.sid}` },
        });
        assert.equal(
          res.status,
          400,
          `?folder=${JSON.stringify(bad)} 被静默忽略了 —— 用户会以为自己在看某个文件夹，` +
            '实际拿到的是全部笔记',
        );
        assert.equal(
          ((await res.json()) as { error?: { code?: string } }).error?.code,
          'BAD_QUERY_PARAM',
        );
      }
    } finally {
      await d.stop();
    }
  });
});
