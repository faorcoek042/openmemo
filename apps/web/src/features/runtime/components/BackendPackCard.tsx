import { useTranslation } from 'react-i18next';
import { Download, Lock, Play, Trash2 } from 'lucide-react';
import type { BackendSelfTest, GetBackendCatalogResponse } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { StatusChip } from '../../../components/common/StatusChip';
import { BackendChip } from '../../../components/common/BackendChip';
import { formatBytes } from '../../../lib/format/bytes';
import { localizedName } from '../../../lib/format/localized';

type Pack = GetBackendCatalogResponse['packs'][number];

/**
 * 一个加速后端包（章程要求 2.1 的"下载对应预编译二进制 → 安装 → 自检 → 显示状态"）。
 *
 * ★ **L1 内置 CPU 包不可删除**（ADR-003 附录 A.3）：ggml 在没有任何可用后端时会 SIGABRT，
 * CPU 包是承重墙。这里从 UI 上就禁用删除并说明原因，而不是等用户删完崩溃再解释。
 */

export interface BackendPackCardProps {
  pack: Pack;
  locale: string;
  isActive: boolean;
  selfTest: BackendSelfTest | null;
  installing: boolean;
  onInstall: (id: string) => void;
  onRemove: (id: string) => void;
  onSelect: (pack: Pack) => void;
  onSelfTest: (id: string) => void;
}

export function BackendPackCard({
  pack,
  locale,
  isActive,
  selfTest,
  installing,
  onInstall,
  onRemove,
  onSelect,
  onSelfTest,
}: BackendPackCardProps) {
  const { t } = useTranslation();
  // 承重墙：内置 CPU 档不允许卸载
  const isLoadBearing = pack.tier === 'builtin' || pack.backend === 'cpu';
  /**
   * 已构建、摘要已核实，但**还没有发布地址**（仓库无 git remote，CI 从未跑过）。
   * 必须在按钮上就说清楚，而不是让用户点下去等一个必然失败的下载 ——
   * 失败要在看得见的地方发生，不要推迟到点击之后。
   */
  const pendingCi = (pack as { availability?: string }).availability === 'pending-ci';
  const selfTestFailed = selfTest != null && !selfTest.passed;

  const actions = pack.installed ? (
    <>
      {!isActive ? (
        <Button size="sm" variant="secondary" onClick={() => onSelect(pack)}>
          {t('runtime.pack.setActive')}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => onSelfTest(pack.id)}>
        <Play className="size-3.5" aria-hidden />
        {t('runtime.pack.selfTest')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={isLoadBearing}
        title={
          isLoadBearing ? t('runtime.pack.loadBearingTitle') : undefined
        }
        onClick={() => onRemove(pack.id)}
        data-testid={`backend-remove-${pack.id}`}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {t('runtime.pack.uninstall')}
      </Button>
    </>
  ) : (
    <Button
      size="sm"
      variant={pack.recommended ? 'primary' : 'secondary'}
      disabled={installing || !pack.applicable || pendingCi}
      title={pendingCi ? t('runtime.pack.pendingCiTitle') : undefined}
      onClick={() => onInstall(pack.id)}
      data-testid={`backend-install-${pack.id}`}
    >
      <Download className="size-3.5" aria-hidden />
      {pendingCi
        ? t('runtime.pack.pendingCi')
        : installing
          ? t('runtime.pack.installing')
          : t('runtime.pack.install', { size: formatBytes(pack.totalSizeBytes, locale) })}
    </Button>
  );

  return (
    <article
      className="rounded-lg border border-line bg-surface-1 p-3.5"
      data-testid={`backend-pack-${pack.id}`}
    >
      {/*
        ★ 动作按钮从"卡片底部自成一行"挪到了标题行右侧。

        原来的结构是：标题行（右半边完全空着）→ 元信息 → **一整行只放一个按钮**。
        实测每张卡因此多出约 40px 纯空白，而这一页要渲染 14 张卡 ——
        光这一处就在页面上白白撑开约 560px。卡片本身没有更多信息要放，
        右上角却空着，这是典型的"布局没用上，高度却付了钱"。

        自检结果块仍然留在下面独占区域：它是**多行的诊断信息**，
        塞进标题行会把行高撑乱，而且它出现的频率远低于按钮。
      */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <BackendChip
              backend={pack.backend}
              state={
                isActive
                  ? 'active'
                  : selfTestFailed
                    ? 'failed'
                    : pack.installed
                      ? 'installed'
                      : pack.applicable
                        ? 'available'
                        : 'not-installed'
              }
            />
            <h3 className="text-sm font-medium text-ink">{localizedName(locale, pack)}</h3>
            {pack.recommended ? <StatusChip tone="good" label={t('runtime.pack.recommended')} /> : null}
            {isLoadBearing ? (
              <StatusChip
                tone="neutral"
                label={t('runtime.pack.loadBearing')}
                icon={<Lock className="size-3.5" />}
              />
            ) : null}
          </div>
          <p className="mt-1 text-xs text-ink-secondary">
            {pack.engine} {pack.engineVersion} · {pack.os}/{pack.arch} ·{' '}
            {formatBytes(pack.totalSizeBytes, locale)}
          </p>
          {!pack.applicable && pack.inapplicableReason ? (
            <p className="mt-1 text-xs text-ink-muted">{pack.inapplicableReason}</p>
          ) : null}
          {pack.requiresDriver ? (
            <p className="mt-1 text-[11px] text-ink-muted">
              {t('runtime.pack.requiresDriver')}
              {[
                pack.requiresDriver.nvidiaDriver && `NVIDIA ${pack.requiresDriver.nvidiaDriver}+`,
                pack.requiresDriver.vulkanApi && `Vulkan ${pack.requiresDriver.vulkanApi}+`,
                pack.requiresDriver.rocmVersion && `ROCm ${pack.requiresDriver.rocmVersion}+`,
                pack.requiresDriver.macosVersion && `macOS ${pack.requiresDriver.macosVersion}+`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
      </div>

      {/* 自检结果 —— 失败必须给真实原因，不能只说"自检失败" */}
      {selfTest ? (
        <div className="mt-3 rounded border border-line bg-surface-0 p-2.5 text-xs">
          {selfTest.passed ? (
            <>
              <StatusChip tone="good" label={t('runtime.pack.selfTestPassed')} />
              <p className="mt-1 text-ink-secondary">
                {t('runtime.pack.devicesFound', { n: selfTest.devicesFound })}
                {selfTest.rtf != null
                  ? t('runtime.pack.rtfMeasured', {
                      rtf: selfTest.rtf.toFixed(2),
                      minutes: Math.round(selfTest.rtf * 60),
                    })
                  : ''}
              </p>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                {t('runtime.pack.selfTestProvenance', {
                  at: new Date(selfTest.ranAt).toLocaleString(locale),
                })}
              </p>
            </>
          ) : (
            <>
              <StatusChip tone="critical" label={t('runtime.pack.selfTestFailed')} />
              {/* 透传服务端已知的具体原因（架构不兼容 / 驱动过旧 / 二进制损坏），
                  绝不用笼统的"出错了"把已知信息藏回黑箱 */}
              <p className="mt-1 text-critical">
                {selfTest.errorMessage ?? t('runtime.pack.unknownReason')}
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => onSelfTest(pack.id)}>
                  {t('runtime.pack.retrySelfTest')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onSelect(pack)}>
                  {t('runtime.pack.switchToCpu')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {isLoadBearing && pack.installed ? (
        <p className="mt-1.5 text-right text-[11px] text-ink-muted">
          {t('runtime.pack.loadBearingNote')}
        </p>
      ) : null}
    </article>
  );
}
