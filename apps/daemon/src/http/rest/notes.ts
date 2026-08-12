/**
 * 笔记 / 导入 / 转写 的 REST 路由（F1/F2/F5）。
 *
 * ✅ **契约缺口已闭合（T-151 ②）。** 这里原来写着「shared 没有 notes 契约，本文件的形状
 * 是临时契约，一旦 shared 补上就应改为 import 它们」—— 那句"一旦…就应该"**没有失效条件、
 * 也没有任何检查器盯着**，于是 shared 补上之后它继续挂在这儿，谁都不知道该谁去做。
 *
 * 现在 `GET /api/notes` 与 `GET /api/notes/:uid` 的响应对象**被显式标注成
 * `@openmemo/shared` 的 `NoteListItem` / `NoteDetail`**，而 `apps/web` 读的是同一份类型。
 * 判据因此从"记得同步"变成"编译期挡得住"：
 *
 * | 分叉的形态 | 现在会发生什么 |
 * |---|---|
 * | daemon 少发一个字段 | 对象字面量缺键 → **本文件编译错误** |
 * | daemon 多发一个字段 | 多余属性检查 → **本文件编译错误**（顺便逼人先去契约里加） |
 * | web 读一个 daemon 不发的字段 | 该属性不在类型上 → **web 编译错误** |
 *
 * ⚠️ 这三条挡不住的是「字段还在、含义变了」。那种只能靠 `noteDetailContract.test.ts`
 * 那类真跑一遍的端到端用例，两道都要有。
 *
 * D-01 §3.2 规则 2：**写操作一律异步化** —— 导入不阻塞 HTTP，
 * 返回 202 + jobUid，进度走 SSE。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, posix, resolve, win32 } from 'node:path';

import {
  isMediaAssetState,
  isNoteKind,
  isNoteStatus,
  makeEvent,
  topics,
  type MediaAssetState,
  type NoteAsset,
  type ListNotesResponse,
  type NoteDetail,
  type NoteKind,
  type NoteListItem,
  type NoteStatus,
} from '@openmemo/shared';

import { NoMediaSourceError, type MediaSourceRegistry } from '@openmemo/pipeline';

import { parseWordsJson, type Repos } from '../../db/repos.js';
import type { JobQueue } from '../../jobs/queue.js';
import { looksLikeUrl, resolveRetranscribeSource } from '../../media/retranscribeSource.js';
import type { SseHub } from '../sse.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';

export interface NoteRoutesDeps {
  readonly repos: Repos;
  /**
   * 媒体源注册表 —— probe 复用它的 `probeWithSource()`（走完整回退链）。
   * `gpu-runtime` 在 T-025 修 TD-002 时加的：先 resolve 再 probe 会**静默绕过回退链**，
   * 第一个候选网络抖一下就整单失败，GPL 兜底也永远engage 不了。
   */
  readonly registry: MediaSourceRegistry;
  readonly queue: JobQueue;
  readonly sse: SseHub;
  /** 本地导入允许的根目录 —— 路径穿越防护（D-01 §8.5）。 */
  readonly importRoots: readonly string[];
  /**
   * 数据目录。**只用来判「这条笔记现在还重跑得了吗」**（`resolveRetranscribeSource`）。
   *
   * 与 `importRoots` 不是一回事，别合并：`importRoots` 是"允许从哪导入"（可由
   * `OPENMEMO_IMPORT_ROOTS` 扩出数据目录之外），而重跑判据要的是"runner 待会儿
   * 真能从哪读"—— 那由 `LocalFileSource` 的 `allowedRoot = paths.dataDir` 决定
   * （`pipeline/setup.ts:542`）。用 `importRoots` 去判会把一批**导得进、却重跑不了**
   * 的笔记judge成可重跑，也就是把这次要消灭的那句谎话换个地方再说一遍。
   */
  readonly dataDir: string;
}

interface ImportBody {
  input?: unknown;
  title?: unknown;
  language?: unknown;
  /** 用户为这一次转写显式选的引擎/模型/初始 prompt（都可不传）。 */
  engineId?: unknown;
  modelId?: unknown;
  prompt?: unknown;
  kind?: unknown;
}

