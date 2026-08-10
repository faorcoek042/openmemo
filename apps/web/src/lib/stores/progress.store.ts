import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { throttle } from '../utils';

/**
 * 高频瞬时流的落点（D-05 §2.4）。
 *
 * **为什么进度不进 TanStack Query 缓存**：
 * `job.progress` 是 4Hz × N 个任务。写进 Query 缓存会让订阅了任务列表的每个组件
 * 每秒重渲染 4N 次 —— 一个下载 + 一个转写就足以让 3000 行的转写稿列表掉帧。
 *
 * 判据（D-05 §2.4）：这个值刷新时，是否需要**超过一个组件**重新渲染？
 * 不需要 → 别进 React state。进度条只有它自己关心自己那一条。
 */

export interface JobProgressSnapshot {
  jobId: string;
  jobType: string;
  noteUid?: string;
  state: string;
  /**
   * 0..1；**`null` = 这一步没有可报的进度**（例如"正在安装"：解压写盘没有字节刻度）。
   *
   * ⚠️ 不确定的进度必须用**不确定的表达**（转圈 / 无刻度条）渲染。
   *   以前 `pct: null` 在 `features/models/sse.ts` 被兜底成 `0`，于是"正在安装"
   *   会显示成一个**停在 0% 的进度条** —— 一个看起来精确的假话，
   *   和"卡在正在校验完整性"是同一族毛病。
   */
  progress: number | null;
  step: string | null;
  stepIndex?: number;
  stepCount?: number;
  completedBytes: number | null;
  totalBytes: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
  at: number;
}

interface ProgressStore {
  byJob: Record<string, JobProgressSnapshot>;
  /** 供 UI 读取（selector 订阅单个 jobId，不会因别的任务变化而重渲染） */
  clear: (jobId: string) => void;
  clearAll: () => void;
  /** 内部使用；外部一律走 pushProgress（带节流） */
  _commit: (batch: Record<string, JobProgressSnapshot>) => void;
}

export const useProgressStore = create<ProgressStore>()(
  subscribeWithSelector((set) => ({
    byJob: {},
    /*
     * ★ T-198 / S-3：**清理必须连待提交的缓冲一起清。**
     *
     * `buffer` 是模块级变量、不在 store 里；`clear()` 原来只删 `byJob`，
     * 而 200ms 后的 `flush()` 会把还躺在 buffer 里的那条快照**重新并回去** ——
     * 于是"已经清掉了"在一次节流窗口之后自己复活。
     * （复现路径没能构造出来，标为**理论缺口**；但它与本轮修的
     * "陈旧快照压过终态"是同一族，清掉它成本为零。）
     */
    clear: (jobId) =>
      set((s) => {
        dropBuffered(jobId);
        const next = { ...s.byJob };
        delete next[jobId];
        return { byJob: next };
      }),
    clearAll: () => {
      dropBuffered();
      set({ byJob: {} });
    },
    _commit: (batch) => set((s) => ({ byJob: { ...s.byJob, ...batch } })),
  })),
);

/**
 * 服务端已按 4Hz 节流（`PROGRESS_THROTTLE_HZ`），前端**再节流一次到 200ms**
 * 才触碰 React state —— 这是 shared/events.ts 注释里明确要求的两级节流。
 */
let buffer: Record<string, JobProgressSnapshot> = {};

/**
 * 丢掉还没 flush 的快照。不传 jobId = 全丢。
 *
 * 声明在 store 之前会撞 TDZ，所以放在这里、由上面的 `clear` 通过函数提升引用。
 */
function dropBuffered(jobId?: string): void {
  if (jobId === undefined) {
    buffer = {};
    return;
  }
  delete buffer[jobId];
}

const flush = throttle(() => {
  if (Object.keys(buffer).length === 0) return;
  useProgressStore.getState()._commit(buffer);
  buffer = {};
}, 200);

export function pushProgress(snap: Omit<JobProgressSnapshot, 'at'>): void {
  buffer[snap.jobId] = { ...snap, at: Date.now() };
  flush();
}

/** 直接读快照，不订阅（给非响应式场景，如 canvas 绘制）。 */
export function peekProgress(jobId: string): JobProgressSnapshot | undefined {
  return useProgressStore.getState().byJob[jobId];
}
