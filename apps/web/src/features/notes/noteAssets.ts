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
export function isUsableAsset(a: Pick<MediaAssetDto, 'state'>): boolean {
  return a.state === undefined || !UNUSABLE.includes(a.state);
}

function pickByRole(note: NoteDetail | undefined, role: string): MediaAssetDto | undefined {
  const assets = note?.assets;
  if (!Array.isArray(assets)) return undefined;
  return assets.find((a) => a.role === role && isUsableAsset(a));
}

/** 播放器的音源：16k 单声道音轨（转写与时间轴都对着它）。 */
export function pickAudioAsset(note: NoteDetail | undefined): MediaAssetDto | undefined {
  return pickByRole(note, 'audio16k');
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
