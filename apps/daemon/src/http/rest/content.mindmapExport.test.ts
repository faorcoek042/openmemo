import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { openAppDatabase, type AppDatabase } from '@openmemo/db';
import type { MindMapDoc } from '@openmemo/mindmap';

import { createContentRoutes } from './content.js';
import { MindMapRepo } from '../../db/mindmapRepo.js';
import { Repos } from '../../db/repos.js';
import type { JobQueue } from '../../jobs/queue.js';
import type { SseHub } from '../sse.js';

/**
 * `GET /api/notes/:uid/export?what=mindmap&format=…` —— **这条路由此前一次都没有被请求过。**
 *
 * ## 为什么补这一份
 *
 * 上一轮对照把这四种格式记成「服务端已实现**且有测试**」。前半句是真的，
 * 后半句**不成立**：`content.export.test.ts` 全文不含 `mindmap` 一词，它测的是
 * *笔记* 导出的纯函数（`toSrt` / `toVtt` / `safeName` / `msToSrtTime`）；
 * 序列化器本身在 `packages/mindmap/src/serialize/` 有测试。
 * 也就是说 **`content.ts` 里那段 `what === 'mindmap'` 分支（路由匹配、`what`/`format`
 * 解析、404 / 400 分支、`Content-Disposition` 头）从来没有任何东西执行过。**
 * 而前端这一轮才刚接上入口 —— 接的正是这条从没被走过的路。
 *
 * ## 判据取"真的发一次请求"，不取"函数返回了字符串"
 *
 * 单测序列化器证明不了这条路由能走通：`what` 拼错、大小写没归一、
 * 别名（`markdown` / `freemind`）漏了、`Content-Type` 写错、
 * 中文标题把 `Content-Disposition` 头炸成 500 —— 以上任何一条都能让
 * 「序列化器全绿 + 用户点了下载不下来」同时成立。所以这里起一个真的 HTTP 服务。
 *
 * ## 为什么不用 `startDaemon`
 *
 * 这里只挂 `createContentRoutes` 一个路由模块，**不启动 daemon**：
 * 不占固定端口（`listen(0)` 由 OS 分配）、不碰单实例锁、
 * 也就完全不接近 PROTOCOL §9 那个机器级的数据目录指针。测这条路由不需要那些。
 */

let db: AppDatabase;
let dir = '';
let base = '';
let noteUid = '';
let bareUid = '';
let close: (() => Promise<void>) | undefined;

/** 有层级、有时间戳 refs、有 XML 元字符 —— 四种格式的差别只有这样才看得出来。 */
const doc = {
  schemaVersion: 1,
  uid: 'placeholder',
  title: '产品评审会',
  rootKey: 'root',
  nodes: {
    root: { key: 'root', text: '产品评审会', children: ['a', 'b'] },
    a: {
      key: 'a',
      text: '成本 <预算> & 排期',
      children: ['a1'],
      refs: [
        {
          transcriptUid: 'T1',
          startMs: 754_000,
          endMs: 761_000,
          quote: '这里说到成本',
          matchScore: 1,
        },
      ],
    },
    a1: { key: 'a1', text: '硬件采购', children: [] },
    b: { key: 'b', text: '风险 "引号" 项', children: [] },
  },
  edges: [],
  summaries: [],
} as unknown as MindMapDoc;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'om-mm-export-'));
  db = openAppDatabase({ filename: join(dir, 'openmemo.db') });
  const repos = new Repos(db.db);
  const mindmaps = new MindMapRepo(db.db);

  // 标题刻意带中文与 Windows 非法字符：`Content-Disposition` 是这条链上最容易 500 的地方
  const note = repos.createNote({ title: '产品评审会 2026/03「第一次」' });
  noteUid = note.uid;
  mindmaps.save({ noteId: note.id, doc, generatedBy: 'test' });

  // 第二条笔记刻意**不给**导图 —— 404 分支同样从没被走过
  bareUid = repos.createNote({ title: 'no mindmap here' }).uid;

  const routes = createContentRoutes({
    db: db.db,
    repos,
    mindmaps,
    // 导出分支用不到这两个；给最小桩而不是启动真队列/事件总线
    queue: {} as unknown as JobQueue,
    sse: { publish: () => {} } as unknown as SseHub,
    /*
     * 导出分支同样用不到 `dataDir`（它只喂重跑判据 `resolveRetranscribeSource`），
     * 但**不能给假路径**：给个存在的目录，万一将来有人在这条链上加了真读盘的一步，
     * 失败会是"读不到东西"而不是"路径根本是编的"。
     */
    dataDir: tmpdir(),
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void routes
      .handle(req, res, url, req.method ?? 'GET')
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end('unrouted');
        }
      })
      .catch((e: unknown) => {
        res.writeHead(500);
        res.end(String(e));
      });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((r) => server.close(() => r()));
});

