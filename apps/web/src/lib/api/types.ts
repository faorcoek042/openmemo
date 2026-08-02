/**
 * 笔记域 DTO。
 *
 * ⚠️ 同 `lib/events/types.ts`：这些的权威定义**应当在 `@openmemo/shared`**
 * （`model-mgmt` 独占）。这里是本地镜像，让前端能先跑。
 * 形状对齐 D-02 的表结构，字段名保持一致以便日后直接替换。
 */

import type { TranscriptSegmentDto } from '../events/types';

/** D-02 §1.3 notes.status */
export type NoteStatus = 'draft' | 'processing' | 'ready' | 'partial' | 'failed';

export type NoteKind = 'media' | 'recording' | 'plain';

/** D-02 §1.3 notes + §1.4 media_sources 的投影 */
export interface NoteSummary {
  uid: string;
  title: string;
  kind: NoteKind;
  status: NoteStatus;
  folderUid: string | null;
  durationMs: number | null;
  coverAssetUid: string | null;
  starred: boolean;
  tags: { uid: string; name: string; color: string | null }[];
  createdAt: string;
  updatedAt: string;
  /** 该笔记未完成的作业（列表页要显示进度条） */
  activeJobId: string | null;
  source: {
    kind: 'url' | 'local' | 'recording' | 'rss_item';
    /** 'ytdlp' | 'direct-http' | 'rss' | 'local' —— 可替换性可审计（D-01 §6.4） */
    adapterId: string | null;
    site: string | null;
    author: string | null;
    inputUrl: string | null;
  } | null;
}

export interface NoteDetail extends NoteSummary {
  summaryMd: string | null;
  /** TipTap 文档 JSON（保真）。`bodyText` 是它的纯文本投影，供 FTS5 索引。 */
  bodyJson: unknown | null;
  bodyText: string;
  language: string | null;
  assets: MediaAssetDto[];
  transcriptUid: string | null;
}

export interface MediaAssetDto {
  uid: string;
  role: string;
  mime: string | null;
  bytes: number | null;
  durationMs: number | null;
  state: 'pending' | 'ready' | 'missing' | 'failed';
}

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
