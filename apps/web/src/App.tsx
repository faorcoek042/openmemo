import { Suspense, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, Cpu, FileAudio, Mic, Package, Plus, Settings, Star } from 'lucide-react';

import { Banner } from './components/common/Banner';
import { ConnectivitySummary } from './components/common/MockNotice';
import { JobToaster } from './components/common/JobToaster';
import { PanelBoundary } from './components/common/PanelBoundary';
import { ReadinessBanner } from './components/common/ReadinessBanner';
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
  const activeCount = useProgressStore((s) => Object.keys(s.byJob).length);

  /**
   * 首启引导走**无外壳**布局。
   *
   * 之前 `/onboarding` 是套在完整外壳里渲染的：一个还没配置过任何东西的新用户，
   * 第一屏同时看到三条黄色降级条幅（"中文分词未启用""向量检索未启用""转写组件缺失"）
   * 和一整列他还没有权利用的导航（全部笔记 / 星标 / 录音 / 运行时 / 模型 / 任务中心 / 设置）。
   *
   * 这与引导本身的承诺直接矛盾 —— 引导第一句写的是"每一步都可以跳过"，
   * 而背景里同时挂着三条"你这儿有问题"。R-04 §1.5 的经验是**第一次不要让用户做任何配置决策**，
   * 那就更不该让他先读三条他还看不懂的降级告警。
   *
   * 引导页自己会把这些信息按顺序讲一遍（第 2 步讲加速、第 3 步讲模型），
   * 所以这里不是"藏问题"，是**不要在同一屏把同一件事说两遍、还用告警的语气说**。
   *
   * 判据用 `startsWith` 而不是全等：引导以后加子步骤（`/onboarding/models`）不会悄悄失效。
   */
  const chromeless = useLocation().pathname.startsWith('/onboarding');
  if (chromeless) {
    return (
      <div className="h-full overflow-auto bg-surface-0">
        {/* 内容不足一屏时垂直居中，超过一屏时正常从顶部滚动 ——
            `min-h-full` + `items-center` 的组合两种情况都成立，不需要 JS 测高。 */}
        <div className="flex min-h-full items-center justify-center px-6 py-10">
          <div className="w-full max-w-3xl">
            <PanelBoundary name={t('app.name')}>
              <Suspense fallback={<div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>}>
                <Outlet />
              </Suspense>
            </PanelBoundary>
          </div>
        </div>
        <JobToaster />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── 持久条幅区：全局降级态。可折叠不可关闭 —— 问题还在就不该消失 ── */}
      {/* 不再有"全局 MOCK 条幅"：daemon 是逐个端点接通的，全局开关表达不了
          "笔记已接通、转写还没有"这种真实中间态。改为
          ① 顶栏一个连通性摘要（已接通 N / 模拟 M），
          ② 每个页面在自己的数据区域挂 <MockNotice surface=…/>。
          全部接通后两者都会自己消失，不需要谁记得回来删。 */}
      {/*
        ★ 顶部**只剩一条**「能力未就绪」，且默认折叠（T-107）。

        之前这里是三块：HealthBanner（分词/向量/转写，最多三行）
        + SecureContextBanner（自己再展开四行）+ multiTab（一行）——
        七八行堆在首屏，用户的原话是「打开页面顶部一堆报错」。
        其中 multiTab 和安全上下文里的 "webLocks 不可用" **本来就是同一件事**。

        现在合并进 <ReadinessBanner/>：全就绪时渲染 null，有问题时占一行，
        点开才看明细，每项带可点的修复动作。
      */}
      <PanelBoundary name={t('readiness.title')} fallback={() => null}>
        <ReadinessBanner />
      </PanelBoundary>
      {conn === 'degraded' ? <Banner tone="warning" title={t('banner.sseDegraded')} /> : null}
      {conn === 'reconnecting' ? <Banner tone="info" title={t('banner.sseReconnecting')} /> : null}

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
          <PanelBoundary name={t('nav.folders')}>
            <FolderTree />
          </PanelBoundary>

          <hr className="my-2 border-line" />

          {/*
            运行时与模型是**一级导航**，不埋进设置。
            章程要求 2.1/2.2 把"网页里装 GPU 后端、管模型"列为硬性功能；
            竞品把它们埋在设置里，结果"模型下载卡 0%"成了它最高频的用户问题。
            这两页归 T-022（features/runtime、features/models，见各自 README 契约）。
          */}
          <SideLink to="/runtime" icon={<Cpu className="size-4" />} label={t('nav.runtime')} />
          <SideLink to="/models" icon={<Package className="size-4" />} label={t('nav.models')} />
          <SideLink to="/tasks" icon={<Activity className="size-4" />} label={t('nav.tasks')} />
          <SideLink to="/settings" icon={<Settings className="size-4" />} label={t('nav.settings')} />
        </nav>

        {/* ── 主区 ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center justify-end gap-3 border-b border-line bg-surface-1 px-4">
            <SearchBox />
            <PanelBoundary name={t('app.name')} fallback={() => null}>
              <ConnectivitySummary className="mr-auto" />
            </PanelBoundary>
            {activeCount > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setTasksDrawer(true)}>
                <Activity className="size-3.5 text-accent" />
                {t('app.tasksBadge', { count: activeCount })}
              </Button>
            ) : null}
          </header>

          <main className="min-h-0 flex-1 overflow-auto">
            {/* 路由出口单独兜住：某一页崩了，侧栏与顶栏仍然可用，用户还能切走 */}
            <PanelBoundary name={t('app.name')}>
              <Suspense fallback={<div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>}>
                <Outlet />
              </Suspense>
            </PanelBoundary>
          </main>
        </div>
      </div>

      <PanelBoundary name={t('tasks.title')}>
        <TasksDrawer />
      </PanelBoundary>

      {/*
        安装 / 下载的全局即时反馈层。
        实测：点「安装后端包」之后整整 6 秒页面一个字都没变（详见 JobToaster.tsx 文件头）。
        它挂在外壳而不是某一页里，因为作业活在 daemon 中、不属于任何一页 ——
        用户点完就切走也照样看得见进度和结果。
      */}
      <JobToaster />
    </div>
  );
}

/**
 * 侧栏导航项。
 *
 * ⚠️ 这里**曾经**有一个 `pending` 分支，把还没人认领的页面渲染成不可点击的灰色 `<span>`
 * （"灰显而不是隐藏，让 IA 完整可见"）。`/runtime` 与 `/models` 用的就是它。
 * 后来 T-022 把两个页面做完、路由也注册了，**但没人回来删这两个 `pending`** ——
 * 于是页面明明存在、路由明明通着，用户却**点不动**。
 *
 * 教训：**占位状态必须与"是否已实现"绑定，不能靠人记得回来删。**
 * 该分支已整个移除 —— 没有它，这类"忘了删"就不可能再发生。
 */
function SideLink({
  to,
  icon,
  label,
}: {
  to: string;
  icon: ReactNode;
  label: string;
}) {
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
