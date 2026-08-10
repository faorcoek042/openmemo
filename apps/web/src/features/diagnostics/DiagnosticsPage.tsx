import { useQuery } from '@tanstack/react-query';
import { copyText } from '../../lib/secure-context';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, MinusCircle, RefreshCw, XCircle } from 'lucide-react';

import { ApiError, rawFetch } from '../../lib/api/client';
import { Button } from '../../components/common/Button';
import { EmptyState } from '../../components/common/EmptyState';
import { useSurfaceStore } from '../../lib/api/surfaces';
import { cn } from '../../lib/utils';
import { pickCheckRemediation, pickCheckText } from './checkText';

/**
 * M-8 诊断页 —— `HealthBanner` 的完整版。
 *
 * ## 它要回答的问题
 *
 * 产品的每一层都有优雅降级：libsimple 缺失 → 退回 trigram（中文搜索静默变差）、
 * 后端包缺失 → 退回"未安装"（转写直接不可用）、VAD 模型缺失 → 退回固定分块。
 * **每个降级单独看都是对的，合起来却让产品在降级态运行而没人知道。**
 *
 * 条幅只报最要紧的两三条；这一页把每一层摊开，并且**如实标注它检查的是"存在性"还是"功能"**。
 *
 * ## 两个数据源，各答各的问题（T-150 ①）
 *
 * | 区块 | 端点 | 它问的问题 |
 * |---|---|---|
 * | 「功能自检」（页首） | `GET /api/selfcheck` | **功能到底能不能用** —— "`用户` 这个词在 FTS5 里能不能被匹配到"、
 *   "交给 whisper 的那份 VAD 权重它加载得了吗"、"yt-dlp 在不在" |
 * | 下面几组 | `GET /api/health` | **组件在不在、加载没加载** —— 定位到具体是哪个零件 |
 *
 * ⚠️ **本文件此前那段注释写着「selfcheck 只是 CLI、没有对应的 HTTP 端点」——
 * 那句话在写下之后就过期了**（`apps/daemon/src/http/rest/selfcheck.ts` 早已落地，
 * `[实测]` demo 上返回 25 条 200）。它的代价是具体的：自检里 20 多条结论
 * （转写引擎缺失 / 中文分词退化 / ANE 没启用 / 音频切分方式）**用户在界面上一条都看不到**，
 * 而那正是"我的东西为什么不工作"的答案。两名 agent 先后据这句注释重新得出了同一个错误结论
 * （见 `coordination/inbox/{remediation,vad-fix}.md`）——
 * 所以这里保留"曾经写着什么"，而不是抹掉（HANDOFF ⑤D-bis 的做法）。
 *
 * `/api/selfcheck` 与 CLI `scripts/selfcheck.mjs` 调**同一个** `runSelfCheck()`
 * （`packages/runtime/src/selfcheck.ts`），差异只允许在渲染层。
 */

interface Health {
  version: string;
  instanceId: string;
  contractVersion: number;
  dataDir: string;
  port: number;
  pid: number;
  db?: {
    driver?: string;
    sqliteVersion?: string;
    journalMode?: string;
    schemaVersion?: number;
    extensions?: {
      libsimple?: boolean;
      sqliteVec?: boolean;
      tokenizer?: string;
      failures?: Record<string, string>;
    };
    search?: { ok?: boolean; tokenizer?: string };
  };
  pipeline?: {
    missing?: string[];
    ffmpeg?: string | null;
    whisperCli?: string | null;
    /** T-148 —— 切分方式。`fixed` 是降级态：转写仍会完成，但断句变差。 */
    vad?: {
      model?: string | null;
      chunking?: 'vad' | 'fixed';
      reasonZh?: string;
      rejected?: string[];
    };
  };
  lanes?: Record<string, { capacity: number; inUse: number }>;
  scheduler?: { running?: number };
  sseClients?: number;
}

