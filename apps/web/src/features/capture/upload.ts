import { markSurface } from '../../lib/api/surfaces';

/**
 * F2 本地媒体上传。
 *
 * ## ⚠️ 契约订正（T-056）—— 我原来整套协议都是猜的
 *
 * 我按 D-05 §4.2 的设计自造了一套**三步分块协议**：
 * `POST /import/file/init` → `PUT /import/file/:uid/part/:n` → `POST /import/file/:uid/complete`。
 * **daemon 里这三条路由一条都不存在**（`grep "'/api/import" apps/daemon` 零命中），
 * 所以"把文件拖到网页上"在浏览器里必然 404 ——
 * 这就是 D-08 §5 那条"import 面整面 404"的确切来源。
 *
 * daemon 实际提供的是 **`POST /api/notes/upload`**：单次 `multipart/form-data` **流式**上传，
 * 服务端边收边写盘（任何时刻内存里只有一个 chunk），响应
 * `202 {noteUid, jobUid, bytes, filename, storedAs}`。
 *
 * **他的设计是对的，我的分块协议在这里属于过度设计**：
 * - 浏览器发送 `File` 本来就是流式的，`fetch`/XHR 不会把它读进内存；
 * - 断点续传的价值在**本机回环**上接近于零（不跨公网、不掉线）；
 * - 少一套 init/part/complete 状态机，就少一整类"服务端半成品文件"的清理问题。
 *
 * 所以这里**按他的协议重写**，不再坚持我的设计。
 *
 * ## 仍然保留的一条
 * "为什么本地文件还要上传"必须在 UI 上解释 —— 浏览器沙箱拿不到真实路径
 * （`<input type=file>` 与 drop 事件给的 `File` 都没有路径），
 * 不解释用户会困惑"我文件就在本机，为什么还要传"。
 */

export interface UploadResult {
  noteUid: string;
  jobUid: string;
  bytes: number;
  filename: string;
  storedAs: string;
}

export interface UploadProgress {
  file: File;
  /** 0..1 */
  progress: number;
  phase: 'uploading' | 'done' | 'failed';
  error?: unknown;
}

/**
 * 上传一个文件并触发导入。
 *
 * 用 `XMLHttpRequest` 而不是 `fetch`：**只有 XHR 能给出上传进度**
 * （`fetch` 的流式上传在多数浏览器仍不可用）。用户会传 500MB 的视频，
 * 没有进度条的等待不可接受 —— 这是少数"老 API 更合适"的场景，不是没跟上新写法。
 */
export function uploadMediaFile(
  file: File,
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const form = new FormData();
    // 字段名 `file`；磁盘名由服务端生成 ULID，原名只作展示元数据（D-01 §8.5）
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', UPLOAD_ENDPOINT);
    xhr.withCredentials = true;

    const csrf = readCsrf();
    if (csrf) xhr.setRequestHeader('X-OpenMemo-CSRF', csrf);

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      onProgress({ file, progress: e.loaded / e.total, phase: 'uploading' });
    };

    xhr.onload = () => {
      if (xhr.status === 404 || xhr.status === 501) {
        // 端点不存在：如实标注，绝不静默当成功（写操作永不假装成功）
        markSurface('import', 'mock');
        const err = new Error(`上传接口不存在（HTTP ${xhr.status}）`);
        onProgress({ file, progress: 1, phase: 'failed', error: err });
        reject(err);
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const err = parseError(xhr.responseText, xhr.status);
        onProgress({ file, progress: 1, phase: 'failed', error: err });
        reject(err);
        return;
      }
      try {
        const out = JSON.parse(xhr.responseText) as UploadResult;
        markSurface('import', 'live');
        onProgress({ file, progress: 1, phase: 'done' });
        resolve(out);
      } catch (err) {
        onProgress({ file, progress: 1, phase: 'failed', error: err });
        reject(err);
      }
    };

    xhr.onerror = () => {
      const err = new Error('连不上本地服务，上传未完成');
      markSurface('import', 'offline');
      onProgress({ file, progress: 0, phase: 'failed', error: err });
      reject(err);
    };

    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    onProgress({ file, progress: 0, phase: 'uploading' });
    xhr.send(form);
  });
}

export const UPLOAD_ENDPOINT = '/api/notes/upload';

function readCsrf(): string | null {
  try {
    return sessionStorage.getItem('openmemo.csrf');
  } catch {
    return null;
  }
}

function parseError(text: string, status: number): Error {
  try {
    const body = JSON.parse(text) as { error?: { messageZh?: string; message?: string } };
    return new Error(body.error?.messageZh ?? body.error?.message ?? `HTTP ${status}`);
  } catch {
    return new Error(`HTTP ${status}`);
  }
}

/** 客户端侧的类型白名单。真正的判定以服务端 ffprobe 实探为准（D-01 §8.5）。 */
export function looksLikeMedia(file: File): boolean {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true;
  return /\.(mp3|m4a|wav|flac|ogg|opus|aac|wma|mp4|mkv|mov|avi|webm|flv|wmv|m4v|mpeg|mpg)$/i.test(
    file.name,
  );
}
