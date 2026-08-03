import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { AlertTriangle, CheckCircle2, Clock, Download, RotateCw, ShieldCheck, X } from 'lucide-react';

import type {
  DownloadJob,
  JobBlockedEvent,
  JobCreatedEvent,
  JobFailedEvent,
  JobState,
  JobStateEvent,
} from '@openmemo/shared';

import { bus } from '../../lib/events/bus';
import { rawFetch } from '../../lib/api/client';
import { useProgressStore } from '../../lib/stores/progress.store';
import { formatBytes, formatSpeed } from '../../lib/format/bytes';
import { approxEta } from '../../lib/format/time';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { ProgressMeter } from './ProgressMeter';

/**
 * 安装 / 下载的**全局即时反馈层**（T-101 ②）。
 *
 * ## 为什么必须有这一层（这是实测出来的，不是审美意见）
 *
 * 用真浏览器点了一次「安装后端包」，逐帧记录页面文本：
 *
 * ```
 * [backend-install] 按钮点击前文案: "安装 5.3 MB"
 *   t=+150ms  按钮="安装 5.3 MB"  新出现文本=[]
 *   t=+400ms  按钮="安装 5.3 MB"  新出现文本=[]
 *   t=+1000ms 按钮="安装 5.3 MB"  新出现文本=[]
 *   t=+2500ms 按钮="安装 5.3 MB"  新出现文本=[]
 *   t=+6000ms 按钮="安装 5.3 MB"  新出现文本=[]
 * ```
 *
 * **整整 6 秒，整个页面一个字都没变。** 而后台其实已经建好作业并开始下载了 ——
 * 切到 `/tasks` 就能看到它在跑。也就是说：系统在干活，但**只有用户不知道**。
 *
 * 模型页稍好（它自己有「下载中」区块），但那个区块渲染在**目录列表之上**。
 * 实测：滚到第 4 张卡片点下载，反馈区块的位置是 `top=-297px` ——
 * **在视口外**。用户点完看到的仍然是"没反应"。
 *
 * 这两条合起来就是用户的原话「点击后的提示不明确」的全部成因：
 * **反馈存在，但不在用户眼睛所在的位置。**
 *
 * ## 解法为什么是"全局 Toast"而不是"在卡片里加进度条"
 *
 * 安装入口不止一个：`/runtime`、`/models`、`/capture` 的「去安装模型」、
 * 首启引导第 3 步、以及降级条幅的「去修复」。在每个入口各做一套局部进度，
 * 既重复又必然漏掉其中一两个。**Toast 层与入口无关** —— 从任何地方发起，
 * 反馈都出现在同一个固定位置，而且跟着用户跨页面走（作业在 daemon 里，不属于任何一页）。
 *
 * 这也正是 D-05 §5.1 给 Toast 定的用途：「异步动作的结果通知」，
 * 且「**带动作的 toast 不自动消失**」—— 下面严格照此实现。
 *
 * ## 数据来源：只读 SSE，零新增 API 调用
 *
 * 订阅 `lib/events/bus` 上已经在跑的那条全局 SSE（`job.created` / `job.state` /
 * `job.failed` / `job.blocked`），进度读 `progressStore`（已按 200ms 节流）。
 * **不发任何请求、不动任何 mutation**，所以它不会与正在改配置链路 / 模型选择的人撞车。
 *
 * ## 五个阶段的文案原则
 *
 * `queued → resolving → downloading → verifying → installing`
 *
 * 其中 **`verifying` 是唯一必须额外解释的一步**：大模型逐字节核对 SHA-256 要几十秒，
 * 而且**进度条在这一步不动**。不说清楚，用户就会把"正常的校验"读成"卡死了"然后去杀进程 ——
 * 于是一个正确的安全设计（ADR-004 决策 5：校验不过就丢弃）反而制造了坏体验。
 * 所以这里给它一个显式的解释句 + 脉动条（`indeterminate`），而不是一个不动的百分比。
 *
 * `blocked` **不是失败**（是在等依赖，条件满足会自动继续），因此用 warning 而不是 critical，
 * 并明说"这不是失败"。把它画成红色错误会让用户以为要重来一次。
 */

