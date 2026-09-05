/**
 * `GET /api/search` 的两条**浏览器实测出来的**缺陷，各钉一条会红的断言。
 *
 * ## ① 存量笔记的 `body_text` 没有被回填 ⇒ 升级了也搜不到
 *
 * `[浏览器实测]` 三阶段，每一步都是真的 `/api/search` 请求：
 * 旧构建搜 `0:39` → 0 命中；**装上 #87 的新构建、笔记没重存过 → 仍然 0 命中**；
 * 把那条笔记手工重存一次 → 命中。
 *
 * 本文件把那三阶段变成一条自动断言：**回填前搜不到、回填后搜到**。
 *
 * ⚠️ **「把修法退回去它会红吗」** —— 验过：
 * 把 `main.ts` 那次 `backfillBodyText()` 调用删掉，本文件对应的那一 `it` 里
 * 「回填后应当命中」当场红（`hits.length` 停在 0）。判据不是"函数返回了什么"，
 * 而是**一次真的 HTTP 请求拿到了几条命中**，所以它连"回填写对了列但索引没跟上"
 * 也一并守住了（`notes_fts` 与 `notes` 脱节的话，这条同样红）。
 *
 * ## ② 搜到了，但看不出为什么搜到
 *
 * `[浏览器实测]` 搜 `0:39` 命中后卡片显示「audit-long.wav / audit-long.wav」——
 * **标题重复了两遍，而匹配到的 `[0:39]` 一个字都不出现**。
 * 成因是 `snippet: r.title || r.body_text.slice(0, 120)`：`notes.title` 有
 * `NOT NULL DEFAULT ''` 但真实笔记几乎总有标题 ⇒ 短路左边永远为真。
 *
 * ## 为什么这份测试用真的 HTTP 服务，而不是直接调函数
 *
 * 这条链上有四段，任何一段断了用户都是"搜不到"或"看不出为什么"：
 * 投影（`extractPlainText`）→ 回填写回 `notes.body_text` → 触发器同步 `notes_fts`
 * → 路由的 `MATCH` / `snippet()` 拼装。**只测其中一段全绿、而用户仍然搜不到**
 * 是这两个缺陷已经发生过的形态。所以判据取"发一次请求，看响应"。
 *
 * ## 分词器：这里跑的是 **trigram 降级路**
 *
 * `openAppDatabase()` 不传 `extensions` ⇒ 不加载 libsimple ⇒ `tokenize='trigram'`。
 * CI 上没有 `OPENMEMO_TEST_EXT_DIR`，所以这是**唯一能稳定复现的那一路**，
 * 也正是最需要被守住的一路（扩展缺失时搜索仍须可用）。
 * `[实测]` trigram 下 `"0:39"` 能命中 `…[0:39]…`，`snippet()` 也照常画高亮 ——
 * 这两条性质不依赖 libsimple。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { openAppDatabase, type AppDatabase } from '@openmemo/db';

import { createSearchRoutes } from './search.js';
import { backfillBodyText } from '../../db/backfillBodyText.js';
import { Repos } from '../../db/repos.js';

/**
 * 审计现场那条笔记的 `body_json`，**逐字原样**（uid `01M1RY1FZ38EWNX5GQVW7ZYKBE`）。
 *
 * 手写一个"干净"的文档会洗掉两个要命的细节：`startMs` 是浮点（`4706.022`）、
 * `quote` 是 `null`。#87 的单测踩过同一个坑，这里沿用同一条纪律。
 */
const AUDIT_BODY_JSON = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'AUDITMARKanchors:' },
        {
          type: 'timeAnchor',
          attrs: {
            anchorKey: 'anc_62373cbc-c4fd-41cc-9f46-4f35d075ef66',
            startMs: 4706.022,
            transcriptUid: '01M1RY1G6E7QHRXFYHGNQ7F2EN',
            quote: null,
          },
        },
        { type: 'text', text: ' ' },
        {
          type: 'timeAnchor',
          attrs: {
            anchorKey: 'anc_11ee5cd3-0cbd-4f10-a352-3d5e9060c539',
            startMs: 39854.604999999996,
            transcriptUid: '01M1RY1G6E7QHRXFYHGNQ7F2EN',
            quote: null,
          },
        },
        { type: 'text', text: ' ' },
        {
          type: 'timeAnchor',
          attrs: {
            anchorKey: 'anc_6fe2d951-3378-4baa-b71d-04477568fcbb',
            startMs: 88305.031,
            transcriptUid: '01M1RY1G6E7QHRXFYHGNQ7F2EN',
            quote: null,
          },
        },
        { type: 'text', text: ' TIMECODEPROBE0:04literal' },
      ],
    },
  ],
});

