/**
 * 「契约里的字面量联合」与「建表语句的 CHECK 约束」必须**双向一致**（T-151 ②）。
 *
 * ## 为什么需要这条守卫
 *
 * `[实测]` T-151 开工时，`packages/shared` 的两个联合是这样的：
 *
 * ```
 * NOTE_KINDS    = ['media', 'text', 'recording']
 * NOTE_STATUSES = ['draft', 'importing', 'transcribing', 'structuring', 'ready', 'failed']
 * ```
 *
 * 而 `0001_init.sql` 写的是：
 *
 * ```sql
 * kind   CHECK (kind   IN ('media','recording','plain'))
 * status CHECK (status IN ('draft','processing','ready','partial','failed'))
 * ```
 *
 * 也就是说契约里承诺的 `'text'` / `'importing'` / `'transcribing'` / `'structuring'`
 * **一行都不可能存在** —— 写进去 SQLite 当场拒；而真实存在的 `'plain'` / `'processing'` /
 * `'partial'` 契约里一个都没有。**它能错这么久的唯一原因是没有任何人 import 过它**：
 * 一份没人用的契约不会被任何东西证伪，它只在有人第一次相信它的那天出事。
 *
 * T-151 ② 让 daemon 与 web **都开始用**这份契约（`rest/notes.ts` 的响应对象直接标注成
 * `NoteDetail` / `NoteListItem`），于是这两个联合从"没人看的文档"变成了**产品行为**：
 *   - 联合里少一个 DB 允许的值 → `narrowColumn` 在那种行上**抛异常 → 笔记详情 500**；
 *   - 联合里多一个 DB 不允许的值 → 消费方按它写的分支**永远走不到**（静默的死代码）。
 *
 * ## 判据钉的是行为，不是字符串
 *
 * 「契约 ⊆ DB」这一半用**真的 INSERT** 验：每个契约值都必须真能写进去。
 * （光比字符串的话，CHECK 写在触发器里、或者被后续 migration 改掉，都看不出来。）
 * 「DB ⊆ 契约」这一半必须读 schema —— 只有它能回答"还有哪些值是我不知道的"，
 * 而那正是会让线上 500 的方向。两半缺一不可。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  MEDIA_ASSET_ROLES,
  MEDIA_ASSET_STATES,
  NOTE_KINDS,
  NOTE_STATUSES,
} from '@openmemo/shared';

import { openAppDatabase, type AppDatabase } from './open.js';

const ROOT = mkdtempSync(join(tmpdir(), 'om-schema-'));
const opened: AppDatabase[] = [];
after(() => {
  for (const h of opened) h.close();
  rmSync(ROOT, { recursive: true, force: true });
});

let n = 0;
function fresh(): AppDatabase {
  const h = openAppDatabase({ filename: join(ROOT, `s${n++}.db`) });
  opened.push(h);
  return h;
}

/**
 * 从**活着的库**里把某一列 CHECK 约束允许的取值抠出来。
 *
 * 读 `sqlite_master.sql`（SQLite 保存的建表语句原文）而不是读磁盘上的 .sql 文件：
 * 前者是这个库**真正生效**的那份 schema，后续 migration 重建过表也照样准；
 * 后者只是"我们以为会被跑的那个文件"。
 */
function checkValues(h: AppDatabase, table: string, column: string): string[] {
  const row = h.db
    .prepare<{ sql: string | null }>(`SELECT sql FROM sqlite_master WHERE type='table' AND name=:t`)
    .get({ t: table });
  assert.ok(row?.sql, `sqlite_master 里没有表 ${table}`);
  // CHECK (<column> IN ('a','b',...))  —— 允许中间换行（建表语句里确实是折行的）
  const m = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(row.sql);
  assert.ok(m, `表 ${table} 的列 ${column} 上没有找到 CHECK (... IN (...)) 约束`);
  return [...(m[1] as string).matchAll(/'([^']*)'/g)].map((x) => x[1] as string);
}

describe('契约字面量联合 ↔ 建表 CHECK 约束（双向）', () => {
  it('★ notes.kind：契约里的每个值都必须真的写得进去', () => {
    const h = fresh();
    for (const kind of NOTE_KINDS) {
      h.db
        .prepare(
          `INSERT INTO notes(uid,kind,title,status,created_at,updated_at)
           VALUES (:u,:k,'t','draft',1,1)`,
        )
        .run({ u: `K-${kind}`, k: kind });
    }
    const got = h.db
      .prepare<{ kind: string }>('SELECT kind FROM notes ORDER BY id')
      .all()
      .map((r) => r.kind);
    assert.deepEqual(got, [...NOTE_KINDS]);
  });

  it('★ notes.kind：DB 允许的每个值都必须在契约里（少一个 = 那种笔记的详情页 500）', () => {
    assert.deepEqual(checkValues(fresh(), 'notes', 'kind').sort(), [...NOTE_KINDS].sort());
  });

  it('★ notes.status：契约里的每个值都必须真的写得进去', () => {
    const h = fresh();
    for (const status of NOTE_STATUSES) {
      h.db
        .prepare(
          `INSERT INTO notes(uid,kind,title,status,created_at,updated_at)
           VALUES (:u,'media','t',:s,1,1)`,
        )
        .run({ u: `S-${status}`, s: status });
    }
    const got = h.db
      .prepare<{ status: string }>('SELECT status FROM notes ORDER BY id')
      .all()
      .map((r) => r.status);
    assert.deepEqual(got, [...NOTE_STATUSES]);
  });

  it('★ notes.status：DB 允许的每个值都必须在契约里', () => {
    assert.deepEqual(checkValues(fresh(), 'notes', 'status').sort(), [...NOTE_STATUSES].sort());
  });

  it('★ media_assets.state / role：两个方向都对得上', () => {
    const h = fresh();
    assert.deepEqual(
      checkValues(h, 'media_assets', 'state').sort(),
      [...MEDIA_ASSET_STATES].sort(),
    );
    assert.deepEqual(checkValues(h, 'media_assets', 'role').sort(), [...MEDIA_ASSET_ROLES].sort());
  });

  it('对照：CHECK 约束真的在生效（否则上面那几条"写得进去"证明不了任何事）', () => {
    /*
     * 这一条是给上面那三条"契约值都写得进去"做对照的。
     * 少了它，CHECK 被谁顺手删掉之后，那几条照样全绿 ——
     * 「写得进去」就退化成了「这个库什么都收」，一条通过理由完全不对的绿灯。
     */
    const h = fresh();
    assert.throws(
      () =>
        h.db
          .prepare(
            `INSERT INTO notes(uid,kind,title,status,created_at,updated_at)
             VALUES ('BAD','媒体','t','draft',1,1)`,
          )
          .run({}),
      /CHECK|constraint/i,
      'notes.kind 的 CHECK 约束没有生效',
    );
    assert.throws(
      () =>
        h.db
          .prepare(
            `INSERT INTO notes(uid,kind,title,status,created_at,updated_at)
             VALUES ('BAD2','media','t','transcribing',1,1)`,
          )
          .run({}),
      /CHECK|constraint/i,
      // 'transcribing' 正是订正前 shared 里那个不存在的状态 —— 用它做反例最贴切
      'notes.status 的 CHECK 约束没有生效',
    );
  });
});
