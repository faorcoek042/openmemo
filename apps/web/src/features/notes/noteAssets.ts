/**
 * 「这条笔记有没有可用的音频 / 波形」—— **纯决策部分**（T-139 A1 / A3）。
 *
 * ## 为什么把两行 `.find()` 拆成一个模块
 *
 * 因为这两行**在真实环境里从来没有返回过东西**，而且没有任何测试执行过它们：
 *
 * ```ts
 * // 原来写在 NoteDetailPage 里：
 * const audioAsset = arr(note.data?.assets).find((a) => a.role === 'audio16k' && a.state === 'ready');
 * ```
 *
 * daemon 的 `GET /api/notes/:uid` **不发 `state`**（那一列一直在库里，只是没被序列化），
 * 于是 `undefined === 'ready'` 恒 false → `audioAsset` 恒 `undefined` →
 * `setSource(null)` → `PlayerBar` 的 `{assetUid ? <audio…/> : null}` **不渲染** →
 * 播放键点了什么都不发生、点转写段落也不跳。**零报错、零提示**，
 * 而波形还照画（那份波形是假的，见 §A3）—— 看起来一切正常。
 * F5 的招牌能力「转写稿 ↔ 音频时间轴联动」因此在产品里从未工作过。
 *
 * 拆出来是为了让这条规则**能被单独钉住**：`noteAssets.test.ts` 喂进去的
 * 是从**真 daemon 上原样抓下来的响应**（`curl` 输出逐字粘贴，不是手写的想象形状），
 * 所以两边任何一侧再分叉，测试就红 —— 而在组件里它只能靠渲染整页间接验证。
 *
 * ## `state` 缺失时按"可用"处理，这是刻意的
 *
 * 判据抄自同一个 DTO 里已经立过的规矩（`NoteDetail.canRetranscribe` 的注释）：
 * **"字段缺失"绝不能读成"不可用"** —— 那会把一个本来能用的功能对所有旧响应静默藏起来，
 * 也正是这次事故的形状。所以只排除 daemon **明确说**不可用的三种状态。
 */
import type { MediaAssetDto, NoteDetail } from '../../lib/api/types';

/** daemon 明确说"现在用不了"的三种状态（`media_assets.state` 的 CHECK 约束）。 */
const UNUSABLE: readonly string[] = ['pending', 'missing', 'failed'];

/**
 * 这份资产现在能不能用。
 *
 * `state === undefined` → 能用（老响应不带这个键，见文件头）。
 * `state === 'ready'`   → 能用。
 * 其余三种                → 不能用。
 */
export function isUsableAsset(a: { state?: string | undefined }): boolean {
  /*
   * ⚠️ 参数类型**刻意比 `MediaAssetDto` 宽**（T-151 ②）。
   *
   * `MediaAssetDto` 现在直接是 `@openmemo/shared` 的 `NoteAsset`，那里 `state` 是**必填**的 ——
   * 必须必填，否则 daemon 把序列化里那一行删掉不会有任何编译错误，A1 那个洞就还开着。
   * 但**契约要求发** 与 **读的时候要不要设防** 是两件事：真实世界里还有
   * 老版本 daemon 的响应、缓存里的旧 JSON、手工构造的载荷 —— 它们真的没有这个键。
   * 参数写成 `Pick<MediaAssetDto,'state'>` 的话，`isUsableAsset({})` 连编译都过不去，
   * 而那正是这个函数最该处理的输入；照着类型把这条分支删掉，就等于把
   * 「字段缺失 = 不可用」这个恰好导致 T-139 A1 的行为又装回来一次。
   *
   * 所以：**契约那一侧收紧，消费那一侧放宽**，两条规矩各守一头。
   */
  return a.state === undefined || !UNUSABLE.includes(a.state);
}

function pickByRole(note: NoteDetail | undefined, role: string): MediaAssetDto | undefined {
  const assets = note?.assets;
  if (!Array.isArray(assets)) return undefined;
  return assets.find((a) => a.role === role && isUsableAsset(a));
}

/**
 * 播放器的音源。
 *
 * **首选** `audio16k`（转写与时间轴都对着它，`peaks.ompk` 也是从它算出来的）。
 *
 * ## 为什么要有第二档：录完的笔记在重跑结束前**根本没有音源**（T-164 ③）
 *
 * `ws/recorder.ts` 停止录音时只建 `role:'original'` 的 WAV；`audio16k` 要等
 * 那个离线重跑 job 跑完、`transcribe.ts` 的 `archiveIntoMedia` 归档之后才出现。
 * 也就是说：**录完立刻打开笔记，`<audio>` 根本不进 DOM** ——
 * 播放键点了没反应、点段落也不跳，而波形和时间码照常显示（peaks 是录音时就算好的）。
 * 看起来一切正常，只是"点了没用"，零报错、零提示。
 *
 * 更糟的一格：**一句话都没识别出来时 recorder 连重跑 job 都不排**
 * （`segments.length > 0` 才 enqueue）→ 那条录音**永远**没有 `audio16k`，
 * 也就永远播不了。而"什么都没识别出来"恰恰是用户最想回去听一遍的时候。
 *
 * ## 回退只收 `audio/*`，不赌容器
 *
 * 录音的 `original` 就是 16 kHz 单声道 PCM WAV（`mime: 'audio/wav'`），
 * 浏览器直接能播，时间轴与 `audio16k` 是同一条（同一段音频）。
 * 而 F1/F2 导入的 `original` 可能是 `video/*` 或站点给的任意容器 ——
 * 那种要不要交给 `<audio>` 是另一个问题（可能没有音轨、可能解不了码），
 * **这里不猜**：mime 不是 `audio/` 开头就当没有，维持现状而不是换一种失败方式。
 *
 * `mime` 为 null（这一列没有 NOT NULL）同样不回退：判据只认**明说是音频**的那一档。
 */
export function pickAudioAsset(note: NoteDetail | undefined): MediaAssetDto | undefined {
  const normalized = pickByRole(note, 'audio16k');
  if (normalized) return normalized;
  const original = pickByRole(note, 'original');
  return original?.mime?.startsWith('audio/') ? original : undefined;
}

/**
 * 预计算波形（`.ompk`）。
 *
 * **没有就是没有** —— 调用方必须如实不画波形，绝不能因为"界面空着不好看"就造一份
 * （T-139 A3：此前正是没有时 `mockPeaks()`、有时反而 `setPeaks(null)`，逻辑整个反着）。
 */
export function pickPeaksAsset(note: NoteDetail | undefined): MediaAssetDto | undefined {
  return pickByRole(note, 'peaks');
}
