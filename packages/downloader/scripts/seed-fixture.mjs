#!/usr/bin/env node
/**
 * Seed a realistic note + transcript fixture into the daemon's database.
 *
 * WHY: T-038 must exercise features that only exist once a note HAS a transcript —
 * segment editing, tags, star, export (SRT/VTT), search hit → timestamp, anchors,
 * mindmap. This machine has no whisper-cli/ASR model installed (the daemon says so on
 * startup: "流水线缺少工具: whisper-cli, asr-model"), so a real transcription cannot
 * produce that state here.
 *
 * This is TEST FIXTURE DATA ONLY. It writes rows the pipeline would normally write; it
 * does not modify any product code. The Chinese text is chosen to exercise the exact
 * two-character words `gpu-runtime` found returning 0 hits under the trigram fallback
 * (用户 / 推特 / 中国 / 服务), so the search check has something real to match.
 *
 * Usage: node packages/downloader/scripts/seed-fixture.mjs [--db <path>] [--reset]
 */

import console from 'node:console';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire('/root/memo/packages/db/');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const DB =
  argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : '/root/.local/share/openmemo/openmemo.db';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(t = Date.now()) {
  let out = '';
  for (let i = 9; i >= 0; i--) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) out += ENCODING[Math.floor(Math.random() * 32)];
  return out;
}

const db = new Database(DB);
db.pragma('foreign_keys = ON');
const now = Date.now();

if (argv.includes('--reset')) {
  db.exec("DELETE FROM notes WHERE title LIKE 'T-038%'");
  console.log('reset: removed prior T-038 fixtures');
}

/** Segments deliberately containing 用户 / 推特 / 中国 / 服务 for the search check. */
const SEGMENTS = [
  [0, 0, 4200, '大家好，今天我们来聊一聊人工智能在中国的发展现状。'],
  [1, 4200, 9800, '首先要谈的是用户增长，过去一年的用户数量翻了一倍还多。'],
  [2, 9800, 15600, '我在推特上看到很多讨论，海外用户对这个话题也很关注。'],
  [3, 15600, 21400, '第二个方面是服务质量，很多公司把服务做成了差异化的核心。'],
  [4, 21400, 27000, '维基百科上有一篇很详细的条目，建议大家去读一读。'],
  [5, 27000, 33800, '华尔街日报也做过报道，提到谷歌和微软都在加大投入。'],
  [6, 33800, 39200, '最后我想说，用户体验永远是第一位的，服务跟不上就留不住人。'],
];

const noteUid = ulid(now);
const trUid = ulid(now + 1);
const assetUid = ulid(now + 2);

const insertNote = db.prepare(`
  INSERT INTO notes (uid, kind, title, body_json, body_text, status, language, starred,
                     duration_ms, created_at, updated_at)
  VALUES (?, 'media', ?, ?, ?, 'ready', 'zh', 0, ?, ?, ?)`);

const bodyJson = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '这是一条 T-038 测试笔记的正文。' }] },
  ],
});

const noteId = insertNote.run(
  noteUid,
  'T-038 中文转写测试笔记',
  bodyJson,
  '这是一条 T-038 测试笔记的正文。',
  SEGMENTS.at(-1)[2],
  now,
  now,
).lastInsertRowid;

// Media asset so the player and /media Range path have something addressable.
let assetId = null;
try {
  assetId = db
    .prepare(
      `INSERT INTO media_assets (uid, note_id, role, rel_path, display_name, mime, bytes,
                                 duration_ms, state, created_at)
       VALUES (?, ?, 'audio16k', ?, ?, 'audio/wav', 640000, ?, 'ready', ?)`,
    )
    .run(assetUid, noteId, `t038/${assetUid}.wav`, 'fixture.wav', SEGMENTS.at(-1)[2], now)
    .lastInsertRowid;
} catch (e) {
  console.log('  (media_assets insert skipped: ' + String(e.message).slice(0, 80) + ')');
}

const trId = db
  .prepare(
    `INSERT INTO transcripts (uid, note_id, asset_id, kind, is_active, engine_id, model_id,
                              backend, language, status, progress, duration_ms, rtf,
                              segment_count, created_at, updated_at)
     VALUES (?, ?, ?, 'final', 1, 'whisper.cpp', 'asr/whisper-large-v3-turbo-q5_0',
             'cpu', 'zh', 'done', 1.0, ?, 0.377, ?, ?, ?)`,
  )
  .run(trUid, noteId, assetId, SEGMENTS.at(-1)[2], SEGMENTS.length, now, now).lastInsertRowid;

const insSeg = db.prepare(
  `INSERT INTO transcript_segments (transcript_id, seq, start_ms, end_ms, text, confidence,
                                    chunk_idx, flags)
   VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
);
for (const [seq, s, e, text] of SEGMENTS) insSeg.run(trId, seq, s, e, text, 0.95);

// Keep FTS in sync — these are external-content tables, so a plain INSERT does not
// populate them. If the daemon uses triggers this is a no-op; if not, search would
// silently return nothing and we would misreport it as a search bug.
let ftsNote;
try {
  db.exec(
    `INSERT INTO segments_fts(segments_fts) VALUES('rebuild');
     INSERT INTO notes_fts(notes_fts) VALUES('rebuild');`,
  );
  ftsNote = 'rebuilt';
} catch (e) {
  ftsNote = 'rebuild failed: ' + String(e.message).slice(0, 60);
}

const counts = {
  notes: db.prepare('SELECT COUNT(*) c FROM notes').get().c,
  transcripts: db.prepare('SELECT COUNT(*) c FROM transcripts').get().c,
  segments: db.prepare('SELECT COUNT(*) c FROM transcript_segments').get().c,
};
db.close();

console.log('seeded T-038 fixture');
console.log('  noteUid       :', noteUid);
console.log('  transcriptUid :', trUid);
console.log('  segments      :', SEGMENTS.length);
console.log('  fts           :', ftsNote);
console.log('  totals        :', JSON.stringify(counts));
