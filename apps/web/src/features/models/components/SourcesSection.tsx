import { useTranslation } from 'react-i18next';
import { Gauge } from 'lucide-react';
import type { ProviderId, SourceProbe } from '@openmemo/shared';

import { Button } from '../../../components/common/Button';
import { Emphasis } from '../../../components/common/Emphasis';
import { ErrorBlock } from '../../../components/common/ErrorBlock';
import { StatusChip } from '../../../components/common/StatusChip';
import { useModelsSourcesQuery, useSelectSourceMutation, useSourceProbeMutation } from '../api';

/**
 * 下载源（镜像）。
 *
 * ── 修之前：daemon 三个端点全是真的，界面上一个入口都没有 ─────────────────────────
 *
 * `GET /api/models/sources` / `POST …/probe` / `POST …/select` 都在，
 * 而 `useModelsSourcesQuery` 与 `useSourceProbeMutation` **零调用方**，
 * **连一个 select 的 hook 都不存在**。
 *
 * 后果不是"少一个高级设置"：HuggingFace 连不上时用户看到的是「所有下载源均失败」，
 * **而他没有任何自救入口** —— 既看不到自动回退到底选了谁，也没法钉一个能通的源。
 * `[实测]` 这台机器连不上 HuggingFace、自动回落到了 ModelScope；
 * **回退是有效的，只是用户看不到也选不了。**
 *
 * ── 三条刻意的诚实 ─────────────────────────────────────────────────────────────
 *
 * 1. **"优先"不是"只用"。** `orderSourcesForDownload` 把钉住的源排到最前，其余仍作回退
 *    （`probe.ts` 写明理由：探测是 5 秒快照，探不通的源真实传输里未必不通，
 *    全丢掉会让用户一个源都不剩）。说明文字照这个说 ——
 *    让用户以为自己"关掉"了别的源，是又一句界面说了算不算数的话。
 * 2. **没测过就说没测过。** `effective` 为 null 时**不显示任何"当前源"**，
 *    也不写"自动"充数 —— "不知道"和"就是它"是两件事，混在一起就是又一个假绿灯
 *    （`components.ts` 文件头为 `latestVersion` 立过同一条）。
 * 3. **可选项来自 daemon 的 `available`**（= 目录里真实出现过的 provider），
 *    不在前端写死一张表；也**不提供"自定义源"** —— `sourceBaseUrl` 存得下来，
 *    但 `[实测 grep]` 全仓没有任何下载路径读它，做出来就是个填了必然无效的输入框。
 */
export function SourcesSection({ locale }: { locale: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useModelsSourcesQuery();
  const probe = useSourceProbeMutation();
  const select = useSelectSourceMutation();

  const data = q.data;
  if (q.isError) {
    return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  }
  if (!data) return null;

  const probeById = new Map<ProviderId, SourceProbe>(data.probes.map((p) => [p.id, p]));
  /*
   * 已经钉住的那个源哪怕不在 `available` 里也要列出来 —— 否则用户在目录变化之后
   * 会看到一个"我明明选过、现在却没有这一项"的界面，而他的选择仍然生效着。
   */
  const options: (ProviderId | 'auto')[] = [
    'auto',
    ...new Set<ProviderId>([
      ...data.available,
      ...(data.selected === 'auto' ? [] : [data.selected]),
    ]),
  ];

  const label = (id: ProviderId | 'auto'): string =>
    id === 'auto' ? t('models.sources.auto') : t(`models.sources.provider.${id}`, { defaultValue: id });

  return (
    <section
      className="rounded-lg border border-line bg-surface-1 p-4"
      data-testid="models-sources"
      aria-label={t('models.sources.title')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-ink">{t('models.sources.title')}</h2>
        {/*
          ★ 这一行是这块 UI 存在的主要理由：让"自动回退到底选了谁"可见。
          没探测过就明说没探测过，不拿"自动"当答案。
        */}
        <span className="text-xs text-ink-secondary" data-testid="models-sources-effective">
          {data.effective
            ? t('models.sources.effective', { provider: label(data.effective) })
            : t('models.sources.effectiveUnknown')}
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={probe.isPending}
          onClick={() => void probe.mutateAsync()}
          data-testid="models-sources-probe"
        >
          <Gauge className={probe.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
          {probe.isPending ? t('models.sources.probing') : t('models.sources.probe')}
        </Button>
      </div>

      {/* 「优先」这个词必须跳出来 —— 这一句要防的正是"以为自己关掉了别的源" */}
      <p className="mt-1 text-xs text-ink-secondary">
        <Emphasis text={t('models.sources.hint')} />
      </p>

      <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label={t('models.sources.title')}>
        {options.map((id) => {
          const p = id === 'auto' ? undefined : probeById.get(id);
          const active = data.selected === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={select.isPending}
              onClick={() => void select.mutateAsync({ provider: id })}
              data-testid={`models-source-${id}`}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                active ? 'border-accent bg-accent text-accent-fg' : 'border-line text-ink-secondary'
              }`}
            >
              {label(id)}
              {p ? (
                <span className={active ? 'opacity-80' : 'text-ink-muted'}>
                  {p.ok
                    ? t('models.sources.speed', {
                        kbps: (p.throughputKbps ?? 0).toLocaleString(locale),
                      })
                    : t('models.sources.unreachable')}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {select.isError ? <ErrorBlock error={select.error} className="mt-3" /> : null}
      {probe.isError ? <ErrorBlock error={probe.error} className="mt-3" /> : null}

      {data.probes.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs" data-testid="models-sources-probes">
          {data.probes.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span className="w-28 shrink-0 text-ink-secondary">{label(p.id)}</span>
              <StatusChip
                tone={p.ok ? 'good' : 'critical'}
                label={p.ok ? t('models.sources.ok') : t('models.sources.unreachable')}
              />
              {p.ok ? (
                <>
                  <span className="text-ink">
                    {t('models.sources.speed', {
                      kbps: (p.throughputKbps ?? 0).toLocaleString(locale),
                    })}
                  </span>
                  <span className="text-ink-secondary">
                    {t('models.sources.ttfb', { ms: p.ttfbMs ?? 0 })}
                  </span>
                </>
              ) : (
                /*
                 * 失败原因**原样显示**。翻成一句"连接失败"会把仅有的线索换成一句废话
                 * —— 与 `queue.ts` 对 `INTERNAL` 保留 detail 是同一条。
                 */
                <span className="text-ink-secondary">{p.error ?? t('models.sources.unknownError')}</span>
              )}
              <span className="ml-auto text-ink-muted">
                {new Date(p.probedAt).toLocaleTimeString(locale)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
