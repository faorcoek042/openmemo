import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Copy, FolderOpen, HardDrive, Loader2 } from 'lucide-react';

import type { GetStorageResponse } from '@openmemo/shared';

import { api, ApiError } from '../../lib/api/client';
import { qk } from '../../app/query';
import { Button } from '../../components/common/Button';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { formatBytes } from '../../lib/format/bytes';

interface HealthResponse {
  dataDir?: string;
  version?: string;
}

/**
 * 数据位置 —— 定义 / 修改 / 移动 / 统计大小。
 *
 * ## 路径的权威来源只能是 daemon
 *
 * 我在密钥那件事上踩过一次：前端按"约定俗成"硬编码了一个路径告诉用户密钥存在哪，
 * 真实位置其实是 `<dataDir>/secrets.json`，而 dataDir 本身可以被
 * `OPENMEMO_DATA_DIR` / `--data-dir` 改掉。前端**没有任何办法**知道用户是怎么启动的。
 * 结论写在那次的复盘里：**凡是要明文告知用户的路径，一律问 daemon**。
 * 这里同理 —— `GET /api/health` 返回 `dataDir`，那是唯一说得准的地方。
 *
 * ## 关于"统计大小"的诚实边界
 *
 * daemon 目前只有 `GET /api/models/storage`，它统计的是**模型目录**
 * （`modelsRoot`）与所在卷的剩余空间，**不是整个 dataDir 的总大小**。
 * 所以下面的文案逐项标明各是什么，绝不把"模型占用"写成"数据占用" ——
 * 模型通常占九成以上，但笔记、音频原件、数据库都不在这个数里，
 * 写成总量会让用户按错误的数字去清理磁盘。
 */
