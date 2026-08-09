import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ComponentStatus } from '@openmemo/shared';

import { Banner } from '../../components/common/Banner';
import { Button } from '../../components/common/Button';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { useCheckUpdatesMutation, useComponentsQuery, useUpdateComponentMutation } from './api';
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

  const [busyId, setBusyId] = useState<string | null>(null);

  const data = check.data ?? q.data;
  const components = useMemo(() => data?.components ?? [], [data]);
  const updatable = components.filter((c) => c.updateAvailable);
  const unchecked = components.filter((c) => !c.updateAvailable && !c.latestVersion);

  async function handleUpdate(c: ComponentStatus) {
    /*
     * 同一个端点，两种语境：**没装过 = 安装，装过 = 更新**。
     * 文案必须分开 —— 对一个从没装过的组件说"从 X 更新到 null"是句假话，
     * 而 `latestVersion` 在没点过「检查更新」时本来就是 null。
     */
    const installing = c.installedVersion == null;
    const ok = window.confirm(
      installing
        ? `安装「${c.displayNameZh}」${c.pinnedVersion}？\n\n` +
            `· 从 ${c.provenance.repoUrl} 的官方发布页下载\n` +
            `· 会校验 sha256，校验不通过不会安装\n` +
            `· 许可证：${c.provenance.license}\n\n` +
            `确定现在安装吗？`
        : /*
           * ⚠️ **最后一行原本写着「旧版本会保留，出问题可以一键回滚」。那是假的**（T-157 ②）。
           *
           * `stashForRollback` 全仓零调用方，`.prev-<version>` 目录从来没有被创建过；
           * 就算创建了，索引键（目录名）与查表键（组件 id）也对不上。
           * 于是 `rollbackVersion` 恒为 null，回滚按钮**一次都没渲染过** ——
           * 而这句承诺**每次点更新都会说出来**。
           *
           * 换成两句真的：
           *   · 失败**确实**不会破坏当前版本 —— `installer.ts` 先解压到 temp、
           *     校验并解包成功后才 rm+rename 换上去；下载/校验/解包任一步失败，
           *     旧目录原地未动（`install()` 的 catch 只清 temp 与刚建的链接）。
           *   · 但更新**成功之后**没有退路：清单里只钉一个版本，没有第二个 sha256 可回。
           *     说清楚，让用户在点之前就知道。
           */
          `将「${c.displayNameZh}」从 ${c.pinnedVersion} 更新到 ${c.latestVersion}？\n\n` +
            `· 会重新下载并校验 sha256，校验不通过不会安装\n` +
            `· 上游换版本可能改变行为（例如文件格式变化），不一定完全兼容\n` +
            `· 下载或校验失败时，当前版本原地不动（新版本校验通过后才替换）\n` +
            `· ⚠️ 但更新成功后**无法回退到旧版本** —— 清单里只钉了一个版本\n\n` +
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
            <RefreshCw
              className={check.isPending ? 'size-3.5 animate-spin' : 'size-3.5'}
              aria-hidden
            />
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
      {/* 「检查」失败以前完全静默；本页的查询错误一直是渲染的，这里只是漏了 */}
      {check.isError ? <ErrorBlock error={check.error} /> : null}
      {/*
        ★ 「安装 / 更新」失败此前**一个字都不显示**。
        `handleUpdate` 是 `await update.mutateAsync(...)` 包在 `try { } finally { }` 里
        —— **没有 catch**，调用点又是 `void handleUpdate(x)`，rejection 直接漏成
        unhandled rejection；而 `update.isError` 全仓零渲染点（`ComponentCard` 里
        连 `error` 这个词都没出现过，它只收 `busy`）。
        用户点「更新到 X」，sha256 对不上 / 上游 404 / 磁盘满 —— 界面什么都没有，
        按钮只是从「更新中…」变回「更新到 X」，与"按钮是死的"完全一样。
        ⚠️ 上一轮「7 处 void mutateAsync 全部补上」在本文件里**只加了 `check` 那一行**，
        `update` 从头到尾不在那份名单上 —— 这是**当时漏的**，不是刻意留的。
      */}
      {update.isError ? <ErrorBlock error={update.error} /> : null}
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
