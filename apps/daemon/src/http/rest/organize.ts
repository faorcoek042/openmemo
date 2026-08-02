/**
 * 组织维度的 REST 路由：标签 / 星标 / 文件夹（D-02 §1.3）。
 *
 * 分层与 `notes.ts` 一致：**本文件一行 SQL 都没有**，
 * 所有落库动作走 `Repos` 的方法；这里只做 HTTP 形状转换与输入校验。
 *
 * 两个容易被漏掉的正确性点，已在 repos 层处理并在此说明：
 *
 * 1. **`tags.usage_count`**：`0001_init.sql` 里**确实存在** `tags_usage_ai` /
 *    `tags_usage_ad` 两个触发器做 ±1 维护。但每次变更后 repos 仍会用
 *    `SELECT COUNT(*) FROM note_tags WHERE tag_id = ?` 重算一遍 —— 触发器是增量的，
 *    一旦历史数据漂移就永远错下去；重算是幂等的，两者叠加也不会算错。
 *
 * 2. **文件夹环检测**：D-02 §1.3 明说「深度上限与环检测由应用层强制」，DB 层没有约束。
 *    改 parent 前先走一遍祖先链，命中自身即 400 `FOLDER_CYCLE`。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { FolderRow, Repos, TagRow } from '../../db/repos.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';

export interface OrganizeRoutesDeps {
  readonly repos: Repos;
}

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const TAGS_OF_NOTE_RE = new RegExp(`^/api/notes/(${ULID})/tags$`);
const TAG_OF_NOTE_RE = new RegExp(`^/api/notes/(${ULID})/tags/(${ULID})$`);
const STAR_RE = new RegExp(`^/api/notes/(${ULID})/star$`);
const NOTE_FOLDER_RE = new RegExp(`^/api/notes/(${ULID})/folder$`);
const TAG_RE = new RegExp(`^/api/tags/(${ULID})$`);
const FOLDER_RE = new RegExp(`^/api/folders/(${ULID})$`);

const MAX_NAME_LEN = 120;
/** 单次替换标签的上限：防止一次请求塞进上万条 note_tags 把事务拖死。 */
const MAX_TAGS_PER_NOTE = 64;

interface TagDto {
  uid: string;
  name: string;
  color: string | null;
  usageCount: number;
}

interface FolderNode {
  uid: string;
  name: string;
  parentUid: string | null;
  sortOrder: number;
  color: string | null;
  icon: string | null;
  noteCount: number;
  children: FolderNode[];
}

