/**
 * `?t=<毫秒>` —— 搜索结果「直达时间点」的那个参数。
 *
 * ## 它此前是半条链
 *
 * `SearchPage.tsx:135` 早就在发它（`navigate(/notes/${uid}?t=${startMs})`），
 * 而 `NoteDetailPage` **从不读**（那个文件里唯一的 `params.get` 是 `'tab'`）——
 * 于是点任何一条转写命中都从 0:00 开始播。`SearchPage` 自己的文件头把这条叫
 * 「杀手级体验」，并且写着「如果搜索结果跳不到那一秒，说明时间轴模型没设计对」。
 * 时间轴模型是对的，**只是没人接线**。
 *
 * ## 为什么解析要单独成一个纯函数
 *
 * 三个边界（媒体没加载完 / 超出时长 / 地址栏留不留）里，**只有"超出时长"是纯计算**，
 * 另外两个是时序与产品判断。把能纯计算的那部分摘出来，它就能被逐个边界钉死，
 * 而不用去 jsdom 里造一个假的媒体元素。
 *
 * ## 判据：**"跳错地方"必须和"没跳"区分得开**
 *
 * 一个越界的 `?t=` 如果被悄悄夹到 0，用户看到的是「从头开始播」——
 * 与「这个功能根本没接」在界面上**完全一样**。所以越界一律夹到**末尾**并返回
 * `clamped`，由调用方说一句话：位置是错的没关系，用户得知道它错了、以及为什么。
 */

export type SeekParamReason =
  /** 没有 `?t=` */
  | 'absent'
  /** 有，但不是一个能用的毫秒数（手改 URL / 老链接格式）→ 不跳，也不打扰用户 */
  | 'malformed'
  /** 正常，跳到 `ms` */
  | 'ok'
  /** 超出本条录音的时长 → 夹到末尾，**调用方必须说明** */
  | 'clamped';

export interface SeekParam {
  /** 要跳到的毫秒；`null` = 不要动播放器 */
  readonly ms: number | null;
  readonly reason: SeekParamReason;
  /** 夹取前用户实际请求的值（只有 `clamped` 时有意义，用于把话说具体） */
  readonly askedMs: number | null;
}

const NONE: SeekParam = { ms: null, reason: 'absent', askedMs: null };
const BAD: SeekParam = { ms: null, reason: 'malformed', askedMs: null };

/**
 * @param raw        `useSearchParams().get('t')` 的原样返回
 * @param durationMs 本条笔记的时长；**0 或负数表示"还不知道"**（转写中的笔记没有时长），
 *                   此时不夹取 —— 拿一个未知的上界去夹，只会把对的值夹坏。
 */
export function parseSeekParam(raw: string | null | undefined, durationMs: number): SeekParam {
  if (raw === null || raw === undefined || raw.trim() === '') return NONE;

  /*
   * `Number()` 而不是 `parseInt()`：`parseInt('12abc')` 给 12，
   * 也就是把一个明显坏掉的参数**当成有效值**用。这里宁可判它 malformed。
   * 同理挡掉 `Infinity`（`Number('Infinity')` 是有限判定的漏网之鱼）。
   */
  const n = Number(raw);
  if (!Number.isFinite(n)) return BAD;
  // 负数不是"用户想跳到开头"，是这个参数坏了 —— 别替他猜
  if (n < 0) return BAD;

  // 搜索发的一直是整数毫秒；容忍小数只是为了别让手写链接白白失败
  const asked = Math.round(n);

  if (durationMs > 0 && asked > durationMs) {
    return { ms: durationMs, reason: 'clamped', askedMs: asked };
  }
  return { ms: asked, reason: 'ok', askedMs: asked };
}
