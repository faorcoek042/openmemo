import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/**
 * 播放器状态（D-05 §2.4：高频瞬时流）。
 *
 * **播放位置不进这个 store 的响应式路径。**
 * 位置以 ~10Hz 更新，若每次都 setState，3000 行的转写稿虚拟列表会掉帧。
 * 做法：位置写进模块级 ref（`positionRef`），由 canvas / 游标直接读；
 * 只有"当前高亮段变了"这件事才进 store（低频，通常几秒一次）。
 */

let positionMs = 0;
const positionListeners = new Set<(ms: number) => void>();

/** 高频写入：不触发 React 渲染。 */
export function setPositionMs(ms: number) {
  positionMs = ms;
  for (const fn of positionListeners) fn(ms);
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
      setPositionMs(ms);
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
