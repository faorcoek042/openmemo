import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { AsrModelPicker } from '../../components/common/AsrModelPicker';
import { useLlmConfig } from '../../components/common/llm/llm-catalog';
import { LlmSettingsSection } from '../../components/common/llm/LlmSettingsSection';
import { PurposeBindingsSection } from '../../components/common/llm/PurposeBindingsSection';
import { useTranslation } from 'react-i18next';
import { Boxes, Cpu, Mic } from 'lucide-react';
import type { CatalogVariant, ModelRole } from '@openmemo/shared';

import { Banner } from '../../components/common/Banner';
import { Button } from '../../components/common/Button';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { StatusChip } from '../../components/common/StatusChip';
import { formatBytes } from '../../lib/format/bytes';
import {
  useGcMutation,
  useJobCancelMutation,
  useJobRetryMutation,
  useJobsQuery,
  useModelActivateMutation,
  useModelDeleteMutation,
  useModelPullMutation,
  useModelsCatalogQuery,
  useModelsInstalledQuery,
  useModelsStorageQuery,
} from './api';
import { ModelCard } from './components/ModelCard';
import { DownloadRow } from './components/DownloadRow';
import { StorageBreakdown } from './components/StorageBreakdown';

/**
 * 模型管理页 —— 章程要求 2.2 的主界面。
 *
 * 原文：「模型的浏览、下载、切换、删除、量化选择，**全部通过网页完成**」。
 * 这一页要闭环覆盖这五件事，用户全程不碰命令行。
 *
 * ★ 挂载顺序（R-04 §9.6 第 2 条）：**并行拉 catalog / jobs / storage 快照，再由
 * `lib/events/bindings.ts` 订阅 SSE**。反过来（先订阅再拉）会漏掉订阅前发生的事件，
 * 或在快照与增量之间重复计数。这里三个 useQuery 天然并行，SSE 订阅在 App 层已建立。
 */


