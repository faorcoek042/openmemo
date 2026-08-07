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
        {offline ? <PlugZap className="size-3" aria-hidden /> : <FlaskConical className="size-3" aria-hidden />}
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
  const buildStamp = health ? (
    <span className="text-ink-muted/70" title={buildTitle(health.version, health.build)}>
      daemon {versionLabel(health.version)} {buildLabel(health.build)}
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

type BuildMeta = NonNullable<NonNullable<ReturnType<typeof useSurfaceStore.getState>['health']>['build']>;

const hms = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
const mdhms = (iso: string) =>
  `${new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${hms(iso)}`;

/**
 * 角落里这一行有**四个**信号，各答各的，谁也替不了谁 —— 所以谁也不能挤掉谁：
 *
 * | 显示        | 回答的问题           | 为什么别的答不了                             |
 * |-------------|----------------------|----------------------------------------------|
 * | `v0.2.0`    | **第几个可用的东西** | commit 是 hash，比不出大小，也数不出"第几个" |
 * | commit/提交时间 | 跑的是哪一份代码 | 一个版本号底下可以有几十个 commit            |
 * | `起 HH:MM:SS` | 到底重启了没有     | 前两个在重启前后一模一样                     |
 *
 * ★ 版本号是 D-12 之后**才有意义**的。此前它是 daemon 源码里手写的 `'0.1.0'`，
 * 和任何 `package.json` 都没有关系，因此从项目开始就没变过 —— 用户看到的是一个
 * 长得很像版本号、但什么都不报告的东西。现在它由构建从根 `package.json` 烘焙进产物。
 *
 * `+dirty` = 构建时工作区有未提交改动，此时 commit 号不足以说明跑的是什么。
 */
function versionLabel(version: string | undefined) {
  // 'unknown' 是 daemon 在读不到 dist/build-info.json 时的**诚实**回答（没构建过 /
  // 非 git 检出）。照原样渲染会变成 "vunknown"，看起来像个真版本号 —— 那正是要避免的。
  if (!version || version === 'unknown') return '版本未知';
  return `v${version}`;
}

function buildLabel(b: BuildMeta | undefined) {
  if (!b) return '(构建信息未知)';
  const commit = b.commitTime ? mdhms(b.commitTime) : b.commit;
  return `· ${commit}${b.dirty ? '+dirty' : ''} · 起 ${hms(b.startedAt)}`;
}

function buildTitle(version: string | undefined, b: BuildMeta | undefined) {
  const head =
    !version || version === 'unknown'
      ? '版本: 未知（daemon 没读到构建信息，多半是没构建过）'
      : `版本: ${version} —— 第 ${version.split('.')[1]} 个可用版本（见 CHANGELOG.md）`;
  if (!b) return `${head}\n该 daemon 未提供构建信息（可能是旧版本，或未经构建脚本生成）`;
  return [
    head,
    `commit: ${b.commit}${b.dirty ? ' (构建时工作区有未提交改动)' : ''}`,
    b.commitTime ? `提交时间: ${mdhms(b.commitTime)}` : null,
    b.builtAt ? `构建时间: ${mdhms(b.builtAt)}` : null,
    `本次启动: ${mdhms(b.startedAt)}`,
    '',
    '版本号答「第几个」，commit 答「哪一份代码」，启动时刻答「重启了没」。',
  ]
    .filter((x) => x !== null)
    .join('\n');
}
