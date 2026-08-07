import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RotateCw, ZapOff } from 'lucide-react';
import { breakerDetail, breakerAdvice, breakerTripped } from '@openmemo/shared';
import type { BreakerCopyInput, GetHardwareResponse } from '@openmemo/shared';

import { Button } from '../../../components/common/Button';
import { useBreakerQuery, useBreakerResetMutation } from '../api';

/**
 * 断路器提示 —— **运行时页上"GPU 加速为什么不工作"的唯一解释**（T-174）。
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
 * 组件只负责排版、状态机和那个按钮。`packages/runtime/src/selfcheck.test.ts` 里
 * 那批钉措辞的断言因此顺带守着这一页。
 *
 * 唯一由本组件提供的文案是**外壳**（标题、按钮字样、计秒），走 i18n catalog；
 * 断路器本身要说的三件事（停用了什么 / 为什么 / 多久之后重试）一律来自 shared。
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

  /*
   * 每秒重算一次，倒计时才会真的在动。
   *
   * ★ 只在**跳闸时**开这个 interval：绝大多数机器上断路器一辈子不跳，
   * 不该为一个永远不显示的组件每秒 setState 一次。
   * tick 只是用来让 `Date.now()` 被重新读取，值本身没有意义。
   */
  const [, setTick] = useState(0);

  /*
   * 手动重试的**已用秒数**。
   *
   * ⚠️ 为什么显示"已用 N 秒"而不是"最长约 10 秒"的静态文案：那个 10 来自 daemon 的
   * `PROBE_TIMEOUT_MS`，前端硬编一份就会漂。`probe.timeoutMs` 确实随响应发过来了
   * （所以下面用得上它），但只在**拿到过硬件响应**时才有 —— 计秒不依赖它，任何时候都能显示。
   */
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number>(0);

  // 实时那份优先；还没回来时用硬件响应里的快照兜底，避免首屏闪一下空白
  const source: BreakerCopyInput & { verdict: string; blacklistedBackends: string[] } | null =
    breaker.data !== undefined
      ? {
          verdict: breaker.data.verdict,
          blacklistedBackends: breaker.data.blacklistedBackends,
          consecutiveFailures: breaker.data.breaker.consecutiveFailures,
          lastError: breaker.data.breaker.lastError,
          retryAt: breaker.data.retryAt,
          recovering: breaker.data.recovering,
        }
      : hardwareRuntime !== undefined
        ? {
            verdict: hardwareRuntime.breaker.verdict,
            blacklistedBackends: hardwareRuntime.blacklistedBackends,
            consecutiveFailures: hardwareRuntime.breaker.consecutiveFailures,
            lastError: hardwareRuntime.breaker.lastError,
            retryAt: hardwareRuntime.breaker.retryAt,
            recovering: hardwareRuntime.breaker.recovering,
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

  useEffect(() => {
    if (!reset.isPending) return;
    startedAt.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [reset.isPending]);

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
  const budgetMs = hardwareRuntime?.probe.timeoutMs;

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

          {/* "你不用动手" —— 与自检 remediation 同源，只是去掉了那条给 CLI 用的 URL */}
          <p className="mt-1.5 text-xs text-ink-muted">{zh ? advice.zh : advice.en}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              /*
               * ★ 按下去之后**必须**变样。这一发是同步的（daemon 就地跑一发探测，
               * 交互预算 10 s），期间界面什么都不变的话用户会连点 ——
               * 而连点正是 daemon 侧单飞机制要防的东西。
               */
              disabled={reset.isPending}
              data-testid="runtime-breaker-retry"
              onClick={() => {
                reset.mutate();
              }}
            >
              {reset.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCw className="size-3.5" aria-hidden />
              )}
              {reset.isPending ? t('runtime.breaker.retrying') : t('runtime.breaker.retry')}
            </Button>

            {reset.isPending ? (
              <span className="text-xs text-ink-muted" data-testid="runtime-breaker-elapsed">
                {budgetMs === undefined
                  ? t('runtime.breaker.elapsed', { s: elapsed })
                  : t('runtime.breaker.elapsedOfBudget', {
                      s: elapsed,
                      budget: Math.round(budgetMs / 1000),
                    })}
              </span>
            ) : null}
          </div>

          {/*
            重试**失败**也必须说出来。
            这里最容易长出来的 bug 是"点了没反应"：请求回来了、断路器还是开着，
            如果界面只是把 spinner 收掉，用户完全无法区分"点了没生效"和"点了但没修好"。
          */}
          {reset.isError ? (
            <p className="mt-2 text-xs text-critical" data-testid="runtime-breaker-error">
              {t('runtime.breaker.retryFailed')}
            </p>
          ) : null}
          {reset.isSuccess && tripped ? (
            <p className="mt-2 text-xs text-ink-secondary" data-testid="runtime-breaker-still">
              {t('runtime.breaker.stillDisabled')}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
