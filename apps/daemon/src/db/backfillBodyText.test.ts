/**
 * `backfillBodyText()` 的库层性质。
 *
 * 端到端那条（**回填前搜不到、回填后搜到**，真的发 `/api/search` 请求）在
 * `http/rest/search.backfill.test.ts`。这里只钉那些在 HTTP 层看不出来、
 * 但一旦错了就会**悄悄毁数据**的性质：
 *
 *   · 没有 `body_json` 的笔记一个字节都不许碰（用户库里 8 条有 7 条是这种）
 *   · 投影出空串时**不覆盖**已有内容
 *   · `body_json` 读不出来时原样跳过，并把条数**报出来**
 *   · 指纹样本不许退化成"什么分支都没覆盖"（那会让下次投影器改动不触发回填）
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { openAppDatabase, type AppDatabase } from '@openmemo/db';

import {
  BODY_TEXT_PROJECTION_KEY,
  backfillBodyText,
  projectionCanaryText,
  projectionFingerprint,
} from './backfillBodyText.js';
import { Repos } from './repos.js';

const TMP = mkdtempSync(join(tmpdir(), 'om-backfill-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function freshDb(): { app: AppDatabase; repos: Repos } {
  const app = openAppDatabase({ filename: join(TMP, `b${n++}.db`) });
  return { app, repos: new Repos(app.db) };
}

function seed(
  app: AppDatabase,
  repos: Repos,
  p: { title: string; bodyJson: string | null; bodyText: string },
): number {
  const note = repos.createNote({ title: p.title });
  app.db
    .prepare('UPDATE notes SET body_json = :j, body_text = :t WHERE id = :id')
    .run({ id: note.id, j: p.bodyJson, t: p.bodyText });
  return note.id;
}

function bodyTextOf(app: AppDatabase, id: number): string {
  return (
    app.db.prepare<{ body_text: string }>('SELECT body_text FROM notes WHERE id = :id').get({ id })
      ?.body_text ?? ''
  );
}

describe('只动该动的', () => {
  it('body_json IS NULL 的笔记根本不进循环，body_text 原样保留', () => {
    const { app, repos } = freshDb();
    const plain = seed(app, repos, {
      title: '纯文本',
      bodyJson: null,
      bodyText: '手打的正文，没有 body_json',
    });

    const r = backfillBodyText(app.db, { force: true });
    assert.equal(r.error, undefined);
    assert.equal(r.scanned, 0, 'body_json 为空的笔记不该被扫到');
    assert.equal(bodyTextOf(app, plain), '手打的正文，没有 body_json');
    app.close();
  });

  it('投影为空、而库里有内容 → 保留旧值并计入 refused', () => {
    const { app, repos } = freshDb();
    // 合法 JSON、但一个 text 节点都没有 ⇒ 投影是空串
    const weird = seed(app, repos, {
      title: '畸形文档',
      bodyJson: JSON.stringify({ type: 'doc', content: [{ type: 'horizontalRule' }] }),
      bodyText: '这段字是搜得到的，不许被一次"修复"抹掉',
    });

    const r = backfillBodyText(app.db, { force: true });
    assert.equal(r.refused, 1);
    assert.equal(r.updated, 0);
    assert.equal(bodyTextOf(app, weird), '这段字是搜得到的，不许被一次"修复"抹掉');
    app.close();
  });

  it('body_json 不是合法 JSON → 原样跳过，条数如实报出来', () => {
    const { app, repos } = freshDb();
    const broken = seed(app, repos, {
      title: '坏 JSON',
      bodyJson: '{"type":"doc",',
      bodyText: '旧投影',
    });

    const r = backfillBodyText(app.db, { force: true });
    assert.equal(r.unparsable, 1, '读不出来 ≠ 里面没东西，必须能被数出来');
    assert.equal(r.updated, 0);
    assert.equal(bodyTextOf(app, broken), '旧投影');
    app.close();
  });

  it('本来就是空的 body_text，投影也是空 → 不算 refused，也不写', () => {
    const { app, repos } = freshDb();
    seed(app, repos, {
      title: '空文档',
      bodyJson: JSON.stringify({ type: 'doc', content: [] }),
      bodyText: '',
    });
    const r = backfillBodyText(app.db, { force: true });
    assert.equal(r.scanned, 1);
    assert.equal(r.updated, 0);
    assert.equal(r.refused, 0);
    app.close();
  });
});

describe('分批与幂等', () => {
  it('分批跑完整表（chunkSize 小于总数），且第二遍 updated=0', () => {
    const { app, repos } = freshDb();
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(
        seed(app, repos, {
          title: `n${i}`,
          bodyJson: JSON.stringify({
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: `第${i}条 ` },
                  { type: 'timeAnchor', attrs: { startMs: 4706.022, quote: null } },
                ],
              },
            ],
          }),
          // 旧投影：锚点不见了
          bodyText: `第${i}条 `.trim(),
        }),
      );
    }

    const first = backfillBodyText(app.db, { force: true, chunkSize: 4 });
    assert.equal(first.error, undefined);
    assert.equal(first.scanned, 25, '游标分页必须扫全，不许漏批');
    assert.equal(first.updated, 25);
    for (const id of ids) assert.ok(bodyTextOf(app, id).includes('[0:04]'));

    const second = backfillBodyText(app.db, { force: true, chunkSize: 4 });
    assert.equal(second.scanned, 25);
    assert.equal(second.updated, 0, '幂等：第二遍一行都不该写');
    app.close();
  });

  it('指纹写进 app_meta，之后不 force 就直接跳过', () => {
    const { app, repos } = freshDb();
    seed(app, repos, {
      title: 'x',
      bodyJson: JSON.stringify({ type: 'doc', content: [] }),
      bodyText: '',
    });

    const first = backfillBodyText(app.db);
    assert.equal(first.ran, true);
    const stored = app.db
      .prepare<{ value: string }>('SELECT value FROM app_meta WHERE key = :k')
      .get({ k: BODY_TEXT_PROJECTION_KEY })?.value;
    assert.equal(stored, projectionFingerprint());

    const second = backfillBodyText(app.db);
    assert.equal(second.ran, false);
    assert.equal(second.scanned, 0);

    /*
     * 指纹变了就必须重跑 —— 这一条守的是「投影器以后又改了，而存量数据留在旧格式」，
     * 也就是本文件要消灭的那个 bug 的下一次复发。
     */
    app.db
      .prepare('UPDATE app_meta SET value = :v WHERE key = :k')
      .run({ k: BODY_TEXT_PROJECTION_KEY, v: 'p1:0000000000000000' });
    assert.equal(backfillBodyText(app.db).ran, true);
    app.close();
  });
});

