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
import { copyText } from '../../lib/secure-context';

interface HealthResponse {
  dataDir?: string;
  version?: string;
}

/**
 * `GET /api/settings/data-dir` —— daemon 侧的目录清单。
 *
 * `usage` 是**整个数据目录**的总量，这正是 `/models/storage` 给不了的那个数：
 * 后者只统计模型目录，所以此前这一节只能一边显示"模型占用"一边写小字提醒
 * "这不是总量"。现在总量有了权威来源，就该显示它。
 *
 * ⚠️ `entries` 只有 `purposeZh`，**没有各自的字节数**。所以下面只列用途不列大小 ——
 * 按目录估一个数写上去，会让用户照着一个我们其实没测过的数字去清理磁盘。
 */
interface DataDirResponse {
  dataDir?: string;
  usage: { bytes: number; files: number } | null;
  entries: { path: string; name: string; purposeZh: string }[];
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
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
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

  const layout = useQuery({
    queryKey: ['settings', 'data-dir'] as const,
    queryFn: () => api<DataDirResponse>('settings', '/settings/data-dir'),
    staleTime: 30_000,
  });

  /**
   * 修改数据目录。
   *
   * `GET|POST /api/settings/data-dir` **已经落地**（`rest/storage.ts`），
   * 这段注释此前还写着"端点目前不存在" —— 已订正。
   *
   * 保留的设计：写操作**绝不静默回落 mock**，失败会如实抛出并渲染成 `ErrorBlock`；
   * 按钮不灰掉，因为灰掉的控件不解释原因，用户只会以为坏了。
   * 端点若因版本差异缺席，`notImplemented` 分支仍会给出环境变量这条真能用的替代路径。
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
              /*
               * 用 `copyText()` 而不是 `navigator.clipboard?.writeText()`：
               * 后者在非安全上下文（http://<IP>）下会被可选链整条短路 ——
               * 不复制、也不报错，按钮静默失效。
               */
              void copyText(dataDir).then((ok) => {
                setCopied(ok ? 'ok' : 'fail');
                setTimeout(() => setCopied(null), 2000);
              });
            }}
          >
            <Copy className="size-3.5" />
            {copied === 'ok'
              ? t('settings.dataDir.copied')
              : copied === 'fail'
                ? t('settings.dataDir.copyFailed')
                : t('settings.dataDir.copy')}
          </Button>
        </div>
      </div>

      {/* ── 统计大小：逐项标明各是什么，不合并成一个含糊的"总计" ── */}
      {storage.data || layout.data?.usage ? (
        <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {layout.data?.usage ? (
            <div>
              <dt className="text-ink-muted">{t('settings.dataDir.totalUsed')}</dt>
              <dd className="text-ink" data-testid="data-dir-total-used">
                {formatBytes(layout.data.usage.bytes, i18n.language)}
                <span className="ml-1 text-ink-muted">
                  {t('settings.dataDir.fileCount', { n: layout.data.usage.files })}
                </span>
              </dd>
            </div>
          ) : null}
          {storage.data ? (
          <div>
            <dt className="text-ink-muted">{t('settings.dataDir.modelsUsed')}</dt>
            <dd className="text-ink" data-testid="data-dir-models-used">
              {formatBytes(storage.data.usedBytes, i18n.language)}
            </dd>
          </div>
          ) : null}
          {storage.data ? (
            <>
              <div>
                <dt className="text-ink-muted">{t('settings.dataDir.volumeFree')}</dt>
                <dd className="text-ink">
                  {formatBytes(storage.data.volume.freeBytes, i18n.language)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('settings.dataDir.volumeTotal')}</dt>
                <dd className="text-ink">
                  {formatBytes(storage.data.volume.totalBytes, i18n.language)}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
      ) : null}
      <p className="mb-4 text-xs text-ink-muted">{t('settings.dataDir.sizeScopeNote')}</p>

      {/*
        ── 目录清单：日志 / 临时文件 / 数据库 这三类此前完全没露过面 ──
        用户问"这个目录能不能删、删了丢什么"，答案取决于里面是什么；
        只报一个总字节数回答不了这个问题。用途文案来自 daemon，
        与"凡是要明文告知用户的路径一律问 daemon"同一条理由。
      */}
      {layout.data?.entries?.length ? (
        <div className="mb-4" data-testid="data-dir-layout">
          <p className="mb-1.5 text-xs text-ink-secondary">{t('settings.dataDir.layoutTitle')}</p>
          <ul className="divide-y divide-line rounded-md border border-line bg-surface-0">
            {layout.data.entries.map((e) => (
              <li key={e.path} className="flex flex-wrap items-baseline gap-x-2 px-2 py-1.5 text-xs">
                <code className="font-mono text-ink">{e.name}</code>
                <span className="text-ink-secondary">{e.purposeZh}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-muted">{t('settings.dataDir.perDirNote')}</p>
        </div>
      ) : null}

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