/**
 * ⚠️ 与 `packages/runtime/src/selfcheck.ts` 的 `CheckStatus` 一一对应。
 *
 * `'unavailable'` 是第四态：**答案取不到，而且没有用户可执行的下一步**
 *（本次没测出来，或这台机器的目录里根本没有可下载的包）。
 *
 * ★ 加它的同时**必须**改 `LevelIcon`：那个函数是"不是 ok 也不是 warn 就画红叉"的
 * 写法，新态若不接，用户看到的仍然是一个红叉 —— 那样 daemon 侧那半修复
 * （不再让整份报告永久红）**在界面上等于没做**。
 * 这正是本仓记过的「算好发出、离终点一行被丢掉」那一族。
 */
type Level = 'ok' | 'warn' | 'fail' | 'unavailable';

/**
 * `GET /api/selfcheck` 的一条结果。
 *
 * 形状与 `packages/runtime/src/selfcheck.ts` 的 `CheckResult` 一一对应 ——
 * 刻意在前端重述一遍而不是 import：`@openmemo/runtime` 有 `node:fs` 依赖，
 * 打包进浏览器会炸（同 `packages/shared` 文件头那条"no node: imports"的理由）。
 */
interface SelfCheckResult {
  layer: string;
  id: string;
  label: string;
  labelZh: string;
  status: Level;
  detail: string;
  /** 这一条挂了 = 产品坏了，不只是降级。 */
  required: boolean;
  remediation: string | null;
  /**
   * `detail` / `remediation` 的英文版（T-173 起，新写的检查项两种语言都给）。
   *
   * ⚠️ **可选，且历史那批检查项没有** —— `detail` 一直是中文原文。所以这里是
   * `detailEn ?? detail` 回退：给了就用英文，没给就照旧显示中文原文。
   * 回退成中文是难看，但比回退成空白诚实 —— 后者会让一条真实的告警在英文界面上消失。
   */
  detailEn?: string;
  remediationEn?: string | null;
}

interface SelfCheckReport {
  ok: boolean;
  ranAt: string;
  counts: { ok: number; warn: number; fail: number };
  results: SelfCheckResult[];
}

interface Row {
  label: string;
  level: Level;
  detail: string;
  /** 这一条查的是"存在性"还是"功能" —— 必须让用户看见区别 */
  probe: 'presence' | 'feature';
  action?: { label: string; to: string };
}

/**
 * 三档共用同一套图标 —— 自检区块与下面几组必须长得一样。
 *
 * D-10 §5.4 R-S1 的同一条道理：用户扫这一页只想回答"哪里坏了"，
 * 同一个语义在同一页出现两套画法，他就得先学会两套。
 */
function LevelIcon({ level }: { level: Level }) {
  if (level === 'ok')
    return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-good" aria-hidden />;
  if (level === 'warn')
    return <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />;
  /*
   * ★ `unavailable` 用中性图标，**不是红叉也不是黄警告**。
   * 红叉 = "坏了"，黄警告 = "降级了，你可以处理" —— 这一态两者都不是：
   * 它是"这里没有答案，而且你没有下一步"。画成红叉会让用户去找一个不存在的修法。
   */
  if (level === 'unavailable')
    return <MinusCircle className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />;
  return <XCircle className="mt-0.5 size-3.5 shrink-0 text-critical" aria-hidden />;
}

