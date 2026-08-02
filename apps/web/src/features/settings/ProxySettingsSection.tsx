import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Gauge, Loader2, Network, Plug } from 'lucide-react';

import {
  DEFAULT_PROXY_CONFIG,
  PROXY_MODES,
  redactProxyUrl,
  type ProxyConfig,
  type ProxyMode,
  type ProxyTestReport,
  type SourceLatencyReport,
} from '@openmemo/shared';

import { api, ApiError } from '../../lib/api/client';
import { arr } from '../../lib/safe';
import { Button } from '../../components/common/Button';
import { Banner } from '../../components/common/Banner';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { StatusChip } from '../../components/common/StatusChip';

/**
 * 代理配置（用户点名的缺口 5）。
 *
 * ## 为什么这是刚需而不是高级选项
 *
 * 目标用户在中国大陆网络下，**Hugging Face 与 GitHub 直连不通**。
 * 没有代理配置，"下载模型"这件事整个产品的第一步就走不了 ——
 * 而失败现象是最令人困惑的一种：浏览器能上网，应用说"下载失败"，
 * 屏幕上没有任何东西把两者联系起来。
 *
 * ## 两个按钮，不是一个
 *
 * 「测试代理」打**中立主机**回答"我的代理到底通不通"；
 * 「测试下载源」出**各源延迟表**回答"我该从哪个镜像拉"。
 * 这是两个不同的问题，指向两种不同的修法：
 * 合成一个按钮会把两个答案压成一个红/绿判定，而**慢但可用**的镜像在延迟表里是有用信息、
 * 在红绿灯里却只能算"失败"。比较关系一旦丢了就找不回来。
 * （`packages/shared/src/proxy.ts` 的 `SourceLatency` 注释里写的就是这条，UI 照做。）
 */

const ENDPOINT = '/settings/proxy';