export function createOrganizeRoutes(deps: OrganizeRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  const { repos } = deps;

  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;

      // =======================================================================
      // 标签
      // =======================================================================

      // ---- GET /api/tags | POST /api/tags ----
      if (p === '/api/tags') {
        if (method === 'GET') {
          sendJson(res, 200, repos.listTags().map(toTagDto));
          return true;
        }
        if (method === 'POST') {
          const body = await parseBody(req, res);
          if (body === BAD_JSON) return true;
          const raw = asRecord(body);
          const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
          if (!name) {
            sendError(res, 400, 'BAD_REQUEST', 'name is required', '缺少 name（标签名不能为空）');
            return true;
          }
          if (name.length > MAX_NAME_LEN) {
            sendError(
              res,
              400,
              'NAME_TOO_LONG',
              `name exceeds ${MAX_NAME_LEN} chars`,
              `标签名过长（超过 ${MAX_NAME_LEN} 字）`,
            );
            return true;
          }
          const color = optionalString(raw['color']);
          if (color === INVALID) {
            sendError(res, 400, 'BAD_REQUEST', 'color must be a string or null', 'color 必须是字符串或 null');
            return true;
          }

          // 按 name_norm 判重：已存在就回既有标签 + 200，绝不建重复项
          const { tag, created } = repos.findOrCreateTag({ name, color });
          sendJson(res, created ? 201 : 200, toTagDto(tag));
          return true;
        }
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET or POST', '方法不允许');
        return true;
      }

      // ---- DELETE /api/tags/:uid ----
      const tagMatch = TAG_RE.exec(p);
      if (tagMatch) {
        if (method !== 'DELETE') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use DELETE', '方法不允许');
          return true;
        }
        const tag = repos.tagByUid(tagMatch[1]);
        if (!tag) {
          sendError(res, 404, 'TAG_NOT_FOUND', `no tag ${tagMatch[1]}`, '标签不存在');
          return true;
        }
        repos.deleteTag(tag.id);
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ---- POST /api/notes/:uid/tags（整表替换）----
      const noteTagsMatch = TAGS_OF_NOTE_RE.exec(p);
      if (noteTagsMatch) {
        if (method !== 'POST') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST', '方法不允许');
          return true;
        }
        const note = repos.noteByUid(noteTagsMatch[1]);
        if (!note) {
          sendError(res, 404, 'NOTE_NOT_FOUND', `no note ${noteTagsMatch[1]}`, '笔记不存在');
          return true;
        }
        const body = await parseBody(req, res);
        if (body === BAD_JSON) return true;
        const rawUids = asRecord(body)['tagUids'];
        if (!Array.isArray(rawUids) || rawUids.some((u) => typeof u !== 'string')) {
          sendError(
            res,
            400,
            'BAD_REQUEST',
            'tagUids must be an array of strings',
            'tagUids 必须是字符串数组（传空数组表示清空标签）',
          );
          return true;
        }
        if (rawUids.length > MAX_TAGS_PER_NOTE) {
          sendError(
            res,
            400,
            'TOO_MANY_TAGS',
            `at most ${MAX_TAGS_PER_NOTE} tags`,
            `一篇笔记最多 ${MAX_TAGS_PER_NOTE} 个标签`,
          );
          return true;
        }

        // 先把 uid 全解析成内部 id：**任何一个不存在就整体拒绝**，
        // 不做"能挂几个挂几个"的部分成功 —— 那会让前端以为都挂上了。
        const tagIds: number[] = [];
        for (const uid of rawUids as string[]) {
          const tag = repos.tagByUid(uid);
          if (!tag) {
            sendError(res, 400, 'TAG_NOT_FOUND', `no tag ${uid}`, `标签不存在：${uid}`);
            return true;
          }
          tagIds.push(tag.id);
        }

        sendJson(res, 200, repos.replaceNoteTags(note.id, tagIds).map(toTagDto));
        return true;
      }

      // ---- DELETE /api/notes/:uid/tags/:tagUid ----
      const oneTagMatch = TAG_OF_NOTE_RE.exec(p);
      if (oneTagMatch) {
        if (method !== 'DELETE') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use DELETE', '方法不允许');
          return true;
        }
        const note = repos.noteByUid(oneTagMatch[1]);
        if (!note) {
          sendError(res, 404, 'NOTE_NOT_FOUND', `no note ${oneTagMatch[1]}`, '笔记不存在');
          return true;
        }
        const tag = repos.tagByUid(oneTagMatch[2]);
        if (!tag) {
          sendError(res, 404, 'TAG_NOT_FOUND', `no tag ${oneTagMatch[2]}`, '标签不存在');
          return true;
        }
        const removed = repos.detachNoteTag(note.id, tag.id);
        sendJson(res, 200, { ok: true, removed, tags: repos.tagsOfNote(note.id).map(toTagDto) });
        return true;
      }

      // =======================================================================
      // 星标
      // =======================================================================

      const starMatch = STAR_RE.exec(p);
      if (starMatch) {
        if (method !== 'PUT') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use PUT', '方法不允许');
          return true;
        }
        const note = repos.noteByUid(starMatch[1]);
        if (!note) {
          sendError(res, 404, 'NOTE_NOT_FOUND', `no note ${starMatch[1]}`, '笔记不存在');
          return true;
        }
        const body = await parseBody(req, res);
        if (body === BAD_JSON) return true;
        const starred = asRecord(body)['starred'];
        if (typeof starred !== 'boolean') {
          sendError(
            res,
            400,
            'BAD_REQUEST',
            'starred must be a boolean',
            'starred 必须是布尔值（true / false）',
          );
          return true;
        }
        sendJson(res, 200, { uid: note.uid, starred: repos.setNoteStarred(note.id, starred) });
        return true;
      }

      // =======================================================================
      // 文件夹
      // =======================================================================

      // ---- GET /api/folders | POST /api/folders ----
      if (p === '/api/folders') {
        if (method === 'GET') {
          // 统一成 `{folders: [...]}` —— 与 /api/notes、/api/secrets、/api/tags
          // 的信封一致。裸数组不利于以后加分页/元信息，也和其它端点不对称。
          sendJson(res, 200, {
            folders: buildFolderTree(repos.listFolders(), repos.folderNoteCounts()),
          });
          return true;
        }
        if (method === 'POST') {
          const body = await parseBody(req, res);
          if (body === BAD_JSON) return true;
          const raw = asRecord(body);
          const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
          if (!name) {
            sendError(res, 400, 'BAD_REQUEST', 'name is required', '缺少 name（文件夹名不能为空）');
            return true;
          }
          if (name.length > MAX_NAME_LEN) {
            sendError(
              res,
              400,
              'NAME_TOO_LONG',
              `name exceeds ${MAX_NAME_LEN} chars`,
              `文件夹名过长（超过 ${MAX_NAME_LEN} 字）`,
            );
            return true;
          }
          const color = optionalString(raw['color']);
          const icon = optionalString(raw['icon']);
          if (color === INVALID || icon === INVALID) {
            sendError(res, 400, 'BAD_REQUEST', 'color/icon must be string or null', 'color / icon 必须是字符串或 null');
            return true;
          }

          let parentId: number | null = null;
          const parentUid = raw['parentUid'];
          if (parentUid !== undefined && parentUid !== null) {
            if (typeof parentUid !== 'string') {
              sendError(res, 400, 'BAD_REQUEST', 'parentUid must be a string or null', 'parentUid 必须是字符串或 null');
              return true;
            }
            const parent = repos.folderByUid(parentUid);
            if (!parent || parent.deleted_at !== null) {
              sendError(res, 400, 'FOLDER_NOT_FOUND', `no folder ${parentUid}`, '父文件夹不存在或已删除');
              return true;
            }
            parentId = parent.id;
          }

          const folder = repos.createFolder({ name, parentId, color, icon });
          sendJson(res, 201, toFolderNode(folder, 0, parentUidOf(repos, folder)));
          return true;
        }
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET or POST', '方法不允许');
        return true;
      }

      // ---- PATCH / DELETE /api/folders/:uid ----
      const folderMatch = FOLDER_RE.exec(p);
      if (folderMatch) {
        const folder = repos.folderByUid(folderMatch[1]);
        if (!folder || folder.deleted_at !== null) {
          sendError(res, 404, 'FOLDER_NOT_FOUND', `no folder ${folderMatch[1]}`, '文件夹不存在');
          return true;
        }

        if (method === 'PATCH') {
          const body = await parseBody(req, res);
          if (body === BAD_JSON) return true;
          const raw = asRecord(body);
          const patch: {
            name?: string;
            parentId?: number | null;
            color?: string | null;
            icon?: string | null;
            sortOrder?: number;
          } = {};

          if (raw['name'] !== undefined) {
            const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
            if (!name || name.length > MAX_NAME_LEN) {
              sendError(
                res,
                400,
                'BAD_REQUEST',
                'name must be a non-empty string',
                `name 必须是非空字符串且不超过 ${MAX_NAME_LEN} 字`,
              );
              return true;
            }
            patch.name = name;
          }

          if (raw['color'] !== undefined) {
            const color = optionalString(raw['color']);
            if (color === INVALID) {
              sendError(res, 400, 'BAD_REQUEST', 'color must be string or null', 'color 必须是字符串或 null');
              return true;
            }
            patch.color = color;
          }
          if (raw['icon'] !== undefined) {
            const icon = optionalString(raw['icon']);
            if (icon === INVALID) {
              sendError(res, 400, 'BAD_REQUEST', 'icon must be string or null', 'icon 必须是字符串或 null');
              return true;
            }
            patch.icon = icon;
          }

          if (raw['sortOrder'] !== undefined) {
            const sortOrder = raw['sortOrder'];
            if (typeof sortOrder !== 'number' || !Number.isFinite(sortOrder)) {
              sendError(
                res,
                400,
                'BAD_REQUEST',
                'sortOrder must be a finite number',
                'sortOrder 必须是有限数字',
              );
              return true;
            }
            patch.sortOrder = sortOrder;
          }

          if (raw['parentUid'] !== undefined) {
            const parentUid = raw['parentUid'];
            if (parentUid === null) {
              patch.parentId = null;
            } else if (typeof parentUid !== 'string') {
              sendError(res, 400, 'BAD_REQUEST', 'parentUid must be a string or null', 'parentUid 必须是字符串或 null');
              return true;
            } else {
              const parent = repos.folderByUid(parentUid);
              if (!parent || parent.deleted_at !== null) {
                sendError(res, 400, 'FOLDER_NOT_FOUND', `no folder ${parentUid}`, '父文件夹不存在或已删除');
                return true;
              }
              // 环检测：新父节点若是自己、或自己的后代（等价于「自己在它的祖先链上」），都会成环
              if (parent.id === folder.id || repos.folderAncestorIds(parent.id).includes(folder.id)) {
                sendError(
                  res,
                  400,
                  'FOLDER_CYCLE',
                  'moving a folder into itself or its descendant would create a cycle',
                  '不能把文件夹移动到它自己或它的子文件夹里（会形成环）',
                );
                return true;
              }
              patch.parentId = parent.id;
            }
          }

          const updated = repos.updateFolder(folder.id, patch);
          if (!updated) {
            sendError(res, 404, 'FOLDER_NOT_FOUND', 'folder vanished', '文件夹不存在');
            return true;
          }
          sendJson(
            res,
            200,
            toFolderNode(
              updated,
              repos.folderNoteCounts().get(updated.id) ?? 0,
              parentUidOf(repos, updated),
            ),
          );
          return true;
        }

        if (method === 'DELETE') {
          // 软删（含整棵子树），其中的笔记移出到"无文件夹"，不跟着一起删
          const r = repos.softDeleteFolderTree(folder.id);
          sendJson(res, 200, { ok: true, deletedFolders: r.folders, movedNotes: r.notes });
          return true;
        }

        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use PATCH or DELETE', '方法不允许');
        return true;
      }

      // ---- PUT /api/notes/:uid/folder ----
      const noteFolderMatch = NOTE_FOLDER_RE.exec(p);
      if (noteFolderMatch) {
        if (method !== 'PUT') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use PUT', '方法不允许');
          return true;
        }
        const note = repos.noteByUid(noteFolderMatch[1]);
        if (!note) {
          sendError(res, 404, 'NOTE_NOT_FOUND', `no note ${noteFolderMatch[1]}`, '笔记不存在');
          return true;
        }
        const body = await parseBody(req, res);
        if (body === BAD_JSON) return true;
        const raw = asRecord(body);
        if (!('folderUid' in raw)) {
          sendError(
            res,
            400,
            'BAD_REQUEST',
            'folderUid is required (string or null)',
            '缺少 folderUid（传 null 表示移出文件夹）',
          );
          return true;
        }
        const folderUid = raw['folderUid'];
        if (folderUid === null) {
          repos.setNoteFolder(note.id, null);
          sendJson(res, 200, { uid: note.uid, folderUid: null });
          return true;
        }
        if (typeof folderUid !== 'string') {
          sendError(res, 400, 'BAD_REQUEST', 'folderUid must be a string or null', 'folderUid 必须是字符串或 null');
          return true;
        }
        const folder = repos.folderByUid(folderUid);
        if (!folder || folder.deleted_at !== null) {
          sendError(res, 400, 'FOLDER_NOT_FOUND', `no folder ${folderUid}`, '目标文件夹不存在或已删除');
          return true;
        }
        repos.setNoteFolder(note.id, folder.id);
        sendJson(res, 200, { uid: note.uid, folderUid: folder.uid });
        return true;
      }

      return false;
    },
  };
}

