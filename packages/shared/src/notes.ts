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

import type { AsrEngineId } from './backends.js';
import type { Remediation } from './events.js';
import type { PipelineJobKind } from './jobs.js';

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
 * ★ `'failed'` 是**读的时候算出来的，不是库里存着的**（#98）。
 *
 * 这一档在 `notes.status` 的 CHECK 约束里从第一天就在，`NotesListPage` 也一直
 * 渲染它（红色的「失败」）—— 但**全仓没有任何一处写它**：`updateNote()` 只有
 * 三四个调用点，取值只有 `processing` / `ready` / `partial`。
 * **接收端早就建好了，发送端从来没接上**，于是一条转写失败的笔记在列表里
 * 永远写着「处理中」。
 *
 * 修法**不是**在失败路径上补一句 `updateNote({status:'failed'})`，理由两条：
 *   1. 那样只能救以后的数据；`:10000` 上那个库里已经卡住的几条，以及所有
 *      用户机器上已经卡住的，仍然会永远转圈 —— 除非再写一次性迁移。
 *   2. 「失败」本来就是**从 job 状态推出来的结论**，不是笔记自己的独立事实。
 *      存一份就等于建立第二个真相，两者迟早分叉（本仓已经为这个形状付过多次账）。
 *
 * 所以 daemon 在序列化时问一次 `jobs` 表：**这条笔记最近一条转写任务是不是
 * 终态 `failed`，而库里存的又还是 `processing`** —— 是就如实报 `'failed'`。
 * 一个字节都不写库，且**修复之前就坏掉的数据同时被救回来**。
 * （同一条路子在 #29 的「重新转写」判据上用过：`canRetranscribe` 也是读时真解析一次。）
 *
 * ⚠️ 这一档**只从 `processing` 升上来**。一条已经 `ready` 的笔记重跑失败时仍然是
 * `ready` —— 它的稿子确实还在、读得了；那次失败由 `NoteDetail.lastFailure` 说，
 * 不该把整条笔记标红。
 */

/**
 * ★★ API **报出来**的笔记状态：库里存的那几档 + 从 job 状态推出来的那几档。
 *
 * ## 为什么必须是两个常量，而不是把新档塞进 `NOTE_STATUSES`
 *
 * `NOTE_STATUSES` 有一条**已经在跑的守卫**钉着它：`packages/db/src/schemaContract.test.ts`
 * 断言 `CHECK (status IN (...))` 的取值集合与它**逐字相等**。也就是说那个常量的职责
 * 是"这一列可以存什么"，而不是"接口可以报什么"。往里加 `cancelled` 会当场把那条
 * 守卫弄红 —— 而它红得对：我们**永远不会把这几个值写进库**。
 *
 * 唯一的另一条路是给 CHECK 做迁移把它们放进去。那是**另一个方向的不诚实**：
 * schema 会声称"这一列可能出现 cancelled"，而全仓没有、也不打算有任何一处这么写。
 *
 * → 所以分开：`NOTE_STATUSES` 继续如实描述那一列，这一份如实描述**响应**。
 *   两者是子集关系（`NoteStatus ⊂ NoteViewStatus`），消费方读的是这一份。
 *
 * ## 新增这三档各自在修哪一句谎话
 *
 * 三条**形状完全相同**（都是"job 已经不在跑了，而笔记还写着「处理中」"），
 * 所以一次判完，不分两轮：
 *
 * | 档 | 修之前用户看到的 |
 * |---|---|
 * | `cancelled` | 自己点了取消，笔记**永远**停在「处理中」。列表行里连进度行都没有（终态不渲染），**整行零解释**。 |
 * | `blocked` | 同一行里**自相矛盾**：芯片写「处理中」，紧挨着的进度行写「暂时无法继续」。 |
 * | `paused` | 同上：芯片「处理中」，进度行「已暂停」。 |
 *
 * ⚠️ `cancelled` **刻意不并进 `failed`**：「我自己取消的」和「它失败了」是两件事，
 * 前者不需要「重试」当主按钮，需要的是「重新转写」。并档能少改三处，
 * 代价是让产品对用户自己刚做过的动作说错话 —— 那正是这一族缺陷的定义。
 *
 * ⚠️ `blocked` **刻意不并进 `failed`**：它在等一个可修复的前置条件（没装 ASR 模型），
 * 条件满足会自动继续。报成失败是把等待态说成终局。
 *
 * ## 判据由 daemon 一处算
 *
 * `apps/daemon/src/jobs/noteStatus.ts` 的 `effectiveNoteStatus()`，
 * 对 `JobState` 做**穷尽 switch** —— 加一个 job 状态就必须在那里显式回答
 * "这条笔记该怎么说"，而不是悄悄落进 default。
 */
