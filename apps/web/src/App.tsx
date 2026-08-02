import { Suspense, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, Cpu, FileAudio, Mic, Package, Plus, Settings, Star } from 'lucide-react';

import { Banner } from './components/common/Banner';
import { ConnectivitySummary } from './components/common/MockNotice';
import { SearchBox } from './features/search';
import { FolderTree } from './features/folders';
import { Button } from './components/common/Button';
import { TasksDrawer } from './features/tasks/TasksDrawer';
import { useUiStore } from './lib/stores/ui.store';
import { useConnectionStore } from './lib/stores/connection.store';
import { useProgressStore } from './lib/stores/progress.store';
import { cn } from './lib/utils';

/** 应用外壳：顶栏 + 侧栏 + 路由出口（D-05 §1.1）。 */
export default function App() {
  const { t } = useTranslation();
  const setTasksDrawer = useUiStore((s) => s.setTasksDrawer);
  const conn = useConnectionStore((s) => s.state);
  const multiTab = useConnectionStore((s) => s.multiTabDegraded);
  const activeCount = useProgressStore((s) => Object.keys(s.byJob).length);

  return (
    <div className="flex h-full flex-col">
      {/* ── 持久条幅区：全局降级态。可折叠不可关闭 —— 问题还在就不该消失 ── */}
      {/* 不再有"全局 MOCK 条幅"：daemon 是逐个端点接通的，全局开关表达不了
          "笔记已接通、转写还没有"这种真实中间态。改为
          ① 顶栏一个连通性摘要（已接通 N / 模拟 M），
          ② 每个页面在自己的数据区域挂 <MockNotice surface=…/>。
          全部接通后两者都会自己消失，不需要谁记得回来删。 */}
      {conn === 'degraded' ? <Banner tone="warning" title={t('banner.sseDegraded')} /> : null}
      {conn === 'reconnecting' ? <Banner tone="info" title={t('banner.sseReconnecting')} /> : null}
      {multiTab ? <Banner tone="info" title={t('banner.multiTab')} /> : null}

      <div className="flex min-h-0 flex-1">
        {/* ── 侧栏 ── */}
        <nav
          className="flex w-52 shrink-0 flex-col gap-1 border-r border-line bg-surface-1 p-3"
          aria-label={t('app.name')}
        >
          <NavLink to="/capture" className="mb-2 block">
            {({ isActive }) => (
              <Button variant={isActive ? 'primary' : 'secondary'} className="w-full justify-start">
                <Plus className="size-4" />
                {t('nav.newCapture')}
              </Button>
            )}
          </NavLink>

          <SideLink to="/notes" icon={<FileAudio className="size-4" />} label={t('nav.allNotes')} />
          <SideLink to="/notes?starred=1" icon={<Star className="size-4" />} label={t('nav.starred')} />
          <SideLink to="/record" icon={<Mic className="size-4" />} label={t('nav.record')} />

          <hr className="my-2 border-line" />

          {/* 文件夹树：此前是静态占位，现在是真数据 + 可新建/删除 */}
          <FolderTree />

          <hr className="my-2 border-line" />

          {/*
            运行时与模型是**一级导航**，不埋进设置。
            章程要求 2.1/2.2 把"网页里装 GPU 后端、管模型"列为硬性功能；
            竞品把它们埋在设置里，结果"模型下载卡 0%"成了它最高频的用户问题。
            这两页归 T-022（features/runtime、features/models，见各自 README 契约）。
          */}
          <SideLink to="/runtime" icon={<Cpu className="size-4" />} label={t('nav.runtime')} pending />
          <SideLink to="/models" icon={<Package className="size-4" />} label={t('nav.models')} pending />
          <SideLink to="/tasks" icon={<Activity className="size-4" />} label={t('nav.tasks')} />
          <SideLink to="/settings" icon={<Settings className="size-4" />} label={t('nav.settings')} />
        </nav>

        {/* ── 主区 ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center justify-end gap-3 border-b border-line bg-surface-1 px-4">
            <SearchBox />
            <ConnectivitySummary className="mr-auto" />
            {activeCount > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setTasksDrawer(true)}>
                <Activity className="size-3.5 text-accent" />
                {t('app.tasksBadge', { count: activeCount })}
              </Button>
            ) : null}
          </header>

          <main className="min-h-0 flex-1 overflow-auto">
            <Suspense fallback={<div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>

      <TasksDrawer />
    </div>
  );
}

function SideLink({
  to,
  icon,
  label,
  pending,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  /** 该页尚未认领（T-022 / T-023）。灰显而不是隐藏 —— 让 IA 完整可见。 */
  pending?: boolean;
}) {
  if (pending) {
    return (
      <span
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink-muted opacity-50"
        title="Wave 3 · T-022"
      >
        {icon}
        {label}
      </span>
    );
  }
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
          isActive ? 'bg-surface-2 text-ink' : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
        )
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}
