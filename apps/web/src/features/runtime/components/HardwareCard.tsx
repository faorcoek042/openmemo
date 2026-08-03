import { useTranslation } from 'react-i18next';
import { ChevronRight, Cpu, HardDrive, MemoryStick, MonitorCog } from 'lucide-react';
import type { HardwareInfo } from '@openmemo/shared';
import { BackendChip } from '../../../components/common/BackendChip';
import { formatBytes } from '../../../lib/format/bytes';

/**
 * 硬件探测结果卡（章程要求 2.1 的第一步："网页检测硬件"）。
 *
 * ★ 显存显示 **可用/总量** 两个数字，不是只显示总量。
 * LM Studio 的 Settings > Hardware 只显示总量，结果在多应用抢显存时把模型误判成
 * "Full GPU Offload Possible"，加载直接 OOM（其 issue #67）。我们两个都给。
 * `vramFreeMB` 为 null 时明确写"未知"，不拿总量冒充可用量。
 */

export function HardwareCard({ hw, locale }: { hw: HardwareInfo; locale: string }) {
  const { t } = useTranslation();
  const gpu = hw.selectedGpuIndex != null ? hw.gpus[hw.selectedGpuIndex] : null;
  const modelsDisk = hw.disks.find((d) => d.pathFor === 'models_root') ?? hw.disks[0];

  return (
    <section
      className="rounded-lg border border-line bg-surface-1 p-4"
      data-testid="runtime-hardware-card"
    >
      <h2 className="text-sm font-medium text-ink">{t('runtime.hw.title')}</h2>

      <dl className="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
        <Row icon={<MonitorCog className="size-4" />} label={t('runtime.hw.gpu')}>
          {gpu ? (
            <>
              <span className="text-ink">{gpu.name}</span>
              <span className="text-ink-secondary">
                {t('runtime.hw.vram', {
                  total:
                    gpu.vramTotalMB != null
                      ? formatBytes(gpu.vramTotalMB * 1e6, locale)
                      : t('runtime.hw.unknown'),
                  free:
                    gpu.vramFreeMB != null
                      ? formatBytes(gpu.vramFreeMB * 1e6, locale)
                      : t('runtime.hw.unknown'),
                })}
              </span>
            </>
          ) : hw.unifiedMemory ? (
            <span className="text-ink">{t('runtime.hw.unifiedMemory')}</span>
          ) : (
            <span className="text-ink-secondary">{t('runtime.hw.noGpu')}</span>
          )}
        </Row>

        <Row icon={<MemoryStick className="size-4" />} label={t('runtime.hw.ram')}>
          <span className="text-ink">{formatBytes(hw.ram.totalMB * 1e6, locale)}</span>
          {hw.ram.availableMB != null ? (
            <span className="text-ink-secondary">
              {t('runtime.hw.ramAvailable', {
                free: formatBytes(hw.ram.availableMB * 1e6, locale),
              })}
            </span>
          ) : null}
        </Row>

        <Row icon={<Cpu className="size-4" />} label={t('runtime.hw.cpu')}>
          <span className="text-ink">{hw.cpu.brand}</span>
          <span className="text-ink-secondary">
            {t('runtime.hw.cores', {
              physical: hw.cpu.physicalCores,
              logical: hw.cpu.logicalCores,
            })}
          </span>
          {!hw.cpu.features.includes('avx2') ? (
            // AVX2 缺失是硬约束：预编译的 CPU 后端普遍要求它
            <span className="text-critical">{t('runtime.hw.noAvx2')}</span>
          ) : null}
        </Row>

        <Row icon={<HardDrive className="size-4" />} label={t('runtime.hw.modelsDir')}>
          {modelsDisk ? (
            <>
              <span className="block truncate font-mono text-[11px] text-ink">
                {modelsDisk.path}
              </span>
              <span className="text-ink-secondary">
                {t('runtime.hw.diskFree', {
                  free: formatBytes(modelsDisk.freeMB * 1e6, locale),
                  total: formatBytes(modelsDisk.totalMB * 1e6, locale),
                })}
              </span>
            </>
          ) : (
            <span className="text-ink-secondary">{t('runtime.hw.unknown')}</span>
          )}
        </Row>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
        <span className="text-xs text-ink-secondary">{t('runtime.hw.backendsLabel')}</span>
        {hw.backends.map((b) => (
          <BackendChip
            key={b.id}
            backend={b.id}
            state={
              hw.selectedBackend === b.id
                ? 'active'
                : b.installed
                  ? 'installed'
                  : b.available
                    ? 'available'
                    : 'not-installed'
            }
          />
        ))}
      </div>

      {/*
        探测不可用时给出真实原因，而不是笼统的"不可用"。

        ⚠️ 但**默认折叠**。这里原来是直接摊开的一个 `<ul>`，实测在本机渲染成 6 行：
        `cuda：probe did not complete: probe executable not found: /tmp/…/bin/runtime/probe`
        —— 英文、带绝对路径、六行几乎一模一样。它出现在整页最上方那张卡里，
        成了用户进 `/runtime` 第一眼看到的东西。

        D-05 §5.3 第 3 条写得很直白：**禁止把 `error.detail` 原样甩给用户，
        技术细节折叠在 `[查看详情]` 里**。这就是那一条的落地 ——
        信息一个字没少（点开就有，可复制去提 issue），但不再占据首屏。
        芯片行上已经用 `不可用` 说明了结论，细节是给排查的人看的，不是给所有人看的。
      */}
      {hw.backends.some((b) => !b.available && b.unavailableReason) ? (
        <details className="group mt-2">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-ink-muted hover:text-ink-secondary">
            <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
            {t('runtime.hw.whyUnavailable', {
              n: hw.backends.filter((b) => !b.available && b.unavailableReason).length,
            })}
          </summary>
          <ul className="mt-1.5 space-y-0.5 border-l-2 border-line pl-2.5">
            {hw.backends
              .filter((b) => !b.available && b.unavailableReason)
              .map((b) => (
                <li key={b.id} className="font-mono text-[11px] break-all text-ink-muted">
                  {b.id}：{b.unavailableReason}
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      <p className="mt-2 text-[11px] text-ink-muted">
        {t('runtime.hw.detectedAt', {
          at: new Date(hw.detectedAt).toLocaleString(locale),
          platform: hw.os.platform,
          arch: hw.os.arch,
          version: hw.os.version,
        })}
      </p>
    </section>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-ink-muted">
        <span aria-hidden>{icon}</span>
        {label}
      </dt>
      <dd className="mt-0.5 min-w-0">{children}</dd>
    </div>
  );
}