export const NOTE_VIEW_STATUSES = [...NOTE_STATUSES, 'cancelled', 'blocked', 'paused'] as const;
export type NoteViewStatus = (typeof NOTE_VIEW_STATUSES)[number];

/*
 * ⚠️ 这里**刻意没有** `isNoteViewStatus()`。
 *
 * 我顺手写了一个"对称一点"，`check:orphans` 当场报它零调用方 —— 报得对：
 * 没有任何一处需要把一个**不可信的字符串**收窄成 `NoteViewStatus`。
 * 收窄发生在读**列**的时候（那是 `isNoteStatus`），而这几档新值压根不来自列，
 * 它们由 daemon 自己算出来，类型上就是对的。
 * 一个"看起来该有"的判据函数摆在这儿，只会让下一个人以为存在一条它守着的路。
 */

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
  /**
   * ⚠️ 是 `NoteViewStatus` 而**不是** `NoteStatus`：这里可能出现库里永远不会存的
   * `failed` / `cancelled` / `blocked` / `paused` —— 它们由 daemon 在读的时候
   * 从这条笔记最近一条转写任务算出来。见 `NOTE_VIEW_STATUSES` 的说明。
   */
  status: NoteViewStatus;
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
   * ★ 盘上这份文件**上一次被换掉**的时刻（epoch ms），没换过就是 `null`（#96②）。
   *
   * ─── 它对着的那件事 ─────────────────────────────────────────────────────────
   * 网络导入的笔记点「重新转写」会**重新下载一次源**，落在与上次完全相同的路径上，
   * `rename(2)` 静默覆盖。覆盖本身是对的（用户点的就是"重来一次"，而且只在
   * 重新取到之后才发生，文件永远可取）——**不对的是没人说过这件事**：
   * `uid` / `rel_path` / `url` 全不变，界面一个字不提，
   * 如果远端内容改过，用户存的那一份就这么被替掉了。
   *
   * 所以这条不是给程序判断用的，是**给用户判断用的**：他要回答的是
   * "我上次听到的那一版还在不在"。`null` 与"有个时间"是两句不同的话，
   * 别把它折叠成布尔，更别在缺失时当成"没换过"（老 daemon 不发它 = **不知道**）。
   *
   * ⚠️ 语义是「**这个路径上的文件被换掉了**」，不是「这一行被改过」：
   * 本地导入 / 上传 / 录音重跑时文件本来就在 media/ 里、根本没被动过，那种情况恒为 `null`。
   */
  replacedAt: number | null;

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
  /** 同 `NoteListItem.status`：**报出来的**状态，含读时算出来的那几档。 */
  status: NoteViewStatus;
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
   * ⚠️ **判据换过一次（#95），别按旧描述理解这个字段。**
   * 它原来是 `media_sources.input_url != null`，也就是**只判非空**。
   * 而那一列存的是绝对路径，且全仓没有任何一处在数据目录搬家时更新它 ——
   * 搬完家每条笔记都成了"字段非空、路径失效"：按钮亮着、POST 回 202、
   * job 事后死在 `no media source can handle this input`。
   * `[实测]` demo 库里两条笔记此刻就是这个形态。
   *
   * 现在的判据是**真的去解析一次**（`daemon/src/media/retranscribeSource.ts`）：
   *   · 本地来源 → `input_url` 打不开就退回本笔记的 `role='original'` 归档原件，
   *     两档都落空才 `false`；
   *   · 链接来源 → 恒 `true`，**而且这是"未知"不是"已验证"**：不做网络探测，
   *     否则断网/限流/防盗链都会被误报成"这条不能重跑"。
   *
   * 为 `false` 时 `retranscribeBlocked` **必然非 null**，反之亦然 —— 两个字段是一对。
   *
   * 与 `NoteAsset.state` 同一条分工：**契约要求服务端必发**；
   * 而消费方拿到老响应（真的没有这个键）时按**可以重跑**处理 ——
   * 「字段缺失」不等于「不能重跑」，那会对所有旧数据静默藏掉一个本来能用的功能。
   */
  canRetranscribe: boolean;

  /**
   * 不能重跑时**为什么** —— 能重跑时为 `null`。
   *
   * ─── 为什么光把 `canRetranscribe` 修准是不够的 ──────────────────────────────
   * 一颗**无声变灰**的按钮，和一颗**亮着但点下去必死**的按钮，是同一种不诚实：
   * 两种情况下用户都只能猜。而客户端也不该自己编原因 ——
   * 它不知道服务端找过哪些位置，编出来的必然是假诊断。
   *
   * `messageZh` / `message` 可**直接展示**；`tried` 是找过的每个绝对路径，
   * 用户照着它能自己确认到底是"文件没了"还是"我们找错了地方"
   * （`/media/asset/:uid` 已经为同一课付过账，见 T-136）。
   */
  retranscribeBlocked: RetranscribeBlocked | null;

  /**
   * ★ 这条笔记上**最近一次终态失败**的流水线任务；没有就是 `null`（#98）。
   *
   * ─── 为什么这个字段必须存在 ────────────────────────────────────────────────────
   * 在它之前，一次转写失败在**整个产品里只活几秒钟**：右下角一条 toast，
   * 刷新即无。笔记详情页对此**一个字都不显示**，笔记列表则因为 `notes.status`
   * 永远停在 `processing` 而写着「处理中」—— 也就是说，对一件已经彻底结束的事，
   * 产品同时给出「什么都没发生」和「还在进行中」两个说法，两个都不是真的。
   *
   * `status` 那一半由 daemon 在**读的时候**自愈（见 `status` 字段的说明），
   * 它回答「这条笔记现在是什么状态」。这个字段回答另外两个问题：
   * **为什么失败**（`messageZh` / `message` 可直接展示）与
   * **能对哪条任务动手**（`jobUid` 就是任务中心那条，可以直接重试）。
   * 三件事缺一件，用户就还是只能猜。
   *
   * ⚠️ 判定与 `status` 用的是**同一份 job 快照**（同一次请求里的同一次查询），
   * 所以不会出现「状态说失败、底下却没有原因」这类自相矛盾。
   *
   * ⚠️ **它不等于「这条笔记坏了」**：一条已经转写好的笔记（`status: 'ready'`）
   * 重跑失败时 `status` 保持 `ready`（稿子确实还在、读得了），而这个字段非 null。
   * 消费方别把它写成「有 lastFailure 就当整条笔记不可用」。
   */
  lastFailure: NoteFailure | null;
}

