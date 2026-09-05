import { useTranslation } from 'react-i18next';
import { FlaskConical, PlugZap } from 'lucide-react';

import {
  isSurfaceMocked,
  useSurfaceStore,
  type Surface,
  type SurfaceState,
} from '../../lib/api/surfaces';
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
  const { t, i18n } = useTranslation();
  const states = useSurfaceStore((s) => s.states);
  const health = useSurfaceStore((s) => s.health);

  const entries = Object.entries(states) as [Surface, string][];
  /*
   * ★ **`'generic'` 不是一个"面"，不许进这两个数。**
   *
   * `lib/api/surfaces.ts` 对它的定义写得很清楚：「未声明 surface 的调用落点。
   * **不计入"已接通/模拟"统计**，只用于回落逻辑」。而这里原本是
   * `Object.entries(states)` 直接数，**漏了 `s !== 'generic'` 这一条** ——
   * 于是任何一次裸 `api('/…')` 调用（今天仍有二十来处）把 `generic` 标成 live 或 mock，
   * 顶栏那句「已接通 N / 模拟 M」就多算一个，**最多差 1**。
   *
   * 一个"关于系统状态的仪表盘自己报错数"，比没有仪表盘更坏：
   * 它教人不再相信这一格，而这一格恰恰是用来判断"哪块是真的"的。
   *
   * ⚠️ **这里仍然是第二份实现，只是它现在被钉住了。**
   * `surfaces.ts` 里的 `liveSurfaces()` / `mockedSurfaces()` 各自带着这条过滤，
   * 本该直接调用它们。没有那么做的理由是外部的、而且是临时的：那两个导出今天登记在
   * `scripts/orphan-exports-baseline.json` 的零引用豁免名单里，一旦被产品代码接上，
   * `check:orphans` 会要求同步删掉那两行 —— 而那个文件本轮归另一路处置
   * （正在被整体删除），我不能同时改它。
   *
   * 所以先用测试兜住：`src/test/components.test.tsx` 的「ConnectivitySummary」那一族里
   * 有两条腿，正反两面钉住"generic 不进这两个数"。
   * **等那份基线落定，这里应当直接换成调用那两个函数** —— 这是一笔明写的欠账，
   * 不是一个已经收工的设计。
   */
  const counted = entries.filter(([s]) => s !== 'generic');
  const live = counted.filter(([, v]) => v === 'live').length;
  const mocked = counted.filter(([, v]) => isSurfaceMocked(v as SurfaceState)).length;

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
              at: hms(health.build.startedAt, i18n.language),
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

/**
 * 「启动于 12:35:01」里的那个钟点。
 *
 * ⚠️ **`locale` 是必填的，不许再退回 `undefined`。**
 * 这里原本是 `toLocaleTimeString(undefined, …)` —— `undefined` 的含义是
 * **浏览器的语言**，不是应用的语言。而应用的语言是用户在引导第一步自己选的
 * （`app/i18n` 的 `i18n.language`，会写进 localStorage）。
 * 于是一台系统语言是英文、应用里选了中文的机器上，整页中文里这一格按 en-US 排版 ——
 * 全仓另外 12 处绝对时间戳（`ModelsPage` / `HardwareCard` / `DiagnosticsPage` …）
 * 用的都是 `i18n.language` / `locale`，**只有这里是例外**。
 *
 * 「例外」在这类事情上从来不是小事：它不会报错、不会崩，只会让人偶尔觉得
 * "这个界面有点不对劲"，然后谁也说不出哪里不对。
 */
const hms = (iso: string, locale: string) =>
  new Date(iso).toLocaleTimeString(locale, { hour12: false });

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
