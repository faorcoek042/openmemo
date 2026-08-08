import { useTranslation } from 'react-i18next';
import { HardDrive } from 'lucide-react';

import { ErrorBlock } from '../../components/common/ErrorBlock';
import { formatBytes } from '../../lib/format/bytes';
import { useGcMutation, useModelsStorageQuery } from './api';
import { StorageBreakdown } from './components/StorageBreakdown';

/**
 * `/settings/storage` —— 复用模型域的 storage API（features/models/README.md 指派）。
 */
export default function StorageSettingsPage() {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const storage = useModelsStorageQuery();
  const gc = useGcMutation();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4" data-testid="storage-settings-page">
      <header>
        <h1 className="text-lg font-semibold text-ink">存储</h1>
        <p className="mt-0.5 text-xs text-ink-secondary">模型与加速后端占用的磁盘空间。</p>
      </header>

      {storage.isError ? (
        <ErrorBlock error={storage.error} onRetry={() => void storage.refetch()} />
      ) : null}
      {/* 「清理」失败以前完全静默 —— 用户点完不知道是清理了还是没清理 */}
      {gc.isError ? <ErrorBlock error={gc.error} /> : null}

      {storage.data ? (
        <>
          <section className="rounded-lg border border-line bg-surface-1 p-4 text-xs">
            <div className="flex items-center gap-2">
              <HardDrive className="size-4 text-ink-muted" aria-hidden />
              <span className="text-ink-secondary">模型目录</span>
            </div>
            <code className="mt-1 block break-all font-mono text-[11px] text-ink">
              {storage.data.modelsRoot}
            </code>
            <p className="mt-1 text-ink-secondary">
              卷容量 {formatBytes(storage.data.volume.totalBytes, locale)} · 剩余{' '}
              {formatBytes(storage.data.volume.freeBytes, locale)}
            </p>
          </section>

          <StorageBreakdown
            storage={storage.data}
            locale={locale}
            gcPending={gc.isPending}
            onGc={() => void gc.mutateAsync({ targets: ['orphan_blobs', 'stale_partials'] })}
          />
        </>
      ) : null}
    </div>
  );
}
