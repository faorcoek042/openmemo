import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { AsrModelPicker } from '../../components/common/AsrModelPicker';
import { useLlmConfig } from '../../components/common/llm/llm-catalog';
import { LlmSettingsSection } from '../../components/common/llm/LlmSettingsSection';
import { PurposeBindingsSection } from '../../components/common/llm/PurposeBindingsSection';
import { useTranslation } from 'react-i18next';
import { Boxes, ChevronDown, ChevronRight, Cpu, Mic } from 'lucide-react';
import type {
  CatalogGroupWithFitness,
  CatalogVariant,
  DownloadJob,
  ModelRole,
  SpeedClass,
} from '@openmemo/shared';

import { Banner } from '../../components/common/Banner';
import { Button } from '../../components/common/Button';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { StatusChip } from '../../components/common/StatusChip';
import { formatBytes } from '../../lib/format/bytes';
import { localizedName } from '../../lib/format/localized';
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
import { DownloadRow } from '../../components/common/DownloadRow';
import { StorageBreakdown } from './components/StorageBreakdown';
import { SourcesSection } from './components/SourcesSection';
import { splitAsrSections } from './asrSections';

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

/**
 * 转写 Tab 上会出现哪些 role。
 *
 * ★ T-150（D-10 #10）：**这里原本写死成 `'asr'` 一个值**，
 * 而 `role=vad`（2 变体）与 `role=punctuation`（1 变体）**一直在目录里** ——
 * 于是它们在网页上一个都看不到，用户没有任何途径装上它们。
 *
 * 后果不止"少了两张卡"：daemon 的 `model.vad` 自检项算好了一句 remediation
 * 「在「模型」页安装 `vad/silero-vad-ggml`」，**而那一页不渲染 VAD** ——
 * 一条具体但无法执行的指引比没有指引更糟，用户会照着去做然后怀疑是自己没找到。
 * （`catalog-truth` 与 D-10 #10 各自独立记到了同一处。）
 *
 * ⚠️ **它们不是"另一类 ASR"，不能直接混进转写列表。** 用户心智里
 * "识别引擎"和"切句子的""补标点的"不是同一类东西。它们进的是
 * 「实时字幕组件」那一组 —— 一条链路上的三个零件，不是彼此的替代品
 * （分组规则在 `asrSections.ts`，那里写了每一组的判据）。
 *
 * 语言模型的目录条目 ADR-016 已砍，这一页一条都不该出现。
 */
const ASR_TAB_ROLES: readonly ModelRole[] = ['asr', 'vad', 'punctuation'];

