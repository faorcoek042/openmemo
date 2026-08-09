import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { stepLabel as stepLabelOf } from '../../lib/format/stepLabel';
import { useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  RotateCw,
  ShieldCheck,
  X,
} from 'lucide-react';

import { bus } from '../../lib/events/bus';
import type { Phase, Toast, ToastAction } from './jobToastModel';
import { isPipelineKind, reduceToasts, toastActionFor } from './jobToastModel';
import { rawFetch } from '../../lib/api/client';
import { useProgressStore } from '../../lib/stores/progress.store';
import { formatBytes, formatSpeed } from '../../lib/format/bytes';
import { approxEta } from '../../lib/format/time';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { ProgressMeter } from './ProgressMeter';
import { RemediationButton } from './RemediationButton';
import { remediationTarget } from '../../lib/remediation/routes';

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

/**
 * ★ `Toast` 类型与"哪条事件能变成一条 toast"的规则住在 `./jobToastModel.ts`。
 *
 * 那条规则正是 T-130 的核心（`blocked` 到不了屏幕上），必须能被单测直接喂真实事件载荷 ——
 * 而这个组件 import 了 react-router（纯 ESM），进不了仓库的 CommonJS 单测通道。
 * 渲染、计时器、`/api/health` 复查留在这里。
 */

/** 同时最多显示几条 —— 再多就变成刷屏，反而看不见。溢出的靠"任务中心"看。 */
const MAX_VISIBLE = 3;
/** 成功后停留多久自动消失。带动作的（blocked/failed/需重启）**永不自动消失**。 */
const SUCCESS_LINGER_MS = 8000;

/**
 * `job.blocked` / `job.failed` 只带 jobId，不带标题。
 *
 * 服务端补上 `job.created` 之后（T-130），正常情况下这里用不到 —— toast 已经有真实笔记标题了。
 * 保留它是**冗余而不是主路径**：SSE 重连时重放缓冲只有 256 条，
 * `job.created` 完全可能滚出去而 `job.blocked` 还在里面。那种时候宁可显示一个笼统的名字，
 * 也不能把"需要用户动手"的状态整条丢掉 —— 后者正是 T-130 那个"零报错的卡住"。
 * 未知 code 一律落到"后台任务"：宁可笼统，也不编一个具体但可能是错的名字。
 */
function blockedFallbackName(code: string, t: TFunction): string {
  if (code === 'MISSING_ASR_MODEL') return t('jobToast.blockedTranscribe');
  if (code === 'NO_TRANSCRIPT' || code === 'LLM_NOT_CONFIGURED')
    return t('jobToast.blockedMindmap');
  return t('jobToast.blockedGeneric');
}

