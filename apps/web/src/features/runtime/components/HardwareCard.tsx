import { Cpu, HardDrive, MemoryStick, MonitorCog } from 'lucide-react';
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
  const gpu = hw.selectedGpuIndex != null ? hw.gpus[hw.selectedGpuIndex] : null;
  const modelsDisk = hw.disks.find((d) => d.pathFor === 'models_root') ?? hw.disks[0];

  return (
    <section
      className="rounded-lg border border-line bg-surface-1 p-4"
      data-testid="runtime-hardware-card"
    >
      <h2 className="text-sm font-medium text-ink">你的硬件</h2>

      <dl className="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
        <Row icon={<MonitorCog className="size-4" />} label="显卡">
          {gpu ? (
            <>
              <span className="text-ink">{gpu.name}</span>
              <span className="text-ink-secondary">
                {' '}
                · 显存{' '}
                {gpu.vramTotalMB != null ? formatBytes(gpu.vramTotalMB * 1e6, locale) : '未知'}
                （可用{' '}
                {gpu.vramFreeMB != null ? formatBytes(gpu.vramFreeMB * 1e6, locale) : '未知'}）
              </span>
            </>
          ) : hw.unifiedMemory ? (
            <span className="text-ink">统一内存架构（显存与内存共享）</span>
          ) : (
            <span className="text-ink-secondary">未检测到可用 GPU</span>
          )}
        </Row>

        <Row icon={<MemoryStick className="size-4" />} label="内存">
          <span className="text-ink">{formatBytes(hw.ram.totalMB * 1e6, locale)}</span>
          {hw.ram.availableMB != null ? (
            <span className="text-ink-secondary">
              {' '}
              · 可用 {formatBytes(hw.ram.availableMB * 1e6, locale)}
            </span>
          ) : null}
        </Row>

        <Row icon={<Cpu className="size-4" />} label="处理器">
          <span className="text-ink">{hw.cpu.brand}</span>
          <span className="text-ink-secondary">
            {' '}
            · {hw.cpu.physicalCores} 核 / {hw.cpu.logicalCores} 线程
          </span>
          {!hw.cpu.features.includes('avx2') ? (
            // AVX2 缺失是硬约束：预编译的 CPU 后端普遍要求它
            <span className="text-critical"> · 不支持 AVX2</span>
          ) : null}
        </Row>

        <Row icon={<HardDrive className="size-4" />} label="模型目录">
          {modelsDisk ? (
            <>
              <span className="block truncate font-mono text-[11px] text-ink">
                {modelsDisk.path}
              </span>
              <span className="text-ink-secondary">
                剩余 {formatBytes(modelsDisk.freeMB * 1e6, locale)} /{' '}
                {formatBytes(modelsDisk.totalMB * 1e6, locale)}
              </span>
            </>
          ) : (
            <span className="text-ink-secondary">未知</span>
          )}
        </Row>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
        <span className="text-xs text-ink-secondary">后端：</span>
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

      {/* 探测不可用时给出真实原因，而不是笼统的"不可用" */}
      {hw.backends.some((b) => !b.available && b.unavailableReason) ? (
        <ul className="mt-2 space-y-0.5">
          {hw.backends
            .filter((b) => !b.available && b.unavailableReason)
            .map((b) => (
              <li key={b.id} className="text-[11px] text-ink-muted">
                {b.id}：{b.unavailableReason}
              </li>
            ))}
        </ul>
      ) : null}

      <p className="mt-2 text-[11px] text-ink-muted">
        探测于 {new Date(hw.detectedAt).toLocaleString(locale)} ·{' '}
        {hw.os.platform}/{hw.os.arch} {hw.os.version}
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
