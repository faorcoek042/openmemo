/**
 * API 面（surface）连通性登记表 —— T-029 的核心。
 *
 * ## 为什么需要它
 *
 * daemon 正在被 `oss-scout` 逐个端点接通（T-028）。前端不能等它全好了再切，
 * 也不能"一刀切"地宣称已接通 —— 那会变成用 mock 冒充真实。
 *
 * 所以这里按**面**（notes / import / media / jobs / …）分别记录状态：
 * 每个面第一次被调用时**先打真 daemon**；
 * - 通了 → 该面标 `live`，此后一直走真接口；
 * - 返回 404 / 501（路由还没实现）→ 该面标 `mock`，回落到内存 mock，
 *   并且 UI 上**只有这个面**挂 MOCK 条幅，其它已接通的面不受影响。
 *
 * ## 这个设计的关键收益
 *
 * **`oss-scout` 每接通一个端点，前端自动切过去，我一行代码都不用改。**
 * 不需要两边约时间、不需要我盯着他的进度改开关 —— 这正是"靠契约对齐、别互相等"。
 */

import { create } from 'zustand';

export const SURFACES = [
  'health', // /api/health（daemon 是否在跑）
  'auth', // /api/auth/session
  'events', // /api/events（SSE）
  'notes', // /api/notes*
  'import', // /api/import/*
  'transcript', // /api/notes/:uid/transcript
  'media', // /media/asset/*
  'jobs', // /api/jobs*
  'models', // /api/models*      （features/models，归 model-mgmt）
  'backends', // /api/backends*  （features/runtime，归 model-mgmt）
  'runtime', // /api/runtime/*
  'settings', // /api/settings*
  'recorderWs', // /ws/recorder
  /** 未声明 surface 的调用落点。**不计入"已接通/模拟"统计**，只用于回落逻辑。 */
  'generic',
] as const;

export type Surface = (typeof SURFACES)[number];

export type SurfaceState =
  /** 还没试过 */
  | 'unknown'
  /** 真 daemon 接通并返回了正常响应 */
  | 'live'
  /** daemon 在跑，但这个端点还没实现（404/501）→ 走 mock */
  | 'mock'
  /** daemon 完全连不上 → 走 mock，但原因不同（要提示"本地服务未启动"） */
  | 'offline';

interface SurfaceStore {
  states: Record<Surface, SurfaceState>;
  /** daemon 的 /api/health 回执，null = 没连上 */
  health: {
    version: string;
    instanceId: string;
    contractVersion: number;
    dataDir: string;
    port: number;
    pid: number;
    /** 构建来源。老 daemon 没有这个字段，故可选 —— 缺失时界面显示"未知"而不是猜。 */
    build?: {
      commit: string;
      commitTime: string | null;
      dirty: boolean;
      builtAt: string | null;
      startedAt: string;
    };
  } | null;
  /** 鉴权握手是否完成（cookie + CSRF 就位） */
  authed: boolean;

  set: (s: Surface, v: SurfaceState) => void;
  setHealth: (h: SurfaceStore['health']) => void;
  setAuthed: (v: boolean) => void;
}

const initial = Object.fromEntries(SURFACES.map((s) => [s, 'unknown'])) as Record<
  Surface,
  SurfaceState
>;

export const useSurfaceStore = create<SurfaceStore>((set) => ({
  states: initial,
  health: null,
  authed: false,
  set: (s, v) => set((st) => (st.states[s] === v ? st : { states: { ...st.states, [s]: v } })),
  setHealth: (health) => set({ health }),
  setAuthed: (authed) => set({ authed }),
}));

/* ── 非 React 读写（fetcher 内部用，避免 hook 约束）── */

export function surfaceState(s: Surface): SurfaceState {
  return useSurfaceStore.getState().states[s];
}

export function markSurface(s: Surface, v: SurfaceState): void {
  useSurfaceStore.getState().set(s, v);
}

/** 该面是否在用 mock 数据（UI 据此决定挂不挂 MOCK 条幅）。 */
export function isSurfaceMocked(s: SurfaceState): boolean {
  return s === 'mock' || s === 'offline';
}

/** 汇总：有任何一个面还在 mock 吗？用于"部分接通"的整体提示。 */
export function mockedSurfaces(states: Record<Surface, SurfaceState>): Surface[] {
  return SURFACES.filter((s) => s !== 'generic' && isSurfaceMocked(states[s]));
}

export function liveSurfaces(states: Record<Surface, SurfaceState>): Surface[] {
  return SURFACES.filter((s) => s !== 'generic' && states[s] === 'live');
}
