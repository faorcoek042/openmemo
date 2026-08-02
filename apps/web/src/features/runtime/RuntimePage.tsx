import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu } from 'lucide-react';
import type { GetBackendCatalogResponse } from '@openmemo/shared';

import { Banner } from '../../components/common/Banner';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { formatBytes } from '../../lib/format/bytes';
import {
  useBackendInstallMutation,
  useBackendRemoveMutation,
  useBackendSelectMutation,
  useBackendSelfTestMutation,
  useBackendsCatalogQuery,
  useBackendsInstalledQuery,
  useHardwareQuery,
} from './api';
import { HardwareCard } from './components/HardwareCard';
import { BackendPackCard } from './components/BackendPackCard';

/**
 * 运行时与加速后端页 —— 章程要求 2.1 的主界面。
 *
 * 原文：「网页检测硬件 → 推荐后端 → 下载对应预编译二进制 → 安装 → 自检 → 显示状态」。
 * 这一页要闭环覆盖这六步，用户不装 CUDA、不配环境变量、不去 README 找二进制链接。
 *
 * 页面被放在侧栏一级导航而不是埋进设置里：R-01 调研发现 memo.ac 把这类功能埋在设置中，
 * 「模型下载卡 0%」因此成为它 FAQ 里最高频的问题。
 */
export default function RuntimePage() {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  const hardware = useHardwareQuery();
  const catalog = useBackendsCatalogQuery();
  const installed = useBackendsInstalledQuery();

  const install = useBackendInstallMutation();
  const remove = useBackendRemoveMutation();
  const select = useBackendSelectMutation();
  const selfTest = useBackendSelfTestMutation();

  const selfTestById = useMemo(() => {
    const m = new Map<string, NonNullable<(typeof installed.data)>['packs'][number]['selfTest']>();
    for (const p of installed.data?.packs ?? []) m.set(p.id, p.selfTest);
    return m;
  }, [installed.data]);

  const hw = hardware.data?.hardware;
  const packs = catalog.data?.packs ?? [];

  // 适用的排前面，推荐的再排前面 —— 用户第一眼看到的应该是"该装哪个"
  const sorted = useMemo(
    () =>
      [...packs].sort((a, b) => {
        if (a.applicable !== b.applicable) return a.applicable ? -1 : 1;
        if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
        return b.priority - a.priority;
      }),
    [packs],
  );

  const anyFailed = (installed.data?.packs ?? []).some((p) => p.selfTest && !p.selfTest.passed);

  function handleSelect(pack: GetBackendCatalogResponse['packs'][number]) {
    void select.mutateAsync(pack.backend);
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4" data-testid="runtime-page">
      <header>
        <h1 className="text-lg font-semibold text-ink">运行时与加速后端</h1>
        <p className="mt-0.5 text-xs text-ink-secondary">
          检测硬件 → 推荐后端 → 下载安装 → 自检 → 显示状态，全部在网页里完成。
        </p>
      </header>

      {anyFailed ? (
        <Banner
          tone="critical"
          title="有加速后端自检未通过"
          detail="下面的卡片里写了具体原因。你可以重试自检，或改用 CPU 后端（永远可用）。"
        />
      ) : null}

      {hardware.isError ? (
        <ErrorBlock error={hardware.error} onRetry={() => void hardware.refetch()} />
      ) : null}
      {hardware.isLoading ? (
        <p className="text-xs text-ink-muted">正在探测硬件（会真正枚举设备，可能需要几秒）…</p>
      ) : null}
      {hw ? <HardwareCard hw={hw} locale={locale} /> : null}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink">加速后端包</h2>
          {catalog.data?.stale ? (
            <span className="text-xs text-ink-muted">离线目录</span>
          ) : null}
        </div>

        {catalog.isError ? (
          <ErrorBlock error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : null}

        {sorted.length === 0 && !catalog.isLoading ? (
          <p className="rounded-lg border border-line bg-surface-1 p-4 text-xs text-ink-secondary">
            <Cpu className="mr-1 inline size-3.5" aria-hidden />
            目录里还没有适用于这台机器的加速后端包。CPU 后端始终可用。
          </p>
        ) : null}

        {sorted.map((p) => (
          <BackendPackCard
            key={p.id}
            pack={p}
            locale={locale}
            isActive={installed.data?.selectedBackend === p.backend && p.installed}
            selfTest={selfTestById.get(p.id) ?? null}
            installing={install.isPending && install.variables === p.id}
            onInstall={(id) => void install.mutateAsync(id)}
            onRemove={(id) => {
              if (window.confirm('卸载这个加速后端？之后可以重新下载。')) {
                void remove.mutateAsync(id);
              }
            }}
            onSelect={handleSelect}
            onSelfTest={(id) => void selfTest.mutateAsync(id)}
          />
        ))}
      </section>

      <p className="text-[11px] text-ink-muted">
        提示：自检里的 RTF 是**本机实测值**；模型卡片上的"预计耗时"是由它外推的**估算**，
        外推系数尚未标定，仅供参考。
        {hw?.disks[0]
          ? ` 后端包会安装到模型目录所在卷（剩余 ${formatBytes(hw.disks[0].freeMB * 1e6, locale)}）。`
          : ''}
      </p>
    </div>
  );
}
