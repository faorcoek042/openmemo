import { Trash2 } from 'lucide-react';
import type { GetStorageResponse } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { formatBytes } from '../../../lib/format/bytes';
import { cn } from '../../../lib/utils';

/**
 * 磁盘占用分解条。
 *
 * ★ 硬性要求（features/models/README.md，`architect` 实测对比度后写死）：
 * **必须配图例和字节数标签，不能只画色条。**
 * 明档 `--data-3`（aqua）对比度 2.74:1、`--data-4`（yellow）2.11:1，都低于 3:1 ——
 * 纯靠颜色区分分类对部分用户根本不可读。所以每一段都有图例方块 + 名称 + 字节数，
 * 色条只是辅助，删掉颜色信息依然完整。
 *
 * 分类色固定顺序（tokens.css）：data-1 模型 / data-2 后端 / data-3 媒体 / data-4 缓存。
 */

const CAT_COLOR = ['bg-data-1', 'bg-data-2', 'bg-data-3', 'bg-data-4'] as const;

export interface StorageBreakdownProps {
  storage: GetStorageResponse;
  locale: string;
  onGc?: () => void;
  gcPending?: boolean;
}

export function StorageBreakdown({ storage, locale, onGc, gcPending }: StorageBreakdownProps) {
  const { reclaimable } = storage;
  const reclaimableBytes =
    reclaimable.orphanBlobsBytes + reclaimable.stalePartialsBytes;

  // 只展示 Top 4，其余归"其他" —— 不新造第 5 个分类色（tokens.css 的约定）。
  const sorted = [...storage.breakdown].sort((a, b) => b.bytes - a.bytes);
  const top = sorted.slice(0, 4);
  const restBytes = sorted.slice(4).reduce((a, x) => a + x.bytes, 0);
  const segments = [
    ...top.map((x, i) => ({
      label: x.displayName,
      bytes: x.bytes,
      color: CAT_COLOR[i],
      active: x.active,
    })),
    ...(restBytes > 0
      ? [{ label: '其他', bytes: restBytes, color: 'bg-ink-muted', active: false }]
      : []),
  ];
  const total = segments.reduce((a, s) => a + s.bytes, 0) || 1;

  return (
    <section
      className="rounded-lg border border-line bg-surface-1 p-4"
      aria-label="磁盘占用"
      data-testid="models-storage"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-ink">磁盘占用</h2>
        <span className="text-xs text-ink-secondary">
          模型共占用 {formatBytes(storage.usedBytes, locale)} · 卷剩余{' '}
          {formatBytes(storage.volume.freeBytes, locale)}
        </span>
      </div>

      {/* 色条：辅助信息，不是唯一载体 */}
      <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-accent-tint">
        {segments.map((s) => (
          <div
            key={s.label}
            className={cn('h-full', s.color)}
            style={{ width: `${(s.bytes / total) * 100}%` }}
            aria-hidden
          />
        ))}
      </div>

      {/* 图例 + 数字标签：即使完全看不见颜色，信息也完整 */}
      <ul className="mt-3 space-y-1.5">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-xs">
            <span className={cn('size-2.5 shrink-0 rounded-sm', s.color)} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink">{s.label}</span>
            {s.active ? <span className="shrink-0 text-good">使用中</span> : null}
            <span className="shrink-0 tabular-nums text-ink-secondary">
              {formatBytes(s.bytes, locale)}
            </span>
          </li>
        ))}
        {segments.length === 0 ? (
          <li className="text-xs text-ink-muted">还没有安装任何模型</li>
        ) : null}
      </ul>

      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="text-xs text-ink-secondary">
          可清理：未完成的下载 {formatBytes(reclaimable.stalePartialsBytes, locale)} · 孤立文件{' '}
          {formatBytes(reclaimable.orphanBlobsBytes, locale)}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={reclaimableBytes === 0 || gcPending}
          onClick={onGc}
          data-testid="models-gc-button"
        >
          <Trash2 className="size-3.5" aria-hidden />
          清理 {formatBytes(reclaimableBytes, locale)}
        </Button>
      </div>
    </section>
  );
}
