/**
 * F1 / F2 / F5 contract — notes, import, transcript, search, media.
 *
 * PROVENANCE (ADR-012): these shapes are NOT newly designed here. They are
 * `oss-scout`'s implementation in `apps/daemon/src/http/rest/**`, transcribed verbatim
 * and formalised. He shipped and load-tested them (67 real SSE events, 49 segments
 * persisted, Range 206 on /media) before this file existed.
 *
 * Adopting rather than redesigning is deliberate: `architect` is concurrently switching
 * the frontend off mocks, and two parties inventing two shapes for the same endpoint is
 * exactly the collision this package exists to prevent. Where I would have chosen
 * differently, I kept his shape and noted it — a working implementation outranks my
 * preference. Any real objection goes through DISPUTE, not through a silent redefinition.
 *
 * UNIT RULE: all media time is INTEGER MILLISECONDS here, matching D-02 §1.1. The SSE
 * transcription events still carry float seconds; that discrepancy is tracked separately
 * and the daemon converts at the boundary.
 */

import type { Remediation } from './events.js';

/** ULID (26 chars, Crockford base32). The only note identifier the API exposes. */
export type NoteUid = string;

/**
 * `notes.kind` —— **取值来自 `0001_init.sql` 的 CHECK 约束**，不是这里发明的。
 *
 * ⚠️ 这个常量原来写的是 `['media','text','recording']`。`[实测]` 建表语句是
 * `CHECK (kind IN ('media','recording','plain'))` ——
 * 也就是说 `'text'` **一行都不可能存在**（写进去会被 SQLite 拒），
 * 而真正存在的 `'plain'` 这个契约里没有。
 * 它能错这么久的唯一原因是**全仓没有任何一处 import 过它**（T-151 ② 逐个 grep 确认）。
 * 一份没人用的契约不会被任何东西证伪 —— 它只会在有人第一次相信它的那天出事。
 */
