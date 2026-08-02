import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ExternalLink, Gauge, ShieldCheck } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { StatusChip } from '../../components/common/StatusChip';
import { FitBadge, FitEta } from '../../components/common/FitBadge';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { formatBytes } from '../../lib/format/bytes';
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
  const { i18n } = useTranslation();
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
  if (catalog.isLoading) return <p className="p-4 text-xs text-ink-muted">加载中…</p>;
  if (!found) {
    return (
      <div className="p-4">
        <Link to="/models" className="text-xs text-accent hover:underline">
          ← 返回模型管理
        </Link>
        <p className="mt-3 text-sm text-ink">目录里没有这个模型（{modelId}）。</p>
      </div>
    );
  }

  const { group, variant } = found;
  // 本机实测值。null = 还没跑过基准。
  const bench = installedRec?.benchmark ?? variant.benchmark;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4" data-testid="model-detail-page">
      <Link to="/models" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden />
        返回模型管理
      </Link>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-ink">{group.displayNameZh}</h1>
          <StatusChip tone="neutral" label={variant.quantization.toUpperCase()} />
          {installedRec ? <StatusChip tone="good" label="已安装" /> : null}
        </div>
        <p className="mt-1 text-sm text-ink-secondary">{group.descriptionZh}</p>
      </header>

      <section className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-surface-1 p-4 text-xs sm:grid-cols-3">
        <Field label="架构" value={`${variant.arch} (${variant.format})`} />
        <Field label="量化" value={variant.quantization.toUpperCase()} />
        <Field label="体积" value={formatBytes(variant.totalSizeBytes, locale)} />
        <Field label="语言" value={variant.languages.join(' / ')} />
        <Field label="许可" value={variant.license.id} />
        <Field label="目录版本" value={variant.catalogVersion} />
      </section>

      {/* 文件与摘要 —— sha256 是唯一判重依据，展示出来便于排障 */}
      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-medium text-ink">文件</h2>
        <ul className="mt-2 space-y-2">
          {variant.files.map((f) => (
            <li key={f.sha256} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ink">
                  {f.name}
                  {f.optional ? <span className="ml-1 text-ink-muted">（可选）</span> : null}
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
        <h2 className="text-sm font-medium text-ink">这台机器</h2>
        <div className="mt-2 space-y-1">
          <FitBadge fitness={variant.fitness} showReason />
          <FitEta fitness={variant.fitness} />
          <p className="text-xs text-ink-muted">
            需内存 {formatBytes(variant.requirements.ramRequiredMB * 1e6, locale)} · 需显存{' '}
            {formatBytes(variant.requirements.vramRequiredMB * 1e6, locale)}
            {variant.requirements.computedAtContext
              ? `（按 ${variant.requirements.computedAtContext} 上下文，含 KV 缓存）`
              : ''}
          </p>
          {variant.gguf ? (
            <p className="text-xs text-ink-muted">
              KV 缓存 {(variant.gguf.kvBytesPerToken / 1024).toFixed(0)} KiB/token ·{' '}
              {variant.gguf.blockCount} 层 · 最大上下文 {variant.gguf.contextLength}
            </p>
          ) : null}
        </div>
      </section>

      {/* ★ 准确率 / 速度：ADR-004 决策 3 */}
      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-medium text-ink">准确率与速度</h2>
        {bench ? (
          <div className="mt-2 space-y-1 text-xs">
            <p className="text-ink">
              实测 RTF {bench.rtf.toFixed(2)} —— 1 小时音频约需{' '}
              {Math.round(bench.rtf * 60)} 分钟
            </p>
            <p className="text-ink-muted">
              于 {new Date(bench.measuredAt).toLocaleString(locale)} 在本机 {bench.deviceName}（
              {bench.backend}）上用 {bench.sampleDurationSec} 秒测试音频实测
            </p>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-ink-secondary">
              尚未测量。我们**不显示论文里的准确率数字** —— 那些数字在你的机器、你的音频上不成立。
              点下面的按钮，用内嵌测试音频在本机实测。
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={!installedRec || benchmark.isPending}
              onClick={() => void benchmark.mutateAsync(variant.id)}
              data-testid="model-benchmark-button"
            >
              <Gauge className="size-3.5" aria-hidden />
              {benchmark.isPending ? '正在跑基准…' : '跑基准'}
            </Button>
            {!installedRec ? (
              <p className="text-xs text-ink-muted">需要先安装这个模型才能跑基准。</p>
            ) : null}
          </div>
        )}
      </section>

      <section className="flex flex-wrap items-center gap-2">
        {installedRec ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void verify.mutateAsync(variant.id)}
            disabled={verify.isPending}
          >
            <ShieldCheck className="size-3.5" aria-hidden />
            {verify.isPending ? '校验中…' : '校验完整性'}
          </Button>
        ) : null}
        <a
          href={variant.license.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          查看上游与许可证
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