/**
 * `NoteDetail.lastFailure` 的形状。
 *
 * 字段只有**服务端真的知道**的那些：`jobs` 表那一行的 uid / 类型 / 错误码 /
 * 两份文案 / 结束时间。**没有 `retryable`** —— 对一条已经处于 `failed` 终态的任务
 * 它恒为 false（自动重试的预算已经用完，或这类错误本来就不该重试），
 * 发一个恒定值只会让消费方以为它带着信息。
 * 「还能不能再试一次」的答案在别处：`POST /api/jobs/:uid/retry`
 * （`queue.requeue()` 把 attempt 归零）对**任何**终态任务都成立，不需要这里再说一遍。
 */
export interface NoteFailure {
  /** 失败的那条任务（`jobs.uid`）。UI 直接拿它调 `POST /api/jobs/:uid/retry`。 */
  jobUid: string;
  /** 决定标题说「转写失败」还是「生成思维导图失败」—— 两者的下一步动作不同。 */
  kind: PipelineJobKind;
  /** `jobs.error_code`，例如 `NO_MEDIA_SOURCE` / `RUNNER_ERROR`。 */
  code: string;
  /** 英文 / 技术原文，可直接展示。 */
  message: string;
  /**
   * 中文文案，可直接展示。
   *
   * ⚠️ 它**不是** `message` 的原样拷贝。曾经是 —— `pipelineJobOf()` 把
   * `error_detail`（一个英文串）同时填进两个字段，于是中文界面上的任务错误全是英文，
   * 而且没有任何东西会因此报错。现在两份都由 daemon 的 `jobErrorTextOf()` 一处产出。
   */
  messageZh: string;
  /** 这条任务结束的时间（ISO 8601）。 */
  at: string;
}

/** `NoteDetail.retranscribeBlocked` 的形状。 */
export interface RetranscribeBlocked {
  /**
   * `NO_SOURCE_INPUT`（压根没记原始输入）
   * 或 `SOURCE_UNREADABLE`（记了，但那个位置读不到，且没有可回退的归档原件）。
   *
   * 与绕过按钮直接调重跑端点时拿到的 `error.code` **是同一套值** ——
   * 事前禁用与事后拒绝必须给同一个诊断，否则用户会当成两个不同的毛病。
   */
  code: 'NO_SOURCE_INPUT' | 'SOURCE_UNREADABLE';
  message: string;
  messageZh: string;
  /** 找过的绝对路径。空数组 = 没有任何候选落在数据目录内。 */
  tried: readonly string[];
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