export default function ModelsPage() {
  const { t, i18n } = useTranslation();
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
  const [onlyRunnable, setOnlyRunnable] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  /**
   * 用户打算转写的语言。默认跟随界面语言。
   * ADR-011 决策 1：中文场景下**默认过滤掉**实测不可用的模型。
   */
  const targetLanguage = locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  /** 「已隐藏 N 个在<这里>下…」的那个语言名。中文档说"中文"，其余说"该语言"。 */
  const targetLanguageLabel =
    targetLanguage === 'zh' ? t('models.language.zh') : t('models.language.other');
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
        .filter((g) => ASR_TAB_ROLES.includes(g.role))
        .flatMap((g) => g.variants)
        .filter((v) => v.fitness.notRecommendedForLanguage && !installedIds.has(v.id)).length,
    [catalog.data, installedIds],
  );

  const active = installed.data?.active ?? { asr: null, llm: null };

  const groups = useMemo(() => {
    const all = catalog.data?.groups ?? [];
    return all
      .filter((g) => ASR_TAB_ROLES.includes(g.role))
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
          ? g.variants.some(
              (v) => v.fitness.tier === 'recommended' || v.fitness.tier === 'slow_partial',
            )
          : true,
      );
  }, [catalog.data, onlyRunnable, showNotRecommended, installedIds, active.asr, active.llm]);

  /** D-10 #9 / #10 / #29：推荐 / 实时字幕组件 / 更多档位（按 `speedClass` 分三挡）。 */
  const sections = useMemo(() => splitAsrSections(groups), [groups]);

  /*
   * 只显示模型域的活跃下载（后端包下载在 /runtime 页展示）。
   *
   * ⚠️ `filter` 的回调必须写成**类型谓词**：`jobs` 现在是 `AnyJob[]`
   * （`DownloadJob | PipelineJob`，T-130 补了流水线 job 的表示），
   * 而 TS 不会顺着普通 `filter` 收窄联合类型 —— 不写谓词，`DownloadRow`
   * 就会收到一个可能没有 `totalBytes` / `completedBytes` 的 job。
   * 这里判据仍是运行时那句 `kind === 'model'`，谓词只是把它告诉类型系统。
   *
   * ⏳ **待 `job-events` 的 job 契约落地后可换**：若那边统一出
   * `isDownloadJob()` 作为收窄入口，这里应改用它而不是各写一遍谓词
   * （替换由 Manager 协调，见 `coordination/inbox/models-page-fix.md` §8.4）。
   * **这不是最终形态**，别照着它在别处复制一份。
   */
  const activeJobs = useMemo(
    () =>
      (jobs.data?.jobs ?? []).filter(
        (j): j is DownloadJob =>
          j.kind === 'model' && !['succeeded', 'cancelled'].includes(j.state),
      ),
    [jobs.data],
  );

  async function handlePull(v: CatalogVariant, includeOptional: string[] = []) {
    // unsupported 不禁用按钮，改为二次确认（R-04 §9.6 第 7 条）
    if (v.fitness.tier === 'unsupported') {
      const ok = window.confirm(
        t('models.confirmUnsupported', {
          name: localizedName(locale, v),
          reason: v.fitness.reasonZh,
        }),
      );
      if (!ok) return;
    }
    if (v.license.requiresAcceptance || v.license.gated) {
      const ok = window.confirm(
        t('models.confirmLicense', {
          name: localizedName(locale, v),
          license: v.license.id,
          url: v.license.url,
        }),
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
        /*
         * ★ T-153：可选文件（今天只有 `coreml-encoder`）必须原样传给 daemon。
         * `installer.ts:129` 的规则是「optional 且不在 includeOptional 里 ⇒ 跳过」，
         * 而 T-153 之前**全仓没有任何地方传过这个字段** —— 也就是说
         * 用户在界面上没有任何办法装 CoreML encoder，ANE 那条链在这里断掉。
         * 空数组也照传：形状恒定，读代码的人一眼看得出这个字段是活的。
         */
        includeOptional,
      });
    } finally {
      setPendingId(null);
    }
  }

  /** 一张卡的渲染。三组共用同一个 —— 分组只改归属，不改卡片本身。 */
  const card = (g: CatalogGroupWithFitness) => (
    <ModelCard
      key={g.groupId}
      group={g}
      locale={locale}
      installedIds={installedIds}
      activeId={g.role === 'asr' ? active.asr : null}
      pendingId={pendingId}
      onPull={(v, includeOptional) => void handlePull(v, includeOptional)}
      onDelete={(id) => {
        if (window.confirm(t('models.confirmDelete'))) {
          void del.mutateAsync(id);
        }
      }}
      onActivate={(id) => void activate.mutateAsync({ role: g.role, id })}
    />
  );

  const asrActive = installed.data?.models.find((m) => m.id === active.asr);
  /* D-10 #8：语言模型的"当前使用"必须读 settings，不是 `installed.active.llm`。 */
  const llmCfg = useLlmConfig();
  const llmModel = llmCfg.defaultModel;
  const llmProviderLabel =
    llmCfg.providers.find((p) => p.id === llmCfg.activeProviderId)?.label ??
    llmCfg.activeProviderId;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4" data-testid="models-page">
      <header>
        <h1 className="text-lg font-semibold text-ink">{t('models.title')}</h1>
        <p className="mt-0.5 text-xs text-ink-secondary">{t('models.intro')}</p>
      </header>

      {catalog.data?.stale ? (
        <Banner
          tone="warning"
          title={t('models.staleTitle')}
          detail={t('models.staleDetail', {
            time: new Date(catalog.data.fetchedAt).toLocaleString(locale),
          })}
        />
      ) : null}

      {/* 当前使用 */}
      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-medium text-ink">{t('models.current.title')}</h2>
        <ul className="mt-2 space-y-2 text-xs">
          <li className="flex items-center gap-2">
            <Mic className="size-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="w-16 shrink-0 text-ink-secondary">{t('models.current.asr')}</span>
            {asrActive ? (
              <>
                <span className="text-ink">{asrActive.displayName}</span>
                <span className="text-ink-secondary">
                  {formatBytes(asrActive.totalSizeBytes, locale)}
                </span>
                {/*
                  ★ T-199 ①：`corrupt` 此前被说成「未校验」。
                  **校验过并且失败了，和从没校验过，是两回事** —— 前者是"这个文件坏了、
                  现在跑不了"，后者是"还没查过、多半没事"。用同一句话说，
                  等于把一个确定的坏消息降级成一句无所谓的提示。
                  三态各自成一格，`corrupt` 给 critical（它确实会让转写起不来）。
                */}
                {/* 包一层只为给判据一个**结构锚点**：整页文字匹配会撞上
                    选择器里那句「（校验未通过，选了也跑不了）」——
                    同一个词出现在两个地方，关键词判据就分不清是谁说的。 */}
                <span data-testid="asr-integrity-chip">
                  <StatusChip
                    tone={
                      asrActive.integrity === 'ok'
                        ? 'good'
                        : asrActive.integrity === 'corrupt'
                          ? 'critical'
                          : 'warning'
                    }
                    label={
                      asrActive.integrity === 'ok'
                        ? t('models.current.verified')
                        : asrActive.integrity === 'corrupt'
                          ? t('models.current.corrupt')
                          : t('models.current.unverified')
                    }
                  />
                </span>
              </>
            ) : (
              <StatusChip tone="warning" label={t('models.current.noAsr')} />
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
            <span className="w-16 shrink-0 text-ink-secondary">{t('models.current.llm')}</span>
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
              <StatusChip tone="warning" label={t('models.current.noLlm')} />
            )}
            <button
              type="button"
              className="ml-auto text-xs text-accent underline"
              onClick={() => setTab('llm')}
              data-testid="current-llm-change"
            >
              {t('models.current.change')}
            </button>
          </li>
        </ul>
      </section>

      {/*
        ★ 取消 / 重试 / 清理 的错误块**搬到 tabpanel 外面**。

        它们原来写在 `id="models-panel-asr"` 那个 section 里，而那个 section 是
        `className={tab === 'asr' ? 'space-y-3' : 'hidden'}` ——
        **`?tab=llm` 下点这三个按钮，错误块被 `hidden` 吞掉，一个字都看不到。**
        而这三个按钮（下载行的取消/重试、页尾的清理）渲染在**两个 tab 下都可见**的位置。

        这是"渲染点在，但在某些状态下够不着"的第二个形态：
        不是分支不对，是**它和触发它的控件不在同一个可见性作用域里**。
        判据与 ModelDetailPage 那处同一条：**错误的渲染点必须和控件同处一个条件/可见性作用域。**
      */}
      {cancelJob.isError ? <ErrorBlock error={cancelJob.error} /> : null}
      {retryJob.isError ? <ErrorBlock error={retryJob.error} /> : null}
      {gc.isError ? <ErrorBlock error={gc.error} /> : null}

      {/* 下载中 */}
      {activeJobs.length > 0 ? (
        <section className="space-y-2" aria-label={t('models.downloadingLabel')}>
          <h2 className="text-sm font-medium text-ink">
            {t('models.downloadingCount', { n: activeJobs.length })}
          </h2>
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
        ★★ Tab 切换条属于**页面骨架**，不属于任何一个 Tab 的内容。

        它原本写在下面那个 `tab === 'asr' ? … : 'hidden'` 的 section **里面**，
        于是切到「语言模型」之后，切换条**连同整个 section 一起被 hidden 了** ——
        页面上再没有任何一个能切回「转写」的控件，用户只能手改 URL 或从侧栏绕回默认 Tab
        （`ui-polish` 在 T-124 的真浏览器截图里抓到，`[实测]`）。

        这不是样式问题：**tablist 与 tabpanel 必须是兄弟，不能是父子**。
        `?tab=llm` 是一个可分享的 URL（D-10 §1.2），别人打开它就落在语言模型 Tab 上，
        对他而言"切回去"的入口从来就没出现过。

        顺带补齐 tablist/tab/tabpanel 的 ARIA 关系 —— 两个 Tab 面板本来就是
        "同一块区域的两种内容"，读屏用户此前拿不到这层关系。
      */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label={t('models.tabsLabel')}
          className="flex rounded-md border border-line bg-surface-1 p-0.5"
          data-testid="models-tabs"
        >
          {[
            { id: 'asr' as const, label: t('models.tabs.asr') },
            { id: 'llm' as const, label: t('models.tabs.llm') },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`models-panel-${item.id}`}
              onClick={() => setTab(item.id)}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium ${
                tab === item.id ? 'bg-accent text-accent-fg' : 'text-ink-secondary'
              }`}
              data-testid={`models-tab-${item.id}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {/*
          「只显示这台机器能跑的」筛的是**目录卡片**，只在转写 Tab 下有意义 ——
          它跟着 Tab 走，切换条不跟着 Tab 走。这正是"骨架 vs 内容"的分界。
        */}
        {tab === 'asr' ? (
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={onlyRunnable}
              onChange={(e) => setOnlyRunnable(e.target.checked)}
              className="size-3.5 accent-[var(--accent)]"
            />
            {t('models.onlyRunnable')}
          </label>
        ) : null}
      </div>

      {/*
        D-10 #1/#6：语言模型 Tab 承接原本在**设置页**的两个区块。
        它们搬过来而不是复制 —— 服务商下拉必须是同页上方清单的子集（INV-1），
        跨页正是上次漂移的成因。
      */}
      {tab === 'llm' ? (
        <div
          className="space-y-4"
          id="models-panel-llm"
          role="tabpanel"
          data-testid="models-llm-tab"
        >
          <LlmSettingsSection />
          <PurposeBindingsSection />
        </div>
      ) : null}

      {/* 目录（仅转写 Tab） */}
      <section
        id="models-panel-asr"
        role="tabpanel"
        className={tab === 'asr' ? 'space-y-3' : 'hidden'}
      >
        {/*
          ADR-011 决策 1：中文下 base/small 不是"稍差"，是把「维基百科」听成「危机摆科」。
          默认隐藏，但必须说明隐藏了什么、为什么，并且**可以一键看回来** ——
          静默隐藏会让用户以为产品没有这些模型。
        */}
        {hiddenByLanguage > 0 && !showNotRecommended ? (
          <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-xs text-ink-secondary">
            {t('models.hidden.notice', { n: hiddenByLanguage, language: targetLanguageLabel })}
            <button
              type="button"
              className="ml-1 text-accent-ink hover:underline"
              onClick={() => setShowNotRecommended(true)}
              data-testid="models-show-not-recommended"
            >
              {t('models.hidden.show')}
            </button>
          </div>
        ) : null}
        {showNotRecommended && hiddenByLanguage > 0 ? (
          <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-xs text-ink-secondary">
            {t('models.hidden.showingAll', { n: hiddenByLanguage, language: targetLanguageLabel })}
            <button
              type="button"
              className="ml-1 text-accent-ink hover:underline"
              onClick={() => setShowNotRecommended(false)}
            >
              {t('models.hidden.hideAgain')}
            </button>
          </div>
        ) : null}

        {catalog.isError ? (
          <ErrorBlock error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : null}
        {/*
          ★ T-140：安装 / 删除失败此前**一个字都不显示**。
          `pull.error` 与 `del.error` 全仓零渲染点 —— 点「安装」磁盘不够、或模型受许可限制，
          界面上没有任何反应，用户只会以为按钮坏了。

          而 daemon 恰恰在这两条上算好了可执行的补救动作：
            · `rest/models.ts:353` 403 GATED_REPO   → `accept_license`  → 模型详情页（有许可证链接）
            · `rest/models.ts:369` 507 DISK_FULL    → `free_disk`       → `/settings/storage`
            · `rest/models.ts:597` 409 MODEL_IN_USE → `activate_model`  → `/models`
          三条都是**在建 job 之前**同步返回的，所以 JobToaster 也永远看不到它们。
          没有这两行，那三个 remediation 在产品里不可能被渲染出来 —— 与 prop 传不传无关。
        */}
        {pull.isError ? <ErrorBlock error={pull.error} /> : null}
        {del.isError ? <ErrorBlock error={del.error} /> : null}
        {/*
          ★ 这四条以前是 `void X.mutateAsync(...)` —— 失败时界面一个字都不说。
          它们**不是刻意静默**：本页紧挨着的 `pull` / `del` 就是这么渲染错误的，
          也就是说这套写法一直在手边，只是这几处漏了。判据与用户报的那条同一条：
          点了一个按钮，要么发生该发生的事，要么看到一句读得懂的话，没有第三种。
        */}
        {activate.isError ? <ErrorBlock error={activate.error} /> : null}
        {catalog.isLoading ? <p className="text-xs text-ink-muted">{t('models.loading')}</p> : null}

        {!catalog.isLoading && groups.length === 0 ? (
          <EmptyState
            icon={<Cpu className="size-8" aria-hidden />}
            title={onlyRunnable ? t('models.emptyRunnable') : t('models.emptyNone')}
            hint={onlyRunnable ? t('models.emptyRunnableHint') : undefined}
            action={
              onlyRunnable ? (
                <Button variant="secondary" size="sm" onClick={() => setOnlyRunnable(false)}>
                  {t('models.showAll')}
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {/*
          ★ D-10 #9 / #10 / #29：三分组 + 档位。

          此前是 8 张卡**平铺**，排序按目录顺序 —— 于是"边说边出字要装哪三个"
          和"我要更准该换哪个"混在同一列里，而 large-v1/v2 这些被新版严格支配的
          也和 v3-turbo 并排站着。分组规则是纯函数（`asrSections.ts`），这里只排版。
        */}
        <AsrGroupSection
          title={t('models.section.recommended')}
          hint={t('models.section.recommendedHint')}
          testId="models-section-recommended"
          groups={sections.recommended}
          render={card}
        />
        <AsrGroupSection
          title={t('models.section.realtime')}
          hint={t('models.section.realtimeHint')}
          testId="models-section-realtime"
          groups={sections.realtime}
          render={card}
        />

        {sections.more.length > 0 ? (
          <section className="space-y-3" data-testid="models-section-more">
            <div>
              <h2 className="text-sm font-medium text-ink">{t('models.section.more')}</h2>
              {/*
                ★ D-10 R-M1：这里写的是**档位**，不是"速度"。
                档位是目录常量（按体积人工分档，与你的机器无关）；
                "在你的机器上大约多久"是卡内那一行（`FitEta`，daemon 按硬件算）。
                两个都叫"速度"，用户就没法知道哪个是承诺、哪个是估计。
              */}
              <p className="mt-0.5 text-xs text-ink-secondary">{t('models.section.moreHint')}</p>
            </div>
            {sections.more.map((bucket) => (
              <div key={bucket.speedClass} data-testid={`models-speed-${bucket.speedClass}`}>
                <h3 className="mb-2 text-xs font-medium text-ink-secondary">
                  {t(`models.speedClass.${bucket.speedClass}`)}
                </h3>
                <div className="space-y-3">{bucket.groups.map(card)}</div>
                {bucket.superseded.length > 0 ? (
                  <SupersededRow
                    speedClass={bucket.speedClass}
                    groups={bucket.superseded}
                    render={card}
                  />
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
      </section>

      {/*
        ★ T-157 ④：下载源（镜像）。放在目录**之后、磁盘占用之前** ——
        它既不是"选哪个模型"的一部分，也不该藏进设置页：用户会需要它的确切时刻，
        是刚看到「所有下载源均失败」的时候，而那条横幅就出现在这一页上。
      */}
      <SourcesSection locale={locale} />

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

/**
 * 一组卡片。**组是空的就整块不渲染** —— 画一个空标题只会让人问"是不是还没做完"。
 */
function AsrGroupSection({
  title,
  hint,
  testId,
  groups,
  render,
}: {
  title: string;
  hint: string;
  testId: string;
  groups: CatalogGroupWithFitness[];
  render: (g: CatalogGroupWithFitness) => React.ReactNode;
}) {
  if (groups.length === 0) return null;
  return (
    <section className="space-y-3" data-testid={testId}>
      <div>
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        <p className="mt-0.5 text-xs text-ink-secondary">{hint}</p>
      </div>
      {groups.map(render)}
    </section>
  );
}

/**
 * 「已被新版本取代的 N 个」（D-10 §4.1.2）。
 *
 * **折叠不是隐藏**：复现旧结果、跑对照实验是真实需求，而且这些条目一直在目录里 ——
 * 悄悄消失比折叠更让人困惑。折叠 = 我们表态"别选这个"；删除 = 我们替用户做决定。
 * 数字必须写出来（`2 (+2)` 里的那个 `+2`），否则用户不知道自己没看见什么。
 */
function SupersededRow({
  speedClass,
  groups,
  render,
}: {
  speedClass: SpeedClass;
  groups: CatalogGroupWithFitness[];
  render: (g: CatalogGroupWithFitness) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2" data-testid={`models-superseded-${speedClass}`}>
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-accent-ink hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={`models-superseded-toggle-${speedClass}`}
      >
        {open ? (
          <ChevronDown className="size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
        {t('models.supersededCount', { n: groups.length })}
      </button>
      {open ? <div className="mt-2 space-y-3">{groups.map(render)}</div> : null}
    </div>
  );
}