describe('指纹样本不许退化', () => {
  /*
   * 指纹 = 投影器对 `PROJECTION_CANARY` 的输出。样本没覆盖到的分支，
   * 改了也不会触发存量回填 —— 所以这里要求样本**真的把每一类行为都走一遍**。
   * 加新分支时这条会提醒你把样本也补上。
   */
  it('样本产出里，投影器的每一类行为都留下了痕迹', () => {
    const text = projectionCanaryText();
    assert.ok(text.length > 0, '样本不能投影成空串 —— 那样指纹就永远不变了');
    assert.ok(text.includes('甲乙'), 'text 节点');
    assert.ok(text.includes('[0:04]'), '★ 由 attrs 算出可见文字的 atom node（时间锚点，#87）');
    assert.ok(text.includes('ALT'), 'attrs.alt');
    assert.ok(text.includes('TITLE'), 'attrs.title');
    assert.ok(text.includes('@某人'), 'attrs.label');
    assert.ok(text.includes('tail'), 'hardBreak 之后的文字');
    assert.ok(text.includes('\n'), '块级节点之间补了换行');
  });

  it('指纹稳定且带前缀（同一份代码算两次必须相同）', () => {
    const a = projectionFingerprint();
    assert.equal(a, projectionFingerprint());
    assert.match(a, /^p1:[0-9a-f]{16}$/);
  });
});
