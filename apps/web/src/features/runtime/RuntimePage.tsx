import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Boxes, ChevronRight, Cpu } from 'lucide-react';
import type { GetBackendCatalogResponse } from '@openmemo/shared';

import { Banner } from '../../components/common/Banner';
import { Emphasis } from '../../components/common/Emphasis';
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
import { BreakerNotice } from './components/BreakerNotice';
import { BackendPackCard } from './components/BackendPackCard';
import { isMeaningfulRecommendation } from './packStatus';

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
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const hardware = useHardwareQuery();
  const catalog = useBackendsCatalogQuery();
  const installed = useBackendsInstalledQuery();

  const install = useBackendInstallMutation();
  const remove = useBackendRemoveMutation();
  const select = useBackendSelectMutation();
  const selfTest = useBackendSelfTestMutation();

  const selfTestById = useMemo(() => {
    const m = new Map<string, NonNullable<typeof installed.data>['packs'][number]['selfTest']>();
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

  /**
   * ★ 把"本机根本装不了的包"从主列表里分出去。
   *
   * 排序把它们排到了后面，**但它们仍然占着同等大小的卡片**。实测本机：目录里 14 个包，
   * 其中 9 个是 darwin/arm64、win32/x64、linux/arm64 —— 一台 linux/x64 机器上
   * 永远不可能装的东西，却占了整页约三分之二的高度，每个都长成"标题 + 元信息 +
   * 一个灰掉的安装按钮"。用户要滚过九屏别人的平台包，才看得完自己的五个。
   *
   * 这是"界面看着乱"的第一成因，而且**是密度问题不是配色问题** ——
   * 换任何颜色都救不了一页 14 张等重卡片。
   *
   * 不直接删掉的理由：目录里有什么应当可查（跨平台构建是否齐全是真实需求，
   * 也便于用户判断"换台机器能不能用"）。所以是**折叠**，不是隐藏，
   * 且摘要行写清楚折了几个、为什么折。
   */
  const applicable = useMemo(() => sorted.filter((p) => p.applicable), [sorted]);
  const inapplicable = useMemo(() => sorted.filter((p) => !p.applicable), [sorted]);

  const anyFailed = (installed.data?.packs ?? []).some((p) => p.selfTest && !p.selfTest.passed);

  /**
   * ★ 哪些「推荐」徽章真的承载信息（T-165 / `progress-audit §4⑩`）。
   *
   * `[实测 :10000]` 本机适用的 6 个包**全部** `recommended:true` —— 因为它们的
   * `backend` 都是 `cpu`，而选中的后端就是 `cpu`。六个「推荐」徽章 + 六个主按钮，
   * 一个都没区分出任何东西。判据与规则写在 `packStatus.ts`：
   * **只收窄、不增加**，且必须看整份目录才算得出来（一张卡自己看不出"有没有得选"）。
   */
  const recommendedIds = useMemo(
    () => new Set(packs.filter((p) => isMeaningfulRecommendation(p, packs)).map((p) => p.id)),
    [packs],
  );

  function handleSelect(pack: GetBackendCatalogResponse['packs'][number]) {
    void select.mutateAsync(pack.backend);
  }

  /** 两处（主列表 / 折叠区）渲染同一种卡片，抽出来免得两边漂移。 */
  function renderPack(p: GetBackendCatalogResponse['packs'][number]) {
    return (
      <BackendPackCard
        key={p.id}
        pack={p}
        locale={locale}
        isActive={installed.data?.selectedBackend === p.backend && p.installed}
        selfTest={selfTestById.get(p.id) ?? null}
        installing={install.isPending && install.variables === p.id}
        recommended={recommendedIds.has(p.id)}
        onInstall={(id) => void install.mutateAsync(id)}
        onRemove={(id) => {
          if (window.confirm(t('runtime.confirmRemove'))) {
            void remove.mutateAsync(id);
          }
        }}
        onSelect={handleSelect}
        onSelfTest={(id) => void selfTest.mutateAsync(id)}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4" data-testid="runtime-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t('runtime.title')}</h1>
          <p className="mt-0.5 text-xs text-ink-secondary">{t('runtime.intro')}</p>
        </div>
        {/*
          ★ T-140：`/components` 的入口。此前它**在整个界面上不可达** ——
          侧栏 7 项没有它、两张 remediation 路由表没有它、全仓零个 `to=` / `navigate()`，
          只能手敲 URL。而 `ComponentCard.tsx` 自己写着「yt-dlp 缺失导致 F1 断掉后，
          这一页正是用户唯一会去的地方」。

          ## 为什么挂在这里，而不是再加一条侧栏

          `/components` 不是第四类东西，它是 **`/runtime` 那批东西的另一个轴**：
          `[实测]` `GET /api/components` 的 7 条里 5 条的 id 与
          `GET /api/backends/catalog` 的包 id **逐字相同**（whispercpp / libsimple /
          sqlite-vec / media-tools / ytdlp）。
          （T-144 前是 8 条里 6 条 —— 多出来的那条是 `llamacpp-cpu-linux-x64`，
          随 ADR-016 决策 3 一起摘除。）
          两页问的是同一批二进制的两个问题：
            · `/runtime`    —— 这台机器该装哪个？（按平台筛、装/选/自检）
            · `/components` —— 这个东西从哪来、钉在哪版、有没有新版、能不能回滚？

          按 D-10 §3.2 自己立的 R1 判据（"换掉它输出会变的才叫模型"）：
          换 yt-dlp 的版本，转出来的字不变 → 它不是模型 → 不归 `/models`，归这一侧。
          再按 D-10 的 R3（"同一问题只准一个出处"）：
          "yt-dlp 装不装得上"如果在侧栏出现第二个一级入口，就是给同一个问题开了两个出处。

          （D-10 §3.3 规划的 `/runtime` 页内「功能组件」分区，和这一页覆盖的是同一批东西 ——
          D-10 写的时候没看见这一页，因为它当时**在界面上不可达**，取证是在 `:10000` 上做的。
          两者合并归 `architect`，这里先把路走通，不替它做版面裁决。）
        */}
        <Link
          to="/components"
          className="shrink-0 rounded-md px-2 py-1 text-xs text-accent-ink hover:bg-fill-hover"
          data-testid="runtime-components-link"
        >
          <Boxes className="mr-1 inline size-3.5" aria-hidden />
          {t('runtime.componentsLink')}
          <span className="ml-1 text-ink-muted">{t('runtime.componentsLinkHint')}</span>
        </Link>
      </header>

      {anyFailed ? (
        <Banner
          tone="critical"
          title={t('runtime.selfTestFailedTitle')}
          detail={t('runtime.selfTestFailedDetail')}
        />
      ) : null}

      {/*
        ★ 用户 2026-08-08：「点击去安装模型，完全没有任何反应。」
        那条已经修掉一个源头（按钮导航到自己所在的页面）。**这是第二个源头**：
        请求真的发了、失败了，而 `void install.mutateAsync(id)` 把 rejection 吞掉，
        界面上一个字都不说 —— **在用户眼里与死按钮一模一样**。

        判据：点了一个按钮，要么发生该发生的事，要么看到一句读得懂的话。**没有第三种。**
        这里复用本页已有的 `ErrorBlock`（`select` / `selfTest` 本来就是这么渲染的），
        不另发明一套。
      */}
      {install.isError ? (
        <ErrorBlock error={install.error} onRetry={() => install.reset()} />
      ) : null}
      {remove.isError ? <ErrorBlock error={remove.error} onRetry={() => remove.reset()} /> : null}

      {hardware.isError ? (
        <ErrorBlock error={hardware.error} onRetry={() => void hardware.refetch()} />
      ) : null}
      {hardware.isLoading ? <p className="text-xs text-ink-muted">{t('runtime.probing')}</p> : null}
      {hw ? <HardwareCard hw={hw} locale={locale} /> : null}

      {/*
        ★ T-174：断路器提示。**放在硬件卡下面、后端包上面**，因为它解释的正是
        "为什么上面那排后端芯片是灰的、下面那些包装了也不起作用"。
        没跳闸时组件自己返回 null —— 不占位、不显示"一切正常"。
      */}
      <BreakerNotice locale={locale} hardwareRuntime={hardware.data?.runtime} />

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink">{t('runtime.packsTitle')}</h2>
          {catalog.data?.stale ? (
            <span className="text-xs text-ink-muted">{t('runtime.staleCatalog')}</span>
          ) : null}
        </div>

        {catalog.isError ? (
          <ErrorBlock error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : null}

        {/*
          ★ T-140：同 ModelsPage —— 「设为当前后端」与「自检」失败此前也是零渲染。
          daemon 对这两条给的补救动作是有落点的：
            · `rest/backends.ts:330` 409 CONFLICT          → `install_backend` → 本页
            · `rest/hardware.ts:204` 409 SELF_TEST_BLOCKED → `install_backend` / `install_model`
          （`runtime/setup.ts:574` 按缺的是模型还是后端二选一）
          不渲染的话，用户点「自检」什么都不发生，而 daemon 已经算出了"缺哪一件、去哪装"。
        */}
        {select.isError ? <ErrorBlock error={select.error} /> : null}
        {selfTest.isError ? <ErrorBlock error={selfTest.error} /> : null}

        {sorted.length === 0 && !catalog.isLoading ? (
          <p className="rounded-lg border border-line bg-surface-1 p-4 text-xs text-ink-secondary">
            <Cpu className="mr-1 inline size-3.5" aria-hidden />
            {t('runtime.noPacks')}
          </p>
        ) : null}

        {applicable.map(renderPack)}

        {/* 不适用于本机的：折叠，但说清楚折了几个 —— 隐藏而不说明会让人以为目录不全 */}
        {inapplicable.length > 0 ? (
          <details className="group rounded-lg border border-line bg-surface-1">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-xs text-ink-secondary hover:text-ink">
              <ChevronRight
                className="size-3.5 transition-transform group-open:rotate-90"
                aria-hidden
              />
              {t('runtime.inapplicableSummary', { n: inapplicable.length })}
              <span className="text-ink-muted">{t('runtime.inapplicableHint')}</span>
            </summary>
            <div className="space-y-3 border-t border-line p-3">{inapplicable.map(renderPack)}</div>
          </details>
        ) : null}
      </section>

      {/*
        这句原来是**硬编码**的，且里面就带着 `**本机实测值**` / `**估算**` 两处裸标记
        —— 页面上真的显示星号。搬进词条之后照样带标记，靠 <Emphasis> 渲染（T-129b）。
        「实测」与「估算」正是这句话要区分的两件事，删掉标记等于把重点抹平。
      */}
      <Emphasis
        className="block text-[11px] text-ink-muted"
        text={
          t('runtime.rtfNote') +
          (hw?.disks[0]
            ? ' ' +
              t('runtime.installTarget', {
                free: formatBytes(hw.disks[0].freeMB * 1e6, locale),
              })
            : '')
        }
      />
    </div>
  );
}
