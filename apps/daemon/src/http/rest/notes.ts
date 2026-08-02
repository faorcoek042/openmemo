/**
 * 笔记 / 导入 / 转写 的 REST 路由（F1/F2/F5）。
 *
 * ⚠️ **契约缺口（已在 inbox 报 Manager）**：`packages/shared` 的 `ENDPOINTS`
 * 目前只有 models/backends/jobs/runtime 27 条，**没有 notes/import/transcript 契约**。
 * 该文件归 `model-mgmt` 独占，我不能往里加。
 * → 这里的形状是按 D-01 §3.2 的分层原则实现的**临时契约**，
 *   一旦 shared 补上正式类型，本文件应改为 import 它们，而不是各写各的。
 *
 * D-01 §3.2 规则 2：**写操作一律异步化** —— 导入不阻塞 HTTP，
 * 返回 202 + jobUid，进度走 SSE。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';

import type { SseEvent } from '@openmemo/shared';
import { makeEvent, topics } from '@openmemo/shared';

import type { Repos } from '../../db/repos.js';
import type { JobQueue } from '../../jobs/queue.js';
import type { SseHub } from '../sse.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';

export interface NoteRoutesDeps {
  readonly repos: Repos;
  readonly queue: JobQueue;
  readonly sse: SseHub;
  /** 本地导入允许的根目录 —— 路径穿越防护（D-01 §8.5）。 */
  readonly importRoots: readonly string[];
}

interface ImportBody {
  input?: unknown;
  title?: unknown;
  language?: unknown;
  kind?: unknown;
}

