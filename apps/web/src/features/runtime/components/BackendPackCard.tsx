import { Download, Lock, Play, Trash2 } from 'lucide-react';
import type { BackendSelfTest, GetBackendCatalogResponse } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { StatusChip } from '../../../components/common/StatusChip';
import { BackendChip } from '../../../components/common/BackendChip';
import { formatBytes } from '../../../lib/format/bytes';

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
  // 承重墙：内置 CPU 档不允许卸载
  const isLoadBearing = pack.tier === 'builtin' || pack.backend === 'cpu';
  /**
   * 已构建、摘要已核实，但**还没有发布地址**（仓库无 git remote，CI 从未跑过）。
   * 必须在按钮上就说清楚，而不是让用户点下去等一个必然失败的下载 ——
   * 失败要在看得见的地方发生，不要推迟到点击之后。
   */
  const pendingCi = (pack as { availability?: string }).availability === 'pending-ci';
  const selfTestFailed = selfTest != null && !selfTest.passed;

  return (
    <article
      className="rounded-lg border border-line bg-surface-1 p-4"
      data-testid={`backend-pack-${pack.id}`}
    >
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
            <h3 className="text-sm font-medium text-ink">{pack.displayNameZh}</h3>
            {pack.recommended ? <StatusChip tone="good" label="推荐" /> : null}
            {isLoadBearing ? (
              <StatusChip tone="neutral" label="兜底后端" icon={<Lock className="size-3.5" />} />
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
              需要驱动：
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
      </div>

      {/* 自检结果 —— 失败必须给真实原因，不能只说"自检失败" */}
      {selfTest ? (
        <div className="mt-3 rounded border border-line bg-surface-0 p-2.5 text-xs">
          {selfTest.passed ? (
            <>
              <StatusChip tone="good" label="自检通过" />
              <p className="mt-1 text-ink-secondary">
                枚举到 {selfTest.devicesFound} 个设备
                {selfTest.rtf != null ? (
                  <>
                    {' '}
                    · 实测 RTF {selfTest.rtf.toFixed(2)}（1 小时音频约{' '}
                    {Math.round(selfTest.rtf * 60)} 分钟）
                  </>
                ) : null}
              </p>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                于 {new Date(selfTest.ranAt).toLocaleString(locale)} 用内嵌测试音频真实推理得出
              </p>
            </>
          ) : (
            <>
              <StatusChip tone="critical" label="自检失败" />
              {/* 透传服务端已知的具体原因（架构不兼容 / 驱动过旧 / 二进制损坏），
                  绝不用笼统的"出错了"把已知信息藏回黑箱 */}
              <p className="mt-1 text-critical">{selfTest.errorMessage ?? '未知原因'}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => onSelfTest(pack.id)}>
                  重试自检
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onSelect(pack)}>
                  改用 CPU
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {pack.installed ? (
          <>
            {!isActive ? (
              <Button size="sm" variant="secondary" onClick={() => onSelect(pack)}>
                设为当前后端
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => onSelfTest(pack.id)}>
              <Play className="size-3.5" aria-hidden />
              自检
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={isLoadBearing}
              title={
                isLoadBearing
                  ? 'CPU 后端是兜底，删除后在没有其它可用后端时会导致推理进程崩溃，因此不允许卸载'
                  : undefined
              }
              onClick={() => onRemove(pack.id)}
              data-testid={`backend-remove-${pack.id}`}
            >
              <Trash2 className="size-3.5" aria-hidden />
              卸载
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant={pack.recommended ? 'primary' : 'secondary'}
            disabled={installing || !pack.applicable || pendingCi}
            title={pendingCi ? '该组件已构建并核实过摘要，但尚未发布下载地址（需要先跑 CI 发布）' : undefined}
            onClick={() => onInstall(pack.id)}
            data-testid={`backend-install-${pack.id}`}
          >
            <Download className="size-3.5" aria-hidden />
            {pendingCi
              ? '尚未发布，暂不可安装'
              : installing
                ? '正在开始…'
                : `安装 ${formatBytes(pack.totalSizeBytes, locale)}`}
          </Button>
        )}
      </div>

      {isLoadBearing && pack.installed ? (
        <p className="mt-1.5 text-right text-[11px] text-ink-muted">
          CPU 后端是永不失败的兜底，不可卸载
        </p>
      ) : null}
    </article>
  );
}
