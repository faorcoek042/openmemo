import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Info, Star, Trash2, Zap } from 'lucide-react';
import { Link } from 'react-router';
import type { CatalogGroupWithFitness, CatalogVariant } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { Emphasis } from '../../../components/common/Emphasis';
import { StatusChip } from '../../../components/common/StatusChip';
import { FitBadge, FitEta, FitGpuLayers } from '../../../components/common/FitBadge';
import { formatBytes } from '../../../lib/format/bytes';
import { localizedDescription, localizedName } from '../../../lib/format/localized';
import { useIsAppleSilicon } from '../../../lib/api/hardware';
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
  /**
   * @param includeOptional 用户勾选的可选文件 role（今天只有 `coreml-encoder`）。
   *   **必须显式传出去**：daemon 的 `selectFiles()` 只有收到
   *   `includeOptional:['coreml-encoder']` 才会下载它（`installer.ts:129`），
   *   而 T-153 之前**全仓没有任何地方传过这个值** —— 也就是说
   *   「用户在界面上根本没有办法装 CoreML encoder」，ANE 那条链在这里断掉。
   */
  onPull: (variant: CatalogVariant, includeOptional: string[]) => void;
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
  /**
   * 勾选"同时下载 CoreML encoder"。
   *
   * **默认不勾**：它是另外 ~1.1 GB，而且不装也能正常转写（只是走 Metal/CPU 慢一些）。
   * 默认勾上等于替用户决定花掉一个多 GB 的流量与磁盘。
   */
  const [wantCoreMl, setWantCoreMl] = useState(false);
  /** 三态：`null` = 硬件还没探回来（此时什么都不渲染，不先当成"不是 Mac"）。 */
  const appleSilicon = useIsAppleSilicon();

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

  /*
   * 这个变体到底有没有 CoreML encoder，**问清单，不猜**。
   * `role === 'coreml-encoder'` 是契约里的枚举值（`FILE_ROLES`），
   * 按文件名匹配 `.mlmodelc` 会在上游换命名时静默失效。
   */
  const coreMlFile = variant.files.find((f) => f.role === 'coreml-encoder');
  const offerCoreMl = appleSilicon === true && coreMlFile !== undefined && !installed;

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
          {/*
            ★ T-150：目录里的描述**带 Markdown 强调记号**，必须渲染成 `<strong>`。
            实测：`vad/silero-vad` 的 `descriptionZh` 是
            「语音活动检测，**sherpa-onnx 引擎专用格式**。…whisper.cpp 用不了这个文件」——
            照直渲染，用户在页面上看到的是两颗裸星号（与 T-129 修掉的
            `settings.llmIntro` / disclosure 是同一族，只是这次的文字来自 manifest 而不是 i18n）。
            `EMPHASIS_REGISTRY` 那条护栏只扫 locale 文件，**扫不到 manifest**，
            所以这一处只能在渲染侧接住。
          */}
          <Emphasis
            className="mt-1 block text-xs text-ink-secondary"
            text={localizedDescription(locale, group)}
          />
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

      {/*
        ★ T-153：CoreML encoder（Apple 神经引擎）。**这是 ANE 链路上断掉的那一环。**

        `libwhisper.coreml.dylib` 早就编进 macOS 包里了（T-146 `[CI 实测]` 解包确认），
        清单里也有 encoder 条目，但它是 `optional` —— daemon 只在收到
        `includeOptional:['coreml-encoder']` 时才下载，而**全仓没有任何地方传过这个值**。
        于是自检一直如实报 `asr.coreml warn 未启用 ANE`，而用户在界面上
        **没有任何办法**去装它。这个勾选框就是那个办法。

        只在 Apple Silicon 上渲染：其它平台勾了也会被 daemon 按 `platforms` 过滤掉，
        画一个"勾了什么都不会发生"的框比不画更糟。
      */}
      {offerCoreMl ? (
        <label
          className="mt-2 flex items-start gap-2 text-xs text-ink-secondary"
          data-testid="model-coreml-optin"
        >
          <input
            type="checkbox"
            checked={wantCoreMl}
            onChange={(e) => setWantCoreMl(e.target.checked)}
            className="mt-0.5"
            data-testid="model-coreml-checkbox"
          />
          <span>
            {t('models.card.coreml.label', {
              size: formatBytes(coreMlFile!.sizeBytes, locale),
            })}
            <span className="block text-ink-muted">{t('models.card.coreml.hint')}</span>
          </span>
        </label>
      ) : null}

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
            onClick={() => onPull(variant, wantCoreMl && offerCoreMl ? ['coreml-encoder'] : [])}
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