export default function DiagnosticsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const surfaces = useSurfaceStore((s) => s.states);
  /*
   * ⚠️ **必须放在任何 early return 之前。**
   * 第一版我把这两行写在 `if (isError || !data) return …` 后面，React 当场报
   * `Rendered more hooks than during the previous render` —— 组件在出错分支里
   * 少调两个 hook，hook 顺序对不上。表现是**整页塌掉**，6 条既有用例一起红，
   * 而我当时只看到"copyState 没更新"，把它记成了 UNKNOWN。
   * 成因不是剪贴板、也不是安全上下文，是**违反了 Rules of Hooks**。
   */
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'failed'>('idle');
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const zh = i18n.language.toLowerCase().startsWith('zh');

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['health', 'diagnostics'],
    queryFn: async (): Promise<Health> => {
      const res = await rawFetch('/api/health');
      if (!res.ok) {
        // 抛裸 Error 会让错误文案表用不上（无 code）—— 这是我上一轮修过的同一类问题，
        // 说明"别处还有裸 throw"这条排查没做干净。这次给它一个稳定 code。
        throw new ApiError(res.status, {
          code: 'HEALTH_UNAVAILABLE',
          message: `health endpoint returned ${res.status}`,
          messageZh: `本地服务健康检查返回 ${res.status}`,
          retryable: true,
        });
      }
      return (await res.json()) as Health;
    },
    refetchInterval: 15_000,
  });

  /*
   * ★ T-150 ①：功能自检。
   *
   * **不设 `refetchInterval`。** 这一条会在 daemon 里真跑子进程枚举设备、真建 FTS5 临时表、
   * 真读 8 条 .so 符号链接 —— 每 15 秒替用户跑一遍是拿他的 CPU 换一个他没在看的数字。
   * 它跟着页面上那颗「重新检测」按钮走（下面 `refetch` 两个一起点）。
   *
   * 端点不在（老 daemon）时**不许让整页塌掉**：下面几组仍然有价值，
   * 所以这里的失败只在自检区块内显形，并说清"下面那些只查组件在不在"。
   */
  const selfcheck = useQuery({
    queryKey: ['selfcheck', 'diagnostics'],
    queryFn: async (): Promise<SelfCheckReport> => {
      const res = await rawFetch('/api/selfcheck');
      if (!res.ok) {
        throw new ApiError(res.status, {
          code: 'SELFCHECK_UNAVAILABLE',
          message: `selfcheck endpoint returned ${res.status}`,
          messageZh: `功能自检接口返回 ${res.status}`,
          retryable: true,
        });
      }
      return (await res.json()) as SelfCheckReport;
    },
    staleTime: 30_000,
  });

  if (isLoading) return <div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>;

  if (isError || !data) {
    return (
      <EmptyState
        icon={<XCircle className="size-10 text-critical" />}
        title={t('diagnostics.daemonDown')}
        hint={t('diagnostics.daemonDownHint')}
        action={
          <Button variant="primary" onClick={() => void refetch()}>
            <RefreshCw className="size-3.5" />
            {t('diagnostics.recheck')}
          </Button>
        }
      />
    );
  }

  const ext = data.db?.extensions;
  const missing = data.pipeline?.missing ?? [];

  const groups: { title: string; rows: Row[] }[] = [
    {
      title: t('diagnostics.groupService'),
      rows: [
        {
          label: t('diagnostics.daemon'),
          level: 'ok',
          detail: `v${data.version} · pid ${data.pid} · :${data.port}`,
          probe: 'presence',
        },
        {
          label: t('diagnostics.dataDir'),
          level: 'ok',
          detail: data.dataDir,
          probe: 'presence',
        },
        {
          label: t('diagnostics.liveUpdates'),
          level: (data.sseClients ?? 0) > 0 ? 'ok' : 'warn',
          detail: t('diagnostics.sseClients', { n: data.sseClients ?? 0 }),
          probe: 'presence',
        },
      ],
    },
    {
      title: t('diagnostics.groupStorage'),
      rows: [
        {
          label: t('diagnostics.database'),
          level: 'ok',
          detail: `${data.db?.driver ?? '?'} · SQLite ${data.db?.sqliteVersion ?? '?'} · ${data.db?.journalMode ?? '?'} · schema v${data.db?.schemaVersion ?? '?'}`,
          probe: 'presence',
        },
        {
          label: t('diagnostics.chineseTokenizer'),
          level: ext?.libsimple ? 'ok' : 'warn',
          detail: ext?.libsimple
            ? t('diagnostics.tokenizerOk', { tokenizer: ext.tokenizer ?? 'simple' })
            : (ext?.failures?.['libsimple'] ??
              t('diagnostics.tokenizerFallback', { tokenizer: ext?.tokenizer ?? 'trigram' })),
          probe: 'presence',
          ...(ext?.libsimple ? {} : { action: { label: t('health.fix'), to: '/runtime' } }),
        },
        {
          label: t('diagnostics.vectorIndex'),
          level: ext?.sqliteVec ? 'ok' : 'warn',
          detail:
            ext?.failures?.['sqlite-vec'] ??
            (ext?.sqliteVec ? t('diagnostics.enabled') : t('diagnostics.semanticOff')),
          probe: 'presence',
        },
      ],
    },
    {
      title: t('diagnostics.groupPipeline'),
      rows: [
        {
          label: 'ffmpeg',
          level: data.pipeline?.ffmpeg ? 'ok' : 'fail',
          detail: data.pipeline?.ffmpeg ?? t('diagnostics.notFound'),
          probe: 'presence',
        },
        {
          label: t('diagnostics.asrEngine'),
          level: missing.length === 0 ? 'ok' : 'fail',
          detail:
            missing.length === 0
              ? (data.pipeline?.whisperCli ?? t('diagnostics.ready'))
              : t('diagnostics.missingItems', { items: missing.join(', ') }),
          probe: 'presence',
          ...(missing.length > 0
            ? {
                action: {
                  label: t('health.fix'),
                  to: missing.includes('asr-model') ? '/models' : '/runtime',
                },
              }
            : {}),
        },
        /*
         * ★ 本文件开头那段注释把「VAD 模型缺失 → 退回固定分块」列为本页存在的理由之一，
         * 而这一行**在 T-148 之前根本不存在** —— 一页专门用来揭示静默降级的诊断页，
         * 漏掉了它自己点名的那条降级。
         *
         * 判据钉的是 `chunking`（实际用了哪种切分），不是「VAD 文件在不在」：
         * 出事那次文件确实在，只是格式不对（sherpa 的 ONNX），
         * 而按"在不在"判会给出一盏绿灯。
         */
        {
          label: t('diagnostics.chunking'),
          level: data.pipeline?.vad?.chunking === 'vad' ? 'ok' : 'warn',
          detail:
            data.pipeline?.vad?.reasonZh ??
            (data.pipeline?.vad?.chunking === 'vad'
              ? t('diagnostics.chunkingVad')
              : t('diagnostics.chunkingFixed')),
          probe: 'presence',
          ...(data.pipeline?.vad?.chunking === 'vad'
            ? {}
            : { action: { label: t('health.fix'), to: '/models' } }),
        },
        {
          label: t('diagnostics.scheduler'),
          level: 'ok',
          detail: t('diagnostics.runningJobs', { n: data.scheduler?.running ?? 0 }),
          probe: 'presence',
        },
      ],
    },
    {
      title: t('diagnostics.groupApi'),
      rows: (Object.entries(surfaces) as [string, string][])
        .filter(([k]) => k !== 'generic')
        .map(([k, v]) => ({
          label: k,
          level: v === 'live' ? 'ok' : v === 'unknown' ? 'warn' : 'fail',
          detail: t(`diagnostics.surface.${v}`, { defaultValue: v }),
          probe: 'presence' as const,
        })),
    },
  ];

  /*
   * 自检结果按 `layer` 分组。
   *
   * **顺序取数据里的首次出现顺序**，不写死一张 layer 白名单：
   * `runSelfCheck()` 是"检查项列表在任何情况下都是同一份、同一个顺序"（该文件头有此承诺），
   * 照着它渲染就永远不会漏掉一个新加的 layer。写死白名单则会让
   * "daemon 新增一层" = "界面上悄悄少一层"，那正是本轮要修的那类洞的翻版。
   */
  const selfcheckLayers: { layer: string; rows: SelfCheckResult[] }[] = [];
  for (const r of selfcheck.data?.results ?? []) {
    const bucket = selfcheckLayers.find((g) => g.layer === r.layer);
    if (bucket) bucket.rows.push(r);
    else selfcheckLayers.push({ layer: r.layer, rows: [r] });
  }

  const copyReport = () => {
    const text = JSON.stringify(
      { health: data, selfcheck: selfcheck.data ?? null, surfaces },
      null,
      2,
    );
    /*
     * ★ Manager 2026-08-08 裁决：**成功必须出声。**
     * 点完什么都不说，用户没法判断是复制成功了、还是又一个死按钮 ——
     * 而他今天刚被两个死按钮教育过。
     *
     * `[实测]` 本产品在 `http://127.0.0.1` 下 **isSecureContext=true**，
     * `navigator.clipboard` 也存在，但 `writeText()` 会因**权限**被拒
     * （无头里是 NotAllowedError）。`copyText()` 把它 catch 掉后回退到
     * `execCommand`，**只返回布尔、从不抛** —— 所以这里用 then 的两个分支就够了。
     *
     * 失败时不只是说一句"失败"，还要**给退路**：把全文摊出来让用户自己选中复制。
     * 绑非回环地址 + 明文 HTTP 时剪贴板会被浏览器直接关掉，那时这条退路就是唯一出路。
     */
    setFallbackText(null);
    void copyText(text).then((okCopied) => {
      setCopyState(okCopied ? 'ok' : 'failed');
      if (!okCopied) setFallbackText(text);
    });
  };

  const recheck = () => {
    void refetch();
    void selfcheck.refetch();
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-ink">{t('diagnostics.title')}</h1>
        <span className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={copyReport}>
            <Copy className="size-3.5" />
            {t('diagnostics.copy')}
          </Button>
          {copyState === 'ok' ? (
            <span className="self-center text-xs text-success" data-testid="diagnostics-copy-ok">
              {t('diagnostics.copied')}
            </span>
          ) : null}
          {copyState === 'failed' ? (
            <span
              className="self-center text-xs text-warning"
              data-testid="diagnostics-copy-failed"
            >
              {t('diagnostics.copyFailed')}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={recheck}
            disabled={isFetching || selfcheck.isFetching}
          >
            <RefreshCw
              className={cn('size-3.5', (isFetching || selfcheck.isFetching) && 'animate-spin')}
            />
            {t('diagnostics.recheck')}
          </Button>
        </span>
      </header>

      {/*
        失败时的**退路**：把全文摊出来让用户自己选中复制。
        绑非回环地址 + 明文 HTTP 时浏览器会直接关掉剪贴板（README 里
        「录音会直接不可用」是同一个成因），那时这条退路就是唯一出路。
      */}
      {fallbackText !== null ? (
        <div
          className="rounded-lg border border-warning/40 bg-surface-1 p-3"
          data-testid="diagnostics-copy-fallback"
        >
          <textarea
            readOnly
            aria-label={t('diagnostics.copy')}
            className="h-40 w-full resize-y rounded bg-surface-2 p-2 font-mono text-xs text-ink"
            value={fallbackText}
          />
        </div>
      ) : null}

      {/* 说清楚两个区块各答什么 —— 上面问"功能能不能用"，下面问"组件在不在" */}
      <p className="rounded-md border border-line bg-surface-1 px-3 py-2 text-xs text-ink-secondary">
        ⓘ {t('diagnostics.probeCaveat')}
      </p>

      {/*
        ★ T-150 ①：功能自检。**放在最前面**，因为它是更强的判据 ——
        下面几组回答"零件在不在"，这一组回答"东西能不能用"。
      */}
      <section
        className="rounded-lg border border-line bg-surface-1 p-4"
        data-testid="selfcheck-section"
      >
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-ink">{t('diagnostics.selfcheck.title')}</h2>
          {selfcheck.data ? (
            <span className="text-xs text-ink-muted" data-testid="selfcheck-counts">
              {t('diagnostics.selfcheck.counts', selfcheck.data.counts)}
              {' · '}
              {t('diagnostics.selfcheck.ranAt', {
                time: new Date(selfcheck.data.ranAt).toLocaleString(i18n.language),
              })}
            </span>
          ) : null}
        </div>
        <p className="mb-2 text-xs text-ink-secondary">{t('diagnostics.selfcheck.hint')}</p>

        {selfcheck.isLoading ? (
          <p className="text-xs text-ink-muted">{t('diagnostics.selfcheck.loading')}</p>
        ) : selfcheck.isError ? (
          /*
           * 端点拿不到 ≠ 一切正常。这里必须画成 warn 并说清"下面那些只查组件在不在" ——
           * 静默留白会让这一整块的缺席看起来像"没什么可报的"。
           */
          <p
            className="flex items-start gap-2 text-xs text-warning"
            data-testid="selfcheck-unavailable"
          >
            <LevelIcon level="warn" />
            <span className="text-ink-secondary">
              <span className="block text-ink">{t('diagnostics.selfcheck.unavailable')}</span>
              {t('diagnostics.selfcheck.unavailableHint')}
            </span>
          </p>
        ) : selfcheckLayers.length === 0 ? (
          <p className="text-xs text-warning" data-testid="selfcheck-empty">
            {t('diagnostics.selfcheck.empty')}
          </p>
        ) : (
          selfcheckLayers.map((g) => (
            <div key={g.layer} className="mt-3" data-testid={`selfcheck-layer-${g.layer}`}>
              <h3 className="text-xs font-medium text-ink-secondary">
                {t(`diagnostics.selfcheck.layer.${g.layer}`, { defaultValue: g.layer })}
              </h3>
              <ul className="flex flex-col divide-y divide-line" role="list">
                {g.rows.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-start gap-2 py-2"
                    data-testid="selfcheck-row"
                    data-check-id={r.id}
                    data-level={r.status}
                  >
                    <LevelIcon level={r.status} />
                    <span className="min-w-0 flex-1">
                      <span className="text-sm text-ink">{zh ? r.labelZh : r.label}</span>
                      {r.required && r.status !== 'ok' ? (
                        <span className="ml-1.5 rounded bg-surface-0 px-1.5 py-0.5 text-[10px] text-critical">
                          {t('diagnostics.selfcheck.required')}
                        </span>
                      ) : null}
                      {/*
                        `detail` / `remediation` 是**服务端原文**（路径、设备名、修复建议
                        只有 daemon 知道），与 `secrets.disclosure` 同一条理由：
                        前端自己编必然说错。这里只负责显示 —— 包括选哪一种语言。
                      */}
                      <span className="mt-0.5 block break-all text-xs text-ink-muted">
                        {pickCheckText(zh, r.detail, r.detailEn)}
                      </span>
                      {r.remediation ? (
                        <span
                          className="mt-0.5 block text-xs text-ink-secondary"
                          data-testid="selfcheck-remediation"
                        >
                          → {pickCheckRemediation(zh, r.remediation, r.remediationEn)}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {groups.map((g) => (
        <section key={g.title} className="rounded-lg border border-line bg-surface-1 p-4">
          <h2 className="mb-2 text-sm font-medium text-ink">{g.title}</h2>
          <ul className="flex flex-col divide-y divide-line" role="list">
            {g.rows.map((r) => (
              <li key={r.label} className="flex items-start gap-2 py-2" data-level={r.level}>
                <LevelIcon level={r.level} />
                <span className="min-w-0 flex-1">
                  <span className="text-sm text-ink">{r.label}</span>
                  <span className="mt-0.5 block break-all text-xs text-ink-muted">{r.detail}</span>
                </span>
                {r.action ? (
                  <Button size="sm" variant="ghost" onClick={() => navigate(r.action!.to)}>
                    {r.action.label}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
