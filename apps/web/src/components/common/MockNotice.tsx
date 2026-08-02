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
      {health ? <span className="text-ink-muted/70">· daemon v{health.version}</span> : null}
    </span>
  );
}
