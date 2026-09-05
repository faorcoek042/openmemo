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
  /** **已转义的 HTML 片段**，命中处包在 `<mark>` 里。见 `toMarkedHtml()`。 */
  snippet: string;
  score: number;
  source: 'segment' | 'note';
}

/* ------------------------------ 命中摘要 ------------------------------ */

/**
 * FTS5 `snippet()` 的开合标记。**刻意不是 `<mark>` / `</mark>`。**
 *
 * `snippet()` 把标记**原样插进列的原文里**，它不做任何 HTML 转义。直接传
 * `'<mark>'` 就等于把「用户写的正文 + 我们插的标签」拼成一段 HTML 交给前端 ——
 * 而前端 `SearchPage.tsx` 正是用 `dangerouslySetInnerHTML` 渲染这一格。
 * 于是一条标题叫 `<img src=x onerror=…>` 的笔记会在搜索结果页上执行。
 *
 * 所以走两步：先让 SQLite 插两个**不可能有含义的控制字符**，
 * 再在 JS 里 **先整体转义、后把这两个字符换成 `<mark>`**（`toMarkedHtml()`）。
 * 顺序反过来就白做了。
 *
 * ⚠️ 这两个字符不会从用户的查询串里溜进来：`toFtsQuery()` 第一步就把
 * `U+0000`–`U+001F` 全替换成空格。它们只可能来自**笔记正文本身**，
 * 那种情况由 `toMarkedHtml()` 末尾的"清掉落单标记"兜住 —— 最坏结果是少画一处高亮，
 * 不会变成标签。
 */
const MARK_OPEN = '\u0002';
const MARK_CLOSE = '\u0003';
const ELLIPSIS = '…';

/**
 * 摘要窗口（token 数）。FTS5 的上限是 64。
 *
 * 取 32 而不是文档示例里的 12：`simple` 分词器下**一个汉字就是一个 token**，
 * 12 个 token 的中文摘要只有 12 个字，看不出上下文。
 * `[实测]` 用户库里 275 条转写段落平均 64 字符、最长 108，32 token 足够覆盖整段。
 */
const SNIPPET_TOKENS = 32;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `snippet()` 的产出 → 可以安全塞进 innerHTML 的片段。
 *
 * **必须先转义再替换标记**：反过来的话转义会把我们自己刚插进去的 `<mark>` 也吃掉。
 * 成对匹配（而不是分别 replace 两个字符）是为了让**正文里原本就有**的
 * `U+0002` / `U+0003` 无法造出一个落单的标签，最后再把没配上对的清掉。
 */
function toMarkedHtml(raw: string | null | undefined): string {
  if (!raw) return '';
  return (
    escapeHtml(raw)
      // eslint-disable-next-line no-control-regex -- 刻意匹配 snippet() 插进来的哨兵标记
      .replace(/\u0002([^\u0002\u0003]*)\u0003/g, '<mark>$1</mark>')
      // eslint-disable-next-line no-control-regex -- 同上：清掉正文里自带的、没配上对的哨兵
      .replace(/[\u0002\u0003]/g, '')
  );
}

/**
 * 笔记命中要显示哪一段。
 *
 * ## 这一格原来是 `r.title || r.body_text.slice(0, 120)`
 *
 * `notes.title` 有 `NOT NULL DEFAULT ''`，但真实笔记的标题几乎从不为空
 * （导入/录音都会填文件名）⇒ **短路的左边永远为真** ⇒ 摘要恒等于标题。
 * `[浏览器实测]` 搜 `0:39` 命中之后，卡片上是「audit-long.wav / audit-long.wav」：
 * **标题重复两遍，而真正匹配到的 `[0:39]` 一个字都不出现。**
 * 用户搜到了，却拿不到「命中在哪」的任何证据 —— 这直接抵消了让它能被搜到的那次修复。
 *
 * ## 现在的规则
 *
 * 1. **完全不看 `title` 列**（FTS 的第 0 列）。卡片上已经单独渲染了标题
 *    （`SearchPage.tsx` 的 `title={h.noteTitle}`），摘要再抄一遍是纯噪音。
 * 2. 正文（第 1 列）与摘要（第 2 列）各取一段 `snippet()`，
 *    **优先选真的画出了高亮的那一段** —— 命中在摘要里时不该给一段没高亮的正文开头。
 * 3. 两段都没高亮（命中只在标题里）时退回正文开头：
 *    `snippet()` 在该列没有命中时返回的正是"这一列的开头若干 token"，
 *    这恰好就是我们想要的降级 —— **宁可给一段没高亮的上下文，也不要整个丢空**。
 * 4. 正文为空（`body_text = ''`）时 `snippet()` 返回空串，这一格就真的是空的。
 *    那是实话：这条笔记确实没有正文可展示。
 */