  /**
   * ★ 只为**这一次重跑**指定引擎。省略 = 后端按语言自动选（今天的行为，不变）。
   *
   * ## 为什么类型是 `AsrEngineId` 而不是 `string`
   *
   * daemon 侧收的是**未校验的自由字符串**（`rest/content.ts` 只判 `typeof === 'string'`），
   * 而 `pipeline/setup.ts` 里 `candidates.find(c => c.engine.id === override.engineId && c.available)`
   * 找不到时**不报错、不警告、不记日志**，直接落回 `pickEngine(language)` 自动选择。
   * 也就是说：**拼错一个 id 与选对一个 id，在响应上完全无法区分** ——
   * 用户以为自己换到了 paraformer，实际跑的还是 whisper.cpp。
   *
   * 所以这里收窄到联合类型：**拼错的 id 在编译期就过不去**，
   * 这是这条链路上唯一一道真的会拦住人的闸（后端那道不存在）。
   *
   * ## ⚠️ 类型对了也不够 —— 调用方必须自己按 `available` 过滤
   *
   * 联合类型只能保证"这个 id 后端认识"，保证不了"这台机器上它装了"。
   * `paraformer` 需要 `OPENMEMO_PARAFORMER_DIR` 指向模型目录，没设就不进候选，
   * 于是它同样走上面那条静默回落。可用性只有一个来源：
   * `GET /api/health` 的 `pipeline.engines[]`（`{id, available, reason?}`）。
   *
   * ## 事后怎么确认真的换了
   *
   * **不是靠 SSE**：`TranscribeStartedEvent`（见 events.ts）只有
   * `modelId`，**没有 `engineId`**。唯一的事后凭据是
   * `GET /api/notes/:uid/transcript` 的 `transcript.engineId` ——
   * 那一列由 runner 写入**实际选中**的引擎（`chosen.engineId`），不是请求里的那个。
   * 静默回落发生时，这两个值会不一样，而这是它唯一看得出来的地方。
   */
  engineId?: AsrEngineId;
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
/**
 * 「为什么没有语义检索」—— **机器可读**，措辞归 `apps/web` 的两份 locale（#112）。
 *
 * ## 为什么不是 `semanticReason: string`
 *
 * 上一版这一格是一句**中文散文**（`sqlite-vec 未加载`），而 `SearchPage` 把它插进
 * `search.modesUnavailable`（**一句英文**）的 `{{reason}}` 里，逐字渲染成：
 *
 * ```
 * Semantic search is unavailable: sqlite-vec 已加载，但尚无 embedding 生成环节（链路未接通）
 * ```
 *
 * 它符合「CJK 只出现在数据里」的表面判据（`en.json` 里一个汉字都没有），
 * **但对英文用户就是半句中文**。
 *
 * ★ 只有两格，而且**必须是两格**：向量扩展装没装上，对用户的下一步是不同的答案 ——
 * 装上了只差链路 ⇒ **他做什么都没用，等产品接通**；没装上 ⇒ 那是一个环境问题。
 * 合并成一句「语义检索不可用」会把这条区别抹掉。
 */
export type SemanticUnavailableReason =
  | {
      /**
       * `sqlite-vec` 加载上了，**但全仓没有任何地方生成 embedding** —— 链路没接通。
       * ⚠️ 这一档要说清「**不是你的环境问题，等产品接通**」，别让用户去折腾扩展。
       */
      readonly kind: 'no_embedding_stage';
    }
  | {
      /** `sqlite-vec` 扩展没加载上 —— 向量路连地基都没有。 */
      readonly kind: 'vector_extension_not_loaded';
    };

export interface SearchModeReport {
  keyword: boolean;
  semantic: boolean;
  /** Hybrid (keyword + vector) — false until an embedding step exists. */
  hybrid: boolean;
  /**
   * Why semantic/hybrid is unavailable. Null when it is available.
   *
   * ⚠️ **机器可读，不是一句话**（#112）：它会被插进 `search.modesUnavailable`
   * 那句**英文**里，塞一句中文进去就是给英文用户一句半中文的话。
   */
  semanticReason: SemanticUnavailableReason | null;
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
