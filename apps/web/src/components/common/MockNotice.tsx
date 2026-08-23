import { useTranslation } from 'react-i18next';
import { FlaskConical, PlugZap } from 'lucide-react';

import { isSurfaceMocked, useSurfaceStore, type Surface } from '../../lib/api/surfaces';
import { cn } from '../../lib/utils';

/**
 * 单个 API 面的"这块还是假数据"提示（T-029）。
 *
 * ## 为什么是按面而不是全局条幅
 *
 * daemon 正被逐个端点接通。全局条幅只有两种状态（全真 / 全假），
 * 于是"笔记列表已经是真的、但转写还是假的"这种**真实的中间态无法表达**——
 * 要么谎称全接通了，要么把已接通的部分也说成假的。两种都是失真。
 *
 * 按面之后，用户（和验收的人）在页面上看到的就是精确的事实：
 * 哪块真、哪块假、假的那块是因为"还没实现"还是"服务没启动"。
 */
export function MockNotice({
  surface,
  className,
  compact,
}: {
  surface: Surface;
  className?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const state = useSurfaceStore((s) => s.states[surface]);

  if (!isSurfaceMocked(state)) return null;

  const offline = state === 'offline';
  const label = offline ? t('mock.offlineShort') : t('mock.notImplementedShort');

  if (compact) {
    return (
      <span
        className={cn('inline-flex items-center gap-1 text-xs text-serious', className)}
        title={offline ? t('mock.offlineDetail') : t('mock.notImplementedDetail')}
      >
        {offline ? (
          <PlugZap className="size-3" aria-hidden />
        ) : (
          <FlaskConical className="size-3" aria-hidden />
        )}
        {label}
      </span>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border border-line border-l-4 border-l-serious bg-surface-1 px-3 py-2 text-xs',
        className,
      )}
    >
      {offline ? (
        <PlugZap className="mt-0.5 size-3.5 shrink-0 text-serious" aria-hidden />
      ) : (
        <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-serious" aria-hidden />
      )}
      <div>
        <div className="font-medium text-ink">{label}</div>
        <div className="mt-0.5 text-ink-secondary">
          {offline ? t('mock.offlineDetail') : t('mock.notImplementedDetail')}
        </div>
      </div>
    </div>
  );
}

/**
 * 顶栏的整体连通性摘要：`已接通 4 / 模拟 3`。
 * 只在**存在**模拟面时出现 —— 全部接通后它自己消失，不需要谁去删代码。
 */
export function ConnectivitySummary({ className }: { className?: string }) {
  const { t } = useTranslation();
  const states = useSurfaceStore((s) => s.states);
  const health = useSurfaceStore((s) => s.health);

  const entries = Object.entries(states) as [Surface, string][];
  const live = entries.filter(([, v]) => v === 'live').length;
  const mocked = entries.filter(([, v]) => isSurfaceMocked(v as never)).length;

  /*
   * ★ 版本戳**不能**跟着"还有假数据"这个条件一起消失。
   *
   * 原来两者写在同一个 `if (mocked === 0) return null` 下面 —— 于是所有面都接通那天，
   * 版本戳会**一起不见**。而那正是最需要它的时刻：产品看起来正常了，
   * 用户判断"我刚让它重启的改动生效了没有"就只剩下猜。
   *
   * 这是「Tab 条嵌在 `tab === 'asr'` 的 hidden 分支里」的同族缺陷：
   * **嵌套让 A 继承了 B 的消失条件**，而 A 和 B 本来毫无关系。
   * 判据：一个元素的显示条件，必须是它自己的条件。
   */
  /*
   * ⚠️ 没有 `build` 时**不给 tooltip**，而不是给一句「该 daemon 未提供构建信息」。
   * 后者是在向用户报告我们这一侧的字段缺失 —— 他既不关心也做不了什么。
   * 一个内容等于标签本身的 tooltip 同样是噪音。
   */
  const buildStamp = health ? (
    <span
      className="text-ink-muted/70"
      data-testid="version-stamp"
      {...(health.build
        ? {
            title: t('app.versionStampTitle', {
              version: versionLabel(t, health.version),
              at: hms(health.build.startedAt),
            }),
          }
        : {})}
    >
      {versionLabel(t, health.version)}
    </span>
  ) : null;

  if (mocked === 0) {
    return buildStamp ? (
      <span className={cn('inline-flex items-center gap-1.5 text-xs text-ink-muted', className)}>
        {buildStamp}
      </span>
    ) : null;
  }

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs text-ink-muted', className)}
      title={entries.map(([k, v]) => `${k}: ${v}`).join('\n')}
    >
      <FlaskConical className="size-3 text-serious" aria-hidden />
      {t('mock.summary', { live, mocked })}
      {buildStamp ? <>· {buildStamp}</> : null}
    </span>
  );
}

const hms = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });

/**
 * 角落里这一格显示什么 —— **只剩两个信号，另外两个搬去了诊断页。**
 *
 * ## 原来是四个，而其中两个是开发者信号
 *
 * 这一行逐字是 `daemon v0.7.4 · 08-24 12:34:56+dirty · 起 12:35:01`，
 * tooltip 是七行，最后一行写着「版本号答「第几个」，commit 答「哪一份代码」，
 * 启动时刻答「重启了没」」——**那是我们自己的诊断分类学**。
 * 而 `+dirty`（构建时工作区有未提交改动）、commit hash、「见 CHANGELOG.md」
 * 都是给开发者看的。整块还**硬编码中文、日期写死 `zh-CN`**，
 * 于是它在英文界面上是这一页仅剩的中文之一。
 *
 * ## 留下的那两个，以及为什么
 *
 * | 显示 | 回答的问题 | 为什么留 |
 * |---|---|---|
 * | `v0.7.4` | 跑的是哪一版 | 用户报问题时唯一说得清的东西 |
 * | tooltip 里的「启动于 12:35」 | **到底重启了没有** | 版本号在重启前后一模一样，只有它答得了 |
 *
 * 「是否重启了」这个信号是**刻意**放在这里的（用户靠它确认"我让它重启的改动生效了没"），
 * 所以它没有被搬走，只是从主行挪进 tooltip。
 *
 * ## 搬走的那两个去了哪
 *
 * commit / `+dirty` / 提交时间 / 构建时间 → **诊断页的「服务」组**
 * （`DiagnosticsPage` 里 `diagnostics.build` 那一行）。那一页本来就是这个用途，
 * 而且「导出诊断包」也在那儿 —— 要排障的人本来就会去那里。
 *
 * ★ 版本号是 D-12 之后**才有意义**的。此前它是 daemon 源码里手写的 `'0.1.0'`，
 * 和任何 `package.json` 都没有关系，从项目开始就没变过 —— 用户看到的是一个
 * 长得很像版本号、但什么都不报告的东西。现在它由构建从根 `package.json` 烘焙进产物。
 */
function versionLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  version: string | undefined,
) {
  // 'unknown' 是 daemon 在读不到 dist/build-info.json 时的**诚实**回答（没构建过 /
  // 非 git 检出）。照原样渲染会变成 "vunknown"，看起来像个真版本号 —— 那正是要避免的。
  if (!version || version === 'unknown') return t('app.versionUnknown');
  return `v${version}`;
}