function noteSnippet(bodySnippet: string | null, summarySnippet: string | null): string {
  const body = toMarkedHtml(bodySnippet);
  const summary = toMarkedHtml(summarySnippet);
  if (body.includes('<mark>')) return body;
  if (summary.includes('<mark>')) return summary;
  return body || summary;
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

      /*
       * 摘要用 **FTS5 内置的 `snippet()`**，不用 libsimple 的 `simple_snippet()`。
       *
       * 判据是量出来的，不是偏好：`[实测]` 在 `tokenize='simple'` 的表上，两者对
       * `zhong` / `zg` / `zhongguo` / `中国` / `dmx` / `da` **六条查询逐字节相同**
       *（含拼音首字母、拼音前缀这两种最可能分叉的形态）。
       * 既然产出一样，就选**不依赖扩展**的那个：`simple_snippet()` 只在 libsimple
       * 加载成功时存在，用它就等于给降级路径新开一个
       * "no such function: simple_snippet" 的 500 —— 而降级恰恰是这条路最需要活着的时候。
       *（`buildMatchExpression()` 的注释记着同一个坑的上一次发生。）
       */
      const snip = (table: string, col: number): string =>
        `snippet(${table}, ${col}, :markOpen, :markClose, :ellipsis, ${SNIPPET_TOKENS})`;
      const snippetArgs = { markOpen: MARK_OPEN, markClose: MARK_CLOSE, ellipsis: ELLIPSIS };

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
            snip: string | null;
            score: number;
          }>(
            `SELECT n.uid AS note_uid, n.title AS note_title, t.uid AS tr_uid,
                    s.seq, s.start_ms, s.end_ms, s.text,
                    ${snip('segments_fts', 0)} AS snip,
                    bm25(segments_fts) AS score
             FROM segments_fts
             JOIN transcript_segments s ON s.id = segments_fts.rowid
             JOIN transcripts t ON t.id = s.transcript_id
             JOIN notes n ON n.id = t.note_id
             WHERE segments_fts MATCH ${matchExpr} AND n.deleted_at IS NULL
             ORDER BY score LIMIT :limit`,
          )
          .all({ q: ftsQuery, limit, ...snippetArgs });

        for (const r of segRows) {
          hits.push({
            noteUid: r.note_uid,
            noteTitle: r.note_title,
            transcriptUid: r.tr_uid,
            seq: r.seq,
            startMs: r.start_ms,
            endMs: r.end_ms,
            /*
             * 段落这一格原来发的是**整段原文**（`r.text`）。它不算错 —— 段落本来就短
             *（`[实测]` 用户库 275 条平均 64 字符）—— 但它同样看不出"命中在哪个词"。
             * 兜底仍然是整段原文（转义过的）：`snippet()` 理论上不会对一条 MATCH 到的
             * 行返回空，但**如果它返回了，用户该看到原文，而不是一片空白**。
             */
            snippet: toMarkedHtml(r.snip) || escapeHtml(r.text),
            score: r.score,
            source: 'segment',
          });
        }

        // ---- 笔记标题/正文命中 ----
        const noteRows = db
          .prepare<{
            uid: string;
            title: string;
            body_snip: string | null;
            summary_snip: string | null;
            score: number;
          }>(
            // 列序按 `0002_search.sql`：0=title、1=body_text、2=summary_md。**刻意不取第 0 列**，理由见 `noteSnippet()`。
            `SELECT n.uid, n.title,
                    ${snip('notes_fts', 1)} AS body_snip,
                    ${snip('notes_fts', 2)} AS summary_snip,
                    bm25(notes_fts) AS score
             FROM notes_fts
             JOIN notes n ON n.id = notes_fts.rowid
             WHERE notes_fts MATCH ${matchExpr} AND n.deleted_at IS NULL
             ORDER BY score LIMIT :limit`,
          )
          .all({ q: ftsQuery, limit, ...snippetArgs });

        for (const r of noteRows) {
          hits.push({
            noteUid: r.uid,
            noteTitle: r.title,
            transcriptUid: null,
            seq: null,
            startMs: null,
            endMs: null,
            snippet: noteSnippet(r.body_snip, r.summary_snip),
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
