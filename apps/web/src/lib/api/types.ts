/**
 * 笔记域 DTO。
 *
 * ─── ✅ T-151 ②：`NoteDetail` / `MediaAssetDto` **不再是手抄的镜像** ───────────────
 * 这里原来写着「权威定义应当在 `@openmemo/shared`，这里是本地镜像让前端能先跑，
 * 字段名保持一致以便日后直接替换」。**那句"以便日后替换"没有失效条件**，
 * 于是这份镜像和 daemon 之间**没有任何东西连着** —— 不是断言写松了，
 * 是编译器**结构上看不见**这条缝。实测代价（T-139）：
 *
 * | | 这份镜像声明 | daemon 实际发 | 后果 |
 * |---|---|---|---|
 * | `state` | **必填** | 不发 | `a.state === 'ready'` 恒 false → `<audio>` **从未进过 DOM**，F5 招牌功能从未工作过 |
 * | `bodyJson` | 必有 | 不发 | 编辑器初值恒空 → **用户写的正文自动保存了、刷新就没了** |
 * | `url` | 没有 | **一直在发** | 前端只好自己再拼一次路径 |
 *
 * 现在 `NoteDetail` / `MediaAssetDto` 直接是 `@openmemo/shared` 的那一份，
 * daemon 的 `rest/notes.ts` 也把响应对象标注成同一个类型。判据因此变成**编译期**的：
 * daemon 少发一个字段 → daemon 编译失败；这里读一个 daemon 不发的字段 → web 编译失败。
 *
 * ✅ **T-150 补完了 T-151 留下的那一半**：`NoteSummary`（`GET /api/notes` 那份）
 * 原来仍是手抄的，而且**已经在分叉** —— `source` / `coverAssetUid` / `folderUid`
 * 三个字段 daemon 的列表端点一个都不发，于是 `NotesListPage` 的站点徽章
 * **在真实环境里恒不渲染**（用了可选链所以不崩，安静得多）。
 * 现在它直接是 `@openmemo/shared` 的 `NoteListItem`，理由与上表逐条对应。
 */

import type {
  NoteAsset,
  NoteDetail as NoteDetailContract,
  NoteKind as NoteKindContract,
  NoteListItem,
  NoteStatus as NoteStatusContract,
  RetranscribeBlocked as RetranscribeBlockedContract,
} from '@openmemo/shared';

import type { TranscriptSegmentDto } from '../events/types';

/**
 * D-02 §1.3 `notes.status`。**取值来自 shared，而 shared 抄的是建表语句的 CHECK 约束。**
 *
 * （顺带记一笔：shared 里这个联合原来写的是 `draft|importing|transcribing|structuring|ready|failed`，
 * 中间三个**在 CHECK 约束里根本不存在**，写进库会被 SQLite 当场拒。
 * 它能错这么久是因为**全仓没有任何一处 import 过它** —— 一份没人用的契约不会被证伪。
 * T-151 ② 已按建表语句订正。）
 */
export type NoteStatus = NoteStatusContract;

export type NoteKind = NoteKindContract;

/**
 * `GET /api/notes` 的一行 —— **就是 daemon 那一份**（`@openmemo/shared` 的 `NoteListItem`）。
 *
 * ─── ✅ T-150：这里原来是**手抄件，而且已经分叉** ────────────────────────────────
 *
 * 上面文件头那段注释（T-151 ② 写的）把这条列成了"没有被编译期保护覆盖"的剩余项，
 * 并写明"收敛它要连带改 `NotesListPage.tsx`"。这一轮把它收了。
 *
 * 手抄件多出来的三个字段，daemon 的列表端点**一个都不发**：
 *
 * | 手抄件声明 | daemon 的 `.map()` | 后果 |
 * |---|---|---|
 * | `source: {...} \| null` | 不发 | `NotesListPage.tsx:157` 的站点徽章（`n.source?.site`）**在真实产品里从不渲染** |
 * | `coverAssetUid` | 不发 | 只有 mock 造得出来 |
 * | `folderUid` | 不发 | 同上；筛文件夹靠的是 `?folder=` 查询串，不是这个字段 |
 *
 * 它们没崩，是因为都用了可选链 —— **和 `<audio>` 从未进过 DOM 是同一族缺陷**，
 * 只是这一族的症状是"一个徽章永远不出现"，安静得多。
 *
 * 换成共享类型之后判据变成**编译期**的：读一个 daemon 不发的字段 = web 编译失败；
 * daemon 少发一个字段 = daemon 编译失败。
 *
 * ⚠️ 反过来也补上了两个手抄件漏掉的：`language`（daemon 一直在发）与 `tags` 的元素类型。
 */
