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

  if (mocked === 0) return null;

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs text-ink-muted', className)}
      title={entries.map(([k, v]) => `${k}: ${v}`).join('\n')}
    >
      <FlaskConical className="size-3 text-serious" aria-hidden />
      {t('mock.summary', { live, mocked })}
      {health ? (
        <span className="text-ink-muted/70" title={buildTitle(health.build)}>
          · daemon v{health.version} {buildLabel(health.build)}
        </span>
      ) : null}
    </span>
  );
}

type BuildMeta = NonNullable<NonNullable<ReturnType<typeof useSurfaceStore.getState>['health']>['build']>;

const hms = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
const mdhms = (iso: string) =>
  `${new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${hms(iso)}`;

/**
 * 角落里那行版本号要同时回答两个问题：**跑的是哪份代码** 和 **刚才那次重启生效了没有**。
 *
 * commit 只答得了第一个 —— 同一个 commit 重启两次，commit 号一模一样。
 * 所以启动时刻必须一起显示，否则"我改完让它重启了，页面没变，是没重启还是改动没生效"
 * 这个问题无法从界面上回答，只能靠猜。
 *
 * `+dirty` = 构建时工作区有未提交改动，此时 commit 号不足以说明跑的是什么。
 */
function buildLabel(b: BuildMeta | undefined) {
  if (!b) return '(构建信息未知)';
  const commit = b.commitTime ? mdhms(b.commitTime) : b.commit;
  return `· ${commit}${b.dirty ? '+dirty' : ''} · 起 ${hms(b.startedAt)}`;
}

function buildTitle(b: BuildMeta | undefined) {
  if (!b) return '该 daemon 未提供构建信息（可能是旧版本，或未经构建脚本生成）';
  return [
    `commit: ${b.commit}${b.dirty ? ' (构建时工作区有未提交改动)' : ''}`,
    b.commitTime ? `提交时间: ${mdhms(b.commitTime)}` : null,
    b.builtAt ? `构建时间: ${mdhms(b.builtAt)}` : null,
    `本次启动: ${mdhms(b.startedAt)}`,
  ]
    .filter(Boolean)
    .join('\n');
}