export const NOTE_KINDS = ['media', 'recording', 'plain'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/**
 * `notes.status` —— 同上，取值来自 `CHECK (status IN ('draft','processing','ready','partial','failed'))`。
 *
 * ⚠️ 原来写的是 `['draft','importing','transcribing','structuring','ready','failed']`：
 * 中间那三个**都不在 CHECK 里**，daemon 写任何一个都会当场违反约束；
 * 而真实存在的 `'processing'` / `'partial'` 反倒不在契约里。
 */
export const NOTE_STATUSES = ['draft', 'processing', 'ready', 'partial', 'failed'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/**
 * `media_assets.state` —— `CHECK (state IN ('pending','ready','missing','failed'))`。
 *
 * ⚠️ **"字段缺失"绝不能读成"不可用"**（T-139 A1 的教训，见 `NoteAsset.state`）。
 * 消费方要判"能不能用"，判据是「不属于 pending/missing/failed」，而不是「等于 ready」。
 */
export const MEDIA_ASSET_STATES = ['pending', 'ready', 'missing', 'failed'] as const;
export type MediaAssetState = (typeof MEDIA_ASSET_STATES)[number];

/**
 * `media_assets.role` —— `CHECK (role IN (...))`，与建表语句逐字一致。
 *
 * `role` 在 DTO 上仍声明为 `string`（见 `NoteAsset.role`）：收窄它会让**旧库里的老角色**
 * 在前端变成类型错误，而消费方本来就该按"我认识的那几个"去挑，认不出的忽略即可。
 * 这个常量的用途是让写入方有一份可核对的清单，不是给读取方做穷举。
 */
export const MEDIA_ASSET_ROLES = [
  'original',
  'audio16k',
  'transcode',
  'thumbnail',
  'peaks',
  'screenshot',
  'subtitle',
  'export',
  'archive',
] as const;
export type MediaAssetRole = (typeof MEDIA_ASSET_ROLES)[number];

/** `notes.kind` 的运行时判据（DB 的 CHECK 约束已经保证，这里是把它告诉编译器的那一步）。 */
export function isNoteKind(v: string): v is NoteKind {
  return (NOTE_KINDS as readonly string[]).includes(v);
}

/** `notes.status` 的运行时判据。 */
export function isNoteStatus(v: string): v is NoteStatus {
  return (NOTE_STATUSES as readonly string[]).includes(v);
}

/** `media_assets.state` 的运行时判据。 */
export function isMediaAssetState(v: string): v is MediaAssetState {
  return (MEDIA_ASSET_STATES as readonly string[]).includes(v);
}

/* ------------------------------ F1/F2 import ------------------------------ */

/**
 * `POST /api/notes/import`
 *
 * One endpoint for both F1 (paste a URL) and F2 (a local file): `input` is either an
 * absolute local path or a URL, distinguished server-side by a scheme test. Local paths
 * must resolve inside a configured import root — otherwise this endpoint would be an
 * arbitrary-file-read primitive.
 */
export interface ImportNoteRequest {
  /** Absolute local path, or a URL (`https://…`). */
  input: string;
  /** Optional display title; defaults to the basename / remote title. */
  title?: string;
  /**
   * BCP-47 language, or `"auto"`.
   *
   * ⚠️ NEVER leave this empty for Whisper. With no `-l`, whisper.cpp silently TRANSLATES
   * non-English audio into English — a Chinese recording comes back as English prose and
   * the user never asked for a translation. Callers must send an explicit value.
   */
  language?: string | null;
}

export interface ImportNoteResponse {
  noteUid: NoteUid;
  /** ULID of the transcription job; progress arrives over the global SSE stream. */
  jobUid: string;
  status: NoteStatus;
}

/* -------------------------------- F5 notes -------------------------------- */

/**
 * `GET /api/notes` 的一行。**逐字对齐 `rest/notes.ts` 里那个 `.map()` 的输出。**
 *
 * ⚠️ `starred` / `tags` 是 T-151 ② 补的：daemon **一直在发**，这份契约里一直没有。
 * 与 `NoteDetail` 的 `bodyJson` 是同一族缺陷，只是没造成用户可见的后果 ——
 * 因为**也没有任何人 import 过这个类型**。
 */
export interface NoteListItem {
  uid: NoteUid;
  title: string;
  status: NoteStatus;
  kind: NoteKind;
  language: string | null;
  durationMs: number | null;
  starred: boolean;
  /** 与 `NoteDetail.tags` 同一条约定：**永远是数组**，无标签时是 `[]`。 */
  tags: NoteTag[];
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /api/notes` 的响应。
 *
 * ★ T-157 ③：这里原本只有 `notes`。端点只认 `limit`（默认 50 / 上限 200）且没有
 * `offset`，前端也不传 `limit` —— 于是**第 51 条起在界面上永远看不到，
 * 没有翻页、没有"加载更多"、没有总数、一个字的提示都没有**。
 * 静默截断比"显示错的"更难发现：页面上每一条都是对的，只是不全，
 * 用户无从知道自己少看了什么。
 *
 * 三个新字段是**契约层面的**修复：`total` 让"还有更多"可说，`offset`+`hasMore`
 * 让它可翻。daemon 的响应对象显式标注成这个类型，少一个键就编译不过
 * （见 `rest/notes.ts` 文件头那张表）。
 */
export interface ListNotesResponse {
  notes: NoteListItem[];
  /** 当前筛选条件下的**总条数**（不受 limit/offset 影响）。 */
  total: number;
  /** 本次实际使用的 limit（服务端会夹到上限，可能小于请求值）。 */
  limit: number;
  /** 本次的偏移量。 */
  offset: number;
  /** `offset + notes.length < total`。**由服务端算**，不让每个调用方各推一遍。 */
  hasMore: boolean;
}

export interface NoteAsset {
  uid: string;
  /** `MEDIA_ASSET_ROLES` 里的一个，例如 `original` / `audio16k` / `peaks`。 */
  role: string;
  /**
   * ⚠️ **可空**。`media_assets.mime` / `bytes` 两列都没有 NOT NULL，
   * 而录音与部分归档路径确实不填。原来这里写的是 `string` / `number`（必填），
   * 那是**契约在替一个不成立的事实背书**：消费方按"一定有"写代码，真实响应里是 `null`。
   */
  mime: string | null;
  bytes: number | null;
  durationMs: number | null;

  /**
   * ★ 这份资产现在能不能用（`media_assets.state`，`MEDIA_ASSET_STATES`）。
   *
   * ─── 这个字段缺席过一次，代价是 F5 的招牌功能从未工作过 ───────────────────────
   * `apps/web` 的手抄 DTO 里 `state` 是**必填**，而 daemon 的 `GET /api/notes/:uid`
   * **一次都没发过它**；两边之间没有任何东西对过一遍，`tsc` 也不可能发现
   * （手抄的镜像与服务端之间不存在类型连接）。后果是 `a.state === 'ready'` **恒 false**
   * → `<audio>` 元素根本不进 DOM → 播放键点了什么都不发生、点转写段落也不跳，
   * **零报错、零提示**。「转写稿 ↔ 音频时间轴联动」在真实环境里从未工作过（T-139 A1）。
   *
   * 这一次它出现在**共享契约**里，daemon 与 web 都 import 这一份 ——
   * 少发一个字段是编译错误，读一个不发的字段也是编译错误。这才是那个洞真正被堵上。
   *
   * ─── 声明为**必填**，理由 ────────────────────────────────────────────────────
   * 服务端是这份契约的唯一生产方，它没有"不知道"这个选项（`state` 是 NOT NULL 列）。
   * 可选会让服务端可以合法地不发 —— 那正是上面那个事故。
   * **消费方**那一侧的规矩是另一条：拿到老响应（真的没有这个键）时按**可用**处理，
   * 「字段缺失」绝不能读成「不可用」。两条规矩不冲突：契约要求发，消费方宽容地读。
   */
  state: MediaAssetState;

  /**
   * Ready-to-use media URL, always `/media/asset/<ulid>`.
   *
   * The server returns a URL rather than a path, and `/media` accepts ONLY an asset uid —
   * never a filesystem path. That removes path traversal from this surface by construction
   * instead of by validation.
   */
  url: string;
}

/** A tag attached to a note. */
export interface NoteTag {
  uid: string;
  name: string;
  color: string | null;
}

export interface NoteDetail {
  uid: NoteUid;
  title: string;
  status: NoteStatus;
  kind: NoteKind;
  language: string | null;
  durationMs: number | null;
  summaryMd: string | null;
  assets: NoteAsset[];
  transcriptUid: string | null;
  segmentCount: number;
  createdAt: string;

  /**
   * Tags on this note. ALWAYS an array — `[]` when there are none, never absent.
   *
   * Added after a real-browser run found the note detail page white-screening with
   * "Cannot read properties of undefined (reading 'map')": `NoteDetailPage` renders
   * `<TagEditor tags={n.tags} />`, the daemon never returned the field, and nothing in
   * the contract declared it. Three parties, three different assumptions, one blank page.
   * Declaring it here — and requiring [] rather than optional — is what stops that
   * recurring: an absent array is indistinguishable from "no tags" at the call site,
   * so the schema forbids absence.
   */
  tags: NoteTag[];

  /** Whether the note is starred. Always present. */
  starred: boolean;

  /** Folder this note lives in, or null for the root. Always present. */
  folderUid: string | null;

  /**
   * ★ 笔记正文（TipTap 文档 **对象**，不是字符串）。没有正文时 `null`。
   *
   * ─── 这个字段缺席的代价：用户的正文一直在无声丢失 ────────────────────────────
   * 写路径一直是真的：编辑器 800 ms 防抖 → `PATCH /api/notes/:uid` → `notes.body_json`
   * **真落库**（PATCH 的响应甚至回 `hasBody:true`）。读路径**从来没接上** ——
   * `GET /api/notes/:uid` 的响应里没有这个键，全仓也没有第二个返回它的 GET。
   * 于是：用户写完 → 自动保存成功 → **刷新/重进，编辑器是空的**。
   * 数据一个字节没丢，界面上却完全看不出这一点，用户只会认为"它没保存"（T-139 A1b）。
   *
   * ⑤C「写得进读不回」的第七例，与该族第一例 `textRaw` 完全同形。
   *
   * ─── 为什么是 `unknown` 而不是一个结构化的文档类型 ──────────────────────────
   * 富文本文档的 schema 由编辑器（TipTap/ProseMirror）定义，随扩展变化。
   * 在这里写一份"我们以为的形状"，下次加个节点类型就是一份**描述了不存在事实的契约**——
   * 本仓最贵的那一类。`unknown` 迫使消费方在自己那一层解释它，且不会撒谎。
   *
   * ⚠️ 必须发**解析后的对象**，不是那一列的字符串原文：编辑器要的是文档对象，
   * 发字符串会变成"一段显示为 JSON 源码的正文"。解析失败一律 `null`（与 `words` 同约定）——
   * 坏数据宁可当"没有正文"，也绝不原样发出去让编辑器崩在用户脸上。
   */
  bodyJson: unknown | null;

  /**
   * 这条笔记能不能重新转写 —— **由服务端判定并明说**，客户端不要自己猜。
   *
   * 判据只有一条：这条笔记记录了原始输入（`media_sources.input_url` 非空）。
   * 早期本地导入把它存成 null，那种笔记重跑必然 409 `NO_SOURCE_INPUT` ——
   * 让按钮亮着然后报错，不如一开始就告诉客户端它不可用。
   *
   * 与 `NoteAsset.state` 同一条分工：**契约要求服务端必发**；
   * 而消费方拿到老响应（真的没有这个键）时按**可以重跑**处理 ——
   * 「字段缺失」不等于「不能重跑」，那会对所有旧数据静默藏掉一个本来能用的功能。
   */
  canRetranscribe: boolean;
}

/* ------------------------------- transcript ------------------------------- */

export interface TranscriptMeta {
  uid: string;
  engineId: string | null;
  modelId: string | null;
  language: string | null;
  status: string;
  progress: number;
  durationMs: number | null;
  /** Measured real-time factor for this run. Null until the run completes. */
  rtf: number | null;
  segmentCount: number;
}

/** Segment flags bitfield (D-02). */
export const SEGMENT_FLAG = {
  HALLUCINATION: 1 << 0,
  LOW_CONFIDENCE: 1 << 1,
  /** Human-confirmed. Two-pass merge must NEVER overwrite a segment carrying this. */
  CONFIRMED: 1 << 2,
  SILENCE: 1 << 3,
} as const;

export interface TranscriptSegment {
  seq: number;
  /** Integer milliseconds (D-02 §1.1). Float seconds accumulate drift over long audio. */
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  chunkIdx: number | null;
  flags: number;
  /** True when a human edited this segment; drives "your N edits were preserved". */
  edited: boolean;
}

export interface GetTranscriptResponse {
  transcript: TranscriptMeta | null;
  segments: TranscriptSegment[];
}

/* -------------------------------- probe ----------------------------------- */

/**
 * `POST /api/notes/probe` — look before you leap.
 *
 * Paste a link, get title/duration/source back in seconds, THEN decide whether to import.
 * Without it the user has to download hundreds of MB just to discover they pasted the
 * wrong link. Read-only: creates no note and enqueues no job (that is what `import` does).
 */
export interface ProbeRequest {
  /** URL, or an absolute local path inside a configured import root. */
  input: string;
}

export interface ProbeResult {
  title: string;
  author: string | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
  site: string | null;
  /** Which media adapter claimed the input, e.g. "direct-http", "yt-dlp", "rss". */
  adapterId: string;

  /**
   * ⚠️ READ THIS BEFORE USING: `false` means "we do not know", NOT "no login needed".
   *
   * `MediaInfo` carries no authentication signal and the probe stage cannot obtain one,
   * so the daemon returns `false` rather than guessing. Guessing `true` would scare users
   * away from links that work fine, and a fabricated `requiresAuth` is worse than not
   * having the field at all.
   *
   * Therefore the UI MUST NOT render this as "no login required". At most, render
   * something when it is `true` — and today nothing sets it to `true`. Making this
   * meaningful requires each adapter to report it during probe (a pipeline-side change).
   */
  requiresAuth: boolean;

  /** True for RSS feeds / playlists — one paste may import many items. */
  isCollection: boolean;
  /** How many media items this input yields; 1 for a single file. */
  mediaCount: number;
  sourceKind: 'url' | 'local';
  publishedAt?: string | null;
  description?: string | null;
}

/**
 * 422 `NO_MEDIA_SOURCE` — no adapter could handle the input.
 *
 * Carries a `remediation` (e.g. `installSiteExtractor`) so the UI offers a fix rather
 * than a dead end; see `Remediation` in events.ts.
 */

/* ----------------------------- retranscribe ------------------------------- */

/**
 * `POST /api/notes/:uid/retranscribe` — re-run transcription on an EXISTING note.
 *
 * Adopted verbatim from `oss-scout`'s implementation (ADR-012 process: his shipped shape
 * wins over my preference).
 *
 * Distinct from `POST /api/notes/import`, which creates a NEW note. This one reuses the
 * note, its media and its recorded source input, so:
 *   - the note's uid, tags, stars and folder survive
 *   - `resumableTranscript()` reuses an unfinished transcript and skips completed chunks,
 *     which is what makes "cancel, then continue later" work (D-01 §4.5)
 *   - the user's edited segments are preserved by the two-pass time-based merge
 *
 * 409 `NO_SOURCE_INPUT` when the note has no recorded original input — e.g. a recording
 * whose source was never a re-fetchable URL. There is nothing to re-run from, and the UI
 * must not offer the button in that case.
 */
export interface RetranscribeRequest {
  /**
   * Language override for this run. Omit to reuse the note's stored language.
   *
   * Same hazard as import: whisper.cpp with no `-l` silently TRANSLATES non-English audio
   * into English. The daemon falls back to `note.language`, so omitting this is safe here —
   * but never send an empty string.
   */
  language?: string;
}

export interface RetranscribeResponse {
  /** ULID of the new transcription job; progress arrives on the global SSE stream. */
  jobUid: string;
  noteUid: NoteUid;
}

/* --------------------------------- search --------------------------------- */

export const SEARCH_SOURCES = ['segment', 'note'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

export interface SearchHit {
  noteUid: NoteUid;
  noteTitle: string;
  transcriptUid: string | null;
  seq: number | null;
  /** Timestamp of the hit, so the UI can jump straight to that moment in the audio. */
  startMs: number | null;
  endMs: number | null;
  snippet: string;
  /** bm25 score. Lower is better (SQLite FTS5 convention) — do not sort descending. */
  score: number;
  source: SearchSource;
}

/**
 * Which search backends are actually live; the UI must not offer a dead mode.
 *
 * ── ★ T-200 A-2：这份声明曾经是**双向说谎**的 ────────────────────────────────────
 *
 * · `tokenizer` 声明在这里，**全仓没有任何生产者** —— daemon 发的键叫
 *   `chineseTokenizer`（而且是 boolean）。按契约读 `resp.modes.tokenizer` 恒得 `undefined`。
 * · 反过来，daemon **真发**的 `hybrid` / `semanticReason` 契约里没有，
 *   于是前端只能 `as Record<string, unknown>` 硬取（`features/search/modes.ts`）——
 *   **一个类型断言，正是"契约在说谎"的另一半**。
 *
 * 收在 `tokenizer` 这一侧而不是 boolean：它比"加载了没有"多说一句
 * **"降级成了什么"**，而那正是用户需要知道的（trigram 下中文双字词可能搜不到）。
 */
export interface SearchModeReport {
  keyword: boolean;
  semantic: boolean;
  /** Hybrid (keyword + vector) — false until an embedding step exists. */
  hybrid: boolean;
  /** Why semantic/hybrid is unavailable, in the server's own words. Null when it is. */
  semanticReason: string | null;
  /** "simple" = libsimple Chinese segmentation; "trigram" = degraded fallback. */
  tokenizer: 'simple' | 'trigram';
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  modes: SearchModeReport;
}

/* --------------------------------- errors --------------------------------- */

/** Error codes this domain adds on top of the download/model codes in jobs.ts. */
export const NOTE_ERROR_CODES = [
  'BAD_REQUEST',
  'BAD_PATH',
  'PATH_NOT_ALLOWED',
  'NOTE_NOT_FOUND',
  'NO_SOURCE_INPUT',
  'NO_MEDIA_SOURCE',
  'METHOD_NOT_ALLOWED',
  'UNAUTHENTICATED',
] as const;
export type NoteErrorCode = (typeof NOTE_ERROR_CODES)[number];

/** Re-exported for convenience: import errors carry a remediation the UI renders. */
export type { Remediation };

/** Endpoint table for this domain, mirroring `ENDPOINTS` in api.ts. */
export const NOTE_ENDPOINTS = [
  { method: 'POST', path: '/api/notes/import', name: 'importNote' },
  { method: 'GET', path: '/api/notes', name: 'listNotes' },
  { method: 'GET', path: '/api/notes/:uid', name: 'getNote' },
  { method: 'DELETE', path: '/api/notes/:uid', name: 'deleteNote' },
  { method: 'GET', path: '/api/notes/:uid/transcript', name: 'getTranscript' },
  { method: 'POST', path: '/api/notes/probe', name: 'probeInput' },
  { method: 'POST', path: '/api/notes/:uid/retranscribe', name: 'retranscribeNote' },
  { method: 'GET', path: '/api/search', name: 'search' },
  { method: 'GET', path: '/api/selfcheck', name: 'selfcheck' },
  { method: 'GET', path: '/media/asset/:uid', name: 'mediaAsset' },
] as const;
