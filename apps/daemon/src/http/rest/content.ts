/**
 * 笔记正文编辑 / 思维导图 / 导出（F4 + F5）。
 *
 * 补的是 T-028 自查出来的三个洞：
 *   - **笔记正文根本写不进去**（无 PATCH，`body_json`/`body_text` 永远为空）
 *   - **F4 从 UI 到不了**（`packages/mindmap` 跑通了但没有 job runner 与端点）
 *   - **笔记导出没有端点**
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  toFreeMind,
  toMarkdown,
  toOpml,
  type MindMapDoc,
} from '@openmemo/mindmap';
import { makeEvent, topics, type NoteUpdatedEvent } from '@openmemo/shared';

type NoteChange = NoteUpdatedEvent['changed'][number];

import type { DatabaseHandle } from '@openmemo/db';

import type { MindMapRepo } from '../../db/mindmapRepo.js';
import { updateNoteContent, type NoteContentPatch } from '../../db/noteContentRepo.js';
import { extractPlainText } from '../../db/richText.js';
import type { Repos, SegmentRow } from '../../db/repos.js';
import type { JobQueue } from '../../jobs/queue.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';
import type { SseHub } from '../sse.js';

export interface ContentRoutesDeps {
  readonly db: DatabaseHandle;
  readonly repos: Repos;
  readonly mindmaps: MindMapRepo;
  readonly queue: JobQueue;
  readonly sse: SseHub;
}

const NOTE_RE = /^\/api\/notes\/([0-9A-HJKMNP-TV-Z]{26})\/(mindmap|export)$/;
const NOTE_ROOT_RE = /^\/api\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

interface PatchBody {
  title?: unknown;
  bodyJson?: unknown;
  bodyText?: unknown;
  summaryMd?: unknown;
  language?: unknown;
}

export function createContentRoutes(deps: ContentRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  const { repos, mindmaps, queue, sse } = deps;

  return {
    async handle(req, res, url, method): Promise<boolean> {
      // ---- PATCH /api/notes/:uid —— 笔记正文写入（TipTap 的落点）----
      const rootMatch = NOTE_ROOT_RE.exec(url.pathname);
      if (rootMatch && method === 'PATCH') {
        const note = repos.noteByUid(rootMatch[1] as string);
        if (!note) {
          sendError(res, 404, 'NOTE_NOT_FOUND', 'no such note', '笔记不存在');
          return true;
        }
        const body = (await readJsonBody(req)) as PatchBody | undefined;
        if (!body || typeof body !== 'object') {
          sendError(res, 400, 'BAD_REQUEST', 'body required', '请求体不能为空');
          return true;
        }

        const patch: NoteContentPatch = {};
        if (body.title !== undefined) {
          if (typeof body.title !== 'string') {
            sendError(res, 400, 'BAD_TITLE', 'title must be a string', '标题必须是字符串');
            return true;
          }
          patch.title = body.title.slice(0, 500);
        }
        if (body.bodyJson !== undefined) {
          // TipTap 文档是任意 JSON；这里只保证可序列化，不校验其内部结构
          try {
            patch.bodyJson = body.bodyJson === null ? null : JSON.stringify(body.bodyJson);
          } catch {
            sendError(res, 400, 'BAD_BODY_JSON', 'bodyJson not serializable', '正文 JSON 无法序列化');
            return true;
          }
          /*
           * **权威规则：有 `bodyJson` 时，`body_text` 一律由服务端推导。**
           *
           * body_text 是 body_json 的纯文本投影，专供 FTS5（D-02 §1.3）。以前它由
           * 前端一起传上来，两个字段就可能漂移 —— 而漂移不报错，只是搜索悄悄给出
           * 过时结果。让唯一事实来源（body_json）自己推出投影，这类 bug 在结构上消失。
           *
           * 客户端仍可以传 `bodyText`：那被降级成一个可选的优化提示，此处直接被
           * 推导值覆盖，**但不报错**（老客户端照常工作，不需要同步发版）。
           *
           * 提取器刻意做得很浅（只递归收 text 节点，见 db/richText.ts）：服务端不该
           * 为了建索引就把整个 TipTap 运行时搬进 daemon。少收一点装饰性字符可以接受，
           * 因为多引一坨前端 schema 依赖不可接受。
           */
          patch.bodyText = extractPlainText(body.bodyJson);
        }
        if (body.bodyText !== undefined) {
          if (typeof body.bodyText !== 'string') {
            sendError(res, 400, 'BAD_BODY_TEXT', 'bodyText must be a string', '正文纯文本必须是字符串');
            return true;
          }
          // 只有在没有 bodyJson 可推导时，才采信客户端给的投影（见上方权威规则）
          if (body.bodyJson === undefined) patch.bodyText = body.bodyText;
        }
        if (body.summaryMd !== undefined) {
          patch.summaryMd = body.summaryMd === null ? null : String(body.summaryMd);
        }
        if (body.language !== undefined) {
          patch.language = body.language === null ? null : String(body.language);
        }

        const changed = updateNoteContent(deps.db, note.id, patch) as NoteChange[];
        const updated = repos.noteById(note.id);
        sse.publish(
          makeEvent('note.updated', topics.note(note.uid), {
            noteUid: note.uid,
            changed,
          }),
        );
        sendJson(res, 200, {
          uid: note.uid,
          title: updated?.title,
          status: updated?.status,
          hasBody: !!updated?.body_text,
        });
        return true;
      }

      const m = NOTE_RE.exec(url.pathname);
      if (!m) return false;
      const note = repos.noteByUid(m[1] as string);
      if (!note) {
        sendError(res, 404, 'NOTE_NOT_FOUND', 'no such note', '笔记不存在');
        return true;
      }
      const kind = m[2];

      // ---- F4：生成思维导图（异步，返回 jobUid）----
      if (kind === 'mindmap' && method === 'POST') {
        const job = queue.enqueue({
          type: 'mindmap',
          lane: 'gpu.llm',
          priority: 0, // 用户主动点的，属交互式
          noteId: note.id,
          payload: { noteId: note.id },
        });
        /*
         * ⚠️ **刻意不发 `job.created`**：契约里它要求一个完整的 `DownloadJob`
         * （kind: 'model'|'backend-pack'、totalBytes、parts、fileIndex…），
         * 那是为**下载**建模的，转写/导图这类流水线 job 填不进去。
         * 前端从本响应的 202 body 拿 jobUid，后续状态走 job.state / job.progress。
         * 已报 Manager：shared 需要补流水线 job 的表示。
         */
        sendJson(res, 202, { jobUid: job.uid, noteUid: note.uid });
        return true;
      }

      // ---- 读取思维导图 ----
      if (kind === 'mindmap' && method === 'GET') {
        const row = mindmaps.latestOfNote(note.id);
        if (!row) {
          sendJson(res, 200, { mindmap: null });
          return true;
        }
        const doc = mindmaps.loadDoc(row);
        sendJson(res, 200, {
          mindmap: {
            uid: row.uid,
            title: row.title,
            revision: row.revision,
            generatedBy: row.generated_by,
            nodeCount: doc ? Object.keys(doc.nodes).length : 0,
          },
          doc: doc ?? null,
        });
        return true;
      }

      // ---- 导出 ----
      if (kind === 'export' && method === 'GET') {
        const format = (url.searchParams.get('format') ?? 'md').toLowerCase();
        const what = (url.searchParams.get('what') ?? 'note').toLowerCase();

        if (what === 'mindmap') {
          const row = mindmaps.latestOfNote(note.id);
          const doc = row ? mindmaps.loadDoc(row) : undefined;
          if (!doc) {
            sendError(res, 404, 'NO_MINDMAP', 'no mindmap for this note', '这条笔记还没有思维导图');
            return true;
          }
          const out = exportMindmap(doc, format);
          if (!out) {
            sendError(res, 400, 'BAD_FORMAT', `unsupported: ${format}`, `不支持的导出格式：${format}`);
            return true;
          }
          sendDownload(res, out.body, out.mime, `${safeName(note.title)}.${out.ext}`);
          return true;
        }

        const tr = repos.activeTranscriptOfNote(note.id);
        const segments = tr ? repos.segmentsOf(tr.id) : [];
        const out = exportNote(note.title, note.summary_md, segments, format);
        if (!out) {
          sendError(res, 400, 'BAD_FORMAT', `unsupported: ${format}`, `不支持的导出格式：${format}`);
          return true;
        }
        sendDownload(res, out.body, out.mime, `${safeName(note.title)}.${out.ext}`);
        return true;
      }

      return false;
    },
  };
}

