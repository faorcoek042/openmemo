/**
 * 媒体扩展名白名单 —— **全仓唯一事实来源**（T-152 §2.3 收敛）。
 *
 * ## 为什么必须只有一份
 *
 * 收敛之前全仓有三份互相分叉的清单：`packages/pipeline` 的 `MEDIA_EXTENSIONS`(24)、
 * `apps/daemon` 的 `ALLOWED_UPLOAD_EXTENSIONS`(17)、`apps/web` 的 `looksLikeMedia()`
 * 里一条写死的正则(18)。`[实测]` 差集与后果：
 *
 * | 差集 | 后果 |
 * |---|---|
 * | `web ∖ daemon = {flv, wmv}` | 用户拖一个 `.flv`：**前端放行、界面上出现上传行、服务端 415 拒收** |
 * | `daemon ∖ web = {ts}` | 服务端收得下，前端拖拽预检却不认它 |
 * | `daemon ∖ pipeline = {mpeg, mpg}` | 传得上去，但不在 pipeline 的媒体白名单里 |
 *
 * 第三条洞现在**在结构上不可能再出现**：{@link PIPELINE_MEDIA_EXTENSIONS} 由并集
 * **构造**，不再手抄。前两条靠"web 的拖拽预检与 daemon 的上传端点逐字 import 同一个
 * 常量"消除 —— **相等由构造保证，不靠测试比对**。
 *
 * ## 硬约束：本文件不得出现任何 `node:` 导入
 *
 * `@openmemo/shared` 会被打进浏览器 bundle。这里只允许纯数据 + 纯函数。
 *
 * ## 扩展名只是预检，真实类型只能来自 ffprobe（D-01 §8.5）
 *
 * 白名单挡的是"一眼就不该收"的东西（`.exe` / `.sh` / `.dll`），以及**播放列表**这种
 * 间接寻址原语。一个改名成 `.mp4` 的可执行文件照样能通过扩展名预检 ——
 * 判定它到底是不是媒体，是服务端 ffprobe 实探的职责，不是这张表的职责。
 */

/**
 * 用户能从浏览器拖进来 / 上传端点接受的媒体扩展名。
 *
 * **apps/web 的拖拽预检与 apps/daemon 的上传白名单必须逐字用这一份。**
 *
 * 取值决策（T-152，每条都写明理由，改之前先读）：
 *
 * - `.flv` / `.wmv` —— **在里面**。web 早就放行、pipeline 也认，是 daemon 漏了；
 *   漏的后果是用户拖进去看到上传行、然后吃一个 415。
 * - `.mpeg` / `.mpg` —— **在里面**。daemon 早就收；放这里之后它们也自动进
 *   {@link PIPELINE_MEDIA_EXTENSIONS}，`daemon ∖ pipeline` 那个洞就此闭合。
 * - `.ts` —— **在里面**（daemon 早就收，是 web 那侧漏了）。
 *   ⚠️ 它与 **TypeScript 源文件同扩展名**：拖一个 `.ts` 源码进来会通过扩展名预检，
 *   然后由**服务端 ffprobe 当场认出它不是媒体并拒掉**。这不是漏洞，正是 D-01 §8.5
 *   「扩展名只是预检，真实类型只能来自 ffprobe」的设计 —— 真要为了这个把 MPEG-TS
 *   从白名单里删掉，代价是所有 HLS 分片文件都传不上来。
 * - **播放列表扩展名（`.m3u8` `.m3u` `.pls` `.xspf` `.asx` `.wpl`）一个都不许进来。**
 *   见 {@link PLAYLIST_EXTENSIONS}：它们不是媒体文件，是间接寻址原语。
 *   **这是安全边界，不是口味。**
 */
export const UPLOAD_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  // 音频
  '.mp3',
  '.m4a',
  '.wav',
  '.flac',
  '.ogg',
  '.opus',
  '.aac',
  '.wma',
  // 视频 / 容器
  '.mp4',
  '.m4v',
  '.mkv',
  '.mov',
  '.avi',
  '.webm',
  '.mpeg',
  '.mpg',
  '.flv',
  '.wmv',
  '.ts',
]);

/**
 * 播放列表 / 清单格式。
 *
 * **它们不是媒体文件，是间接寻址原语** —— 一张 URI 列表，ffmpeg 会挨个去取。
 * 所以它们与其它扩展名分开管理，并且**永远不进 {@link UPLOAD_MEDIA_EXTENSIONS}**。
 *
 * `[实测攻击]`（T-026，见 `packages/pipeline/src/subprocess/argGuard.ts` 的
 * `isLocalImportSafeExtension`）：一个本地 `.m3u8`，把它的 segment URI 写成
 * `file:///tmp/secret.ts`，就能让 ffmpeg 去读那个路径 —— 真实运行日志里能看到
 * `Opening 'file:///tmp/attack/secret.ts' for reading`。本地导入这条路必须带
 * `-protocol_whitelist file` 普通媒体才解得开，所以**协议白名单挡不住这一条**：
 * 播放列表是在用一个合法启用的协议读本地文件。它绕过的是 `assertWithinRoot` ——
 * 逃逸的不是路径，是播放列表本身。
 *
 * 远程播放列表不受影响（远程那条的 whitelist 里没有 `file`），所以 HLS over HTTP
 * 照常工作；被拒的只有**本地**播放列表导入。
 */
