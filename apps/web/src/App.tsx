import { Suspense, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Cpu,
  FileAudio,
  Mic,
  Package,
  Plus,
  Settings,
  Star,
  Stethoscope,
} from 'lucide-react';

import { Banner } from './components/common/Banner';
import { ConnectivitySummary } from './components/common/MockNotice';
import { JobToaster } from './components/common/JobToaster';
import { PanelBoundary } from './components/common/PanelBoundary';
import { ReadinessBanner } from './components/common/ReadinessBanner';
import { SearchBox } from './features/search';
import { FolderTree } from './features/folders';
import { Button } from './components/common/Button';
import { TasksDrawer } from './features/tasks/TasksDrawer';
import { useUnfinishedJobCount } from './features/tasks/api';
import { useUiStore } from './lib/stores/ui.store';
import { useConnectionStore } from './lib/stores/connection.store';
import { useProgressStore } from './lib/stores/progress.store';
import { activeNavTarget, NAV_FILTER_KEYS } from './lib/nav/activeNav';
import { cn } from './lib/utils';

/** 应用外壳：顶栏 + 侧栏 + 路由出口（D-05 §1.1）。 */
export default function App() {
  const { t } = useTranslation();
  const setTasksDrawer = useUiStore((s) => s.setTasksDrawer);
  // 侧栏「任务」徽标：与任务中心同一个数据源，不许各拉各的
  const unfinishedJobs = useUnfinishedJobCount();
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
  const location = useLocation();
  const chromeless = location.pathname.startsWith('/onboarding');

  /*
   * ★ 侧栏条目是**数据**，不是散在 JSX 里的七个标签（T-138b）。
   *
   * 高亮判定要看"全部条目"才算得出来（见 `lib/nav/activeNav.ts`：至多一项高亮，
   * 由"返回哪一个"而不是"逐项判是不是"来保证）。如果条目清单和渲染出来的链接是两份，
   * 新加一个 SideLink 却忘了登记，那条链接会**永远不高亮，而且什么都不报**。
   * 从同一份数据渲染，这种漂移在结构上就不成立。
   */
  const collectionNav = [
    { to: '/notes', icon: <FileAudio className="size-4" />, label: t('nav.allNotes') },
    { to: '/notes?starred=1', icon: <Star className="size-4" />, label: t('nav.starred') },
    { to: '/record', icon: <Mic className="size-4" />, label: t('nav.record') },
  ];
  /*
   * 运行时与模型是**一级导航**，不埋进设置。
   * 章程要求 2.1/2.2 把"网页里装 GPU 后端、管模型"列为硬性功能；
   * 竞品把它们埋在设置里，结果"模型下载卡 0%"成了它最高频的用户问题。
   */
  const systemNav = [
    { to: '/runtime', icon: <Cpu className="size-4" />, label: t('nav.runtime') },
    { to: '/models', icon: <Package className="size-4" />, label: t('nav.models') },
    /*
     * ★ 「任务」带一个「进行中 N」徽标。
     *
     * 缺口不是"刷新丢了 Toast"这一种，是**屏幕上没有任何环境信号**：
     * 切页、手动关掉 Toast、开着另一个标签页 —— 四种情况下用户都失去了唯一的进度反馈，
     * 而侧栏这一项此前只是个静态图标。判据：**用户不需要"想起来去点"。**
     * 计数口径与任务中心同源（`useUnfinishedJobCount` → `useMergedJobs`），见那边的说明。
     */
    {
      to: '/tasks',
      icon: <Activity className="size-4" />,
      label: t('nav.tasks'),
      badge: unfinishedJobs,
    },
    /*
     * ★ T-165：`/diagnostics` 此前**在界面上没有任何常驻入口**。
     *
     * 全仓唯一指向它的是 `ReadinessBanner` 里那个按钮，而那条横幅
     * **一切正常时渲染 null** —— 也就是说：只有已经出问题的人才找得到诊断页，
     * 而"我想看看现在到底怎么样"是它最主要的用途。章程要求 2.1 的最后一步
     * 写的就是"显示状态"。这与 T-140 补 `/components` 入口是同一件事的另一半。
     *
     * ⚠️ **`/components` 不进侧栏**，那是查过之后的决定，不是漏了：
     * 它已经有一个入口（`/runtime` 页头），而 D-10 §3.2 的 R3 是
     * "同一问题只准一个出处" —— 再加一条一级导航就是给同一个问题开第二个出处。
     * 诊断页不同：它现在的出处数是 **0**。
     */
    { to: '/diagnostics', icon: <Stethoscope className="size-4" />, label: t('nav.diagnostics') },
    { to: '/settings', icon: <Settings className="size-4" />, label: t('nav.settings') },
  ];
  /*
   * `NAV_FILTER_KEYS`：这些查询串键**代表一个兄弟筛选视图**，出现时一级导航就不该抢高亮。
   *
   * - `starred` —— 就是上面那条 `/notes?starred=1`。
   * - `folder`  —— 文件夹树里的链接（`/notes?folder=<uid>`）。它们是**动态**的，
   *   不可能出现在上面那张静态清单里，所以「folder 代表一个筛选视图」这件事
   *   只能在这里说出来。声明键名而不是地址：键名稳定，uid 不稳定。
   *
   * ⚠️ 只有"代表另一个导航目标"的键才配写进来。`tab` **不在此列** ——
   * 它是页内视图状态，写进来就会让 `/models?tab=llm` 退回"一项都不亮"（T-138b 那个哑巴 bug）。
   */
  const activeNav = activeNavTarget(
    [...collectionNav, ...systemNav].map((i) => i.to),
    location,
    NAV_FILTER_KEYS,
  );

  if (chromeless) {
    return (
      <div className="h-full overflow-auto bg-surface-0">
        {/* 内容不足一屏时垂直居中，超过一屏时正常从顶部滚动 ——
            `min-h-full` + `items-center` 的组合两种情况都成立，不需要 JS 测高。 */}
        <div className="flex min-h-full items-center justify-center px-6 py-10">
          <div className="w-full max-w-3xl">
            <PanelBoundary name={t('app.name')}>
              <Suspense
                fallback={<div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>}
              >
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

          {collectionNav.map((item) => (
            <SideLink key={item.to} {...item} active={activeNav === item.to} />
          ))}

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
          {systemNav.map((item) => (
            <SideLink key={item.to} {...item} active={activeNav === item.to} />
          ))}
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
                <Activity className="size-3.5 text-accent-ink" />
                {t('app.tasksBadge', { count: activeCount })}
              </Button>
            ) : null}
          </header>

          <main className="min-h-0 flex-1 overflow-auto">
            {/* 路由出口单独兜住：某一页崩了，侧栏与顶栏仍然可用，用户还能切走 */}
            <PanelBoundary name={t('app.name')}>
              <Suspense
                fallback={<div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>}
              >
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
/**
 * 侧栏的一项。**它自己不判断要不要高亮** —— `active` 由上面算好传进来。
 *
 * ⚠️ 这是本轮的结构性改动，不只是搬家（T-138b）：
 * 判定原先写在这里，每一项各判各的，于是"至多一项高亮"这条性质**没有任何地方在管它**。
 * 实测两个方向都破过：`/notes/<uid>` 上两项同时亮（详情页是 `/notes` 的子路径，
 * 判据交回了 NavLink 的前缀匹配）；`/models?tab=llm` 上**一项都不亮**（pathname 相同、
 * 查询串不同，被判成不匹配）。规则挪到 `lib/nav/activeNav.ts` 之后，它返回**一个** target，
 * 这条性质由类型保证。
 *
 * ⚠️ **用 `Link` 而不是 `NavLink`，这一步是必须的，不是风格选择。**
 * `NavLink` 会**自己**按 `isActive` 写 `aria-current="page"`，外面传的 `aria-current`
 * 只能改它的取值、关不掉它。也就是说：同一个缺陷在**无障碍层也存在** ——
 * `[实测]` 在 `/notes` 与 `/notes/<uid>` 上，「全部笔记」和「星标」**两项都被标成了当前页**，
 * 读屏用户听到的是"你同时在两个地方"。视觉上的双高亮至少还能被看见并报上来，
 * 这一条谁都看不见。既然已经不用它的 `isActive` 了，换成 `Link` 一并解决。
 */
function SideLink({
  to,
  icon,
  label,
  active,
  badge,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  active: boolean;
  /** 可选的计数徽标。`undefined` 或 0 = 不渲染任何东西（**不许渲染一个 0**）。 */
  badge?: number | undefined;
}) {
  const { t } = useTranslation();
  const showBadge = typeof badge === 'number' && badge > 0;
  return (
    <Link
      to={to}
      /*
       * ★ 计数必须进**可及名称**，不能只做一个视觉小圆点。
       * 只给颜色/数字的话，读屏用户读到的仍然只是"任务"——
       * 而这个徽标存在的全部理由就是"告诉用户还有活在跑"，
       * 对读不到它的人来说等于没做。
       */
      aria-label={showBadge ? t('nav.tasksBadgeLabel', { label, n: badge }) : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
        /*
         * 选中态 = 品牌淡底 + 品牌文字（T-124）。
         *
         * 原来是 `bg-surface-2`：侧栏底是 `--surface-1`，两者在明档实测 **1.02:1** ——
         * "你现在在哪一页"这条信息在亮色主题里等于没有显示。
         * hover 也是同一个 surface-2，于是**选中态和 hover 态还长得一模一样**。
         * 现在两者分工：hover = 中性叠加，选中 = 品牌色（语义，不是层级）。
         */
        active
          ? 'bg-accent-tint font-medium text-accent-ink'
          : 'text-ink-secondary hover:bg-fill-hover hover:text-ink',
      )}
    >
      {icon}
      {label}
      {showBadge ? (
        <span
          data-testid="nav-badge"
          /* aria-hidden：数字已经进了上面的 aria-label，这里再念一遍是重复播报 */
          aria-hidden
          className="ml-auto min-w-[1.25rem] rounded-full bg-accent px-1.5 py-0.5 text-center text-[11px] font-medium tabular-nums text-accent-fg"
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
