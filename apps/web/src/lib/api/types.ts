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

export interface ImportUrlRequest {
  url: string;
  modelId?: string;
  language?: string;
  diarize?: boolean;
  keepVideo?: boolean;
  generateStructure?: boolean;
}

/** D-01 §3.2 规则 2：写操作一律异步化，返回 202 + jobId */
export interface AcceptedJob {
  jobUid: string;
  noteUid: string;
}
