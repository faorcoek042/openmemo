import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Info, Star, Trash2, Zap } from 'lucide-react';
import { Link } from 'react-router';
import type { CatalogGroupWithFitness, CatalogVariant } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { StatusChip } from '../../../components/common/StatusChip';
import { FitBadge, FitEta, FitGpuLayers } from '../../../components/common/FitBadge';
import { formatBytes } from '../../../lib/format/bytes';
import { localizedDescription, localizedName } from '../../../lib/format/localized';
import { QuantSelector } from './QuantSelector';

/**
 * 目录里的一张模型卡（R-04 §9.1 线框）。
 *
 * 信息架构是两层：**模型**（折叠）→ **量化档**（展开选）。这是 LM Studio 的做法，
 * 也是唯一合理的组织方式 —— 同一个 Whisper large-v3-turbo 有 q5_0/q8_0/f16 三个变体，
 * 平铺成三张卡会让列表长三倍且难以比较。
 */

export interface ModelCardProps {
  group: CatalogGroupWithFitness;
  locale: string;
  installedIds: Set<string>;
  activeId: string | null;
  onPull: (variant: CatalogVariant) => void;
  onDelete: (id: string) => void;
  onActivate: (id: string) => void;
  pendingId: string | null;
}

export function ModelCard({
  group,
  locale,
  installedIds,
  activeId,
  onPull,
  onDelete,
  onActivate,
  pendingId,
}: ModelCardProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(
    () =>
      group.variants.find((v) => v.fitness.tier === 'recommended')?.id ?? group.variants[0]?.id ?? '',
  );
  const variant = group.variants.find((v) => v.id === selectedId) ?? group.variants[0];
  if (!variant) return null;

  const installed = installedIds.has(variant.id);
  const isActive = activeId === variant.id;
  const isDefault = group.tags.includes('recommended-default');
  const pending = pendingId === variant.id;

  // 只有磁盘不足才真正禁用 —— 那是确定性事实。
  // 其余档位（含 unsupported）都可点，弹二次确认：估算必然有误差，
  // 硬禁用会把"估算可能错"变成"功能缺失"，用户没法自救（R-04 §9.6 第 7 条）。
  const hardBlocked = variant.fitness.tier === 'blocked_disk';

  return (
    <article
      className="rounded-lg border border-line bg-surface-1 p-4"
      data-testid={`model-card-${group.groupId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <FitBadge fitness={variant.fitness} />
            <h3 className="text-sm font-medium text-ink">{localizedName(locale, group)}</h3>
            {isDefault ? (
              <StatusChip tone="neutral" label={t('models.card.officialDefault')} icon={<Star className="size-3.5" />} />
            ) : null}
            {installed ? <StatusChip tone="good" label={t('models.card.installed')} /> : null}
            {/* 「使用中」与「已安装」同为 good：区分交给 ⚡ 图标与文字，不靠颜色（statusTone.ts） */}
            {isActive ? (
              <StatusChip tone="good" label={t('models.card.inUse')} icon={<Zap className="size-3.5" />} />
            ) : null}
          </div>
          <p className="mt-1 text-xs text-ink-secondary">{localizedDescription(locale, group)}</p>
        </div>
        <Link
          to={`/models/${encodeURIComponent(variant.id)}`}
          className="shrink-0 text-xs text-accent-ink hover:underline"
        >
          <span className="inline-flex items-center gap-1">
            <Info className="size-3.5" aria-hidden />
            {t('models.card.details')}
          </span>
        </Link>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <QuantSelector
          variants={group.variants}
          selectedId={variant.id}
          onSelect={setSelectedId}
          locale={locale}
        />
        <span className="text-xs text-ink-secondary">
          {t('models.card.vramNeeded', {
            size: formatBytes(variant.requirements.vramRequiredMB * 1e6, locale),
          })}
        </span>
        <FitEta fitness={variant.fitness} />
      </div>

      <p className="mt-2 text-xs text-ink-secondary">{variant.fitness.reasonZh}</p>
      <FitGpuLayers fitness={variant.fitness} />

      <div className="mt-3 flex items-center justify-end gap-2">
        {installed ? (
          <>
            {!isActive ? (
              <Button size="sm" variant="secondary" onClick={() => onActivate(variant.id)}>
                <Star className="size-3.5" aria-hidden />
                {t('models.card.setDefault')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDelete(variant.id)}
              data-testid="model-delete"
            >
              <Trash2 className="size-3.5" aria-hidden />
              {t('models.card.delete')}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant={variant.fitness.tier === 'recommended' ? 'primary' : 'secondary'}
            disabled={hardBlocked || pending}
            onClick={() => onPull(variant)}
            data-testid="models-download-button"
          >
            <Download className="size-3.5" aria-hidden />
            {pending
              ? t('models.card.starting')
              : hardBlocked
                ? t('models.card.noSpace')
                : variant.fitness.tier === 'unsupported'
                  ? t('models.card.downloadAnyway', {
                      size: formatBytes(variant.totalSizeBytes, locale),
                    })
                  : t('models.card.download', {
                      size: formatBytes(variant.totalSizeBytes, locale),
                    })}
          </Button>
        )}
      </div>
    </article>
  );
}