export default function ModelsPage() {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  /**
   * D-10 §1.2：**一个页面、页内两个 Tab、不开子路由**。
   * Tab 状态进 URL query（`?tab=asr|llm`）以满足"URL 是可分享状态"，
   * 而不是新增 `/models/asr`、`/models/llm` —— 拆成两条路由就同不了屏，
   * 页顶「当前使用」两行会各自复述一遍，第二天必漂移
   * （`llm.providers` vs `llm.baseUrl.*` 已是前车之鉴）。
   */
  const [sp, setSp] = useSearchParams();
  const tab: 'asr' | 'llm' = sp.get('tab') === 'llm' ? 'llm' : 'asr';
  const setTab = (t: 'asr' | 'llm') => {
    const next = new URLSearchParams(sp);
    next.set('tab', t);
    setSp(next, { replace: true });
  };
  // 目录侧只剩转写：语言模型不再走 catalog（ADR-016 砍掉内置 llama.cpp）
  const role: ModelRole = 'asr';
  const [onlyRunnable, setOnlyRunnable] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  /**
   * 用户打算转写的语言。默认跟随界面语言。
   * ADR-011 决策 1：中文场景下**默认过滤掉**实测不可用的模型。
   */
  const targetLanguage = locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  /** 允许用户手动解除过滤 —— 英文转写时 base 在弱机器上仍然合理，一刀切会误伤。 */
  const [showNotRecommended, setShowNotRecommended] = useState(false);

  const catalog = useModelsCatalogQuery('all', targetLanguage);
  const installed = useModelsInstalledQuery();
  const storage = useModelsStorageQuery();
  const jobs = useJobsQuery();

  const pull = useModelPullMutation();
  const del = useModelDeleteMutation();
  const activate = useModelActivateMutation();
  const gc = useGcMutation();
  const cancelJob = useJobCancelMutation();
  const retryJob = useJobRetryMutation();

  const installedIds = useMemo(
    () => new Set((installed.data?.models ?? []).map((m) => m.id)),
    [installed.data],
  );

  /** 被语言过滤掉的变体数量 —— 必须显式告诉用户"我们藏了几个"，不能静默。 */
  const hiddenByLanguage = useMemo(
    () =>
      (catalog.data?.groups ?? [])
        .filter((g) => g.role === role)
        .flatMap((g) => g.variants)
        .filter((v) => v.fitness.notRecommendedForLanguage && !installedIds.has(v.id)).length,
    [catalog.data, role, installedIds],
  );

  const active = installed.data?.active ?? { asr: null, llm: null };

  const groups = useMemo(() => {
    const all = catalog.data?.groups ?? [];
    return all
      .filter((g) => g.role === role)
      .map((g) => ({
        ...g,
        // ADR-011：默认隐藏实测在该语言下不可用的变体。
        //
        // ★ 但**已安装/正在使用的永远不隐藏**。真浏览器 E2E 抓到的 bug：
        // 用户下载完 base-q5_1（zh 下被标 notRecommendedFor），列表里它直接消失了，
        // 看起来像"下载失败"。过滤器是给"该装哪个"用的推荐机制，
        // 不该让用户失去对自己已装文件的可见性与控制权（删不掉、切不了）。
        variants: showNotRecommended
          ? g.variants
          : g.variants.filter(
              (v) =>
                !v.fitness.notRecommendedForLanguage ||
                installedIds.has(v.id) ||
                v.id === active.asr ||
                v.id === active.llm,
            ),
      }))
      .filter((g) => g.variants.length > 0)
      .filter((g) =>
        onlyRunnable
          ? g.variants.some((v) => v.fitness.tier === 'recommended' || v.fitness.tier === 'slow_partial')
          : true,
      );
  }, [catalog.data, role, onlyRunnable, showNotRecommended, installedIds, active.asr, active.llm]);

  // 只显示模型域的活跃下载（后端包下载在 /runtime 页展示）
  const activeJobs = useMemo(
    () =>
      (jobs.data?.jobs ?? []).filter(
        (j) => j.kind === 'model' && !['succeeded', 'cancelled'].includes(j.state),
      ),
    [jobs.data],
  );

  async function handlePull(v: CatalogVariant) {
    // unsupported 不禁用按钮，改为二次确认（R-04 §9.6 第 7 条）
    if (v.fitness.tier === 'unsupported') {
      const ok = window.confirm(
        `${v.displayNameZh}\n\n${v.fitness.reasonZh}\n\n这台机器很可能无法运行它，或者极慢。仍要下载吗？`,
      );
      if (!ok) return;
    }
    if (v.license.requiresAcceptance || v.license.gated) {
      const ok = window.confirm(
        `${v.displayNameZh} 使用 ${v.license.id} 许可，需要你先到上游页面接受条款。\n\n${v.license.url}\n\n已接受并继续下载？`,
      );
      if (!ok) return;
      window.open(v.license.url, '_blank', 'noopener');
    }
    setPendingId(v.id);
    try {
      await pull.mutateAsync({
        id: v.id,
        kind: 'model',
        provider: 'auto',
        licenseAccepted: true,
      });
    } finally {
      setPendingId(null);
    }
  }

  const asrActive = installed.data?.models.find((m) => m.id === active.asr);
  /* D-10 #8：语言模型的"当前使用"必须读 settings，不是 `installed.active.llm`。 */
  const llmCfg = useLlmConfig();
  const llmModel = llmCfg.defaultModel;
  const llmProviderLabel =
    llmCfg.providers.find((p) => p.id === llmCfg.activeProviderId)?.label ?? llmCfg.activeProviderId;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4" data-testid="models-page">
      <header>
        <h1 className="text-lg font-semibold text-ink">模型管理</h1>
        <p className="mt-0.5 text-xs text-ink-secondary">
          浏览、下载、切换、删除、选择量化档 —— 全部在网页里完成，不需要命令行。
        </p>
      </header>

      {catalog.data?.stale ? (
        <Banner
          tone="warning"
          title="当前使用离线模型目录"
          detail={`最后更新于 ${new Date(catalog.data.fetchedAt).toLocaleString(locale)}。联网后会自动更新。`}
        />
      ) : null}

      {/* 当前使用 */}
      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-medium text-ink">当前使用</h2>
        <ul className="mt-2 space-y-2 text-xs">
          <li className="flex items-center gap-2">
            <Mic className="size-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="w-16 shrink-0 text-ink-secondary">转写模型</span>
            {asrActive ? (
              <>
                <span className="text-ink">{asrActive.displayName}</span>
                <span className="text-ink-secondary">
                  {formatBytes(asrActive.totalSizeBytes, locale)}
                </span>
                <StatusChip
                  tone={asrActive.integrity === 'ok' ? 'good' : 'warning'}
                  label={asrActive.integrity === 'ok' ? '已校验' : '未校验'}
                />
              </>
            ) : (
              <StatusChip tone="warning" label="未选择 —— 无法转写" />
            )}
            {/*
              INV-2 / D-10 #21：**复用**既有的 `AsrModelPicker`，不要新写一个。
              新写最容易犯的错是"从 catalog 里选" —— 那会让用户选中一个没下载的模型然后转写报错。
              它已经只列 `installed` 且 `role==='asr'`，一个没装时给"去安装"。
            */}
            <span className="ml-auto">
              <AsrModelPicker />
            </span>
          </li>
          <li className="flex items-center gap-2">
            <Boxes className="size-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="w-16 shrink-0 text-ink-secondary">语言模型</span>
            {/*
              ★ D-10 #8：这里原本读 `active.llm`，而**在线 provider 从不进 `installed` 表**，
              所以它恒为 null —— 用户明明配好了 DeepSeek，页面却一直写着
              「未选择 —— 思维导图功能不可用」。**在谎报功能不可用。**
              改读 daemon 真正解析用的那两个键（`llm.defaultProviderId` / `llm.defaultModelId`）。
            */}
            {llmProviderLabel && llmModel ? (
              <>
                <span className="text-ink">{llmProviderLabel}</span>
                <span className="text-ink-secondary">{llmModel}</span>
              </>
            ) : (
              <StatusChip tone="warning" label="未配置 —— 摘要与思维导图不可用" />
            )}
            <button
              type="button"
              className="ml-auto text-xs text-accent underline"
              onClick={() => setTab('llm')}
              data-testid="current-llm-change"
            >
              更换
            </button>
          </li>
        </ul>
      </section>

      {/* 下载中 */}
      {activeJobs.length > 0 ? (
        <section className="space-y-2" aria-label="下载中">
          <h2 className="text-sm font-medium text-ink">下载中（{activeJobs.length}）</h2>
          {activeJobs.map((j) => (
            <DownloadRow
              key={j.jobId}
              job={j}
              locale={locale}
              onCancel={(id) => void cancelJob.mutateAsync(id)}
              onRetry={(id) => void retryJob.mutateAsync(id)}
            />
          ))}
        </section>
      ) : null}

      {/*
        D-10 #1/#6：语言模型 Tab 承接原本在**设置页**的两个区块。
        它们搬过来而不是复制 —— 服务商下拉必须是同页上方清单的子集（INV-1），
        跨页正是上次漂移的成因。
      */}
      {tab === 'llm' ? (
        <div className="space-y-4" data-testid="models-llm-tab">
          <LlmSettingsSection />
          <PurposeBindingsSection />
        </div>
      ) : null}

      {/* 目录（仅转写 Tab） */}
      <section className={tab === 'asr' ? 'space-y-3' : 'hidden'}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-line bg-surface-1 p-0.5">
            {(
              [
                { id: 'asr' as const, label: '转写' },
                { id: 'llm' as const, label: '语言模型' },
              ]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium ${
                  tab === t.id ? 'bg-accent text-accent-fg' : 'text-ink-secondary'
                }`}
                data-testid={`models-tab-${t.id}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={onlyRunnable}
              onChange={(e) => setOnlyRunnable(e.target.checked)}
              className="size-3.5 accent-[var(--accent)]"
            />
            只显示这台机器能跑的
          </label>
        </div>

        {/*
          ADR-011 决策 1：中文下 base/small 不是"稍差"，是把「维基百科」听成「危机摆科」。
          默认隐藏，但必须说明隐藏了什么、为什么，并且**可以一键看回来** ——
          静默隐藏会让用户以为产品没有这些模型。
        */}
        {role === 'asr' && hiddenByLanguage > 0 && !showNotRecommended ? (
          <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-xs text-ink-secondary">
            已隐藏 {hiddenByLanguage} 个在{targetLanguage === 'zh' ? '中文' : '该语言'}
            下实测识别质量不可接受的模型（小模型会把「维基百科」听成「危机摆科」）。
            <button
              type="button"
              className="ml-1 text-accent-ink hover:underline"
              onClick={() => setShowNotRecommended(true)}
              data-testid="models-show-not-recommended"
            >
              仍要显示
            </button>
          </div>
        ) : null}
        {showNotRecommended && hiddenByLanguage > 0 ? (
          <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-xs text-ink-secondary">
            正在显示全部模型，含 {hiddenByLanguage} 个不适合
            {targetLanguage === 'zh' ? '中文' : '该语言'}的。
            <button
              type="button"
              className="ml-1 text-accent-ink hover:underline"
              onClick={() => setShowNotRecommended(false)}
            >
              重新隐藏
            </button>
          </div>
        ) : null}

        {catalog.isError ? <ErrorBlock error={catalog.error} onRetry={() => void catalog.refetch()} /> : null}
        {catalog.isLoading ? <p className="text-xs text-ink-muted">正在读取模型目录…</p> : null}

        {!catalog.isLoading && groups.length === 0 ? (
          <EmptyState
            icon={<Cpu className="size-8" aria-hidden />}
            title={onlyRunnable ? '这台机器暂时跑不动任何该类模型' : '目录里还没有该类模型'}
            hint={
              onlyRunnable
                ? '取消勾选可以看到全部模型 —— 我们的估算可能偏保守，你仍然可以选择下载。'
                : undefined
            }
            action={
              onlyRunnable ? (
                <Button variant="secondary" size="sm" onClick={() => setOnlyRunnable(false)}>
                  显示全部
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {groups.map((g) => (
          <ModelCard
            key={g.groupId}
            group={g}
            locale={locale}
            installedIds={installedIds}
            activeId={g.role === 'asr' ? active.asr : active.llm}
            pendingId={pendingId}
            onPull={(v) => void handlePull(v)}
            onDelete={(id) => {
              if (window.confirm('删除这个模型？磁盘空间会被释放，需要时可以重新下载。')) {
                void del.mutateAsync(id);
              }
            }}
            onActivate={(id) => void activate.mutateAsync({ role: g.role, id })}
          />
        ))}
      </section>

      {storage.data ? (
        <StorageBreakdown
          storage={storage.data}
          locale={locale}
          gcPending={gc.isPending}
          onGc={() => void gc.mutateAsync({ targets: ['orphan_blobs', 'stale_partials'] })}
        />
      ) : null}
    </div>
  );
}