/**
 * **#87 之前**的投影结果，逐字。三个锚点只留下了两侧的空格。
 * 这就是升级后没被重存过的那些笔记，今天库里躺着的东西。
 */
const STALE_BODY_TEXT = 'AUDITMARKanchors:   TIMECODEPROBE0:04literal';

/** 回填之后应当得到的投影（`[0:04]` / `[0:39]` / `[1:28]` 三个时间码都在）。 */
const FRESH_BODY_TEXT = 'AUDITMARKanchors:[0:04] [0:39] [1:28] TIMECODEPROBE0:04literal';

let app: AppDatabase;
let repos: Repos;
let dir = '';
let base = '';
let close: (() => Promise<void>) | undefined;

/** 被回填的那条（升级前存的，`body_text` 是旧投影）。 */
let staleNoteId = 0;
/** 已经手工重存过的那条 —— 幂等的现成对照，回填必须**一个字节都不动它**。 */
let freshNoteId = 0;
/** 纯文本笔记：`body_json IS NULL`，`body_text` 有内容。**绝不许被覆盖成空**。 */
let plainNoteId = 0;

interface SearchBody {
  hits: {
    noteUid: string;
    noteTitle: string;
    snippet: string;
    source: 'segment' | 'note';
    startMs: number | null;
  }[];
}

