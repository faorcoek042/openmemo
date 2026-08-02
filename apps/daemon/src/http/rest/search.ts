/**
 * F5 全文检索（D-02 §4.1/§4.2）。
 *
 * 三件套里目前接通的是 **FTS5 + libsimple 中文分词**；
 * 向量路见 §4.3，但 **embedding 生成环节当前不存在**（见 inbox 的缺口报告），
 * 所以本文件只实现关键词路，并在响应里**如实告知向量路不可用**，
 * 而不是假装有混合检索。
 *
 * ⚠️ **绝不把用户输入直接拼进 MATCH 字符串**（D-02 §4.2）：
 * FTS5 的 MATCH 有自己的语法（`"` `*` `NEAR` `AND/OR/NOT` `:` `-` `^`），
 * 用户搜 `A OR B` 或一个裸 `-` 都会变成语法错误或非预期语义。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { DatabaseHandle } from '@openmemo/db';

import { sendError, sendJson } from '../respond.js';

export interface SearchRoutesDeps {
  readonly db: DatabaseHandle;
  /** libsimple 是否加载成功 —— 决定用 `simple_query()` 还是朴素查询。 */
  readonly hasChineseTokenizer: boolean;
  readonly hasVectorIndex: boolean;
}

interface Hit {
  noteUid: string;
  noteTitle: string;
  transcriptUid: string | null;
  seq: number | null;
  startMs: number | null;
  endMs: number | null;
  snippet: string;
  score: number;
  source: 'segment' | 'note';
}

/**
 * 把用户输入变成安全的 FTS5 查询串。
 *
 * 策略：按空白切词，每个词用双引号包成**短语**（内部的 `"` 转义成 `""`），
 * 词之间用 AND 连接。这样：
 *   - 用户输入的 FTS5 元字符全部失去特殊含义
 *   - 多词搜索仍是"都要命中"的直觉语义
 */
export function toFtsQuery(raw: string): string | undefined {
  const terms = raw
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 16); // 防止超长查询把 FTS5 拖垮
  if (terms.length === 0) return undefined;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

export function createSearchRoutes(deps: SearchRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  const { db } = deps;

  return {
    handle(_req, res, url, method): Promise<boolean> {
      if (url.pathname !== '/api/search') return Promise.resolve(false);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', '方法不允许');
        return Promise.resolve(true);
      }

      const q = url.searchParams.get('q') ?? '';
      const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 20) || 20);
      const ftsQuery = toFtsQuery(q);
      if (!ftsQuery) {
        sendJson(res, 200, { query: q, hits: [], modes: modeReport(deps) });
        return Promise.resolve(true);
      }

      // libsimple 可用时走 simple_query()（支持中文分词与拼音）；
      // 降级时直接用查询串（trigram 分词器）。
      const matchExpr = deps.hasChineseTokenizer ? 'simple_query(:q)' : ':q';

      const hits: Hit[] = [];
      try {
        // ---- 段落命中（搜索的主战场）----
        const segRows = db
          .prepare<{
            note_uid: string;
            note_title: string;
            tr_uid: string;
            seq: number;
            start_ms: number;
            end_ms: number;
            text: string;
            score: number;
          }>(
            `SELECT n.uid AS note_uid, n.title AS note_title, t.uid AS tr_uid,
                    s.seq, s.start_ms, s.end_ms, s.text, bm25(segments_fts) AS score
             FROM segments_fts
             JOIN transcript_segments s ON s.id = segments_fts.rowid
             JOIN transcripts t ON t.id = s.transcript_id
             JOIN notes n ON n.id = t.note_id
             WHERE segments_fts MATCH ${matchExpr} AND n.deleted_at IS NULL
             ORDER BY score LIMIT :limit`,
          )
          .all({ q: ftsQuery, limit });

        for (const r of segRows) {
          hits.push({
            noteUid: r.note_uid,
            noteTitle: r.note_title,
            transcriptUid: r.tr_uid,
            seq: r.seq,
            startMs: r.start_ms,
            endMs: r.end_ms,
            snippet: r.text,
            score: r.score,
            source: 'segment',
          });
        }

        // ---- 笔记标题/正文命中 ----
        const noteRows = db
          .prepare<{ uid: string; title: string; body_text: string; score: number }>(
            `SELECT n.uid, n.title, n.body_text, bm25(notes_fts) AS score
             FROM notes_fts
             JOIN notes n ON n.id = notes_fts.rowid
             WHERE notes_fts MATCH ${matchExpr} AND n.deleted_at IS NULL
             ORDER BY score LIMIT :limit`,
          )
          .all({ q: ftsQuery, limit });

        for (const r of noteRows) {
          hits.push({
            noteUid: r.uid,
            noteTitle: r.title,
            transcriptUid: null,
            seq: null,
            startMs: null,
            endMs: null,
            snippet: r.title || r.body_text.slice(0, 120),
            score: r.score,
            source: 'note',
          });
        }
      } catch (err) {
        // FTS 表可能因扩展降级而尚未重建 —— 如实报，不假装没结果
        sendError(
          res,
          500,
          'SEARCH_FAILED',
          err instanceof Error ? err.message : String(err),
          '检索失败（索引可能正在重建）',
          { retryable: true },
        );
        return Promise.resolve(true);
      }

      hits.sort((a, b) => a.score - b.score);
      sendJson(res, 200, {
        query: q,
        ftsQuery,
        hits: hits.slice(0, limit),
        modes: modeReport(deps),
      });
      return Promise.resolve(true);
    },
  };
}

/** 如实报告哪几路检索可用 —— UI 据此灰掉不可用的开关（D-02 §4.5）。 */
function modeReport(deps: SearchRoutesDeps): Record<string, unknown> {
  return {
    keyword: true,
    chineseTokenizer: deps.hasChineseTokenizer,
    // 向量路：扩展在也没用，因为没有任何地方生成 embedding
    semantic: false,
    semanticReason: deps.hasVectorIndex
      ? 'sqlite-vec 已加载，但尚无 embedding 生成环节（链路未接通）'
      : 'sqlite-vec 未加载',
    hybrid: false,
  };
}