export function ProxySettingsSection() {
  const { t } = useTranslation();

  const q = useQuery({
    queryKey: ['settings', 'proxy'] as const,
    queryFn: () => api<ProxyConfig>('settings', ENDPOINT),
    retry: false,
  });

  /**
   * ⚠️ `GET/PUT /api/settings/proxy` **目前不存在**（`oss-scout` 在做）。
   *
   * 我没有把整个区块藏起来或灰掉：读操作 404 时回落到 `DEFAULT_PROXY_CONFIG`
   * 让用户至少能看见形态；写操作**永不静默回落 mock**（`client.ts` 的规则），
   * 404 会如实抛出来，所以"保存了其实没保存"不可能发生。
   * 端点上线后这里一行都不用改。
   */
  const notImplemented = q.error instanceof ApiError && q.error.status === 404;
  const [cfg, setCfg] = useState<ProxyConfig>(DEFAULT_PROXY_CONFIG);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (q.data) {
      setCfg(q.data);
      setDirty(false);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: (next: ProxyConfig) => api<ProxyConfig>('settings', ENDPOINT, { method: 'PUT', body: next }),
    onSuccess: () => setDirty(false),
  });

  // ★ 两个**独立**动作，各自独立的 loading / 结果，互不覆盖
  const testProxy = useMutation({
    mutationFn: () => api<ProxyTestReport>('settings', `${ENDPOINT}/test`, { method: 'POST', body: cfg }),
  });
  const testSources = useMutation({
    mutationFn: () => api<SourceLatencyReport>('settings', `${ENDPOINT}/sources`, { method: 'POST', body: cfg }),
  });

  const patch = (p: Partial<ProxyConfig>) => {
    setCfg((c) => ({ ...c, ...p }));
    setDirty(true);
  };

  const manual = cfg.mode === 'manual';
  // ffmpeg 不支持 SOCKS：只有手动模式填了 socks5 才确定会走这条降级
  const socksInUse = manual && Boolean(cfg.socks5);

  return (
    <section className="rounded-lg border border-line bg-surface-1 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-ink">
        <Network className="size-4" aria-hidden />
        {t('settings.proxy.title')}
      </h2>

      {notImplemented ? (
        <Banner tone="warning" title={t('settings.proxy.unsupported')} detail={t('settings.proxy.unsupportedDetail')} />
      ) : null}

      {/* ── 模式：默认跟随系统 ── */}
      <fieldset className="mb-4">
        <legend className="sr-only">{t('settings.proxy.mode')}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {PROXY_MODES.map((m: ProxyMode) => (
            <label key={m} className="flex items-center gap-1.5 text-ink-secondary">
              <input
                type="radio"
                name="proxy-mode"
                value={m}
                checked={cfg.mode === m}
                onChange={() => patch({ mode: m })}
                data-testid={`proxy-mode-${m}`}
                className="size-3.5 accent-[var(--accent)]"
              />
              {t(`settings.proxy.modes.${m}`)}
            </label>
          ))}
        </div>
        {/* 默认是 system 而不是 off —— 理由写在 shared 的 DEFAULT_PROXY_CONFIG 上，这里复述给用户 */}
        <p className="mt-1.5 text-xs text-ink-muted">{t(`settings.proxy.modeHint.${cfg.mode}`)}</p>
      </fieldset>

      {/* ── 手动配置 ── */}
      {manual ? (
        <div className="mb-4 space-y-2">
          {(['httpProxy', 'httpsProxy', 'socks5'] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1 text-xs text-ink-secondary sm:flex-row sm:items-center">
              <span className="w-28 shrink-0">{t(`settings.proxy.fields.${k}`)}</span>
              <input
                value={cfg[k] ?? ''}
                onChange={(e) => patch({ [k]: e.target.value.trim() || null } as Partial<ProxyConfig>)}
                placeholder={k === 'socks5' ? 'socks5://127.0.0.1:1080' : 'http://127.0.0.1:7890'}
                spellCheck={false}
                autoComplete="off"
                data-testid={`proxy-${k}`}
                className="h-8 flex-1 rounded-md border border-line bg-surface-0 px-2 font-mono text-xs text-ink"
              />
            </label>
          ))}
          {/* 认证写在 URL 里（user:pass@host） —— 与 curl / 各客户端一致，不另造一套字段 */}
          <p className="text-xs text-ink-muted">{t('settings.proxy.authHint')}</p>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary sm:flex-row sm:items-start">
            <span className="w-28 shrink-0 sm:pt-1.5">{t('settings.proxy.fields.noProxy')}</span>
            <textarea
              value={cfg.noProxy.join(', ')}
              onChange={(e) =>
                patch({ noProxy: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
              }
              rows={2}
              placeholder="localhost, .cn, 192.168.1.5"
              spellCheck={false}
              data-testid="proxy-no-proxy"
              className="flex-1 rounded-md border border-line bg-surface-0 px-2 py-1 font-mono text-xs text-ink"
            />
          </label>
          <p className="text-xs text-ink-muted">{t('settings.proxy.loopbackAlwaysBypassed')}</p>
        </div>
      ) : null}

      {/*
        ★ SOCKS 的真实边界必须说出来。

        `ffmpegProxySupport()` 对 socks5 返回 `supported:false` 且**刻意返回空 env**
        （libavformat 只认 `http_proxy`，塞了它也会忽略）。
        yt-dlp 则通过 `--proxy` 明确支持 SOCKS。
        也就是说选 SOCKS 时：**解析/下载走代理，媒体拉流这条链路直连**。
        不写出来，用户会以为全走代理了 —— 那是个隐私预期问题，不只是功能问题。
      */}
      {socksInUse ? (
        <Banner
          tone="warning"
          title={t('settings.proxy.socksFfmpegTitle')}
          detail={t('settings.proxy.socksFfmpegDetail')}
        />
      ) : null}

      {/* ── 两个独立按钮 ── */}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || save.isPending}
          data-testid="proxy-save"
          onClick={() => save.mutate(cfg)}
        >
          {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t('settings.proxy.save')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={testProxy.isPending}
          data-testid="proxy-test"
          onClick={() => testProxy.mutate()}
        >
          {testProxy.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
          {t('settings.proxy.testProxy')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={testSources.isPending}
          data-testid="proxy-test-sources"
          onClick={() => testSources.mutate()}
        >
          {testSources.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Gauge className="size-3.5" />}
          {t('settings.proxy.testSources')}
        </Button>
      </div>

      {save.isError ? <ErrorBlock error={save.error} /> : null}

      {/* ── 代理连通性结果 ── */}
      {testProxy.isError ? <ErrorBlock error={testProxy.error} /> : null}
      {testProxy.data ? (
        <div className="mt-3" data-testid="proxy-test-report">
          {/*
            ★ "代理不通"和"代理通但目标站不可达"是两件事，指向两种完全不同的修法。
            把它们并成一个红叉，正是别的工具里代理设置让人抓狂的原因
            —— `proxyReachable` 这个字段就是为此存在的，别浪费它。
          */}
          <p className="mb-1.5 text-xs">
            {testProxy.data.proxyReachable === false
              ? t('settings.proxy.verdictProxyDown')
              : testProxy.data.ok
                ? t('settings.proxy.verdictAllOk')
                : t('settings.proxy.verdictUpstreamBlocked')}
          </p>
          <ul className="space-y-1">
            {arr(testProxy.data.probes).map((p) => (
              <li key={p.url} className="flex flex-wrap items-center gap-2 text-xs">
                {/* StatusChip 强制要求 label —— 状态绝不只用颜色表达 */}
                <StatusChip
                  tone={p.result === 'ok' ? 'good' : p.result === 'skipped' ? 'neutral' : 'critical'}
                  label={t(`settings.proxy.probe.${p.result}`)}
                />
                <span className="text-ink">{p.target}</span>
                <span className="tabular-nums text-ink-muted">{p.elapsedMs}ms</span>
                {/* 这一条到底走没走代理，必须逐条可见：noProxy 命中时是直连 */}
                <span className="text-ink-muted">
                  {p.viaProxy ? t('settings.proxy.viaProxy') : t('settings.proxy.direct')}
                </span>
                {p.detail ? <span className="text-ink-muted">· {p.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── 下载源延迟表 ── */}
      {testSources.isError ? <ErrorBlock error={testSources.error} /> : null}
      {testSources.data ? (
        <table className="mt-3 w-full text-xs" data-testid="proxy-source-table">
          <thead>
            <tr className="text-left text-ink-muted">
              <th className="font-normal">{t('settings.proxy.source')}</th>
              <th className="font-normal">{t('settings.proxy.latency')}</th>
              <th className="font-normal">{t('settings.proxy.route')}</th>
            </tr>
          </thead>
          <tbody>
            {arr(testSources.data.rows).map((r) => (
              <tr key={r.provider} className={r.provider === testSources.data.fastest ? 'text-accent' : 'text-ink'}>
                <td>
                  {r.label}
                  {r.provider === testSources.data.fastest ? ` · ${t('settings.proxy.fastest')}` : ''}
                </td>
                {/* 不可达就写"不可达"，绝不填一个 0ms 或 "—" 让它看起来像最快的 */}
                <td className="tabular-nums">
                  {r.reachable && r.latencyMs !== null ? `${r.latencyMs}ms` : t('settings.proxy.unreachable')}
                </td>
                <td className="text-ink-muted">
                  {r.viaProxy ? t('settings.proxy.viaProxy') : t('settings.proxy.direct')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {/* 当前生效值（凭据已脱敏）—— 让用户能确认"我填的到底存进去没有" */}
      {manual && (cfg.socks5 || cfg.httpProxy || cfg.httpsProxy) ? (
        <p className="mt-3 font-mono text-xs text-ink-muted" data-testid="proxy-effective">
          {t('settings.proxy.effective')}: {redactProxyUrl(cfg.socks5 ?? cfg.httpsProxy ?? cfg.httpProxy)}
        </p>
      ) : null}
    </section>
  );
}