/** 每个阶段的标题。四种 kind × 四个 phase，散在 JSX 三元里写不下第三层。 */
function titleFor(toast: Toast, t: TFunction, step?: string | null): string {
  const name = toast.name;
  if (toast.phase === 'done') {
    if (toast.kind === 'transcribe') return t('jobToast.doneTranscribe', { name });
    if (toast.kind === 'mindmap') return t('jobToast.doneMindmap', { name });
    return t(toast.kind === 'backend-pack' ? 'jobToast.doneBackend' : 'jobToast.doneModel', {
      name,
    });
  }
  if (toast.phase === 'failed') {
    // "安装失败"对一条转写任务是错的说法
    return t(isPipelineKind(toast.kind) ? 'jobToast.failedJob' : 'jobToast.failedTitle', { name });
  }
  if (toast.phase === 'blocked') return t('jobToast.blockedTitle', { name });
  if (toast.kind === 'transcribe') return t('jobToast.startedTranscribe', { name });
  if (toast.kind === 'mindmap') return t('jobToast.startedMindmap', { name });
  /*
   * ★ 用户 2026-08-09：「任务中心 正在安装 然后就没有后续进展了」。
   *
   * `Phase` 只有 `active|blocked|failed|done` 四挡，`active` 从 `job.created` 一路
   * 盖到终态 —— 于是一个后端包从**解析下载源、下载几百 MB、校验、解包**到真正安装，
   * 标题自始至终是「开始安装组件 · X」。而副行**已经**在准确地说「下载中」。
   * **两行互相打架时用户信标题**，所以他看到的是"安装卡住了"，
   * 而实际上那几分钟是在下载。
   *
   * 修法：下载/校验/解包这几段用**中性标题**（「正在准备 · X」），
   * 只有真的走到 `installing` 及以后才说"安装"。不新增 Phase ——
   * 那要动 `jobToastModel` 的状态机（别人在途），这里只按 step 分档，改动面最小。
   */
  const preparing =
    step === 'resolving' || step === 'downloading' || step === 'verifying' || step === 'unpacking';
  if (preparing) return t('jobToast.preparing', { name });
  return t(toast.kind === 'backend-pack' ? 'jobToast.startedBackend' : 'jobToast.startedModel', {
    name,
  });
}

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

  /**
   * 应用一条动作。
   *
   * 「这条事件能不能变成一条 toast」的规则住在 `jobToastModel.ts`（纯函数、可单测），
   * 这里只把它接到 React 状态与计时器上 —— 那条规则正是 T-130 的核心，
   * 埋在 useEffect 里就只能靠起浏览器点一遍来验证。
   */
  const apply = useCallback(
    (action: ToastAction) => {
      if (action.kind === 'dismiss') {
        dismiss(action.jobId);
        return;
      }
      setToasts((prev) => reduceToasts(prev, action));
      // 需重启的那一类要等 health 查完才决定是否自动消失（见下方 effect）
      if (action.kind === 'upsert' && action.settled) scheduleDismiss(action.jobId);
    },
    [dismiss, scheduleDismiss],
  );

  useEffect(() => {
    const names = {
      /**
       * `job.blocked` / `job.failed` 只带 jobId，不带标题。
       *
       * 服务端补上 `job.created` 之后（T-130），正常情况下这里用不到 —— toast 已经有真实笔记标题。
       * 保留它是**冗余而不是主路径**：SSE 重放缓冲只有 256 条，`job.created` 完全可能滚出去
       * 而 `job.blocked` 还在里面。那种时候宁可显示一个笼统的名字，
       * 也不能把"需要用户动手"的状态整条丢掉 —— 后者正是 T-130 那个"零报错的卡住"。
       */
      blocked: (code: string) => blockedFallbackName(code, t),
      failed: () => t('jobToast.failedFallback'),
    };
    const offs = (['job.created', 'job.state', 'job.blocked', 'job.failed'] as const).map((type) =>
      bus.on(type, (e) => apply(toastActionFor(type, e, names))),
    );
    return () => offs.forEach((off) => off());
  }, [apply, t]);

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
          prev.map((x) =>
            x.phase === 'done' && x.needsRestart === undefined ? { ...x, needsRestart: need } : x,
          ),
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
            prev.map((x) =>
              x.phase === 'done' && x.needsRestart === undefined
                ? { ...x, needsRestart: false }
                : x,
            ),
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
          <p className="truncate text-sm font-medium text-ink">{titleFor(toast, t, step)}</p>

          {/* 阶段名 + 字节 + 速度 + ETA。全部用 tabular-nums，数字跳动时不抖行宽。 */}
          {toast.phase === 'active' ? (
            <p className="mt-0.5 text-xs text-ink-secondary">
              <span>
                {/* 收敛到共享实现：此前缺词条会回退成「排队中」—— 那是**阶段倒退**，
                    比显示英文更坏（用户会以为进度倒回去了）。见 lib/format/stepLabel。 */}
                {stepLabelOf(step ?? toast.state, t, (k: string) => i18n.exists(k))}
              </span>
              {total ? (
                <span className="tabular-nums">
                  {' · '}
                  {formatBytes(completed, locale)} / {formatBytes(total, locale)}
                </span>
              ) : null}
              {live?.speedBps ? (
                <span className="tabular-nums">{` · ${formatSpeed(live.speedBps, locale)}`}</span>
              ) : null}
              {eta && !verifying ? <span className="tabular-nums">{` · ${eta}`}</span> : null}
            </p>
          ) : null}

          {(toast.phase === 'blocked' || toast.phase === 'failed') &&
          (toast.reason || toast.reasonEn) ? (
            <p
              className={cn(
                'mt-0.5 text-xs',
                toast.phase === 'failed' ? 'text-critical' : 'text-ink-secondary',
              )}
            >
              {/* 服务端两份文案都给了；无条件取中文会让英文界面上冒出一句中文（实测见过） */}
              {locale.startsWith('zh')
                ? (toast.reason ?? toast.reasonEn)
                : (toast.reasonEn ?? toast.reason)}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('jobToast.dismiss')}
          className="-m-1 shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-fill-hover hover:text-ink"
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
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
        {subtitleFor(toast, step, t)}
      </p>

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
    // 「去捕获页粘一个链接就能转写」对一条**刚转写完**的任务是句废话
    if (isPipelineKind(toast.kind)) return t('jobToast.doneNoteHint');
    return t(toast.kind === 'backend-pack' ? 'jobToast.doneBackendHint' : 'jobToast.doneModelHint');
  }
  if (toast.willRetry) {
    return t('jobToast.retryingHint', { attempt: toast.attempt ?? 1, max: toast.maxAttempts ?? 1 });
  }
  if (step === 'verifying') return t('jobToast.verifyingHint');
  if (step === 'installing') return t('jobToast.installingHint');
  /*
   * ★ T-172：macOS 上装完后要把 Metal 着色器缓存捂热，实测十几秒（真机 UNKNOWN）。
   * 这一步进度条已经满格且不动 —— 不说这一句，用户看到的就是"装完了但卡死了"。
   */
  if (step === 'warming') return t('jobToast.warmingHint');
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
    /*
     * 流水线任务完成后唯一有意义的出口是**那条笔记**，不是模型页。
     * 没有 noteUid（理论上不该发生）就不给按钮，而不是给一个点了跳到模型页的假出口。
     */
    if (isPipelineKind(toast.kind)) {
      return toast.noteUid ? (
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onDismiss();
              navigate(`/notes/${toast.noteUid ?? ''}`);
            }}
            data-testid="job-toast-goto-note"
          >
            {t('jobToast.gotoNote')}
          </Button>
        </div>
      ) : null;
    }
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
              void rawFetch('/api/daemon/restart', { method: 'POST' }).catch(() =>
                setRestarting(false),
              );
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
          <RemediationButton
            remediation={toast.remediation}
            variant="secondary"
            /*
             * 关掉提示条要在跳转**之前**发生，所以这里接管点击而不是让按钮自己跳。
             * 但落点仍然来自那一份共享表 —— 接管的是"点完还要做什么"，
             * 不是"该去哪"（该去哪只准有一个答案）。
             */
            onAct={(r) => {
              onDismiss();
              const to = remediationTarget(r);
              if (to !== null) void navigate(to);
            }}
          />
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

/*
 * ⚠️ 这里原本有第二张 `remediation.action → 路由` 表（T-140 删）。
 *
 * 它和 `RemediationButton` 那张对同一个 action 给不同答案：
 * `configure_api_key` 这边去 `/settings/llm`、那边去 `/settings`；
 * default 这边 `/tasks`、那边 `/models`。而**两张表加起来认识的 5 个 action 里，
 * daemon 真正会发的只有 3 个** —— 它真正会发的 `installSiteExtractor`
 * （yt-dlp 缺失）两边都不认识，一起落进各自的 default。
 *
 * 现在唯一一份在 `lib/remediation/routes.ts`，且有护栏扫 daemon 源码对表。
 */
