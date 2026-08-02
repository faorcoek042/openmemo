import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ComponentStatus } from '@openmemo/shared';

import { Banner } from '../../components/common/Banner';
import { Button } from '../../components/common/Button';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import {
  useCheckUpdatesMutation,
  useComponentsQuery,
  useRollbackComponentMutation,
  useUpdateComponentMutation,
} from './api';
import { ComponentCard } from './components/ComponentCard';

/**
 * 组件与来源页。
 *
 * 回答用户直接提出的两个问题：
 *   「只要写明从哪里下载对应依赖即可」 → 每个组件的来源链完整可见且可点：
 *      源码 submodule commit → 发布页 → 二进制 → sha256（含来源说明）→ 许可证
 *   「检测上游组件对应版本然后灵活更新各个组件」 → 三个版本并列 + 单组件一键更新
 *
 * ★ 默认不自动更新。检测到新版本只提示，更新永远是用户点出来的。
 *   上游换版本可能直接改变行为（我们自己就出过 ONNX / ggml 格式不兼容那次），
 *   静默更新会让用户的转写结果莫名其妙变化，而且无从追查。
 */
export default function ComponentsPage() {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  // 首屏不查上游：先把本地清单和来源渲染出来，联网检测是用户点出来的额外动作。
  const q = useComponentsQuery(false);
  const check = useCheckUpdatesMutation();
  const update = useUpdateComponentMutation();
  const rollbackMut = useRollbackComponentMutation();

  const [busyId, setBusyId] = useState<string | null>(null);

  const data = check.data ?? q.data;
  const components = useMemo(() => data?.components ?? [], [data]);
  const updatable = components.filter((c) => c.updateAvailable);
  const unchecked = components.filter((c) => !c.updateAvailable && !c.latestVersion);

  async function handleUpdate(c: ComponentStatus) {
    const ok = window.confirm(
      `将「${c.displayNameZh}」从 ${c.pinnedVersion} 更新到 ${c.latestVersion}？\n\n` +
        `· 会重新下载并校验 sha256，校验不通过不会安装\n` +
        `· 上游换版本可能改变行为（例如文件格式变化），不一定完全兼容\n` +
        `· 旧版本会保留，出问题可以一键回滚\n\n` +
        `确定现在更新吗？`,
    );
    if (!ok) return;
    setBusyId(c.id);
    try {
      await update.mutateAsync({ id: c.id, toVersion: c.latestVersion ?? undefined });
    } finally {
      setBusyId(null);
    }
  }

  async function handleRollback(c: ComponentStatus) {
    if (!window.confirm(`把「${c.displayNameZh}」回滚到 ${c.rollbackVersion}？`)) return;
    setBusyId(c.id);
    try {
      await rollbackMut.mutateAsync(c.id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4" data-testid="components-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">组件与来源</h1>
          <p className="mt-0.5 text-xs text-ink-secondary">
            每个组件从哪里下载、钉在哪个版本、上游有没有新版本 —— 全部可查。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.checkedAt ? (
            <span className="text-[11px] text-ink-muted">
              {new Date(data.checkedAt).toLocaleString(locale)} 检查
            </span>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={check.isPending}
            onClick={() => void check.mutateAsync({})}
            data-testid="components-check-updates"
          >
            <RefreshCw className={check.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
            {check.isPending ? '检查中…' : '检查更新'}
          </Button>
        </div>
      </header>

      {/* 默认不自动更新 —— 说明白，让用户知道这是有意为之 */}
      <Banner
        tone="info"
        icon={<ShieldCheck className="size-4" aria-hidden />}
        title="不会自动更新"
        detail="检测到新版本只会在这里提示。是否更新、什么时候更新，由你决定 —— 上游换版本可能改变行为。"
      />

      {updatable.length > 0 ? (
        <Banner
          tone="warning"
          title={`${updatable.length} 个组件有新版本`}
          detail={updatable.map((c) => `${c.displayNameZh} → ${c.latestVersion}`).join(' · ')}
        />
      ) : null}

      {/* 检查过但一个都没问到 → 明确说这是"不知道"，不是"都最新" */}
      {data?.checkedAt && !data.online ? (
        <Banner
          tone="warning"
          icon={<CircleHelp className="size-4" aria-hidden />}
          title="没能连上任何上游"
          detail="下面的「未检测」表示不知道有没有新版本，不代表已是最新。已安装的组件不受影响，照常可用。"
        />
      ) : null}

      {q.isError ? <ErrorBlock error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <p className="text-xs text-ink-muted">正在读取组件清单…</p> : null}

      {!q.isLoading && components.length === 0 ? (
        <EmptyState
          title="还没有登记任何组件"
          hint="组件清单来自 vendor/manifests/components.json。"
        />
      ) : null}

      <section className="space-y-3">
        {components.map((c) => (
          <ComponentCard
            key={c.id}
            component={c}
            locale={locale}
            busy={busyId === c.id}
            onUpdate={(x) => void handleUpdate(x)}
            onRollback={(x) => void handleRollback(x)}
          />
        ))}
      </section>

      {unchecked.length > 0 && data?.checkedAt ? (
        <p className="text-[11px] text-ink-muted">
          {unchecked.length} 个组件这次没问到上游（可能是限流或网络问题）。
          再点一次「检查更新」通常就好；查不到不影响安装和使用。
        </p>
      ) : null}
    </div>
  );
}
