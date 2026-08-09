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
            /*
              ★ 这一格此前说的是「未检测到可用 GPU」—— 一句**我们没资格说的话**。
                GPU 枚举是探针干的，而探针随后端包出厂；后端包没装时我们**根本没查过**，
                与 CPU 特性那条是同一个病：把"没查"渲染成"查过且没有"。
                所以按有没有装过后端包分两句话说，并给一个能去装的入口。
            */
            <span className="text-ink-secondary">
              {hw.backends.some((b) => b.installed)
                ? t('runtime.hw.noGpu')
                : t('runtime.hw.gpuUnknownNoBackend')}
            </span>
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
          {/*
            AVX2 缺失是**硬约束**：预编译的 CPU 后端普遍要求它。
            但它是 **x86 专属**的维度 —— 在 arm64（Apple Silicon）上根本不存在这个概念。

            ⚠️ 原来这里只判 `!features.includes('avx2')`，于是 M 系列 Mac 上必然为真，
            用户看到的是「Apple M4 · 10 核 / 10 线程 · **不支持 AVX2**」并且是红色告警色。
            用户 2026-08-08 因此以为自己的 M4 缺了什么 —— 而 M4 不支持 AVX2
            既不是缺陷也不是降级，**是一个不适用的维度**。

            判据：**「不适用」和「不支持」必须区分得开。**
            前者不该出现，后者才该报警。所以这一行只在 x64 上渲染。
          */}
          {/*
            ★★ 三态，不是两态。上一次修复只分出了「不适用」与「不支持」，
            而**空集合仍然被渲染成"已知的不支持"** —— 那正是 Windows 上的现状：
            `detectCpuWin32()` 无条件返回 `features: []`，它**从来没查过任何指令集标志**。
            于是每一台 Windows 机器都被红字告知「不支持 AVX2」，包括支持 AVX2/AVX-512 的
            Ryzen 7 7840HS。**用户读到的是"我的 CPU 不行"，而真相是"我们从来没看过"。**

            · arm64            → 一个字都不说（AVX2 是 x86 概念，**不适用**）
            · x64 且查到了特性 → 有 avx2 就不说；没有才红字「不支持」（**确实查过**）
            · x64 但特性集为空 → 灰字「无法确认」（**未知**）——不报警、也不假称支持
          */}
          {hw.os.arch !== 'x64' ? null : hw.cpu.features.length === 0 ? (
            <span className="text-ink-secondary">{t('runtime.hw.avx2Unknown')}</span>
          ) : !hw.cpu.features.includes('avx2') ? (
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
              /*
               * ★ 这里此前**不读 `probed`** —— `installed:true, probed:false` 的后端
               *   与真正加载成功的显示同一个「已安装」，T-168 建立的区分
               *   在最后一跳上死掉了（那句"这一轮没有去加载它"只在折叠的 details 里）。
               *   现在装在盘上但这轮没被加载的单独成一档。
               */
              hw.selectedBackend === b.id
                ? 'active'
                : b.installed
                  ? b.probed
                    ? 'installed'
                    : 'installed-unprobed'
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
            <ChevronRight
              className="size-3 transition-transform group-open:rotate-90"
              aria-hidden
            />
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