export function DataLocationSection() {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [moveExisting, setMoveExisting] = useState(true);
  const [showChange, setShowChange] = useState(false);

  const health = useQuery({
    queryKey: ['health', 'dataDir'] as const,
    queryFn: () => api<HealthResponse>('health', '/health'),
    staleTime: 60_000,
  });

  const storage = useQuery({
    queryKey: qk.models.storage,
    queryFn: () => api<GetStorageResponse>('models', '/models/storage'),
    staleTime: 30_000,
  });

  /**
   * 修改数据目录。
   *
   * ⚠️ **这个端点目前不存在** —— `oss-scout` 在做 daemon 侧的移动逻辑。
   * 我没有把按钮灰掉或藏起来，因为：
   * 1. 灰掉的控件不解释原因，用户只会以为坏了（上一轮刚因为这个把导航改成可点）
   * 2. `client.ts` 对写操作**绝不静默回落 mock**，404 会如实抛出来，
   *    所以这里的失败是**可见**的，不会变成"点了没反应"
   *
   * 端点落地后这里不用改，`ErrorBlock` 自动消失。
   * 在那之前 `catch` 里给出**真的能用**的替代路径：环境变量。
   */
  const changeDir = useMutation({
    mutationFn: (p: { path: string; moveExisting: boolean }) =>
      api<{ restartRequired?: boolean }>('settings', '/settings/data-dir', {
        method: 'POST',
        body: p,
      }),
  });

  const dataDir = health.data?.dataDir ?? null;
  const notImplemented = changeDir.error instanceof ApiError && changeDir.error.status === 404;

  return (
    <section className="rounded-lg border border-line bg-surface-1 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-ink">
        <HardDrive className="size-4" aria-hidden />
        {t('settings.dataDir.title')}
      </h2>

      {/* ── 定义：当前在哪 ── */}
      <div className="mb-4">
        <p className="mb-1 text-xs text-ink-secondary">{t('settings.dataDir.current')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code
            className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface-0 px-2 py-1.5 font-mono text-xs text-ink"
            data-testid="data-dir-path"
            title={dataDir ?? ''}
          >
            {/* 拿不到就说拿不到，绝不填一个"看起来对"的默认路径 */}
            {dataDir ?? t('common.loading')}
          </code>
          <Button
            size="sm"
            variant="secondary"
            disabled={!dataDir}
            onClick={() => {
              if (!dataDir) return;
              void navigator.clipboard?.writeText(dataDir).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <Copy className="size-3.5" />
            {copied ? t('settings.dataDir.copied') : t('settings.dataDir.copy')}
          </Button>
        </div>
      </div>

      {/* ── 统计大小：逐项标明各是什么，不合并成一个含糊的"总计" ── */}
      {storage.data ? (
        <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-ink-muted">{t('settings.dataDir.modelsUsed')}</dt>
            <dd className="text-ink" data-testid="data-dir-models-used">
              {formatBytes(storage.data.usedBytes, i18n.language)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t('settings.dataDir.volumeFree')}</dt>
            <dd className="text-ink">{formatBytes(storage.data.volume.freeBytes, i18n.language)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t('settings.dataDir.volumeTotal')}</dt>
            <dd className="text-ink">{formatBytes(storage.data.volume.totalBytes, i18n.language)}</dd>
          </div>
        </dl>
      ) : null}
      <p className="mb-4 text-xs text-ink-muted">{t('settings.dataDir.sizeScopeNote')}</p>

      {/* ── 修改 / 移动 ── */}
      {!showChange ? (
        <Button size="sm" variant="secondary" onClick={() => setShowChange(true)}>
          <FolderOpen className="size-3.5" />
          {t('settings.dataDir.change')}
        </Button>
      ) : (
        <div className="space-y-2 rounded-md border border-line bg-surface-0 p-3">
          <label className="block text-xs text-ink-secondary" htmlFor="data-dir-new">
            {t('settings.dataDir.newPath')}
          </label>
          <input
            id="data-dir-new"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder={dataDir ?? '/path/to/openmemo-data'}
            spellCheck={false}
            autoComplete="off"
            data-testid="data-dir-new-input"
            className="h-8 w-full rounded-md border border-line bg-surface-1 px-2 font-mono text-xs text-ink"
          />
          <label className="flex items-center gap-2 text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={moveExisting}
              onChange={(e) => setMoveExisting(e.target.checked)}
              className="size-3.5 accent-[var(--accent)]"
            />
            {t('settings.dataDir.moveExisting')}
          </label>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!newPath.trim() || changeDir.isPending}
              onClick={() => changeDir.mutate({ path: newPath.trim(), moveExisting })}
            >
              {changeDir.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {changeDir.isPending ? t('settings.dataDir.moving') : t('settings.dataDir.apply')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowChange(false)}>
              {t('capture.cancel')}
            </Button>
          </div>

          {changeDir.isSuccess ? (
            <p className="text-xs text-success">{t('settings.dataDir.needRestart')}</p>
          ) : null}

          {/*
            端点还没上线时给**真的能用**的办法，而不是一句"暂不支持"。
            这是本地部署工具 —— 用户本来就是自己起进程的，环境变量对他不是负担。
          */}
          {notImplemented ? (
            <p className="text-xs text-warning" data-testid="data-dir-unsupported">
              {t('settings.dataDir.unsupported')}
              <code className="ml-1 font-mono">OPENMEMO_DATA_DIR=&lt;path&gt;</code>
            </p>
          ) : changeDir.isError ? (
            <ErrorBlock error={changeDir.error} />
          ) : null}
        </div>
      )}

      {/*
        ★ 说清楚后果。这条是实测过的：运行中 rm -rf 数据目录 → health 仍 200；
        停掉重启 → 自动重建，notes / selfcheck 均 200。
        所以"删了会不会把程序搞坏"可以明确回答"不会"，但**必须同时说清丢什么** ——
        只说前半句会让人以为删了没代价。
      */}
      <p className="mt-4 border-t border-line pt-3 text-xs text-ink-muted">
        {t('settings.dataDir.safeToDelete')}
      </p>
    </section>
  );
}