after(async () => {
  await close?.();
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const get = async (query: string) => fetch(`${base}/api/notes/${noteUid}/export?${query}`);

describe('GET /api/notes/:uid/export?what=mindmap', () => {
  it('★ 四种格式全部 200，且各自的 Content-Type 不同（前端菜单直连这四条）', async () => {
    const want: Record<string, string> = {
      md: 'text/markdown; charset=utf-8',
      opml: 'text/x-opml; charset=utf-8',
      mm: 'application/x-freemind; charset=utf-8',
      json: 'application/json; charset=utf-8',
    };
    for (const [format, mime] of Object.entries(want)) {
      const res = await get(`what=mindmap&format=${format}`);
      assert.equal(res.status, 200, `format=${format} 没有 200`);
      assert.equal(res.headers.get('content-type'), mime, `format=${format} 的 Content-Type 不对`);
      const body = await res.text();
      assert.ok(body.length > 0, `format=${format} 回了空 body`);
      assert.ok(body.includes('产品评审会'), `format=${format} 的正文里没有根节点`);
    }
  });

  it('★ 时间戳只有 md 与 json 带得走 —— 界面上那句损耗说明的**事实依据**', async () => {
    /*
     * 这条同时钉两件事：
     * ① `toMarkdown` 是带 `includeTimestamps: true` 调用的（漏了这个参数不会有任何东西报错，
     *    只是导出的大纲从此跳不回录音）；
     * ② `MindmapExportMenu` 里那句「OPML 与 FreeMind 不含时间戳」是**真的**。
     *    哪天序列化器补上了时间戳，这条会红 —— 那正是该去改文案的时刻。
     */
    assert.ok(
      (await (await get('what=mindmap&format=md')).text()).includes('[12:34]'),
      'md 丢了时间戳：includeTimestamps 没传，或者序列化器变了',
    );
    assert.ok(
      (await (await get('what=mindmap&format=json')).text()).includes('754000'),
      'json 丢了 refs 里的 startMs',
    );

    for (const format of ['opml', 'mm']) {
      const body = await (await get(`what=mindmap&format=${format}`)).text();
      assert.equal(
        body.includes('12:34') || body.includes('754000'),
        false,
        `${format} 现在带上时间戳了 —— 菜单里那句损耗说明该改了`,
      );
    }
  });

  it('XML 两种格式必须转义元字符（不转义 = 导出的文件在别的软件里打不开）', async () => {
    for (const format of ['opml', 'mm']) {
      const body = await (await get(`what=mindmap&format=${format}`)).text();
      assert.ok(body.includes('&lt;预算&gt;'), `${format} 没转义 <>`);
      assert.ok(body.includes('&amp;'), `${format} 没转义 &`);
      assert.equal(body.includes('<预算>'), false, `${format} 漏出了未转义的尖括号`);
    }
  });

  it('★ 中文标题不许把 Content-Disposition 炸成 500（RFC 5987 的 filename*）', async () => {
    /*
     * 直接把中文塞进 `filename=` 会让 Node 抛 `Invalid character in header content` → 500。
     * 这条路由从没被请求过，也就意味着**这个 500 从来没有人撞到过**。
     */
    const res = await get('what=mindmap&format=md');
    const cd = res.headers.get('content-disposition') ?? '';
    assert.ok(cd.startsWith('attachment;'), `不是附件下载：${cd}`);
    assert.ok(
      cd.includes("filename*=UTF-8''"),
      `缺 RFC 5987 的 filename*，中文名会变成下划线：${cd}`,
    );
    // ASCII 回退名里不许出现路径分隔符（标题里那个 `/` 必须已被换掉）
    const ascii = /filename="([^"]*)"/.exec(cd)?.[1] ?? '';
    assert.equal(ascii.includes('/'), false, `回退文件名里漏出了路径分隔符：${ascii}`);
  });

  it('别名与大小写：markdown / freemind / 大写 MINDMAP 都要认', async () => {
    assert.equal((await get('what=mindmap&format=markdown')).status, 200);
    assert.equal((await get('what=mindmap&format=freemind')).status, 200);
    assert.equal((await get('what=MINDMAP&format=OPML')).status, 200);
  });

  it('★ 不支持的格式回 400 且带 code，不是 200 空文件', async () => {
    const res = await get('what=mindmap&format=pdf');
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'BAD_FORMAT');
  });

  it('★ 笔记还没有导图时回 404 NO_MINDMAP —— 前端据此不该给出入口', async () => {
    /*
     * 前端这一轮把入口放在**导图渲染器的工具栏**上，也就是只有 doc 真的存在时才画得出来，
     * 所以这条 404 在产品里走不到。它仍然要对：入口的位置是可以被下一个人挪的，
     * 而挪到"没有导图也看得见"的地方时，用户点到的就是这个响应。
     */
    const res = await fetch(`${base}/api/notes/${bareUid}/export?what=mindmap&format=md`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: { code?: string; messageZh?: string } };
    assert.equal(body.error?.code, 'NO_MINDMAP');
    assert.ok((body.error?.messageZh ?? '').length > 0, '中文错误信息不能是空的');
  });

  it('★ 缺省 what= 走的是**笔记**导出，不是导图（这正是前端漏 what= 时的后果）', async () => {
    /*
     * `what` 的缺省值是 `'note'`。前端菜单如果只发 `?format=md`，用户拿到的是
     * **一份格式正确但内容是转写稿的文件** —— 没有任何东西会报错。
     * 这条把那个后果钉下来，免得下一个人以为"反正都是导出，带不带 what 无所谓"。
     */
    const res = await get('format=md');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(
      body.includes('- 成本 <预算> & 排期'),
      false,
      '不带 what=mindmap 却导出了导图 —— 缺省值变了，前端那四条链接的判据要跟着重看',
    );
    assert.ok(
      body.startsWith('# 产品评审会 2026/03「第一次」'),
      `导出的应当是笔记本身：${body.slice(0, 60)}`,
    );
  });
});
