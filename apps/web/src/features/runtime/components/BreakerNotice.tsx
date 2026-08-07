import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RotateCw, ZapOff } from 'lucide-react';
import { breakerDetail, breakerAdvice, breakerTripped } from '@openmemo/shared';
import type { BreakerCopyInput, GetHardwareResponse } from '@openmemo/shared';

import { Button } from '../../../components/common/Button';
import { useBreakerQuery, useBreakerResetMutation, useHardwareRefresh } from '../api';

/**
 * 断路器提示 —— **运行时页上"GPU 加速为什么不工作"的唯一解释**（T-174 / T-175）。
 *
 * ## 它补的是什么洞
 *
 * 断路器连续两次探测失败就停用全部加速后端，此前这在界面上是**零报错的静默降级**：
 * daemon 一直随 `/api/runtime/hardware` 发 `runtime.breaker`，但前端把响应断言成
 * 不含它的窄契约，字段在类型边界上就被丢掉了 —— 全仓前端引用数 **0**。
 * 用户看到的是"GPU 加速就是不工作"，而唯一的解释躺在他不会去看的自检页里。
 *
 * ## 措辞不在这里，在 `@openmemo/shared`
 *
 * `breakerDetail()` / `breakerAdvice()` 与自检的 `hw.breaker` 是**同一个函数**。
 * 两处各写一遍就是下一次不一致的种子（本仓吃过很多次），所以这里一个字都不自己编：
 * 组件只负责排版、状态机和那个按钮。
 *
 * ## ★ T-175：进度是**服务端的**，不是这个组件的
 *
 * 手点「立刻重试」现在与冷却到期走同一条路（后台 90 s 单飞），所以
 * "正在重试"这件事**不是本组件的 mutation 状态**，而是 daemon 的 `recovering`；
 * 已等多久由 `recoveryStartedAt`（服务端时刻）算出来。于是：
 *   - 用户**切走再回来**，进度还在（不是从 0 重数）；
 *   - **自动恢复**与**手点**长得完全一样（用户不需要知道这一发是谁起的）；
 *   - 另开一个标签页看到的是同一个进度。
 */