export const PLAYLIST_EXTENSIONS: ReadonlySet<string> = new Set([
  '.m3u8',
  '.m3u',
  '.pls',
  '.xspf',
  '.asx',
  '.wpl',
]);

/**
 * 字幕。pipeline 认，但**不接受用户直接上传**（上传端点只收音视频本体）。
 */
export const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set(['.srt', '.vtt', '.ass']);

/**
 * 只有 pipeline 认、上传端点刻意不收的额外媒体扩展名。
 *
 * 这三个是"能从远程 URL 拿到、但没人会从浏览器拖进来"的长尾格式。
 * 想让某个扩展名同时对上传开放，请把它加进 {@link UPLOAD_MEDIA_EXTENSIONS}，
 * **不要**加在这里 —— 加在这里等于重新制造 `daemon ∖ pipeline` 那种单向差集。
 */
export const PIPELINE_ONLY_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  '.oga',
  '.aiff',
  '.aif',
]);

/**
 * 远程 HLS 清单。**唯一一个进 {@link PIPELINE_MEDIA_EXTENSIONS} 的播放列表格式。**
 *
 * 它必须在里面：远程 HLS（`https://…/index.m3u8`）是产品支持的正当输入，
 * `directHttp.match()` 靠它把 HLS 链接排到 yt-dlp 之前。
 * 本地导入那条路另有 `isLocalImportSafeExtension` 把**全部**播放列表剔掉（T-026），
 * 两件事分开管，别合并。
 */
const HLS_MANIFEST_EXTENSIONS: ReadonlySet<string> = new Set(['.m3u8']);

/**
 * pipeline（`argGuard.MEDIA_EXTENSIONS`）用的**超集**。
 *
 * ★ **由并集构造，不手抄。** 这就是 `daemon ∖ pipeline = {mpeg, mpg}` 那个洞
 * 在结构上不可能再出现的原因：任何进了 {@link UPLOAD_MEDIA_EXTENSIONS} 的扩展名，
 * 自动就在这里面，不需要谁记得去同步第二处。
 *
 * ⚠️ **刻意不是 `∪ PLAYLIST_EXTENSIONS`**（T-153 收窄，`last-mile` 复核）。
 * 收敛之前 pipeline 的清单里**只有 `.m3u8`**，没有 `.m3u/.pls/.xspf/.asx/.wpl`。
 * 把整个播放列表集合并进来会**扩大产品会去抓取的远程 URL 范围**：
 * `directHttp.match()` 对它们的评分从 30 跳到 80，`probe()` 里
 * `looksMedia` 也会在没有媒体 Content-Type 时直接成立 —— 那是一次
 * **没人要求过的行为变更**，而且发生在一个专门处理"间接寻址原语"的地方。
 * 收敛的目标是「三份变一份」，不是「顺手把口子开大」。
 *
 * 所以这里的并集恰好等于 **收敛前的 24 项 + `{mpeg, mpg}`** —— 只闭合那个洞，不多也不少。
 * 真要支持别的播放列表格式，把它加进 {@link HLS_MANIFEST_EXTENSIONS}
 * 并在那里写清"为什么这个格式值得抓"，**不要**改成整个集合并进来。
 */
export const PIPELINE_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...UPLOAD_MEDIA_EXTENSIONS,
  ...HLS_MANIFEST_EXTENSIONS,
  ...SUBTITLE_EXTENSIONS,
  ...PIPELINE_ONLY_MEDIA_EXTENSIONS,
]);

/**
 * 取小写扩展名（含前导点）。没有点则返回 `undefined`。
 *
 * 与 `argGuard.hasAllowedMediaExtension` 用的是同一条判据：**取最后一个点之后的部分**。
 * 所以 `x.m3u8.exe` 的扩展名是 `.exe`，不是 `.m3u8` —— 双扩展名骗不过它。
 * 注意 `.hidden` 这种只有前导点的名字会得到 `'.hidden'`，不在任何白名单里，天然被拒。
 */
export function mediaExtensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return name.slice(dot).toLowerCase();
}

/** 这个文件名的扩展名是否允许上传 / 允许从浏览器拖进来。 */
export function hasUploadMediaExtension(name: string): boolean {
  const ext = mediaExtensionOf(name);
  return ext !== undefined && UPLOAD_MEDIA_EXTENSIONS.has(ext);
}

/** 这个文件名是不是播放列表 / 清单。 */
export function hasPlaylistExtension(name: string): boolean {
  const ext = mediaExtensionOf(name);
  return ext !== undefined && PLAYLIST_EXTENSIONS.has(ext);
}