interface Exported {
  body: string;
  mime: string;
  ext: string;
}

function exportMindmap(doc: MindMapDoc, format: string): Exported | undefined {
  switch (format) {
    case 'md':
    case 'markdown':
      return { body: toMarkdown(doc, { includeTimestamps: true }), mime: 'text/markdown; charset=utf-8', ext: 'md' };
    case 'opml':
      return { body: toOpml(doc), mime: 'text/x-opml; charset=utf-8', ext: 'opml' };
    case 'mm':
    case 'freemind':
      return { body: toFreeMind(doc), mime: 'application/x-freemind; charset=utf-8', ext: 'mm' };
    case 'json':
      return { body: JSON.stringify(doc, null, 2), mime: 'application/json; charset=utf-8', ext: 'json' };
    default:
      return undefined;
  }
}

function exportNote(
  title: string,
  summaryMd: string | null,
  segments: readonly SegmentRow[],
  format: string,
): Exported | undefined {
  switch (format) {
    case 'md':
    case 'markdown': {
      const lines = [`# ${title}`, ''];
      if (summaryMd) lines.push(summaryMd, '');
      if (segments.length) {
        lines.push('## 转写稿', '');
        for (const s of segments) lines.push(`**[${msToClock(s.start_ms)}]** ${s.text.trim()}`, '');
      }
      return { body: lines.join('\n'), mime: 'text/markdown; charset=utf-8', ext: 'md' };
    }
    case 'txt':
      return {
        body: segments.map((s) => s.text.trim()).join('\n'),
        mime: 'text/plain; charset=utf-8',
        ext: 'txt',
      };
    case 'srt':
      return { body: toSrt(segments), mime: 'application/x-subrip; charset=utf-8', ext: 'srt' };
    case 'vtt':
      return { body: toVtt(segments), mime: 'text/vtt; charset=utf-8', ext: 'vtt' };
    case 'json':
      return {
        body: JSON.stringify(
          { title, summaryMd, segments: segments.map((s) => ({ seq: s.seq, startMs: s.start_ms, endMs: s.end_ms, text: s.text })) },
          null,
          2,
        ),
        mime: 'application/json; charset=utf-8',
        ext: 'json',
      };
    default:
      return undefined;
  }
}