export function BreakerNotice({
  locale,
  hardwareRuntime,
}: {
  locale: string;
  /** 硬件响应里的 `runtime` 快照。只用于**首屏兜底**，见下面的 `source`。 */
  hardwareRuntime?: GetHardwareResponse['runtime'];
}) {
  const { t } = useTranslation();
  const zh = locale.toLowerCase().startsWith('zh');
  const breaker = useBreakerQuery();
  const reset = useBreakerResetMutation();
  const refreshHardware = useHardwareRefresh();

  /*
   * 每秒重算一次，倒计时/计秒才会真的在动。
   * 只在跳闸时开这个 interval：绝大多数机器上断路器一辈子不跳。
   * tick 只是让 `Date.now()` 被重新读取，值本身没有意义。
   */
  const [, setTick] = useState(0);

  // 实时那份优先；还没回来时用硬件响应里的快照兜底，避免首屏闪一下空白
  const live = breaker.data;
  const snap = hardwareRuntime;
  const source:
    | (BreakerCopyInput & {
        verdict: string;
        blacklistedBackends: string[];
        recoveryStartedAt: string | null;
        recoveryTimeoutMs: number;
      })
    | null =
    live !== undefined
      ? {
          verdict: live.verdict,
          blacklistedBackends: live.blacklistedBackends,
          consecutiveFailures: live.breaker.consecutiveFailures,
          lastError: live.breaker.lastError,
          retryAt: live.retryAt,
          recovering: live.recovering,
          recoveryStartedAt: live.recoveryStartedAt,
          recoveryTimeoutMs: live.recoveryTimeoutMs,
        }
      : snap !== undefined
        ? {
            verdict: snap.breaker.verdict,
            blacklistedBackends: snap.blacklistedBackends,
            consecutiveFailures: snap.breaker.consecutiveFailures,
            lastError: snap.breaker.lastError,
            retryAt: snap.breaker.retryAt,
            recovering: snap.breaker.recovering,
            recoveryStartedAt: snap.breaker.recoveryStartedAt,
            recoveryTimeoutMs: snap.breaker.recoveryTimeoutMs,
          }
        : null;

  const tripped = source !== null && breakerTripped(source.verdict, source.blacklistedBackends);

  useEffect(() => {
    if (!tripped) return;
    const id = setInterval(() => {
      setTick((n) => n + 1);
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [tripped]);

  /*
   * ★ 恢复成功的那一刻，把硬件重探一次。
   *
   * daemon 侧硬件响应带缓存，恢复探测只改断路器 state、**不动那份缓存**。
   * 不补这一发的话：提示块消失了（它读的是实时端点），而上面那排后端芯片还是灰的 ——
   * 用户刚被告知"好了"，看到的却是"还是不可用"。
   *
   * `useRef` 记住上一次是不是跳闸的，**只在 true → false 那一次跳变时**打一发，
   * 不是每次渲染都打（那会变成一个自己给自己发请求的循环）。
   */
  const wasTripped = useRef(false);
  useEffect(() => {
    if (wasTripped.current && !tripped) void refreshHardware();
    wasTripped.current = tripped;
  }, [tripped, refreshHardware]);

  /*
   * 没跳闸就**什么都不渲染**。
   *
   * 这里不做"一切正常"的绿色提示：运行时页上后端芯片行已经说了哪个后端在用，
   * 再加一条恒常绿条只会让真正跳闸时的那条提示更容易被当成背景噪音。
   */
  if (!tripped || source === null) return null;

  // ★ 与自检 `hw.breaker` 同一个函数、同一份措辞
  const detail = breakerDetail(source);
  const advice = breakerAdvice();

  /*
   * ★「正在重试」以**服务端**的 `recovering` 为准，不是 `reset.isPending`。
   *
   * `reset.isPending` 只覆盖那一个立刻返回的 HTTP 请求（几十毫秒），
   * 而用户要等的是后台那 90 秒。两者都算"忙"，但**进度只能来自服务端**。
   * 手点与自动恢复因此长得完全一样 —— 这正是要的：用户不需要知道是谁起的这一发。
   */
  const recovering = source.recovering;
  const busy = recovering || reset.isPending;

  const startedAt = source.recoveryStartedAt === null ? null : Date.parse(source.recoveryStartedAt);
  const elapsedS =
    startedAt === null || Number.isNaN(startedAt)
      ? null
      : Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  // 「最长约 N 秒」的 N 取自 daemon 自己报的预算，前端不硬编那个 90
  const budgetS = Math.round(source.recoveryTimeoutMs / 1000);

  return (
    <section
      // 降级态要让屏幕阅读器播报（D-05 §6.3）；polite 而非 assertive：CPU 兜底还在，产品能用
      role="status"
      aria-live="polite"
      data-testid="runtime-breaker-notice"
      className="rounded-lg border border-l-4 border-line border-l-warning bg-surface-1 p-4"
    >
      <div className="flex items-start gap-3">
        <ZapOff className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-ink">{t('runtime.breaker.title')}</h3>

          {/* 停用了什么 / 为什么 / 多久之后重试 —— 一整句，来自 shared */}
          <p className="mt-1 text-xs break-words text-ink-secondary">{zh ? detail.zh : detail.en}</p>

          {/*
            "你不用动手" —— 与自检 remediation 同源，只是去掉了那条给 CLI 用的 URL。

            ★ **正在重试时不显示它。** 这句话说的是"到点会自动重试"，而此刻已经在重试了：
            留着既重复（详情句里已经有"成功即自动恢复"），又轻微地说错话
            （用户会以为还要再等一个"到点"）。正在重试时它的位置让给"可以离开这个页面"。
          */}
          {!recovering ? (
            <p className="mt-1.5 text-xs text-ink-muted">{zh ? advice.zh : advice.en}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              /*
               * ★ 正在重试时按钮是禁用的 —— 这就是「单飞与手点共存」在界面上的样子：
               * 用户根本点不出第二发。真撞上并发（比如两个标签页），daemon 侧也只是
               * **加入等待**，不会起第二个探针、也不会报错。
               */
              disabled={busy}
              data-testid="runtime-breaker-retry"
              onClick={() => {
                reset.mutate();
              }}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCw className="size-3.5" aria-hidden />
              )}
              {busy ? t('runtime.breaker.retrying') : t('runtime.breaker.retry')}
            </Button>

            {busy ? (
              <span className="text-xs text-ink-muted" data-testid="runtime-breaker-elapsed">
                {elapsedS === null
                  ? t('runtime.breaker.starting')
                  : t('runtime.breaker.elapsedOfBudget', { s: elapsedS, budget: budgetS })}
              </span>
            ) : null}
          </div>

          {/*
            这一句只在**正在重试**时出现，说清"你可以走开"。
            90 秒比 10 秒更需要这句话：没有它，用户会守在页面上盯着一个转圈。
          */}
          {recovering ? (
            <p className="mt-2 text-xs text-ink-muted" data-testid="runtime-breaker-leaveable">
              {t('runtime.breaker.leaveable')}
            </p>
          ) : null}

          {/*
            重试**失败**也必须说出来。
            这里最容易长出来的 bug 是"点了没反应"：请求回来了、断路器还是开着，
            如果界面只是把转圈收掉，用户完全无法区分"点了没生效"和"点了但没修好"。
          */}
          {reset.isError ? (
            <p className="mt-2 text-xs text-critical" data-testid="runtime-breaker-error">
              {t('runtime.breaker.retryFailed')}
            </p>
          ) : null}
          {reset.isSuccess && !busy && tripped ? (
            <p className="mt-2 text-xs text-ink-secondary" data-testid="runtime-breaker-still">
              {t('runtime.breaker.stillDisabled')}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