export type NoteSummary = NoteListItem;

/**
 * `GET /api/notes/:uid` 的响应 —— **就是 daemon 那一份，不是"对齐了的另一份"**。
 *
 * ⚠️ 它**不再 `extends NoteSummary`**，这是刻意的、也是这次改动的要点：
 * 详情端点与列表端点是两个不同的响应，daemon 的详情**不发** `updatedAt` /
 * `coverAssetUid` / `source` / `bodyText`。让详情继承列表，等于**用类型系统
 * 替四个不存在的字段背书** —— 调用方写 `note.updatedAt` 一路编译通过、
 * 运行时永远是 `undefined`。那正是 A1/A1b 的形状。
 *
 * 现在它是 `@openmemo/shared` 的 `NoteDetail`：读一个 daemon 不发的字段 = 编译错误。
 */
export type NoteDetail = NoteDetailContract;

/**
 * 「为什么不能重跑」—— 同样直接取自共享契约（#95）。
 *
 * 独立导出是给 `RetranscribeButton` 用的：组件只吃这一个字段，不该为了标注一个 prop
 * 去 import 整个 `NoteDetail`（那会让它看起来依赖了整条详情响应）。
 */
export type RetranscribeBlocked = RetranscribeBlockedContract;

/**
 * 一条媒体资产 —— 同样直接取自共享契约（`shared` 的 `NoteAsset`）。
 *
 * 与旧版的两处差别，都别再改回去：
 * 1. `state` 是**必填**的。契约里必填 = **服务端没有"不发"这个选项**，
 *    删掉 daemon 那一行会当场编译失败。这正是 T-139 A1 缺的那道闸。
 * 2. `url` 是**必填**的。daemon 一直在发，旧镜像里连声明都没有 ——
 *    于是前端只好自己再拼一次 `/media/asset/<uid>`，路径规则凭空多出第二处。
 *
 * ⚠️ **契约必填 ≠ 读取时可以不设防**。判"这份资产能不能用"一律走
 * `features/notes/noteAssets.ts` 的 `isUsableAsset`，它对**真的没带这个键的老响应**
 * 按"可用"处理 —— 「字段缺失」绝不能读成「不可用」。两条规矩分工不同，都要在。
 */
export type MediaAssetDto = NoteAsset;

export interface TranscriptDto {
  uid: string;
  noteUid: string;
  engineId: string;
  modelId: string | null;
  backend: string | null;
  language: string | null;
  status: 'pending' | 'running' | 'partial' | 'done' | 'failed';
  progress: number;
  durationMs: number | null;
  rtf: number | null;
  speakers: { label: string; displayName: string | null; color: string | null }[];
  segments: TranscriptSegmentDto[];
}

/** F1 的 probe 结果 —— 秒级返回，先于下载（D-01 §5 F1） */
export interface ProbeResult {
  title: string;
  author: string | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
  site: string | null;
  adapterId: string;
  /** 该 URL 是否需要登录/cookie（提前暴露，别下了 400MB 才发现） */
  requiresAuth: boolean;
}

/**
 * ⚠️ 这个类型只保留**后端真会读的字段**。
 *
 * 原来还有 `modelId` / `diarize` / `keepVideo` / `generateStructure` 四个 ——
 * 全部删除。daemon 的 `ImportBody`（`rest/notes.ts`）只解析 `input` / `title` / `language`，
 * 而 `api.ts` 的 mutation 更是只发 `{input}`，那四个字段连请求体都没进过。
 *
 * 让它们留在类型里的危害不是"多几个没用的键"，而是**类型系统在替谎言背书**：
 * 调用方看到 `diarize?: boolean` 会合理认为传了就生效，
 * TS 也不会报错，于是 UI 上长出一排勾选框，勾了什么都不会发生。
 * 类型能表达的东西必须与后端能接受的东西一致，否则它就是最贵的一种注释错误。
 */
export interface ImportUrlRequest {
  url: string;
  /** BCP-47 或 `"auto"`。省略 = 后端按 `auto` 处理（**不是** `en`）。 */
  language?: string;
}

/** D-01 §3.2 规则 2：写操作一律异步化，返回 202 + jobId */
export interface AcceptedJob {
  jobUid: string;
  noteUid: string;
  status?: string;
}
