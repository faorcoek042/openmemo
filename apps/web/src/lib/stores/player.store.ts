import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/**
 * 播放器状态（D-05 §2.4：高频瞬时流）。
 *
 * **播放位置不进这个 store 的响应式路径。**
 * 若每次都 setState，3000 行的转写稿虚拟列表会掉帧。
 * 做法：位置写进模块级 ref，由 canvas / 游标 / 逐字高亮直接读；
 * 只有"当前高亮段变了"这件事才进 store（低频，通常几秒一次）。
 *
 * ⚠️ 频率分两档，别混：
 * - **值**（`getPositionMs`）**每帧**更新 —— 拉取方需要 rAF 级分辨率才看得见短词；
 * - **通知**（`subscribePosition`）仍 ~10Hz —— 波形游标那类推送方不需要更快。
 */

let positionMs = 0;
const positionListeners = new Set<(ms: number) => void>();

/**
 * 订阅者的通知节流周期。**只节流"推"，不节流"值"** —— 见 `setPositionMs`。
 */
const NOTIFY_INTERVAL_MS = 100;
let lastNotifyAt = -Infinity;

/**
 * 高频写入：不触发 React 渲染。
 *
 * ## 为什么把"更新值"和"通知订阅者"拆开
 *
 * 原来两件事绑在一起，并由 `PlayerBar` 在 rAF 里以 100ms 节流后才调用本函数。
 * 后果是**位置值本身只有 100ms 分辨率**，而逐字高亮是按 `getPositionMs()` 拉取的，
 * 于是任何比采样周期短的词都可能被整个跳过：
 *
 * - 段首零宽词的兜底窗口 `[220, 300)` 只有 80ms → 实测从 0 起播 8 次**只亮 7 次**；
 * - 真实短词 `' for'` 只有 **60ms**（**不是**退化词，`effectiveEnd` 帮不上）→ **一次都没亮过**。
 *
 * 所以根因不是阈值太小，是**高亮的时间分辨率被位置推送的节流周期封顶了**。
 * 单纯把 `MIN_WORD_MS` 调大救不了 `' for'`：它的 60ms 是真实时长，不该被篡改。
 *
 * 现在：**值每帧都更新**（一次 O(1) 赋值，代价可忽略），
 * 而**订阅者仍按 ~10Hz 通知**（波形游标那类消费者不需要 60Hz，且遍历监听器才是真开销）。
 * 拉取方（逐字高亮、当前段判定）因此拿到 rAF 级分辨率，推送方的成本一点没变。
 */
export function setPositionMs(ms: number, opts?: { immediate?: boolean }) {
  positionMs = ms;

  const now = typeof performance === 'undefined' ? Date.now() : performance.now();
  // seek 是跳变，必须立刻推给订阅者 —— 等到下一个节流窗口会让游标明显滞后
  if (opts?.immediate === true || now - lastNotifyAt >= NOTIFY_INTERVAL_MS) {
    lastNotifyAt = now;
    for (const fn of positionListeners) fn(ms);
  }
}

export function getPositionMs(): number {
  return positionMs;
}

/** 给 canvas / 游标等非 React 消费者订阅。 */
export function subscribePosition(fn: (ms: number) => void): () => void {
  positionListeners.add(fn);
  return () => positionListeners.delete(fn);
}

interface PlayerStore {
  /** 当前笔记的音频 asset uid；null = 无媒体 */
  assetUid: string | null;
  durationMs: number;
  playing: boolean;
  rate: number;
  /** 低频：当前高亮段的 seq。只有它变了才重渲染转写稿。 */
  activeSeq: number | null;

  setSource: (assetUid: string | null, durationMs: number) => void;
  setPlaying: (v: boolean) => void;
  setRate: (v: number) => void;
  setActiveSeq: (seq: number | null) => void;
  /** 请求 seek；由 player feature 的组件消费并作用到 <audio> 上 */
  seekRequest: { ms: number; nonce: number } | null;
  requestSeek: (ms: number) => void;
}

let seekNonce = 0;

export const usePlayerStore = create<PlayerStore>()(
  subscribeWithSelector((set) => ({
    assetUid: null,
    durationMs: 0,
    playing: false,
    rate: 1,
    activeSeq: null,
    seekRequest: null,

    setSource: (assetUid, durationMs) =>
      set({ assetUid, durationMs, activeSeq: null, playing: false }),
    setPlaying: (playing) => set({ playing }),
    setRate: (rate) => set({ rate }),
    setActiveSeq: (activeSeq) => set({ activeSeq }),
    requestSeek: (ms) => {
      seekNonce += 1;
      // 跳变：绕过节流立刻通知，否则游标会滞后最多 100ms 才跟上
      setPositionMs(ms, { immediate: true });
      set({ seekRequest: { ms, nonce: seekNonce } });
    },
  })),
);

/**
 * 二分查找当前段（D-05 §4.4）。
 * 一场 3 小时讲座有 3000+ 段，每帧线性扫会掉帧 → O(log n)。
 * `starts` 必须是升序数组。
 */
export function findActiveIndex(starts: number[], ends: number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // 落在两段之间的静音区：不高亮任何段
  if (ans >= 0 && t > ends[ans]) return -1;
  return ans;
}