/**
 * `notes.body_json`（TEXT）→ TipTap 文档对象。
 *
 * 与 `parseWordsJson` 同一条约定：**解析不出来就当"没有"，绝不把坏数据当有效结果发出去**。
 * 这一列是 `PATCH` 用 `JSON.stringify` 写进去的，正常情况下必然可解析；
 * 会走到 catch 的只有手工改库或旧数据，那种时候"编辑器空着"远好过"编辑器崩了"。
 */
function parseJsonOrNull(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * DB 的 `TEXT` 列 → 契约上的字面量联合。**认不出就抛，不兜底成某个"看起来合理"的值。**
 *
 * 为什么可以放心抛：这三列在 `0001_init.sql` 里都带 `CHECK (… IN (…))`，
 * SQLite 在写入时就拒了越界值 —— 也就是说**走到 throw 那一行本身就是一个真 bug**
 * （schema 被改过 / 有人绕过约束写库）。那种时候一条带原值的 500 远好过
 * 一个"状态显示成 draft"的界面：后者会让用户以为笔记回到了草稿。
 *
 * 兜底成默认值是本仓反复吃亏的形状：**把一次响亮的失败换成一次安静的谎话**。
 */
function narrowColumn<T extends string>(
  value: string,
  is: (v: string) => v is T,
  column: string,
): T {
  if (is(value)) return value;
  throw new Error(
    `${column} 的取值 ${JSON.stringify(value)} 不在契约的字面量联合里 —— ` +
      `建表语句上的 CHECK 约束本该拦住它，走到这里说明 schema 或数据被绕过了`,
  );
}

const noteStatusOf = (v: string): NoteStatus => narrowColumn(v, isNoteStatus, 'notes.status');
const noteKindOf = (v: string): NoteKind => narrowColumn(v, isNoteKind, 'notes.kind');
const assetStateOf = (v: string): MediaAssetState =>
  narrowColumn(v, isMediaAssetState, 'media_assets.state');

/**
 * 一个本地路径是不是落在允许导入的根里。
 *
 * ── 为什么它是一个带 `platform` 参数的独立函数（而不是三行内联） ──────────────────
 *
 * 原来的写法是 `real === root || real.startsWith(root + '/')` —— **硬编码 POSIX 分隔符**。
 * 在 Windows 上 `resolve()` 给出 `C:\…\data\jfk.wav`，而 `root + '/'` 拼出
 * `C:\…\data/`，**永远前缀匹配不上**。
 *
 * `[CI 实测]` cold-start-audit run 31038554367，win32-x64，一个**就放在 dataDir 里**的文件：
 *
 *     POST /api/notes/import → HTTP 403 PATH_NOT_ALLOWED
 *     path outside allowed roots: C:\Users\RUNNER~1\...\data\jfk.wav
 *
 * 后果不是"少一个边角功能"，是 **Windows 上本地文件导入 100% 不可用** ——
 * 而它长得像一条正常的权限拒绝，用户只会以为自己选错了目录。
 * （`platform` T-141 #26「对文件系统路径硬编码 `/`」的同族。）
 *
 * **`platform` 是入参而不是读 `process.platform`**：这正是 `argGuard.isSafeExecutable`
 * 修好之后立下的形状 —— 宿主绑定的判断在本机 Linux 上**测不出来**，
 * 而这个 bug 恰恰只在别的平台上显形。参数化之后本机就能把两边都测到。
 *
 * 顺带堵掉一个与平台无关的老坑：`startsWith(root + sep)` 对
 * `/data-x` vs `/data` 这种「前缀相同但不是子路径」是对的，但 `startsWith(root)`
 * 不是；用 `relative()` 判据统一成「相对路径不以 `..` 开头且不是绝对路径」。
 */
export function isWithinImportRoots(
  roots: readonly string[],
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = platform === 'win32' ? win32 : posix;
  const real = p.resolve(candidate);
  return roots.some((root) => {
    const rel = p.relative(p.resolve(root), real);
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
  });
}

export function createNoteRoutes(deps: NoteRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  const { repos, queue, sse } = deps;

  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;

      /*
       * ---- POST /api/notes/probe ----
       *
       * F1 的"先看清楚再决定"：粘贴链接 → 秒级返回标题/时长/来源 → 用户再点导入。
       * 不是多余的一次请求 —— 没有它，用户得先下载几百 MB 才知道自己粘错了。
       *
       * **只读，不建 note、不排 job**（与 import 的区别就在这里）。
       */
      if (p === '/api/notes/probe' && method === 'POST') {
        const body = (await readJsonBody(req)) as ImportBody | undefined;
        const input = typeof body?.input === 'string' ? body.input.trim() : '';
        if (!input) {
          sendError(res, 400, 'BAD_REQUEST', 'input is required', '缺少 input（链接或本地路径）');
          return true;
        }

        // probe 要快：超时短一些，卡住不如早报错让用户换个链接
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 30_000);
        try {
          const { source, info } = await deps.registry.probeWithSource(input, ac.signal);
          const result = {
            title: info.title ?? basenameOf(input),
            author: info.uploader,
            durationMs: info.durationMs,
            thumbnailUrl: info.thumbnailUrl,
            site: siteOf(input),
            adapterId: source.id,
            /*
             * ⚠️ `MediaInfo` 里**没有**"需不需要登录"这个信息，探测阶段也拿不到。
             * 这里如实返回 false，**不猜** —— 猜 true 会平白吓退用户，
             * 猜出一个假的 requiresAuth 比没有这个字段更糟。
             * 真要支持得让各 adapter 在 probe 时上报，属 pipeline 侧改动。
             */
            requiresAuth: false,
            // 集合类输入（RSS / 播放列表）：让用户知道这一下会导入多少条
            isCollection: info.isCollection,
            mediaCount: info.isCollection ? (info.children?.length ?? 0) : 1,
            sourceKind: /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? 'url' : 'local',
            publishedAt: info.publishedAt,
            description: info.description,
          };
          sendJson(res, 200, result);
        } catch (err) {
          if (err instanceof NoMediaSourceError) {
            sendError(
              res,
              422,
              'NO_MEDIA_SOURCE',
              `no adapter can handle: ${input}`,
              '没有适配器能处理这个链接',
              {
                remediation: {
                  action: 'installSiteExtractor',
                  params: { input },
                  labelZh: '查看如何支持该站点',
                  label: 'How to support this site',
                },
                details: { hint: err.remediation },
              },
            );
            return true;
          }
          const aborted = ac.signal.aborted;
          sendError(
            res,
            aborted ? 504 : 502,
            aborted ? 'PROBE_TIMEOUT' : 'PROBE_FAILED',
            err instanceof Error ? err.message : String(err),
            aborted ? '解析超时（30 秒）—— 该链接可能不可达' : '解析失败',
            { retryable: true },
          );
        } finally {
          clearTimeout(timer);
        }
        return true;
      }

      // ---- POST /api/notes/import ----
      if (p === '/api/notes/import' && method === 'POST') {
        const body = (await readJsonBody(req)) as ImportBody | undefined;
        const input = typeof body?.input === 'string' ? body.input.trim() : '';
        if (!input) {
          sendError(res, 400, 'BAD_REQUEST', 'input is required', '缺少 input（本地路径或 URL）');
          return true;
        }

        /*
         * 本地路径必须落在允许的根内；URL 交给 pipeline 的 argGuard 做校验。
         *
         * 判据从这里的行内正则改成引用 `media/retranscribeSource.ts` 的 `looksLikeUrl` ——
         * 「这串输入是链接还是本地路径」现在有两个消费方（导入、重跑判据），
         * 各写一遍就是给自己留一条"两边规则不一样"的缝。
         */
        const isUrl = looksLikeUrl(input);
        if (!isUrl) {
          if (!isAbsolute(input)) {
            sendError(
              res,
              400,
              'BAD_PATH',
              'local path must be absolute',
              '本地路径必须是绝对路径',
            );
            return true;
          }
          const real = resolve(input);
          const ok = isWithinImportRoots(deps.importRoots, input);
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
        const engineId = typeof body?.engineId === 'string' ? body.engineId : null;
        const modelId = typeof body?.modelId === 'string' ? body.modelId : null;
        const prompt = typeof body?.prompt === 'string' ? body.prompt : null;

        const note = repos.createNote({ title, kind: 'media', language });
        repos.createSource({
          noteId: note.id,
          kind: isUrl ? 'url' : 'local',
          adapterId: isUrl ? null : 'local',
          /*
           * ⚠️ 本地路径**也要存**。
           * D-02 对 `input_url` 的定义是"用户原始输入"，不限于 URL。
           * 之前本地导入存 null，结果**取消后无法重跑**（不知道源文件在哪），
           * 续跑、换模型重跑、重新转写全都做不了。
           */
          originalUrl: input,
          title,
        });

        const job = queue.enqueue({
          type: 'transcribe',
          lane: 'gpu.asr',
          priority: 10,
          noteId: note.id,
          payload: {
            noteId: note.id,
            input,
            language,
            engineId,
            modelId,
            prompt,
            sourceKind: isUrl ? 'url' : 'local',
          },
        });

        sse.publish(
          makeEvent('note.created', topics.note(note.uid), {
            noteUid: note.uid,
            title: note.title,
            folderUid: null,
          }),
        );
        /*
         * `job.created` **不在这里发**，由 `JobQueue` 的 onCreated 钩子统一发（main.ts）。
         *
         * 这里原来的注释写着"刻意不发，因为流水线 job 填不进 DownloadJob 的形状"——
         * 前半句的判断是对的，但结论让 blocked 等状态在界面上彻底不可达（T-130）。
         * shared 现在有 `PipelineJob`，事件可以如实发出；集中到队列层是为了
         * 让新增的入队点不可能漏发。
         */

        // 202：写操作异步化（D-01 §3.2 规则 2）
        sendJson(res, 202, { noteUid: note.uid, jobUid: job.uid, status: note.status });
        return true;
      }

      // ---- GET /api/notes ----
      /*
       * ---- POST /api/notes/:uid/restore —— 撤销删除 ----------------------------------
       *
       * **必须排在按 uid 取笔记的那一段之前**，理由是结构性的：
       * 那一段用 `repos.noteByUid()`，而它**按设计查不到已删的**
       * （`... AND deleted_at IS NULL`，那条过滤是对的，不改）。
       * 恢复要处理的恰恰是"已删"的那一条 —— 走那条路必然 404，
       * 于是这个端点会变成一个**永远够不到的实现**。
       *
       * 这条路径存在的理由见 `repos.restoreNote()` 的注释：
       * 在它之前全 daemon 零 restore 路径，「软删除」只兑现了"软"字的前一半。
       */
      const restoreMatch = /^\/api\/notes\/([^/]+)\/restore$/.exec(p);
      if (restoreMatch && method === 'POST') {
        const uid = decodeURIComponent(restoreMatch[1] ?? '');
        const ok = repos.restoreNote(uid);
        if (!ok) {
          // 分不清"没这条"和"它本来就没被删"时，**不要编一个成功** —— 两种都给 404 并说清楚。
          sendError(
            res,
            404,
            'NOTE_NOT_FOUND',
            `no deleted note ${uid}`,
            '没有找到这条已删除的笔记（可能它从未被删除，或者已经被恢复过了）',
          );
          return true;
        }
        const restored = repos.noteByUid(uid);
        sse.publish(
          makeEvent('note.updated', topics.note(uid), {
            noteUid: uid,
            /*
             * `changed` 的取值是契约里钉死的 6 个（`shared/events.ts:441`），
             * 没有"deleted_at"这一档 —— **不擅自往契约里加值**（那要改 shared，
             * 是别人的地界，且会波及所有消费方）。用 `title`：
             * 恢复之后列表里重新出现的正是这条笔记的标题，消费方据此重拉是对的。
             */
            changed: ['title'],
          }),
        );
        sendJson(res, 200, { ok: true, uid, title: restored?.title ?? null });
        return true;
      }

      if (p === '/api/notes' && method === 'GET') {
        const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50);
        /*
         * ★ `?offset=<n>` —— 翻页（T-157 ③）。
         *
         * 在这之前这个端点**只有 `limit`**（默认 50、上限 200），而前端连 `limit` 都不传。
         * 后果不是"慢"，是**第 51 条笔记起在界面上永远不存在**：没有翻页、没有总数、
         * 没有任何提示。上面 `starred` 那段写着"超过 50 条之后无声地漏"——
         * 那句话对**总量**同样成立，而且更糟：过滤修对了，取不全照样看不到。
         *
         * 认不出的取值 **400，不静默当成 0** —— 与 `starred` / `folder` 同一条判据。
         * `?offset=abc` 静默变成 0 会返回**第一页**，而调用方以为自己在看第三页：
         * 一个既不报错、结果又与意图相反的响应。
         */
        const offsetRaw = url.searchParams.get('offset');
        /*
         * ⚠️ 用正则而不是 `Number(raw)`：**`Number('')` 是 0**。
         * 也就是说 `?offset=` 会被静默当成第一页 —— 恰好是这段注释说不许发生的那件事。
         * （这条是自己写的用例当场抓出来的：`?offset=` 返回了 200。）
         */
        const offset = offsetRaw === null ? 0 : Number(offsetRaw);
        if (offsetRaw !== null && (!/^\d+$/.test(offsetRaw) || !Number.isSafeInteger(offset))) {
          sendError(
            res,
            400,
            'BAD_QUERY_PARAM',
            `offset must be a non-negative integer (got ${JSON.stringify(offsetRaw)})`,
            'offset 必须是不小于 0 的整数',
          );
          return true;
        }
        /*
         * ★ `?starred=1` —— 侧栏「星标」的数据源（T-138 ③）。
         *
         * 在这之前这个端点**只认 `limit`**，于是前端只能对已取回的那一页做过滤
         * （`NotesListPage` 的注释把这笔代价如实写着："真修法在端点"）。
         * 代价不是"慢"，是**超过 50 条之后无声地漏**。
         *
         * 无法识别的取值一律 **400，不静默忽略**：`?starred=0` 最自然的读法是
         * "只看没加星的"，而静默忽略会返回**全部**笔记 —— 一个既不报错、
         * 又和调用方意图相反的结果。本项目最贵的一类 bug 正是这种。
         * 要支持"只看未加星"就在这里显式加一个分支，而不是靠猜。
         */
        const starredRaw = url.searchParams.get('starred');
        if (starredRaw !== null && starredRaw !== '1' && starredRaw !== 'true') {
          sendError(
            res,
            400,
            'BAD_QUERY_PARAM',
            `starred must be "1" or "true" (got ${JSON.stringify(starredRaw)})`,
            'starred 参数只接受 1 或 true',
          );
          return true;
        }
        /*
         * ★ `?folder=<uid>` —— 侧栏文件夹树的数据源（T-138 ④）。
         *
         * 在这之前**全仓没有一处读它**：点开一个空文件夹，地址变了、侧栏高亮变了，
         * 页面照常列出全部笔记（`[实测]` 0 条的文件夹显示 2 条）。
         * T-138c 把高亮修准之后这件事反而更糟 —— 界面开始用可信的口气说错话。
         *
         * **含子孙**（裁决）：文件夹是树，点父级期待的是"这个主题下的全部"。
         * 递归在 SQL 里（`FOLDER_CLOSURE_CTE`），与侧栏计数同一份定义。
         *
         * 认不出的 uid **400，不静默返回全部** —— 与 `starred` 同一条判据。
         * 静默的话，一个手滑打错的 uid 会得到"全部笔记"，而用户以为自己在看某个文件夹。
         */
        const folderRaw = url.searchParams.get('folder');
        let folderId: number | undefined;
        if (folderRaw !== null) {
          const folder = repos.folderByUid(folderRaw);
          if (!folder || folder.deleted_at !== null) {
            sendError(
              res,
              400,
              'BAD_QUERY_PARAM',
              `no such folder: ${JSON.stringify(folderRaw)}`,
              '找不到这个文件夹（可能已被删除）',
            );
            return true;
          }
          folderId = folder.id;
        }
        const filter = {
          starredOnly: starredRaw !== null,
          ...(folderId === undefined ? {} : { folderId }),
        };
        const rows = repos.listNotes(limit, { ...filter, offset });
        // 总数与列表**共用同一份 WHERE**（`repos.notesFilter`），不许各算各的
        const total = repos.countNotes(filter);
        // 一次 IN 查询拿全部标签，避免列表页 N+1
        const tagMap = repos.tagsOfNotes(rows.map((n) => n.id));
        // ★ 显式标注：少一个键或多一个键都在这里编译失败（见文件头那张表）
        const notes: NoteListItem[] = rows.map((n) => ({
          uid: n.uid,
          title: n.title,
          status: noteStatusOf(n.status),
          kind: noteKindOf(n.kind),
          language: n.language,
          durationMs: n.duration_ms,
          starred: n.starred === 1,
          tags: (tagMap.get(n.id) ?? []).map((t) => ({
            uid: t.uid,
            name: t.name,
            color: t.color,
          })),
          createdAt: new Date(n.created_at).toISOString(),
          updatedAt: new Date(n.updated_at).toISOString(),
        }));
        // ★ 显式标注成契约类型：少一个键或多一个键都在这里编译失败
        const body: ListNotesResponse = {
          notes,
          total,
          limit,
          offset,
          // 由服务端算，不让每个调用方各推一遍（前端推错一次就是"永远不显示加载更多"）
          hasMore: offset + notes.length < total,
        };
        sendJson(res, 200, body);
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
            /*
             * ★ 编辑前的原始 ASR 文本。**PATCH 会返回它，但 GET 一直没带** ——
             * 于是用户改完刷新一次，原文就没了。
             *
             * 契约里 textRaw 的用途是「查看改动」与「还原」：读到 null 的前端
             * 只会**安静地不显示那两个按钮**，不报错、不留痕，
             * 表现为"这两个功能从来就不存在"。用户改错了没法还原。
             *
             * 这和 `words` 是同一类缺陷（只在响应里存在、一落地就消失），
             * 所以这次把整行 DB 列与序列化字段逐个比对了一遍，不是只补被报的那个。
             */
            textRaw: s.text_raw,
            confidence: s.confidence,
            /*
             * 第三个漏掉的字段（逐列比对查出来的，没人报过）。
             * 无语音概率是"这段可能是静音/噪声"的唯一依据，
             * 前端要用它把低置信段落做弱化显示；不发出去，那种显示就永远不会出现。
             */
            noSpeechProb: s.no_speech_prob,
            chunkIdx: s.chunk_idx,
            flags: s.flags,
            /*
             * **`editedAt` 是权威字段**，`edited` 只是它的布尔投影。
             *
             * 之前只发 `edited`，而前端类型声明的是 `editedAt` —— 两边各认一个名字，
             * 结果前端恒判"没人编辑过"。这类字段名裂缝不会让任何测试变红，
             * 只会让功能悄悄失效（"已保留"徽标永远不亮）。
             * 统一到 `editedAt` 的理由：它同时是 `mergeTranscripts` 判"要不要保留"的依据，
             * 两边用同一个事实，不再需要各自推导。
             */
            editedAt: s.edited_at,
            edited: s.edited_at !== null,
            /*
             * `words` / `speakerLabel` 之前根本没发出去，于是前端的词级高亮徽标
             * **恒判"无逐字时间戳"** —— whisper 路径本来是有词级时间戳的，
             * 降级徽标却一直亮着，用户永远看不到词级高亮。
             * ADR-013 说的是"中文 Paraformer 无词级时间戳要降级"，
             * 不是"所有路径都没有"。null 与"字段不存在"必须区分开。
             */
            words: parseWordsJson(s.words_json),
            /*
             * 说话人分离（`speakers` 表 + `segments.speaker_id`）**尚未接线** ——
             * 所以这里如实发 `null`，而不是省掉字段。
             * 省掉的话前端分不清"没有说话人信息"和"这条响应压根不带这个字段"，
             * 上一个 bug（`edited` vs `editedAt`）就是这么来的。
             */
            speakerLabel: null,
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
          /*
           * ★ 重跑可用性：**真的去解析一次**，不再只判 `input_url` 非空（#95）。
           *
           * 这一次探测最多两个 `open()` + 读 4 字节，且**只在单条笔记详情上发生** ——
           * `canRetranscribe` 不在 `NoteListItem` 上（列表分支在上面，不含此字段），
           * 所以笔记列表一次都不会调它。别把这个字段加进列表，除非先解决 N 次探测。
           */
          const retranscribe = await resolveRetranscribeSource(
            { repos, dataDir: deps.dataDir },
            note.id,
          );
          const assets: NoteAsset[] = repos.assetsOfNote(note.id).map((a) => ({
            uid: a.uid,
            role: a.role,
            mime: a.mime,
            bytes: a.bytes,
            durationMs: a.duration_ms,
            /*
             * ★ #96②：**「你存的这份原件被换过」要有地方看得见。**
             *
             * 上面这两个数在这次改动之前是**冻住的**：网络导入重转会重新下载一次源、
             * 覆盖同名文件，而 `createAsset` 按 `rel_path` 幂等、原样返回旧行，
             * 于是 `bytes` / `durationMs` 停在第一次下载时的值。
             * 而 `/media/asset/:uid` 用 `stat()` 现取真实大小 ——
             * **正因为播放不受影响，这个错数才会一直没人发现。**
             * 现在覆盖发生时那两个数会被刷新，覆盖时刻记在这一列上。
             */
            replacedAt: a.replaced_at,
            /*
             * ★ `state` —— **资产能不能用**（T-139 A1）。
             *
             * 这一列从 `0001_init.sql` 起就在（`pending|ready|missing|failed`，NOT NULL），
             * 只是**从来没有被发出去过**。而前端筛的正是它：
             * `NoteDetailPage` 的 `a.role === 'audio16k' && a.state === 'ready'`
             * → `undefined === 'ready'` → **恒 false** → `<audio>` 元素根本不进 DOM。
             * 表现是：波形画着、时间码走着、播放键亮着，**点了什么都不发生，零报错**。
             * F5 的招牌能力「转写稿 ↔ 音频时间轴联动」在真实环境里因此从未工作过。
             *
             * ⚠️ 如实说明当前语义：**写入方（`createAsset`）一律写 `'ready'`**，
             * 全仓没有任何一处把它改成别的值。所以今天它恒等于 `'ready'`。
             * 那为什么还要发？因为它是**这条记录自己的事实**，前端已经在按它判断；
             * 让服务端不发、前端瞎猜，正是这个 bug 的成因。哪天异步产物（peaks/转码）
             * 真的先落 `pending` 再转 `ready`，消费方不需要改一行。
             *
             * ✅ T-151 ②：这个字段现在**在共享契约里是必填的**（`shared` 的 `NoteAsset.state`），
             * 上面那段历史里"两边没有任何东西对过一遍"的状态已经结束 ——
             * 把这一行删掉会当场编译失败，而不是等到用户点播放没反应。
             */
            state: assetStateOf(a.state),
            /** 前端播放器直接用这个（只接受 asset uid，绝不接受文件路径）。 */
            url: `/media/asset/${a.uid}`,
          }));
          const tr = repos.activeTranscriptOfNote(note.id);
          /*
           * ★ 显式标注成共享契约（T-151 ②）。**这一行就是这次改动的全部要害。**
           *
           * A1（`state`）与 A1b（`bodyJson`）能各自静默活那么久，不是因为谁写漏了断言，
           * 而是因为**这个对象字面量与前端读它的那份类型之间不存在任何连接** ——
           * 编译器结构上看不见那条缝。把它标注上去之后，缝就归编译器管了。
           */
          const detail: NoteDetail = {
            uid: note.uid,
            title: note.title,
            status: noteStatusOf(note.status),
            kind: noteKindOf(note.kind),
            language: note.language,
            durationMs: note.duration_ms,
            summaryMd: note.summary_md,
            /*
             * ★ `bodyJson` —— 笔记正文（T-139 A1b），⑤C「写得进读不回」的**第七例**，
             * 与该族第一例 `textRaw` 完全同形。
             *
             * 写路径一直是真的：TipTap 800ms 防抖 → `PATCH /api/notes/:uid` →
             * `updateNoteContent` → `notes.body_json` **真落库**（PATCH 的响应甚至回
             * `hasBody:true`）。读路径**从来没接上**：本对象里没有这个键，全仓也没有
             * 第二个返回它的 GET。于是用户写完 → 自动保存成功 → **刷新/重进，编辑器是空的**。
             * 数据一个字节没丢，但界面上完全看不出这一点 —— 用户只会认为"它没保存"。
             *
             * **发解析后的对象，不发字符串**：`NoteEditor` 把它直接喂给 TipTap 的
             * `content`，那里要的是文档对象；发字符串会变成"一段显示为 JSON 的正文"。
             * 解析失败一律回 `null`（同 `parseWordsJson` 的约定）——
             * 坏数据宁可当"没有正文"，也绝不原样发出去让编辑器崩在用户脸上。
             */
            bodyJson: parseJsonOrNull(note.body_json),
            /*
             * ⚠️ `tags` **永远是数组，无标签时是 `[]` 而不是缺字段**。
             * 少了它前端 `tags.map()` 直接整页崩（`undefined.map`），
             * 而"没有标签"和"字段不存在"在契约上是两回事 ——
             * 后者会让每个消费方都得写一次 `?? []`，漏一处就崩一次。
             */
            tags: repos.tagsOfNote(note.id).map((t) => ({
              uid: t.uid,
              name: t.name,
              color: t.color,
            })),
            starred: note.starred === 1,
            folderUid: repos.folderUidOf(note.folder_id),
            assets,
            transcriptUid: tr?.uid ?? null,
            segmentCount: tr?.segment_count ?? 0,
            /*
             * 能不能重跑，**由 daemon 判定并明说**，前端不要自己猜。
             *
             * ⚠️ 这里原来是 `repos.primarySourceOf(note.id)?.input_url != null` ——
             * **只判非空**。那句判断在"字段还在、路径已经失效"面前完全无效，而这正是
             * 数据目录搬家之后的常态（`input_url` 是绝对路径，没有任何迁移会更新它）。
             * 后果是一条不报错的闭合链：按钮亮 → POST 回 202 → job 事后死在
             * `no media source can handle this input`，而笔记详情页对此**一个字都不显示**
             * （只有右下角一条会消失的 toast，刷新即无）。`[实测]` demo 库两条笔记就是这形态。
             *
             * 现在两个字段一起发，且**同出一个判据**（`resolveRetranscribeSource`）——
             * 事前禁用与事后 409 因此不可能给出不同的诊断。
             */
            canRetranscribe: retranscribe.ok,
            /*
             * 变灰必须自带理由。**无声变灰 = 亮着但必死**，两者都是让用户自己猜。
             * `ok` 时恒 `null`：不要发一个"空的原因对象"，那会让消费方以为有话要说。
             */
            retranscribeBlocked: retranscribe.ok
              ? null
              : {
                  code: retranscribe.code,
                  message: retranscribe.message,
                  messageZh: retranscribe.messageZh,
                  tried: retranscribe.tried,
                },
            createdAt: new Date(note.created_at).toISOString(),
          };
          sendJson(res, 200, detail);
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

/** 从 URL 取站点名（本地路径返回 null）。仅用于展示。 */
function siteOf(input: string): string | null {
  try {
    return new URL(input).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function basenameOf(input: string): string {
  const cleaned = input.split(/[?#]/)[0] ?? input;
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || '未命名';
}