function toTagDto(t: TagRow): TagDto {
  return { uid: t.uid, name: t.name, color: t.color, usageCount: t.usage_count };
}

function toFolderNode(f: FolderRow, noteCount: number, parentUid: string | null = null): FolderNode {
  return {
    uid: f.uid,
    name: f.name,
    parentUid,
    sortOrder: f.sort_order,
    color: f.color,
    icon: f.icon,
    noteCount,
    children: [],
  };
}

/** 单个文件夹的响应里也要带 parentUid —— 前端拿它决定插到树的哪一层。 */
function parentUidOf(repos: Repos, folder: FolderRow): string | null {
  if (folder.parent_id === null) return null;
  return repos.folderById(folder.parent_id)?.uid ?? null;
}

/**
 * 扁平行 → 树。
 *
 * `parent_id` 指向一个**不在本次结果里**的行（父已被软删、或数据脏）时，
 * 该节点按根节点处理 —— 否则它既挂不上父也不在根上，会在 UI 里凭空消失。
 */
function buildFolderTree(rows: readonly FolderRow[], counts: Map<number, number>): FolderNode[] {
  const nodes = new Map<number, FolderNode>();
  for (const f of rows) nodes.set(f.id, toFolderNode(f, counts.get(f.id) ?? 0));

  const roots: FolderNode[] = [];
  for (const f of rows) {
    const node = nodes.get(f.id) as FolderNode;
    const parent = f.parent_id === null ? undefined : nodes.get(f.parent_id);
    if (parent) {
      node.parentUid = parent.uid;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // rows 已按 (sort_order, name) 排好，children/roots 的插入顺序即排序结果
  return roots;
}

/** 可选字符串字段：缺省/null → null；非空字符串 → 该串；其余 → INVALID（调用方回 400）。 */
const INVALID = Symbol('invalid');

function optionalString(value: unknown): string | null | typeof INVALID {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return INVALID;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 畸形 JSON 的哨兵值。空 body 本身合法（等于 `undefined`），所以不能用 undefined 当哨兵。 */
const BAD_JSON = Symbol('bad-json');

async function parseBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    return await readJsonBody(req);
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendError(res, 400, 'BAD_JSON', 'malformed JSON body', '请求体不是合法的 JSON');
      return BAD_JSON;
    }
    throw err;
  }
}
