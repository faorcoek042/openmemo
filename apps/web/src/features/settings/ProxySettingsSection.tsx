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
import { cn } from '../../lib/utils';
import { Button } from '../../components/common/Button';
import { Emphasis } from '../../components/common/Emphasis';
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

/** `GET`/`PATCH /api/settings/proxy` 的响应外壳。 */
interface ProxyResponse {
  /** 三个 URL 已脱敏（`http://***:***@host`）—— 不可原样写回。 */
  config: ProxyConfig;
  /** 进程里**实际生效**的那一份。与 config 不一致时说明改了还没应用。 */
  active?: { url: string | null; mode?: string } | null;
  /** ffmpeg 的代理能力，由 daemon 判定并给出中文说明 —— 前端不再自己拼这段话。 */
  media?: { supported: boolean; reason: string | null; noteZh: string | null };
  appliedImmediately?: boolean;
}

export function ProxySettingsSection() {
  const { t } = useTranslation();

  /**
   * ⚠️ 响应是**带壳**的 `{config, active, media, modes, defaultModeZh}`，不是裸 `ProxyConfig`。
   *
   * 而且 `config` 里的三个 URL 都经过 `redactProxyUrl()` —— 带凭据的地址回显为
   * `http://***:***@host:port`。**这一点决定了写回策略**：把读到的值原样 PATCH 回去，
   * 等于用 `***` 覆盖掉用户真实的密码。所以下面只发**用户真的改过**的字段。
   */
  const q = useQuery({
    queryKey: ['settings', 'proxy'] as const,
    queryFn: () => api<ProxyResponse>('settings', ENDPOINT),
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
  /*
   * 记录用户**动过**哪些字段。只有这些才会被 PATCH 出去（见上面的脱敏说明）——
   * 也正是这份账本让下面那条 effect 能在后台重取时分清"用户正在编辑的"和"该跟服务端同步的"。
   */
  const [touched, setTouched] = useState<Set<keyof ProxyConfig>>(new Set());
  const dirty = touched.size > 0;

  useEffect(() => {
    if (!q.data?.config) return;
    const fresh: ProxyConfig = { ...DEFAULT_PROXY_CONFIG, ...q.data.config };
    setCfg((prev) => {
      /*
       * ★ S-9：这条 effect 在**任何一次后台重取**后都会跑——包括 SSE 重连触发的
       * `sync.required` 全量 `invalidateQueries()`（无参，见 lib/events/system.sse.ts
       * 与 lib/events/source.ts 的 onopen：任何一次重连都会发一次，不只是真的丢过帧）。
       * 用户可能正在往某个字段里打字，这时候拿服务端快照整体盖过去，会把他刚打的字
       * （甚至覆盖成脱敏后的 `***:***@host`）当场抹掉，且没有任何提示——原样搬过来就是 S-9。
       *
       * `touched` 本来就是"用户动过哪些字段、还没保存"的账本——这里反过来用它做合并：
       * 没保存的字段保留用户的草稿，其余字段跟着服务端最新值走。两边不冲突，没有一条
       * 数据被覆盖，也就不需要另外弹提示"告知覆盖"——因为压根没有覆盖发生。
       */
      if (touched.size === 0) return fresh;
      const merged: ProxyConfig = { ...fresh };
      for (const k of touched) (merged as unknown as Record<string, unknown>)[k] = prev[k];
      return merged;
    });
    // ⚠️ 不在这里 `setTouched(new Set())`——那一步做的正是"抹掉用户正在编辑的字段"的
    // 标记。`touched` 只应该在保存成功时清空（见下面 save 的 onSuccess）。
    //
    // ⚠️ 依赖数组只写 `q.data`，故意不写 `touched`：这条 effect 该在**服务端数据到达**
    // 时跑，不该在**用户每敲一个字**时跑（那会导致每次按键都多渲染一轮，且没有意义——
    // 闭包里的 `touched` 在 `q.data` 真的变化那一刻自然是最新的，组件早已重渲染过）。
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      // ★ 只发改过的字段：没改过的 URL 手里只有脱敏值，发回去会毁掉真实凭据
      const body: Partial<ProxyConfig> = {};
      for (const k of touched) (body as Record<string, unknown>)[k] = cfg[k];
      // mode 总是带上：PATCH 端点用它做校验，且它没有脱敏问题
      body.mode = cfg.mode;
      return api<ProxyResponse>('settings', ENDPOINT, { method: 'PATCH', body });
    },
    onSuccess: () => {
      setTouched(new Set());
      void q.refetch();
    },
  });

  /*
   * ★ 两个**独立**动作，各自独立的 loading / 结果，互不覆盖。
   * 两者都**不发请求体** —— 服务端一律用**已保存**的配置去测。
   * 这不是疏漏，而是必须让用户知道的一件事：**没保存就测，测的是旧配置**。
   * 下面有未保存改动时会明确提示，免得他对着刚改的地址看一份旧结果。
   */
  const testProxy = useMutation({
    mutationFn: () => api<ProxyTestReport>('settings', `${ENDPOINT}/test`, { method: 'POST' }),
  });
  const testSources = useMutation({
    mutationFn: () =>
      api<SourceLatencyReport>('settings', `${ENDPOINT}/sources`, { method: 'POST' }),
  });

  const patch = (p: Partial<ProxyConfig>) => {
    setCfg((c) => ({ ...c, ...p }));
    setTouched((prev) => new Set([...prev, ...(Object.keys(p) as (keyof ProxyConfig)[])]));
  };

  const manual = cfg.mode === 'manual';
  // 由 daemon 判定，不再靠前端猜"填了 socks5 就一定降级"
  const media = q.data?.media;

  /**
   * 这一次代理测试**到底测了几个目标、跳过了几个**（#105 ⑥）。
   *
   * `ProxyTestReport.ok` 的定义是「每一条**非 skipped** 的探针都 ok」——
   * 它对 skipped 那些**一个字都没说**，而总结句原文却是「各目标站均可达」。
   * 这里把两个数分开数出来，好让那句话只覆盖它真的量过的东西。
   */
  const probeCounts = (() => {
    const probes = arr(testProxy.data?.probes);
    const skipped = probes.filter((p) => p.result === 'skipped').length;
    return { tested: probes.length - skipped, skipped };
  })();

  /**
   * 下载源延迟表里**有几个不可达、分别是谁**（#105 ⑥）。
   *
   * 这张表此前**一句摘要都没有**，于是整屏上唯一的总结就是上面那句代理结论 ——
   * 而它测的是另一组中立目标。闸门读到的正是这个组合：
   * 「代理可用，且各目标站均可达。」＋ 下面 Hugging Face 不可达 / hf-mirror 不可达。
   * 判据：**总结句不许比表格乐观。有不可达的就说出来。**
   */
  const sourceStats = (() => {
    const rows = arr(testSources.data?.rows);
    const down = rows.filter((r) => !r.reachable);
    return { total: rows.length, down };
  })();

  return (
    <section className="rounded-lg border border-line bg-surface-1 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-ink">
        <Network className="size-4" aria-hidden />
        {t('settings.proxy.title')}
      </h2>

      {notImplemented ? (
        <Banner
          tone="warning"
          title={t('settings.proxy.unsupported')}
          detail={t('settings.proxy.unsupportedDetail')}
        />
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
            <label
              key={k}
              className="flex flex-col gap-1 text-xs text-ink-secondary sm:flex-row sm:items-center"
            >
              <span className="w-28 shrink-0">{t(`settings.proxy.fields.${k}`)}</span>
              <input
                value={cfg[k] ?? ''}
                onChange={(e) =>
                  patch({ [k]: e.target.value.trim() || null } as Partial<ProxyConfig>)
                }
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
                patch({
                  noProxy: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
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
      {media && media.supported === false ? (
        <Banner
          tone="warning"
          title={t('settings.proxy.socksFfmpegTitle')}
          /*
           * ★ 直接渲染 daemon 给的 `media.noteZh`，不再用我自己写的那段。
           * 判定来自 `ffmpegProxySupport()`（实测 libavformat 只认 http_proxy），
           * 前端复刻一份措辞只会在两边不一致时误导用户 ——
           * 能力边界由**做判定的那一方**来描述。
           */
          detail={media.noteZh ?? media.reason ?? t('settings.proxy.socksFfmpegDetail')}
        />
      ) : null}

      {/* ── 两个独立按钮 ── */}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || save.isPending}
          data-testid="proxy-save"
          onClick={() => save.mutate()}
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
          {testProxy.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plug className="size-3.5" />
          )}
          {t('settings.proxy.testProxy')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={testSources.isPending}
          data-testid="proxy-test-sources"
          onClick={() => testSources.mutate()}
        >
          {testSources.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Gauge className="size-3.5" />
          )}
          {t('settings.proxy.testSources')}
        </Button>
      </div>

      {save.isError ? <ErrorBlock error={save.error} /> : null}

      {/* 测试用的是**已保存**的配置。有未保存改动时必须说，否则用户会对着新地址读旧结果 */}
      {dirty ? (
        <p className="mt-2 text-xs text-warning" data-testid="proxy-unsaved">
          {/* 带 `**已保存**` —— 这个词恰恰是这句话的全部重点，不能删星号了事（T-129b） */}
          <Emphasis text={t('settings.proxy.testUsesSaved')} />
        </p>
      ) : null}

      {/* ── 代理连通性结果 ── */}
      {testProxy.isError ? <ErrorBlock error={testProxy.error} /> : null}
      {testProxy.data ? (
        <div className="mt-3" data-testid="proxy-test-report">
          {/*
            ★ "代理不通"和"代理通但目标站不可达"是两件事，指向两种完全不同的修法。
            把它们并成一个红叉，正是别的工具里代理设置让人抓狂的原因
            —— `proxyReachable` 这个字段就是为此存在的，别浪费它。
          */}
          <p className="mb-1.5 text-xs" data-testid="proxy-verdict">
            <Emphasis
              text={
                testProxy.data.proxyReachable === false
                  ? t('settings.proxy.verdictProxyDown')
                  : testProxy.data.ok
                    ? /*
                       * ★★ #105 ⑥：**这句总结原来盖过了它根本没测的东西。**
                       *
                       * 原文是「代理可用，且**各目标站均可达**。」而 `ProxyTestReport.ok`
                       * 的契约注释逐字写着：
                       *   > True only if every **non-skipped** probe returned `ok`.
                       * 也就是说**被 noProxy 跳过的那些探针，它一个都没算** ——
                       * "没测过"被这句话说成了"可达"，而这两件事正是本轮整批在分开的那一对。
                       *
                       * 闸门实测到的还有第二层：紧跟在它下面的**下载源延迟表**里
                       * Hugging Face / hf-mirror 都写着「不可达」—— 那张表测的是**另一组目标**，
                       * 这句话对它一个字的依据都没有，却是整屏上唯一的总结。
                       *
                       * 所以两处一起改：
                       *   · 这里**把范围说出来**（"这次探的 N 个目标"，并点明不覆盖那张表）；
                       *   · 有 skipped 时换一句**分开报数**的话；
                       *   · 那张表自己长出一句摘要（下面的 `proxy-source-summary`）。
                       *
                       * 判据：**总结句不许比它下面的表格乐观。**
                       */
                      probeCounts.skipped > 0
                      ? t('settings.proxy.verdictOkSomeSkipped', {
                          tested: probeCounts.tested,
                          skipped: probeCounts.skipped,
                        })
                      : t('settings.proxy.verdictAllOk', { n: probeCounts.tested })
                    : /*
                       * 至少一条探针落在了 'unclassified' —— classify() 也说不清是代理还是
                       * 目标站的问题。这时绝不能落到 verdictUpstreamBlocked，那句话的原文
                       * 就是「问题不在你的代理」，对一个诚实的"不知道"来说这是在瞎猜。
                       */
                      arr(testProxy.data.probes).some((p) => p.result === 'unclassified')
                      ? t('settings.proxy.verdictUnclassified')
                      : t('settings.proxy.verdictUpstreamBlocked')
              }
            />
          </p>
          <ul className="space-y-1">
            {arr(testProxy.data.probes).map((p) => (
              <li key={p.url} className="flex flex-wrap items-center gap-2 text-xs">
                {/* StatusChip 强制要求 label —— 状态绝不只用颜色表达 */}
                <StatusChip
                  tone={
                    p.result === 'ok'
                      ? 'good'
                      : p.result === 'skipped' || p.result === 'unclassified'
                        ? 'neutral'
                        : 'critical'
                  }
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
      {/*
        ★★ #105 ⑥：**这张表自己的一句摘要。**
        它此前没有摘要，于是"整屏唯一的总结"落到了上面那句代理结论上 ——
        而那一句测的是另一组目标。有不可达的就把是谁说出来（`{{list}}` 用的是
        `r.label`，也就是用户在表里逐字看到的那几个字，不是 provider id）。
        全通时也说一句：**沉默会让"没测"和"都通了"再次长得一样。**
      */}
      {testSources.data ? (
        <p
          className={cn(
            'mt-3 text-xs',
            sourceStats.down.length > 0 ? 'text-warning' : 'text-ink-secondary',
          )}
          data-testid="proxy-source-summary"
        >
          <Emphasis
            text={
              sourceStats.down.length > 0
                ? t('settings.proxy.sourcesSomeUnreachable', {
                    n: sourceStats.down.length,
                    list: sourceStats.down.map((r) => r.label).join('、'),
                  })
                : t('settings.proxy.sourcesAllReachable', { n: sourceStats.total })
            }
          />
        </p>
      ) : null}
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
              <tr
                key={r.provider}
                className={r.provider === testSources.data.fastest ? 'text-accent-ink' : 'text-ink'}
              >
                <td>
                  {r.label}
                  {r.provider === testSources.data.fastest
                    ? ` · ${t('settings.proxy.fastest')}`
                    : ''}
                </td>
                {/* 不可达就写"不可达"，绝不填一个 0ms 或 "—" 让它看起来像最快的 */}
                <td className="tabular-nums">
                  {r.reachable && r.latencyMs !== null
                    ? `${r.latencyMs}ms`
                    : t('settings.proxy.unreachable')}
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
          {t('settings.proxy.effective')}:{' '}
          {redactProxyUrl(cfg.socks5 ?? cfg.httpsProxy ?? cfg.httpProxy)}
        </p>
      ) : null}
    </section>
  );
}