export function createNoteRoutes(deps: NoteRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  const { repos, queue, sse } = deps;

  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;

      // ---- POST /api/notes/import ----
      if (p === '/api/notes/import' && method === 'POST') {
        const body = (await readJsonBody(req)) as ImportBody | undefined;
        const input = typeof body?.input === 'string' ? body.input.trim() : '';
        if (!input) {
          sendError(res, 400, 'BAD_REQUEST', 'input is required', '缺少 input（本地路径或 URL）');
          return true;
        }

        // 本地路径必须落在允许的根内；URL 交给 pipeline 的 argGuard 做校验
        const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
        if (!looksLikeUrl) {
          if (!isAbsolute(input)) {
            sendError(res, 400, 'BAD_PATH', 'local path must be absolute', '本地路径必须是绝对路径');
            return true;
          }
          const real = resolve(input);
          const ok = deps.importRoots.some((root) => real === root || real.startsWith(root + '/'));
          if (!ok) {
            sendError(
              res,
              403,
              'PATH_NOT_ALLOWED',
              `path outside allowed roots: ${real}`,
              '该路径不在允许导入的目录内',
              {
                remediation: {
                  action: 'chooseAllowedFolder',
                  params: { roots: deps.importRoots.join(', ') },
                  labelZh: '选择允许的目录',
                  label: 'Choose an allowed folder',
                },
              },
            );
            return true;
          }
        }

        const title =
          typeof body?.title === 'string' && body.title.trim()
            ? body.title.trim()
            : basenameOf(input);
        const language = typeof body?.language === 'string' ? body.language : null;

        const note = repos.createNote({ title, kind: 'media', language });
        repos.createSource({
          noteId: note.id,
          kind: looksLikeUrl ? 'url' : 'local',
          originalUrl: looksLikeUrl ? input : null,
          title,
        });

        const job = queue.enqueue({
          type: 'transcribe',
          lane: 'gpu.asr',
          priority: 10,
          noteId: note.id,
          payload: { noteId: note.id, input, language, sourceKind: looksLikeUrl ? 'url' : 'local' },
        });

        sse.publish(
          makeEvent('note.created', topics.note(note.uid), {
            noteUid: note.uid,
            title: note.title,
            folderUid: null,
          }),
        );
        /*
         * ⚠️ **刻意不发 `job.created`**：契约里它要求一个完整的 `DownloadJob`
         * （kind: 'model'|'backend-pack'、totalBytes、parts、fileIndex…），
         * 那是为**下载**建模的，转写/导图这类流水线 job 填不进去。
         * 前端从本响应的 202 body 拿 jobUid，后续状态走 job.state / job.progress。
         * 已报 Manager：shared 需要补流水线 job 的表示。
         */

        // 202：写操作异步化（D-01 §3.2 规则 2）
        sendJson(res, 202, { noteUid: note.uid, jobUid: job.uid, status: note.status });
        return true;
      }

      // ---- GET /api/notes ----
      if (p === '/api/notes' && method === 'GET') {
        const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50);
        const notes = repos.listNotes(limit).map((n) => ({
          uid: n.uid,
          title: n.title,
          status: n.status,
          kind: n.kind,
          language: n.language,
          durationMs: n.duration_ms,
          createdAt: new Date(n.created_at).toISOString(),
          updatedAt: new Date(n.updated_at).toISOString(),
        }));
        sendJson(res, 200, { notes });
        return true;
      }

      const noteMatch = /^\/api\/notes\/([0-9A-HJKMNP-TV-Z]{26})(\/transcript)?$/.exec(p);
      if (noteMatch) {
        const uid = noteMatch[1] as string;
        const note = repos.noteByUid(uid);
        if (!note) {
          sendError(res, 404, 'NOTE_NOT_FOUND', `no note ${uid}`, '笔记不存在');
          return true;
        }

        // ---- GET /api/notes/:uid/transcript ----
        if (noteMatch[2]) {
          if (method !== 'GET') {
            sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', '方法不允许');
            return true;
          }
          const tr = repos.activeTranscriptOfNote(note.id);
          if (!tr) {
            sendJson(res, 200, { transcript: null, segments: [] });
            return true;
          }
          const segments = repos.segmentsOf(tr.id).map((s) => ({
            seq: s.seq,
            startMs: s.start_ms,
            endMs: s.end_ms,
            text: s.text,
            confidence: s.confidence,
            chunkIdx: s.chunk_idx,
            flags: s.flags,
            edited: s.edited_at !== null,
          }));
          sendJson(res, 200, {
            transcript: {
              uid: tr.uid,
              engineId: tr.engine_id,
              modelId: tr.model_id,
              language: tr.language,
              status: tr.status,
              progress: tr.progress,
              durationMs: tr.duration_ms,
              rtf: tr.rtf,
              segmentCount: tr.segment_count,
            },
            segments,
          });
          return true;
        }

        // ---- GET /api/notes/:uid ----
        if (method === 'GET') {
          const assets = repos.assetsOfNote(note.id).map((a) => ({
            uid: a.uid,
            role: a.role,
            mime: a.mime,
            bytes: a.bytes,
            durationMs: a.duration_ms,
            /** 前端播放器直接用这个（只接受 asset uid，绝不接受文件路径）。 */
            url: `/media/asset/${a.uid}`,
          }));
          const tr = repos.activeTranscriptOfNote(note.id);
          sendJson(res, 200, {
            uid: note.uid,
            title: note.title,
            status: note.status,
            kind: note.kind,
            language: note.language,
            durationMs: note.duration_ms,
            summaryMd: note.summary_md,
            assets,
            transcriptUid: tr?.uid ?? null,
            segmentCount: tr?.segment_count ?? 0,
            createdAt: new Date(note.created_at).toISOString(),
          });
          return true;
        }

        // ---- DELETE /api/notes/:uid ----
        if (method === 'DELETE') {
          repos.softDeleteNote(note.id);
          sse.publish(
            makeEvent('note.deleted', topics.note(note.uid), {
              noteUid: note.uid,
            }),
          );
          sendJson(res, 200, { ok: true });
          return true;
        }
      }

      /*
       * ⚠️ 这里**刻意不做** "非 ULID 就报 400" 的兜底。
       *
       * 路由是按顺序 try 的，本模块排在前面。若在这里对所有
       * `/api/notes/<非ULID>` 直接 400，就会把兄弟模块的合法路由一起打死 ——
       * 例如 `/api/notes/upload`（上传）会在 upload 路由拿到它之前就被拒。
       * 让它 `return false` 落到后续路由，最终没人认领时由主路由 404。
       */
      return false;
    },
  };
}

function basenameOf(input: string): string {
  const cleaned = input.split(/[?#]/)[0] ?? input;
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || '未命名';
}