async function search(q: string): Promise<SearchBody> {
  const res = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}&limit=20`);
  assert.equal(res.status, 200, `搜「${q}」应当 200`);
  return (await res.json()) as SearchBody;
}

function bodyTextOf(id: number): string {
  return (
    app.db.prepare<{ body_text: string }>('SELECT body_text FROM notes WHERE id = :id').get({ id })
      ?.body_text ?? ''
  );
}

function updatedAtOf(id: number): number {
  return (
    app.db
      .prepare<{ updated_at: number }>('SELECT updated_at FROM notes WHERE id = :id')
      .get({ id })?.updated_at ?? 0
  );
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'om-search-backfill-'));
  // 不传 extensions ⇒ 走 trigram 降级路（CI 上没有 libsimple，见文件头）
  app = openAppDatabase({ filename: join(dir, 'openmemo.db') });
  repos = new Repos(app.db);

  const stale = repos.createNote({ title: 'audit-long.wav' });
  staleNoteId = stale.id;
  const fresh = repos.createNote({ title: 'already-resaved.wav' });
  freshNoteId = fresh.id;
  const plain = repos.createNote({ title: '手打的纯文本笔记', kind: 'plain' });
  plainNoteId = plain.id;

  /*
   * 直接写 SQL 造"升级前的库"，**刻意不走 PATCH 路由** ——
   * 走 PATCH 就会顺手把 `body_text` 推导成新格式，那样这份测试测的就是
   * "我刚写对的值还在不在"，而不是"存量数据被修好了没有"。
   */
  const seed = app.db.prepare('UPDATE notes SET body_json = :j, body_text = :t WHERE id = :id');
  seed.run({ id: staleNoteId, j: AUDIT_BODY_JSON, t: STALE_BODY_TEXT });
  seed.run({ id: freshNoteId, j: AUDIT_BODY_JSON, t: FRESH_BODY_TEXT });
  // 纯文本笔记：body_json 保持 NULL，body_text 有内容
  app.db
    .prepare('UPDATE notes SET body_text = :t WHERE id = :id')
    .run({ id: plainNoteId, t: 'PLAINONLYWORD 这条没有 body_json' });

  const routes = createSearchRoutes({
    db: app.db,
    // 与 openAppDatabase 的实际状态保持一致：没加载 libsimple
    hasChineseTokenizer: false,
    hasVectorIndex: false,
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void routes.handle(req, res, url, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
    });
});

after(async () => {
  await close?.();
  app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('① 存量 body_text 回填：回填前搜不到，回填后搜到', () => {
  it('回填前：正文里画着 [0:39]，但 /api/search 找不到那条没重存过的笔记', async () => {
    // 前置条件本身也要断言 —— 否则"库里根本没有这条笔记"也会让下面这条绿
    assert.equal(bodyTextOf(staleNoteId), STALE_BODY_TEXT);

    for (const q of ['0:39', '1:28']) {
      const r = await search(q);
      /*
       * 这就是浏览器里那份 A/B 对照，被搬进同一个库里：
       * **同样的正文、同样的查询**，重存过的那条命中、没重存过的那条不命中。
       * 差别只有一样 —— `body_text` 里的投影是新的还是旧的。
       */
      assert.ok(
        !r.hits.some((h) => h.noteTitle === 'audit-long.wav'),
        `回填前搜「${q}」不该命中那条没重存过的笔记（这正是浏览器实测到的现状）`,
      );
      assert.ok(
        r.hits.some((h) => h.noteTitle === 'already-resaved.wav'),
        `重存过的那条必须命中 —— 否则说明分词器/索引本身就有问题，测的不是这个缺陷`,
      );
    }

    // 再加一条对照：同一条笔记里的普通文字**一直**搜得到，缺的只有时间码
    const ok = await search('AUDITMARKanchors');
    assert.ok(
      ok.hits.some((h) => h.noteTitle === 'audit-long.wav'),
      '普通文字必须搜得到，否则这份测试测的是别的毛病',
    );
  });

  it('★ 回填后：同样的查询命中了 —— 把 backfillBodyText 退回去，这条当场红', async () => {
    const before = updatedAtOf(staleNoteId);
    const res = backfillBodyText(app.db, { force: true });

    assert.equal(res.error, undefined, `回填不该出错：${res.error ?? ''}`);
    assert.equal(res.ran, true);
    assert.equal(res.updated, 1, '只有那条旧投影的笔记该被写回');
    assert.equal(bodyTextOf(staleNoteId), FRESH_BODY_TEXT);

    for (const q of ['0:39', '1:28']) {
      const r = await search(q);
      const hit = r.hits.find((h) => h.noteTitle === 'audit-long.wav');
      assert.ok(hit, `回填后搜「${q}」必须命中那条笔记`);
      assert.equal(hit?.source, 'note');
    }

    /*
     * `body_text` 变了，`notes_fts` 跟着变 —— 靠的是 `0002_search.sql` 的
     * `notes_fts_au` 触发器，回填这边**没有也不该有**任何显式的索引维护代码。
     * 上面那两次命中就是这条性质的证据：影子表没跟上的话，搜索照样 0 条。
     */

    // 不动 `updated_at`：那是用户可见的「最近修改」，笔记列表按它排序
    assert.equal(updatedAtOf(staleNoteId), before, '回填是派生数据重算，不许把笔记顶到列表最前面');
  });

  it('幂等：紧接着再跑一次，updated=0，且三条笔记逐字不变', () => {
    const snapshot = [staleNoteId, freshNoteId, plainNoteId].map(bodyTextOf);

    const again = backfillBodyText(app.db, { force: true });
    assert.equal(again.error, undefined);
    assert.equal(again.updated, 0, '第二次跑不该写任何一行');
    assert.deepEqual([staleNoteId, freshNoteId, plainNoteId].map(bodyTextOf), snapshot);

    // 指纹已经写进 app_meta ⇒ 不 force 时直接跳过，连扫都不扫
    const skipped = backfillBodyText(app.db);
    assert.equal(skipped.ran, false);
    assert.equal(skipped.scanned, 0);
  });

  it('已经手工重存过的那条：重算结果与库里逐字相同，所以它从来没被写过', () => {
    assert.equal(bodyTextOf(freshNoteId), FRESH_BODY_TEXT);
  });

  it('没有 body_json 的纯文本笔记：body_text 一个字节都没被碰', async () => {
    assert.equal(bodyTextOf(plainNoteId), 'PLAINONLYWORD 这条没有 body_json');
    const r = await search('PLAINONLYWORD');
    assert.equal(r.hits.length, 1, '纯文本笔记回填前后都该搜得到');
  });
});

describe('② 命中摘要：看得出为什么搜到，且不把标题重复一遍', () => {
  it('★ 摘要给的是命中处的正文上下文，不是标题的复读', async () => {
    const r = await search('0:39');
    const hit = r.hits.find((h) => h.noteTitle === 'audit-long.wav');
    assert.ok(hit, '前置：这条得先能搜到');
    const snippet = hit?.snippet ?? '';

    // 这一条正是浏览器里看到的那个缺陷：卡片上「audit-long.wav / audit-long.wav」
    assert.notEqual(snippet, 'audit-long.wav', '摘要不许等于标题');
    assert.ok(!snippet.includes('audit-long.wav'), '摘要里不该再出现一遍标题');

    // 看得出"为什么搜到"：匹配到的那一段必须出现，而且被标出来
    assert.ok(snippet.includes('0:39'), `摘要里必须出现匹配到的 0:39，实际是：${snippet}`);
    assert.ok(snippet.includes('<mark>'), `摘要必须标出命中处，实际是：${snippet}`);
    assert.ok(
      /<mark>[^<]*0:39/.test(snippet.replace(/&#\d+;/g, '')) || snippet.includes('<mark>0:39'),
      `高亮应当落在命中的词上，实际是：${snippet}`,
    );
  });

  it('段落命中同样带高亮，而不是把整段原文原样丢回去', async () => {
    const t = repos.createTranscript({ noteId: plainNoteId, engineId: 'test' });
    repos.insertSegments(t.id, [
      {
        startMs: 1000,
        endMs: 4000,
        text: 'and so my fellow SEGWORDPROBE americans ask not what your country can do',
        confidence: null,
        noSpeechProb: null,
        words: null,
        chunkIdx: 0,
        flags: 0,
      },
    ]);

    const r = await search('SEGWORDPROBE');
    const hit = r.hits.find((h) => h.source === 'segment');
    assert.ok(hit, '段落命中应当出现');
    assert.ok(
      (hit?.snippet ?? '').includes('<mark>'),
      `段落摘要也要标出命中处，实际是：${hit?.snippet ?? ''}`,
    );
  });

  it('★ 摘要是转义过的 HTML —— 正文里的 <script> 不许原样出到响应里', async () => {
    /*
     * 前端 `SearchPage.tsx` 用 `dangerouslySetInnerHTML` 渲染这一格，注释还写着
     * 「受控的服务端输出，不是用户输入」。**在这次修复之前那句话是假的**：
     * 这一格发的就是 `r.title || r.body_text.slice(0,120)`，也就是用户自己写的字。
     * 所以转义这件事必须有断言钉着，否则它会被下一次"顺手简化"悄悄拿掉。
     */
    const evil = repos.createNote({ title: 'xss probe' });
    app.db.prepare('UPDATE notes SET body_text = :t WHERE id = :id').run({
      id: evil.id,
      t: '<img src=x onerror=alert(1)> XSSPROBEWORD 结束',
    });

    const r = await search('XSSPROBEWORD');
    const hit = r.hits.find((h) => h.noteTitle === 'xss probe');
    assert.ok(hit, '前置：这条得先能搜到');
    const snippet = hit?.snippet ?? '';
    assert.ok(snippet.includes('&lt;img'), `用户写的尖括号必须被转义：${snippet}`);
    /*
     * 判据是**「整段里唯一的真标签只能是 `<mark>`」**，不是"不含 onerror 这个词"——
     * `onerror=alert(1)` 转义之后作为**纯文本**留在摘要里完全没问题，它已经不是属性了。
     * 用这条正则而不是几个 `includes`，是因为它对下一个人写的任何标签都成立。
     */
    const tags = snippet.match(/<[^>]*>/g) ?? [];
    assert.deepEqual(
      [...new Set(tags)].sort(),
      ['</mark>', '<mark>'],
      `摘要里只允许出现 <mark>，实际出现了：${JSON.stringify(tags)}`,
    );
    // 转义与插标签的**顺序**：反过来的话这里会变成 &lt;mark&gt;，上面那条就红
    assert.ok(snippet.includes('<mark>'), `高亮标签本身必须是真的标签：${snippet}`);
  });
});