/** 毫秒整数 → `HH:MM:SS,mmm`。**无浮点误差**，这是 D-02 §1.1 选整数毫秒的直接收益。 */
export function msToSrtTime(ms: number): string {
  // 非有限值/负数一律夹到 0：一条 NaN 时间轴会让整个 .srt 在播放器里失效，
  // 而在我们自己的 UI 里完全看不出来（架构侧同一处 bug 已由 export.test.ts 逮到过）。
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`;
}

export function msToClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/**
 * 字幕正文清洗。
 *
 * SRT/VTT 用**空行分隔条目**，所以正文里的空行会把一条字幕劈成两条，
 * 其后所有条目的时间轴全部错位 —— 而这在我们自己的界面上完全看不出来。
 * VTT 还要处理 `-->`：它是时间轴行的标记，出现在正文里会让解析器误判。
 */
export function sanitizeCue(text: string, format: 'srt' | 'vtt'): string {
  let out = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (format === 'vtt') out = out.replace(/-->/g, '→');
  return out;
}

export function toSrt(segments: readonly SegmentRow[]): string {
  // 空正文的条目要跳过：一条没有正文的 SRT 条目会让部分解析器直接放弃整个文件。
  // 跳过后序号仍必须从 1 连续 —— 跳号同样会让某些播放器停在跳号处。
  return segments
    .map((s) => ({ ...s, body: sanitizeCue(s.text, 'srt') }))
    .filter((s) => s.body.length > 0)
    .map(
      (s, i) =>
        `${i + 1}\n${msToSrtTime(s.start_ms)} --> ${msToSrtTime(s.end_ms)}\n${s.body}\n`,
    )
    .join('\n');
}

export function toVtt(segments: readonly SegmentRow[]): string {
  const body = segments
    .map((s) => ({ ...s, body: sanitizeCue(s.text, 'vtt') }))
    .filter((s) => s.body.length > 0)
    .map(
      (s) =>
        `${msToSrtTime(s.start_ms).replace(',', '.')} --> ${msToSrtTime(s.end_ms).replace(',', '.')}\n${s.body}\n`,
    )
    .join('\n');
  // WEBVTT 头之后必须有空行，否则首条 cue 会被吞掉
  return `WEBVTT\n\n${body}`;
}

/**
 * 文件名净化。**这个值会进 `Content-Disposition` 头**，
 * 不清理就能注入换行伪造响应头，也可能带路径分隔符。
 */
export function safeName(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex -- 控制字符能伪造响应头，必须剔除
    .replace(/[\u0000-\u001F]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 80);
  return cleaned || 'openmemo-note';
}

function sendDownload(res: ServerResponse, body: string, mime: string, filename: string): void {
  const buf = Buffer.from(body, 'utf8');
  /*
   * ⚠️ `Content-Disposition` 的 `filename=` 部分**必须是纯 ASCII** ——
   * 直接塞中文会让 Node 抛 `Invalid character in header content` 并 500。
   * 正确做法（RFC 6266 / 5987）：
   *   filename=  给一个 ASCII 回退名（老浏览器用）
   *   filename*= 给 UTF-8 百分号编码的真名（现代浏览器优先用这个）
   */
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(buf.length),
    'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}
