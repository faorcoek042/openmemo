import { hasUploadMediaExtension } from '@openmemo/shared';
import { pickLocalized } from '../../lib/format/localized';

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
/**
 * 上传过程中**要显示给用户**的那两样东西。
 *
 * `locale` 不是"顺手带上的"：daemon 的错误体同时发 `message`（英文）与
 * `messageZh`（中文），而这里原来是 `messageZh ?? message` —— 中文那一份
 * **无条件胜出**，于是英文界面上这条错误永远是中文（#106）。
 */
export interface UploadStrings {
  /** 当前界面语言（BCP-47）。用来在 daemon 的双语错误里挑对那一份。 */
  readonly locale: string;
  /** 上传端点根本不存在时那句话（locale key `capture.uploadEndpointMissing`）。 */
  readonly endpointMissing: (status: number) => string;
}

/** 调用方没传时的兜底。**英文**，理由见 `uploadMediaFile` 的参数注释。 */
const DEFAULT_UPLOAD_STRINGS: UploadStrings = {
  locale: 'en',
  endpointMissing: (status) =>
    `The upload endpoint does not exist on this daemon (HTTP ${String(status)}).`,
};

export function uploadMediaFile(
  file: File,
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
  /**
   * BCP-47 或 `"auto"`。省略即不发该 part —— daemon 会存 `null`，
   * 转写时降级为 `auto`，**绝不会退回 `en`**（`whisperCpp.ts` 无条件传 `-l`）。
   */
  language?: string,
  /**
   * 这个模块要说的两句话，**由调用方用 `t()` 解析好再传进来**（#106）。
   *
   * ⚠️ **刻意不在这里 `import` i18n 实例。** 这个文件被 `tsconfig.test.json`
   * 编成 CommonJS 跑 `node --test`，而 `react-i18next` 是纯 ESM ——
   * 直接引进来会把一个纯逻辑单测拖进模块解析的泥潭
   * （同一条坑 `tsconfig.test.json` 的注释里记着：「用打包器解决打包器的问题」）。
   *
   * 缺省值**故意是英文而不是中文**：这个参数缺失只可能是我们自己漏传，
   * 而漏传时给英文用户一句中文正是 #106 在治的那件事。
   */
  strings: UploadStrings = DEFAULT_UPLOAD_STRINGS,
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const form = new FormData();
    // 字段名 `file`；磁盘名由服务端生成 ULID，原名只作展示元数据（D-01 §8.5）
    form.append('file', file, file.name);
    /**
     * daemon 的 multipart 解析器（`http/upload.ts`）收任意字段名（上限 16 个），
     * 但**只读 `title` 和 `language`** 两个。这里只发它真读的那个 ——
     * 多发的 part 不会报错，会被静默丢弃，那正是本轮要消灭的那种"看起来传了"。
     *
     * 空串要跳过：服务端 `rawLang.length > 0` 才采纳，发空串等于白发一个 part。
     */
    if (language) form.append('language', language);

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
        /*
         * #106：这里原来写死一句中文 —— 而这是 **`apps/web` 自己写的文案**，
         * 不是 daemon 递过来的。它最后落在 `CapturePage` 的错误块标题上。
         */
        const err = new Error(strings.endpointMissing(xhr.status));
        onProgress({ file, progress: 1, phase: 'failed', error: err });
        reject(err);
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const err = parseError(xhr.responseText, xhr.status, strings.locale);
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

/**
 * 上传失败的错误体 → 一条 `Error`。
 *
 * ⚠️ #106：这里原来是 `messageZh ?? message`，让中文那一份**无条件胜出** ——
 * daemon 的 `sendError()` 两格都发，而英文界面上这条错误于是永远是中文
 * （它最后落在 `CapturePage` 的 `ErrorBlock` 标题上，走的是非 `ApiError`
 * 那条分支，绕过了 `ErrorBlock` 自己那段按语言挑的逻辑）。
 * 现在按当前界面语言挑，缺哪一份就回落到另一份 —— 与 `JobList.tsx` 同一条。
 */
function parseError(text: string, status: number, locale: string): Error {
  try {
    const body = JSON.parse(text) as { error?: { messageZh?: string; message?: string } };
    const picked = pickLocalized(locale, body.error?.messageZh, body.error?.message);
    return new Error(picked || `HTTP ${status}`);
  } catch {
    return new Error(`HTTP ${status}`);
  }
}

/**
 * 客户端侧的类型白名单。真正的判定以服务端 ffprobe 实探为准（D-01 §8.5）。
 *
 * ★ T-152：这里原本写死了一条 18 项的正则，与 daemon 的 17 项白名单分叉。
 * `[实测]` `web ∖ daemon = {flv, wmv}` —— 用户拖一个 `.flv` 进来，**这条正则放行、
 * 界面上出现上传行、服务端回 415**；反向 `daemon ∖ web = {ts}` —— 服务端收得下，
 * 这条正则不认。现在两边**逐字用 `@openmemo/shared` 的同一个 `UPLOAD_MEDIA_EXTENSIONS`**，
 * 相等由构造保证，不靠谁记得同步。⚠️ 要加扩展名请改 shared 那一份，别在这里写正则。
 *
 * `file.type` 快路径保留：浏览器已经认出 `audio/*` / `video/*` 时不必再看扩展名
 * （很多相机/录音 App 导出的文件没有扩展名，只有 MIME）。
 */
export function looksLikeMedia(file: File): boolean {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true;
  return hasUploadMediaExtension(file.name);
}
