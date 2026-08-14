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
import type { SearchModeReport } from '@openmemo/shared';

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
 * ⚠️ **两条路的转义方式完全不同，混用会静默搜不到东西**（T-028 实测踩到）：
 *
 * | 分词器 | 传什么 | 为什么 |
 * |---|---|---|
 * | `simple`（libsimple） | **原始查询串** | `simple_query()` **自己做转义**。实测 `simple_query('Africa')` → `( a+f+r+i+c+a* OR africa* )`；它还会把 `a OR b` 里的 `OR` 中性化成普通词。再自己加一层引号 → `simple_query('"Africa"')` → `"""" AND (...) AND """"`，那两个空字符串短语**永远匹配不到任何东西**。 |
 * | `trigram`（降级） | **自己加引号** | 没有 `simple_query()` 可用，必须自己把 FTS5 元字符（`"` `*` `NEAR` `AND/OR/NOT` `:` `-` `^`）中性化。 |
 *
 * 这个 bug 不会让任何构建或类型检查变红 —— 只会让搜索**永远返回 0 条**。
 */
export function toFtsQuery(raw: string, tokenizer: 'simple' | 'trigram'): string | undefined {
  // 控制字符一律替换成空格，长度设上限，防止超长查询把 FTS5 拖垮
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- 刻意匹配控制字符，防止它们进 FTS5 查询
    .replace(/[\u0000-\u001F]/g, ' ')
    .trim()
    .slice(0, 200);
  if (cleaned.length === 0) return undefined;

  // libsimple 路：原样交给 simple_query()，它负责转义与分词
  if (tokenizer === 'simple') return cleaned;

  // trigram 降级路：自己把每个词包成短语，元字符失去特殊含义
  const terms = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 16);
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
      const tokenizer = deps.hasChineseTokenizer ? 'simple' : 'trigram';
      const ftsQuery = toFtsQuery(q, tokenizer);
      if (!ftsQuery) {
        sendJson(res, 200, { query: q, hits: [], modes: modeReport(deps) });
        return Promise.resolve(true);
      }

      // libsimple 可用时走 simple_query()（支持中文分词与拼音）；
      // 降级时直接用已自行转义的查询串。
      const matchExpr = tokenizer === 'simple' ? 'simple_query(:q)' : ':q';

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

/**
 * 如实报告哪几路检索可用 —— UI 据此灰掉不可用的开关（D-02 §4.5）。
 *
 * ★ T-200 A-2：返回类型从 `Record<string, unknown>` 收成 `SearchModeReport`。
 * 松类型正是这次分叉能存在的原因：发 `chineseTokenizer`（boolean）而契约写的是
 * `tokenizer`（`'simple'|'trigram'`），**编译器一个字都不会说**。
 * 收紧之后，键名再漂就是编译错误，而不是"上线半年没人发现"。
 */
function modeReport(deps: SearchRoutesDeps): SearchModeReport {
  return {
    keyword: true,
    /*
     * ★ 发 `tokenizer` 而不是 `chineseTokenizer`：后者只说"加载了没有"，
     * 前者多说一句**降级成了什么** —— 而用户要知道的正是这个
     *（trigram 下中文双字词可能搜不到）。与查询执行那一侧用的是**同一个值**。
     */
    tokenizer: deps.hasChineseTokenizer ? ('simple' as const) : ('trigram' as const),
    // 向量路：扩展在也没用，因为没有任何地方生成 embedding
    semantic: false,
    /*
     * ★★ #112 第 11 处：**这一格发的是判别式联合，不是一句中文**。
     *
     * 上一版这里是两句中文散文（`sqlite-vec 未加载`），而搜索页把它插进
     * `search.modesUnavailable`（**一句英文**）的 `{{reason}}` 里，
     * 英文界面上逐字渲染成：
     *   `Semantic search is unavailable: sqlite-vec 未加载`
     * 它符合「CJK 只出现在数据里」的表面判据（`en.json` 里一个汉字都没有），
     * **但对英文用户就是半句中文**。措辞现在归 `apps/web` 的两份 locale；
     * daemon 只说**是哪一格**（判据见 `SemanticUnavailableReason` 的契约注释：
     * 装上了只差链路 ⇒ 用户做什么都没用；没装上 ⇒ 那是一个环境问题）。
     */
    semanticReason: deps.hasVectorIndex
      ? { kind: 'no_embedding_stage' as const }
      : { kind: 'vector_extension_not_loaded' as const },
    hybrid: false,
  };
}
