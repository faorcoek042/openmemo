import { useQuery } from '@tanstack/react-query';
import { copyText } from '../../lib/secure-context';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { AlertTriangle, CheckCircle2, Copy, RefreshCw, XCircle } from 'lucide-react';

import { ApiError, rawFetch } from '../../lib/api/client';
import { Button } from '../../components/common/Button';
import { EmptyState } from '../../components/common/EmptyState';
import { useSurfaceStore } from '../../lib/api/surfaces';
import { cn } from '../../lib/utils';

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
 * ## 一个必须说清的局限
 *
 * 本页的数据源是 `/api/health`，它报的是**组件是否加载**（`libsimple: false`）。
 * 而 `scripts/selfcheck.mjs`（`gpu-runtime` 的跨模块自检）问的是**功能是否可用**
 * （"`用户` 这个词在 FTS5 里能不能匹配到"）—— 那才是更强的判据。
 * 目前 selfcheck 只是 CLI，**没有对应的 HTTP 端点**，所以这一页给不出功能级结论。
 * 我在页面上明确写出了这个区别，而不是让用户以为绿灯等于功能可用。
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

type Level = 'ok' | 'warn' | 'fail';

interface Row {
  label: string;
  level: Level;
  detail: string;
  /** 这一条查的是"存在性"还是"功能" —— 必须让用户看见区别 */
  probe: 'presence' | 'feature';
  action?: { label: string; to: string };
}

export default function DiagnosticsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const surfaces = useSurfaceStore((s) => s.states);

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

  const copyReport = () => {
    const text = JSON.stringify({ health: data, surfaces }, null, 2);
    // 非安全上下文下 clipboard 是 undefined，copyText 会回退到 execCommand
    void copyText(text);
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
          <Button size="sm" variant="secondary" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
            {t('diagnostics.recheck')}
          </Button>
        </span>
      </header>

      {/* 必须说清楚：这一页查的是"组件在不在"，不是"功能能不能用" */}
      <p className="rounded-md border border-line bg-surface-1 px-3 py-2 text-xs text-ink-secondary">
        ⓘ {t('diagnostics.probeCaveat')}
      </p>

      {groups.map((g) => (
        <section key={g.title} className="rounded-lg border border-line bg-surface-1 p-4">
          <h2 className="mb-2 text-sm font-medium text-ink">{g.title}</h2>
          <ul className="flex flex-col divide-y divide-line" role="list">
            {g.rows.map((r) => (
              <li key={r.label} className="flex items-start gap-2 py-2">
                {r.level === 'ok' ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-good" aria-hidden />
                ) : r.level === 'warn' ? (
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 size-3.5 shrink-0 text-critical" aria-hidden />
                )}
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
