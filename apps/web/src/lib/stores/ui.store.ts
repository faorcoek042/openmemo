import { create } from 'zustand';

/** 客户端 UI 状态（D-05 §2.1）。与服务器无关的东西才放这里。 */

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_KEY = 'openmemo.theme';

function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'system';
}

/** `system` 时移除 data-theme，交给 `prefers-color-scheme` 媒体查询（tokens.css 已处理）。 */
export function applyTheme(mode: ThemeMode) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

interface UiStore {
  theme: ThemeMode;
  sidebarOpen: boolean;
  tasksDrawerOpen: boolean;
  /** F5：用户手动滚动转写稿时自动关闭跟随（D-05 §4.4 的经典细节） */
  followPlayback: boolean;

  setTheme: (m: ThemeMode) => void;
  toggleSidebar: () => void;
  setTasksDrawer: (open: boolean) => void;
  setFollowPlayback: (v: boolean) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  theme: readTheme(),
  sidebarOpen: true,
  tasksDrawerOpen: false,
  followPlayback: true,

  setTheme: (theme) => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    set({ theme });
  },
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setTasksDrawer: (tasksDrawerOpen) => set({ tasksDrawerOpen }),
  setFollowPlayback: (followPlayback) => set({ followPlayback }),
}));
