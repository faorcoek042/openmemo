import { api, rawFetch } from '../../lib/api/client';
import { markSurface, surfaceState } from '../../lib/api/surfaces';

/**
 * F2 本地媒体分块上传（M-2）。
 *
 * ## 为什么必须分块，而不是一个 `multipart/form-data` 了事
 *
 * 用户会拖 2 GB 的会议录像。一次性上传：
 * - 显示不了进度（用户会以为卡死）
 * - 断了要从头再来
 * - Node 的 body parser 会把它整个缓冲进内存
 *
 * 分块 + 直接写盘是唯一可行解（D-05 §4.2）。
 *
 * ## 为什么本地文件还要"上传"
 *
 * 浏览器沙箱拿不到文件的真实路径 —— 这点必须在 UI 上解释，
 * 否则用户会困惑"我文件就在本机为什么还要传"。
 */

/** 8 MB 一片：足够摊薄请求开销，又不会让单片重传代价过高。 */
export const CHUNK_SIZE = 8 * 1024 * 1024;

export interface UploadInit {
  uploadUid: string;
  /** 服务端可以覆盖分片大小（例如它更清楚磁盘/内存状况） */
  chunkSize?: number;
  /** 断点续传：服务端已经收到的分片序号 */
  receivedParts?: number[];
}

export interface UploadResult {
  noteUid: string;
  jobUid: string;
}

export interface UploadProgress {
  file: File;
  /** 0..1 */
  progress: number;
  phase: 'init' | 'uploading' | 'finalizing' | 'done' | 'failed';
  error?: unknown;
}

/**
 * 上传一个文件并触发导入。
 *
 * 失败时**不静默吞掉**：把 phase 置 failed 并把错误交给调用方渲染。
 */
export async function uploadMediaFile(
  file: File,
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const report = (patch: Partial<UploadProgress>) =>
    onProgress({ file, progress: 0, phase: 'init', ...patch } as UploadProgress);

  report({ phase: 'init' });

  const init = await api<UploadInit>('import', '/import/file/init', {
    method: 'POST',
    body: { name: file.name, size: file.size, mime: file.type || null },
    signal,
  });

  const chunkSize = init.chunkSize ?? CHUNK_SIZE;
  const total = Math.max(1, Math.ceil(file.size / chunkSize));
  const done = new Set(init.receivedParts ?? []);

  for (let i = 0; i < total; i += 1) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (done.has(i)) continue;

    const slice = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize));
    const res = await rawFetch(`/api/import/file/${init.uploadUid}/part/${i}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: slice,
      signal,
    });
    if (!res.ok) {
      report({ phase: 'failed', progress: i / total, error: new Error(`part ${i}: HTTP ${res.status}`) });
      throw new Error(`分片 ${i} 上传失败：HTTP ${res.status}`);
    }
    report({ phase: 'uploading', progress: (i + 1) / total });
  }

  report({ phase: 'finalizing', progress: 1 });
  const out = await api<UploadResult>('import', `/import/file/${init.uploadUid}/complete`, {
    method: 'POST',
    signal,
  });
  report({ phase: 'done', progress: 1 });
  return out;
}

/**
 * daemon 的上传端点尚未实现时的**明确失败**。
 *
 * 刻意**不做 mock 上传** —— 假装传成功然后凭空变出一条笔记，
 * 会让"哪些接通了"这件事重新变得说不清。宁可让按钮明确报"还没接通"。
 */
export function uploadSurfaceReady(): boolean {
  return surfaceState('import') === 'live';
}

export async function probeUploadSurface(): Promise<boolean> {
  try {
    await api<unknown>('import', '/import/file/init', {
      method: 'POST',
      body: { probe: true },
    });
    return true;
  } catch {
    markSurface('import', surfaceState('import') === 'offline' ? 'offline' : 'mock');
    return false;
  }
}

/** 客户端侧的类型白名单。真正的判定以服务端 ffprobe 实探为准（D-01 §8.5）。 */
export function looksLikeMedia(file: File): boolean {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true;
  return /\.(mp3|m4a|wav|flac|ogg|opus|aac|wma|mp4|mkv|mov|avi|webm|flv|wmv|m4v|mpeg|mpg)$/i.test(
    file.name,
  );
}
