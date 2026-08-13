/*
 * ★★ T-195：从 `features/models/components/` **提升**到这里。
 *
 * 理由是 ESLint 的 `no-restricted-imports` 直接写下的那条：
 * 「features/A 不得 import features/B（D-05 §3.5）。需要复用请把组件**提升**到
 *   components/common/，并在 inbox 写 SHARED-CHANGE 申报。」
 *
 * 后端包的下载与模型下载走的是**同一个 `DownloadQueue`、同一份 `DownloadJob`**，
 * 所以「运行时」页要的不是"长得像的另一个组件"，就是这一个。
 * 它刚从**四份实现收敛成一份**（`d145aa8`）—— 再抄一份就是第五份，
 * 而四份各自漂（同一个 job 在两个页面上说两句矛盾的阶段文案）正是那次要修的病。
 *
 * 文件内容除相对路径外**一字未改**。
 */
import { useTranslation } from 'react-i18next';
import { Ban, RefreshCw, ShieldCheck } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { TERMINAL_JOB_STATES, type DownloadJob } from '@openmemo/shared';
import { Button } from './Button';
import { ProgressMeter } from './ProgressMeter';
import { StatusChip } from './StatusChip';
import { useProgressStore } from '../../lib/stores/progress.store';
import { formatBytes, formatSpeed } from '../../lib/format/bytes';
import { stepLabel } from '../../lib/format/stepLabel';
import { pickLocalized } from '../../lib/format/localized';
import { jobDisplayName } from '../../lib/format/jobName';
import { useJobCatalogNames } from '../../lib/catalog/useJobCatalogNames';

/**
 * 下载中的一行（R-04 §9.3 线框）。
 *
 * ★ 进度**只从 transient store 读，不从 Query 缓存读**（D-05 §2.4）：
 * 用 selector 只订阅自己那一个 jobId，别的任务刷新不会让这一行重渲染。
 * store 内部已节流到 200ms，服务端也限流到 4 次/秒/job。
 */

/*
 * ★ 这里原本有一张 `STEP_KEY` 表 + 一整套 `models.download.*` 阶段词条 ——
 *   **和 `progress.*` 是同一件事的第二份实现。**
 *
 * 后果不是"多写了几行"，是**两份实现会各自漂**：`[实测]` 收敛前
 * `warming` 在两套词条里是两句不同的中文，`unpacking` 一度只有其中一套有；
 * 而三个渲染点（任务中心 / Toast / 这一行）读的是不同的套，
 * 于是同一时刻同一个 job，两个页面可以说两句互相矛盾的话。
 *
 * 现已收敛到 `lib/format/stepLabel.ts` —— **一份实现**。
 * 兜底也随之统一：缺词条时给中性的「处理中」，
 * **不是「排队中」**（那是在断言一件假事：进度倒退回起点），
 * **也不是原始英文 key**（把机器枚举值摆给用户看）。
 */
/** ETA 文案：D-05 §4.1 规则 4 —— 只在有依据时显示，且四舍五入到"约 X 分钟"。
 *  不显示"剩余 03:47"这种假精确：实测速率波动很大。 */
function formatEta(
  t: (k: string, o?: Record<string, unknown>) => string,
  sec: number | null,
): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  if (sec < 60) return t('models.download.etaUnderMinute');
  return t('models.download.etaMinutes', { minutes: Math.round(sec / 60) });
}

export interface DownloadRowProps {
  job: DownloadJob;
  locale: string;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}

/**
 * 服务端说这条任务**已经不在跑了** —— 这些状态下内存快照必然是陈旧的。
 *
 * ## 为什么不能直接用 `TERMINAL_JOB_STATES`
 *
 * 它只有 `succeeded|failed|cancelled` 三个，而 `JOB_TRANSITIONS`（shared 的权威表）
 * 明确允许 `running → paused` 与 `running|queued → blocked`。
 * 这两个恰恰是「服务端说停了、内存说还在跑」最典型的形态，用终态表一律漏掉。
 *
 * ## 为什么不能用 `isActiveJobState()`
 *
 * 它是**反过来的**：`lib/jobs/noteJobs.ts` 刻意把 `paused`/`blocked` 算作"还没结束"，
 * 因为它回答的是另一个问题——"笔记页还要不要继续说这件事"。拿它当这里的守卫，
 * 正好把要修的两种状态放行。**两个谓词长得像、答的不是同一个问题，不许互相顶替。**
 *
 * ## 为什么 `queued` **不**在表里
 *
 * `queued` 不是"停了"，是"还没开始"。这一档内存**合法地领先于服务端**
 * （刚 POST 完，5s 轮询还没把行刷成 running）。把它算进来会让刚点下去的下载
 * 倒退回 0% 并停住几秒 —— 那是拿一个真 bug 换一个假 bug。
 *
 * ## 诚实标注
 *
 * `[实测]` `DownloadQueue` 今天**并不产出** `paused`（它没有暂停实现，
 * `rest/jobs.ts` 对 pause/resume 直接回 501），`blocked` 也没有生产者。
 * 所以这两项现在是**照契约写的防线，不是照实现写的**——`JOB_TRANSITIONS` 允许它们，
 * 等哪天有人把暂停做出来，这一行不需要再被修一次。今天真正会踩到的是
 * `cancelled` / `failed`。
 */
