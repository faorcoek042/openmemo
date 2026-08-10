import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ExternalLink, Gauge, ShieldCheck } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { Emphasis } from '../../components/common/Emphasis';
import { StatusChip } from '../../components/common/StatusChip';
import { FitBadge, FitEta } from '../../components/common/FitBadge';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { formatBytes } from '../../lib/format/bytes';
import { localizedDescription, localizedName } from '../../lib/format/localized';
import {
  useModelBenchmarkMutation,
  useModelVerifyMutation,
  useModelsCatalogQuery,
  useModelsInstalledQuery,
} from './api';

/**
 * 模型详情页（R-04 §9.4 线框）。
 *
 * ★ "准确率"一栏按 ADR-004 决策 3：**初始为空，只有用户在本机跑过基准才有数字。**
 * 这条标准最初就是从这个字段提出来的 —— memo.ac 的注册表里硬编码了
 * `speed: 6, quality: 2` 这类 1–6 的整数，没有任何出处。我们宁可显示"未测量"。
 */
export default function ModelDetailPage() {
  const { modelId = '' } = useParams();
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const catalog = useModelsCatalogQuery('all');
  const installed = useModelsInstalledQuery();
  const benchmark = useModelBenchmarkMutation();
  const verify = useModelVerifyMutation();

  const found = useMemo(() => {
    for (const g of catalog.data?.groups ?? []) {
      const v = g.variants.find((x) => x.id === modelId);
      if (v) return { group: g, variant: v };
    }
    return null;
  }, [catalog.data, modelId]);

  const installedRec = installed.data?.models.find((m) => m.id === modelId) ?? null;

  if (catalog.isError) {
    return (
      <div className="p-4">
        <ErrorBlock error={catalog.error} onRetry={() => void catalog.refetch()} />
      </div>
    );
  }
  if (catalog.isLoading)
    return <p className="p-4 text-xs text-ink-muted">{t('models.detail.loading')}</p>;
  if (!found) {
    return (
      <div className="p-4">
        <Link to="/models" className="text-xs text-accent-ink hover:underline">
          ← {t('models.detail.back')}
        </Link>
        <p className="mt-3 text-sm text-ink">{t('models.detail.notFound', { id: modelId })}</p>
      </div>
    );
  }

  const { group, variant } = found;
  // 本机实测值。null = 还没跑过基准。
  const bench = installedRec?.benchmark ?? variant.benchmark;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4" data-testid="model-detail-page">
      <Link
        to="/models"
        className="inline-flex items-center gap-1 text-xs text-accent-ink hover:underline"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('models.detail.back')}
      </Link>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-ink">{localizedName(locale, group)}</h1>
          <StatusChip tone="neutral" label={variant.quantization.toUpperCase()} />
          {installedRec ? <StatusChip tone="good" label={t('models.detail.installed')} /> : null}
        </div>
        <p className="mt-1 text-sm text-ink-secondary">{localizedDescription(locale, group)}</p>
      </header>

      <section className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-surface-1 p-4 text-xs sm:grid-cols-3">
        <Field label={t('models.detail.fieldArch')} value={`${variant.arch} (${variant.format})`} />
        <Field label={t('models.detail.fieldQuant')} value={variant.quantization.toUpperCase()} />
        <Field
          label={t('models.detail.fieldSize')}
          value={formatBytes(variant.totalSizeBytes, locale)}
        />
        <Field label={t('models.detail.fieldLanguages')} value={variant.languages.join(' / ')} />
        <Field label={t('models.detail.fieldLicense')} value={variant.license.id} />
        <Field label={t('models.detail.fieldCatalogVersion')} value={variant.catalogVersion} />
      </section>

      {/* 文件与摘要 —— sha256 是唯一判重依据，展示出来便于排障 */}
      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-medium text-ink">{t('models.detail.files')}</h2>
        <ul className="mt-2 space-y-2">
          {variant.files.map((f) => (
            <li key={f.sha256} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ink">
                  {f.name}
                  {f.optional ? (
                    <span className="ml-1 text-ink-muted">{t('models.detail.fileOptional')}</span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums text-ink-secondary">
                  {formatBytes(f.sizeBytes, locale)}
                </span>
              </div>
              <code className="mt-0.5 block truncate font-mono text-[11px] text-ink-muted">
                sha256:{f.sha256}
              </code>
            </li>
          ))}
        </ul>
      </section>

      {/* 这台机器 */}
      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-medium text-ink">{t('models.detail.thisMachine')}</h2>
        <div className="mt-2 space-y-1">
          <FitBadge fitness={variant.fitness} showReason />
          <FitEta fitness={variant.fitness} />
          <p className="text-xs text-ink-muted">
            {t('models.detail.requirements', {
              ram: formatBytes(variant.requirements.ramRequiredMB * 1e6, locale),
              vram: formatBytes(variant.requirements.vramRequiredMB * 1e6, locale),
              ctx: variant.requirements.computedAtContext
                ? t('models.detail.requirementsContext', {
                    ctx: String(variant.requirements.computedAtContext),
                  })
                : '',
            })}
          </p>
          {variant.gguf ? (
            <p className="text-xs text-ink-muted">
              {t('models.detail.ggufLine', {
                kv: (variant.gguf.kvBytesPerToken / 1024).toFixed(0),
                layers: variant.gguf.blockCount,
                maxCtx: variant.gguf.contextLength,
              })}
            </p>
          ) : null}
        </div>
      </section>

      {/*
        ★ 诊断数字：契约（`shared/fitness.ts:77`）原话
        `Diagnostic numbers, surfaced in the detail panel so users can sanity-check us.`
        —— **"so users can sanity-check us"**：它存在的理由就是让用户能核对我们的结论，
        而它在这一段写出来之前**一次都没有渲染过**（当时 needMB/vramBudgetMB/
        ramBudgetMB/diskFreeMB/diskNeededMB 在 apps/web 全域各 0 次）。
        ⚠️ **那句"各 0 次"如今已经不成立了 —— 消费方就是下面这个 `dl`。**
        （T-201 A-5 复核时撞上：有人照这句注释判断"这些字段零消费、可以随便改契约"。
        注释描述的是写它那一刻的事实，不是不变量。）

        一个只说"跑不动"却不肯说"我按什么算的"的判断，用户既无法反驳也无法信任。
        这一块就是那个"detail panel"。
      */}
      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-medium text-ink">{t('models.detail.diagTitle')}</h2>
        <dl
          className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs"
          data-testid="model-fit-detail"
        >
          {(
            [
              ['needMB', variant.fitness.detail.needMB],
              ['vramBudgetMB', variant.fitness.detail.vramBudgetMB],
              ['ramBudgetMB', variant.fitness.detail.ramBudgetMB],
              ['diskNeededMB', variant.fitness.detail.diskNeededMB],
              ['diskFreeMB', variant.fitness.detail.diskFreeMB],
            ] as const
          ).map(([key, mb]) => (
            <div key={key} className="contents">
              <dt className="text-ink-secondary">{t(`models.detail.diag.${key}`)}</dt>
              {/*
                `null` = 没测到（`diskFreeMB` 会有这一档）。**不许渲染成 0 B** ——
                这一整块存在的意义就是让用户核对我们的算法，
                给他一个假的 0 比不给更糟。
              */}
              <dd className="tabular-nums text-ink">
                {mb == null ? t('models.fit.unknownDisk') : formatBytes(mb * 1e6, locale)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-[11px] text-ink-muted">{t('models.detail.diagNote')}</p>
      </section>

      {/* ★ 准确率 / 速度：ADR-004 决策 3 */}
      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-medium text-ink">{t('models.detail.accuracyTitle')}</h2>
        {bench ? (
          <div className="mt-2 space-y-1 text-xs">
            <p className="text-ink">
              {t('models.detail.benchResult', {
                rtf: bench.rtf.toFixed(2),
                minutes: Math.round(bench.rtf * 60),
              })}
            </p>
            <p className="text-ink-muted">
              {t('models.detail.benchProvenance', {
                at: new Date(bench.measuredAt).toLocaleString(locale),
                device: bench.deviceName,
                backend: bench.backend,
                seconds: bench.sampleDurationSec,
              })}
            </p>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {/* 这句同样带 `**…**` —— 走 `<Emphasis>`，别把裸标记吐给用户 */}
            <Emphasis
              className="block text-xs text-ink-secondary"
              text={t('models.detail.benchNone')}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!installedRec || benchmark.isPending}
              /*
               * ★ `mutate` 而不是 `void mutateAsync` —— 这不是风格问题。
               *
               * `void mutateAsync(...)` 把 promise 的 rejection **丢掉**：服务端此刻回的是
               * 501（基准测试要在本机真跑推理，ADR-004 决策 3 禁止编造数字，所以宁可不实现），
               * 而用户点下去**什么都不会发生** —— 按钮看起来是坏的。
               * `[用户实测 2026-08-08]` 这正是他报的三条之一「点测速完全没反应」。
               *
               * 判据（Manager 2026-08-08）：**不许静默失败。** 要么发生该发生的事，
               * 要么让他看到一句能读懂的话。501 是当前的正确状态，那就如实说出来。
               */
              onClick={() => benchmark.mutate(variant.id)}
              data-testid="model-benchmark-button"
            >
              <Gauge className="size-3.5" aria-hidden />
              {benchmark.isPending ? t('models.detail.benchRunning') : t('models.detail.benchRun')}
            </Button>
            {!installedRec ? (
              <p className="text-xs text-ink-muted">{t('models.detail.benchNeedsInstall')}</p>
            ) : null}
            {/*
              失败必须渲染出来。文案按 `code` 查 `errors.<CODE>`（i18n/index.ts:13 的既定规矩），
              服务端的 message 只作未知 code 的兜底 —— 501 的 code 是 `NOT_IMPLEMENTED`。
            */}
            {benchmark.isError ? <ErrorBlock error={benchmark.error} /> : null}
          </div>
        )}
      </section>

      {/*
        ★ 校验失败的渲染点**搬到这里**（原来在上面 `bench ? … : …` 的 **else 分支**里）。
        而「校验」按钮在下面这个**无条件** section 里 ⇒
        **已经跑过基准的模型（`bench` 为真），校验失败零表达**。
        这是"渲染点在，但在某些状态下够不着"——比完全没有渲染点更难发现：
        读代码看得到 `verify.isError`，只有走到那个状态才知道它不在同一棵子树上。
        判据：**错误的渲染点必须和触发它的控件在同一个条件分支下。**
      */}
      {verify.isError ? <ErrorBlock error={verify.error} className="mb-2" /> : null}

      <section className="flex flex-wrap items-center gap-2">
        {installedRec ? (
          <Button
            size="sm"
            variant="secondary"
            /*
             * `mutate` 而不是 `void mutateAsync` —— 与上面 benchmark 那段同一条理由：
             * `void` 把 rejection 丢掉，变成 unhandled rejection。
             */
            onClick={() => verify.mutate(variant.id)}
            disabled={verify.isPending}
          >
            <ShieldCheck className="size-3.5" aria-hidden />
            {verify.isPending ? t('models.detail.verifying') : t('models.detail.verify')}
          </Button>
        ) : null}
        <a
          href={variant.license.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-accent-ink hover:underline"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t('models.detail.upstream')}
        </a>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-ink">{value}</dd>
    </div>
  );
}