/* ────────────────────────────── 类型 ────────────────────────────── */

type Phase = 'active' | 'blocked' | 'failed' | 'done';

interface Toast {
  jobId: string;
  kind: DownloadJob['kind'];
  name: string;
  totalBytes: number;
  phase: Phase;
  state: JobState;
  /** blocked / failed 时的中文原因 */
  reason?: string;
  /** blocked 时服务端给的可执行补救 */
  remediation?: JobBlockedEvent['remediation'];
  attempt?: number;
  maxAttempts?: number;
  willRetry?: boolean;
  /** 完成后是否需要重启才生效（由 /api/health 的 restartRequired 判定） */
  needsRestart?: boolean;
}

/** 同时最多显示几条 —— 再多就变成刷屏，反而看不见。溢出的靠"任务中心"看。 */
const MAX_VISIBLE = 3;
/** 成功后停留多久自动消失。带动作的（blocked/failed/需重启）**永不自动消失**。 */
const SUCCESS_LINGER_MS = 8000;

/* ──────────────────────────── 容器 ──────────────────────────── */

export function JobToaster() {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((jobId: string) => {
    const timer = timers.current.get(jobId);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(jobId);
    }
    setToasts((prev) => prev.filter((x) => x.jobId !== jobId));
  }, []);

  const upsert = useCallback((jobId: string, patch: Partial<Toast> & Pick<Toast, 'jobId'>) => {
    setToasts((prev) => {
      const i = prev.findIndex((x) => x.jobId === jobId);
      if (i === -1) {
        // 只有 job.created 会带齐必填字段；晚到的 state/failed 事件如果没见过这个 job，
        // 说明它是本次会话之前就存在的（比如刷新页面），不补建 toast —— 那属于任务中心。
        if (patch.name == null) return prev;
        return [...prev, { phase: 'active', state: 'queued', totalBytes: 0, kind: 'model', ...patch } as Toast];
      }
      const next = [...prev];
      next[i] = { ...next[i]!, ...patch };
      return next;
    });
  }, []);

  /** 终态：成功的排队自动消失；需要用户处理的留着。 */
  const scheduleDismiss = useCallback(
    (jobId: string) => {
      const prev = timers.current.get(jobId);
      if (prev) clearTimeout(prev);
      timers.current.set(
        jobId,
        setTimeout(() => dismiss(jobId), SUCCESS_LINGER_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const offs = [
      bus.on('job.created', (e) => {
        const ev = e as JobCreatedEvent;
        const j = ev.job;
        upsert(j.jobId, {
          jobId: j.jobId,
          kind: j.kind,
          name: j.displayName || j.targetId,
          totalBytes: j.totalBytes,
          state: j.state,
          phase: 'active',
          attempt: j.attempt,
          maxAttempts: j.maxAttempts,
        });
      }),

      bus.on('job.state', (e) => {
        const ev = e as JobStateEvent;
        if (ev.state === 'succeeded') {
          upsert(ev.jobId, { jobId: ev.jobId, phase: 'done', state: ev.state });
          // 需重启的那一类要等 health 查完才决定是否自动消失（见下方 effect）
          scheduleDismiss(ev.jobId);
        } else if (ev.state === 'cancelled') {
          dismiss(ev.jobId);
        } else if (ev.state !== 'blocked' && ev.state !== 'failed') {
          upsert(ev.jobId, { jobId: ev.jobId, phase: 'active', state: ev.state });
        }
      }),

      bus.on('job.blocked', (e) => {
        const ev = e as JobBlockedEvent;
        upsert(ev.jobId, {
          jobId: ev.jobId,
          phase: 'blocked',
          state: 'blocked',
          reason: ev.messageZh || ev.message,
          remediation: ev.remediation,
        });
      }),

      bus.on('job.failed', (e) => {
        const ev = e as JobFailedEvent;
        upsert(ev.jobId, {
          jobId: ev.jobId,
          // ★ 还在自动重试的失败**不升级为红色错误**（D-05 §2.3：重试中的失败不该打扰用户）。
          //   但也不能一声不吭 —— 保持 active 并在副文案里说"正在自动重试"。
          phase: ev.willRetry ? 'active' : 'failed',
          state: 'failed',
          willRetry: ev.willRetry,
          reason: ev.error?.messageZh ?? ev.error?.message,
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [upsert, dismiss, scheduleDismiss]);

  /**
   * 成功之后再问一次 `/api/health`：装完的东西是**立刻可用**还是**要重启才生效**。
   *
   * 这一步不是可选的润色。实测过一次「装 libsimple（中文分词器）」：
   * `restartRequired.required = true` 而 `db.extensions.libsimple` 仍是 `false` ——
   * 也就是**装成功了但还没生效**。如果 toast 只说"已安装"，用户回去搜中文照样搜不到，
   * 会判定为"这软件坏了"。这正是零报错的假成功，必须在成功提示里就说破。
   */
  const hasDone = toasts.some((x) => x.phase === 'done' && x.needsRestart === undefined);
  useEffect(() => {
    if (!hasDone) return;
    let alive = true;
    void (async () => {
      try {
        const res = await rawFetch('/api/health');
        if (!res.ok || !alive) return;
        const body = (await res.json()) as { restartRequired?: { required?: boolean } };
        const need = body.restartRequired?.required === true;
        if (!alive) return;
        setToasts((prev) =>
          prev.map((x) => (x.phase === 'done' && x.needsRestart === undefined ? { ...x, needsRestart: need } : x)),
        );
        // 需要重启 = 带动作的 toast → 取消自动消失
        if (need) {
          for (const [id, timer] of timers.current) {
            clearTimeout(timer);
            timers.current.delete(id);
          }
        }
      } catch {
        /* health 拿不到就按"立刻可用"处理，不额外吓人 */
        if (alive) {
          setToasts((prev) =>
            prev.map((x) => (x.phase === 'done' && x.needsRestart === undefined ? { ...x, needsRestart: false } : x)),
          );
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [hasDone]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  if (toasts.length === 0) return null;
  const visible = toasts.slice(-MAX_VISIBLE);
  const hidden = toasts.length - visible.length;

  return (
    <div
      // Toast 层 z=50（D-05 §7.4 的 z-index 分层）。进度播报用 polite，
      // 且**只在阶段切换时**变文本，不逐帧播报（D-05 §6.3）。
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2"
      role="status"
      aria-live="polite"
      aria-label={t('jobToast.title')}
      data-testid="job-toaster"
    >
      {hidden > 0 ? (
        <div className="pointer-events-auto self-end rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs text-ink-secondary shadow-e1">
          +{hidden}
        </div>
      ) : null}
      {visible.map((toast) => (
        <ToastRow key={toast.jobId} toast={toast} onDismiss={() => dismiss(toast.jobId)} />
      ))}
    </div>
  );
}

/* ──────────────────────────── 单条 ──────────────────────────── */

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const locale = i18n.language;

  // ★ 进度只订阅自己那一个 jobId（D-05 §2.4）：别的任务刷新不会让这一条重渲染。
  const live = useProgressStore(useShallow((s) => s.byJob[toast.jobId]));

  const isBackend = toast.kind === 'backend-pack';
  const step = live?.step ?? null;
  const completed = live?.completedBytes ?? 0;
  const total = live?.totalBytes ?? toast.totalBytes;
  const ratio = total ? Math.min(1, completed / total) : 0;
  const eta = approxEta(live?.etaSeconds ?? null, locale);
  const verifying = step === 'verifying';

  const tone =
    toast.phase === 'failed'
      ? 'critical'
      : toast.phase === 'blocked'
        ? 'warning'
        : toast.phase === 'done'
          ? 'good'
          : 'accent';

  const accentBar = {
    critical: 'border-l-critical-line',
    warning: 'border-l-warning-line',
    good: 'border-l-good-line',
    accent: 'border-l-info-line',
  }[tone];

  return (
    <div
      className={cn(
        'pointer-events-auto rounded-lg border border-l-4 border-line bg-surface-2 p-3 shadow-e2',
        accentBar,
      )}
      data-testid={`job-toast-${toast.jobId}`}
    >
      <div className="flex items-start gap-2">
        <ToastIcon phase={toast.phase} verifying={verifying} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">
            {toast.phase === 'done'
              ? t(isBackend ? 'jobToast.doneBackend' : 'jobToast.doneModel', { name: toast.name })
              : toast.phase === 'failed'
                ? t('jobToast.failedTitle', { name: toast.name })
                : toast.phase === 'blocked'
                  ? t('jobToast.blockedTitle', { name: toast.name })
                  : t(isBackend ? 'jobToast.startedBackend' : 'jobToast.startedModel', { name: toast.name })}
          </p>

          {/* 阶段名 + 字节 + 速度 + ETA。全部用 tabular-nums，数字跳动时不抖行宽。 */}
          {toast.phase === 'active' ? (
            <p className="mt-0.5 text-xs text-ink-secondary">
              <span>{t(`progress.${step ?? toast.state}`, { defaultValue: t('progress.queued') })}</span>
              {total ? (
                <span className="tabular-nums">
                  {' · '}
                  {formatBytes(completed, locale)} / {formatBytes(total, locale)}
                </span>
              ) : null}
              {live?.speedBps ? <span className="tabular-nums">{` · ${formatSpeed(live.speedBps, locale)}`}</span> : null}
              {eta && !verifying ? <span className="tabular-nums">{` · ${eta}`}</span> : null}
            </p>
          ) : null}

          {(toast.phase === 'blocked' || toast.phase === 'failed') && toast.reason ? (
            <p className={cn('mt-0.5 text-xs', toast.phase === 'failed' ? 'text-critical' : 'text-ink-secondary')}>
              {toast.reason}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('jobToast.dismiss')}
          className="-m-1 shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-surface-1 hover:text-ink"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      {toast.phase === 'active' ? (
        <ProgressMeter
          className="mt-2"
          value={ratio}
          // 校验阶段没有可信百分比 —— 脉动而不是假装有进度（D-05 §7.3 的"稀疏值不编数字"）
          indeterminate={verifying || step === 'resolving' || step == null}
          tone="info"
          label={toast.name}
        />
      ) : null}

      {/* ── 副文案：每个阶段各说一句人话，其中 verifying 是重点 ── */}
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">{subtitleFor(toast, step, t)}</p>

      {/* ── 动作：装完之后"现在能干嘛"必须给出口，不能只说"成功" ── */}
      <ToastActions toast={toast} onDismiss={onDismiss} navigate={navigate} />
    </div>
  );
}

function ToastIcon({ phase, verifying }: { phase: Phase; verifying: boolean }) {
  const cls = 'mt-0.5 size-4 shrink-0';
  if (phase === 'done') return <CheckCircle2 className={cn(cls, 'text-good')} aria-hidden />;
  if (phase === 'failed') return <AlertTriangle className={cn(cls, 'text-critical')} aria-hidden />;
  if (phase === 'blocked') return <Clock className={cn(cls, 'text-warning')} aria-hidden />;
  if (verifying) return <ShieldCheck className={cn(cls, 'text-info')} aria-hidden />;
  return <Download className={cn(cls, 'text-accent-ink')} aria-hidden />;
}

/**
 * 每个阶段的解释句。
 *
 * `verifying` 那句是本文件存在的最大理由之一 —— 见文件头注释。
 */
function subtitleFor(toast: Toast, step: string | null, t: TFunction): string {
  if (toast.phase === 'blocked') return t('jobToast.blockedHint');
  if (toast.phase === 'failed') return t('jobToast.backgroundHint');
  if (toast.phase === 'done') {
    if (toast.needsRestart) return t('jobToast.doneRestartHint');
    return t(toast.kind === 'backend-pack' ? 'jobToast.doneBackendHint' : 'jobToast.doneModelHint');
  }
  if (toast.willRetry) {
    return t('jobToast.retryingHint', { attempt: toast.attempt ?? 1, max: toast.maxAttempts ?? 1 });
  }
  if (step === 'verifying') return t('jobToast.verifyingHint');
  if (step === 'installing') return t('jobToast.installingHint');
  if (step == null && toast.state === 'queued') return t('jobToast.queuedHint');
  // 下载 / 选源阶段：这里才是说"可以走开"的时机（D-05 §4.5：用户默认以为关页面 = 任务没了）
  return t('jobToast.backgroundHint');
}

function ToastActions({
  toast,
  onDismiss,
  navigate,
}: {
  toast: Toast;
  onDismiss: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { t } = useTranslation();
  const [restarting, setRestarting] = useState(false);

  if (toast.phase === 'done') {
    if (toast.needsRestart) {
      return (
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="primary"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              // daemon 自我重启端点（`/api/health` 的 restartRequired.endpoint）。
              // 重启后前端会自己走 401 自愈 / SSE 重连，不需要用户做别的。
              void rawFetch('/api/daemon/restart', { method: 'POST' }).catch(() => setRestarting(false));
            }}
            data-testid="job-toast-restart"
          >
            <RotateCw className={cn('size-3.5', restarting && 'animate-spin')} aria-hidden />
            {restarting ? t('jobToast.restarting') : t('jobToast.restartNow')}
          </Button>
        </div>
      );
    }
    return (
      <div className="mt-2 flex justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onDismiss();
            navigate(toast.kind === 'backend-pack' ? '/runtime' : '/models');
          }}
        >
          {t(toast.kind === 'backend-pack' ? 'jobToast.gotoRuntime' : 'jobToast.gotoModels')}
        </Button>
        {toast.kind === 'model' ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onDismiss();
              navigate('/capture');
            }}
            data-testid="job-toast-goto-capture"
          >
            {t('jobToast.gotoCapture')}
          </Button>
        ) : null}
      </div>
    );
  }

  if (toast.phase === 'blocked' || toast.phase === 'failed') {
    return (
      <div className="mt-2 flex justify-end gap-1.5">
        {/* 服务端给的 remediation 是一等公民：blocked 必须有可点按钮，
            否则"用户不碰命令行"就没做到（D-05 §5.3 第 2 条）。 */}
        {toast.remediation ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onDismiss();
              navigate(remediationRoute(toast.remediation!.action));
            }}
          >
            {toast.remediation.labelZh || toast.remediation.label}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            onDismiss();
            navigate('/tasks');
          }}
        >
          {t('jobToast.viewTasks')}
        </Button>
      </div>
    );
  }

  return null;
}

/**
 * `remediation.action` → 路由。
 *
 * 只做导航，**不替服务端做业务判定**（D-05 §2.6 第 2 条）。认不出的动作一律送到任务中心，
 * 那里有完整上下文与重试入口 —— 好过一个点了没反应的按钮。
 */
function remediationRoute(action: string): string {
  switch (action) {
    case 'install_model':
      return '/models';
    case 'install_backend':
      return '/runtime';
    case 'free_disk':
      return '/settings/storage';
    case 'configure_api_key':
      return '/settings/llm';
    default:
      return '/tasks';
  }
}