const SERVER_SAYS_NOT_RUNNING: readonly string[] = [...TERMINAL_JOB_STATES, 'paused', 'blocked'];

export function DownloadRow({ job, locale, onCancel, onRetry }: DownloadRowProps) {
  const { t, i18n } = useTranslation();
  const liveRaw = useProgressStore(useShallow((s) => s.byJob[job.jobId]));
  // 名字按当前界面语言现算；兜底仍是 daemon 的 displayName（见 lib/format/jobName.ts）
  const catalogNames = useJobCatalogNames();
  const shownName = jobDisplayName(i18n.language, job, catalogNames);

  /*
   * ★ 影子守卫：**服务端行是新鲜的，一旦它说这活停了，内存快照就整份作废。**
   *
   * 下面六个字段原本都是 `live?.x ?? job.x` —— 内存快照**无条件胜过**服务端行。
   * 于是一条陈旧的 `running` 快照会同时压住 state / step / 速率 / 字节数 / ETA，
   * 连 `ratio` 也跟着继承陈旧值：任务已经取消了，这一行还在画
   * 「正在下载 · 45% · 3.2 MB/s」。**服务端已经把真相送到这个组件手上，代码主动丢掉。**
   *
   * ⚠️ 为什么不能指望 `features/tasks/sse.ts` 去清 store（它确实在终态清，两处都清）：
   * **那条路依赖事件真的送到**。SSE 掉一帧、页面在后台、多标签页——任意一种下
   * store 就留着残影，而且**再也不会自愈**（服务端不会重发已经发过的终态）。
   * 守卫不依赖任何事件送达，它只看服务端行现在怎么说。
   *
   * ⚠️ **刻意只做局部重绑，不抽公共 helper。** `features/tasks/api.ts:139` 有一段逐字
   * 相同的表达式，但两者的差别恰恰在**守卫处在哪一层**（那边在合并函数里、这边在组件里）。
   * 抽成函数会把这个差别藏起来，下次只改一处就又分叉。
   */
  const live = SERVER_SAYS_NOT_RUNNING.includes(job.state) ? undefined : liveRaw;

  const completed = live?.completedBytes ?? job.completedBytes;
  const total = live?.totalBytes ?? job.totalBytes;
  const step = live?.step ?? job.step;
  const state = live?.state ?? job.state;
  const speed = live?.speedBps ?? job.speedBps;
  const eta = formatEta(t, live?.etaSeconds ?? job.etaSeconds);
  const ratio = total ? Math.min(1, (completed ?? 0) / total) : 0;

  const isVerifying = step === 'verifying';
  const failed = state === 'failed';

  return (
    <div
      className="rounded-lg border border-line bg-surface-1 p-3"
      data-testid={`models-download-row-${job.targetId}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{shownName}</p>
          <p className="mt-0.5 text-xs text-ink-secondary">
            {failed ? (
              <span className="text-critical">
                {/*
                  #106：`messageZh ?? message` 让中文那一份**无条件胜出** ——
                  英文界面上这一行于是永远是中文。`JobList.tsx` 同一件事一直是
                  按语言挑的，这里是唯一的例外。
                */}
                {pickLocalized(i18n.language, job.error?.messageZh, job.error?.message) ||
                  t('models.download.failed')}
                {job.attempt > 1
                  ? t('models.download.attempt', { attempt: job.attempt, max: job.maxAttempts })
                  : ''}
              </span>
            ) : (
              <>
                {/*
                  `step` 为空 = 这个 job **真的还在排队**（不是词条缺失），
                  所以这一档仍然说「排队中」—— 那是事实。
                  词条缺失那一档由 `stepLabel` 兜成「处理中」。两者别混。
                */}
                {step
                  ? stepLabel(step, t, (k: string) => i18n.exists(k))
                  : t('progress.state.queued')}
                {job.provider
                  ? ` · ${t('models.download.source', { provider: job.provider })}`
                  : ''}
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isVerifying ? (
            <StatusChip
              tone="running"
              label={t('models.download.verifyingChip')}
              icon={<ShieldCheck className="size-3.5" />}
            />
          ) : null}
          {failed ? (
            <Button size="sm" variant="secondary" onClick={() => onRetry(job.jobId)}>
              <RefreshCw className="size-3.5" aria-hidden />
              {t('models.download.retry')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onCancel(job.jobId)}
              data-testid="models-download-cancel"
            >
              <Ban className="size-3.5" aria-hidden />
              {t('models.download.cancel')}
            </Button>
          )}
        </div>
      </div>

      <ProgressMeter
        className="mt-2"
        value={ratio}
        tone={failed ? 'critical' : 'info'}
        // 校验阶段没有可信百分比 —— 显示脉动而不是假装有进度
        indeterminate={isVerifying}
        label={t('models.download.progressLabel', { name: shownName })}
      />

      <div className="mt-1.5 flex items-center justify-between text-xs text-ink-secondary">
        <span className="tabular-nums">
          {formatBytes(completed ?? 0, locale)} / {formatBytes(total ?? 0, locale)}
          {total ? ` · ${Math.round(ratio * 100)}%` : ''}
        </span>
        <span className="tabular-nums">
          {speed ? formatSpeed(speed, locale) : ''}
          {eta ? ` · ${eta}` : ''}
        </span>
      </div>
    </div>
  );
}
