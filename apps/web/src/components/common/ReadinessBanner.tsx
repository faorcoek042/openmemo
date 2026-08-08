import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { AlertTriangle, ChevronDown, ChevronRight, XCircle } from 'lucide-react';

import { rawFetch } from '../../lib/api/client';
import { useConnectionStore } from '../../lib/stores/connection.store';
import {
  detectBlockedCapabilities,
  isSecureContext,
  localhostEquivalent,
} from '../../lib/secure-context';
import { Button } from './Button';
import { Emphasis } from './Emphasis';
import { worstTone, type StatusTone } from './statusTone';

/**
 * 「能力未就绪」**唯一一条**横幅（T-107）。
 *
 * ## 它替换掉了什么
 *
 * 之前顶部会同时堆出七八行：三条 health 降级（分词/向量/转写组件）、
 * 一条安全上下文横幅（自己又展开四行）、外加一条 `multiTab`。
 * 而 `multiTab` 和安全上下文横幅里的 "webLocks 不可用" **是同一件事说两遍**，
 * 安全上下文那段更是把结论、原因、办法三样全摊在首屏上。
 *
 * 用户的原话是「打开页面顶部一堆报错」——**他看到的是刷屏，不是信息**。
 *
 * ## 三条设计约束（都来自这次反馈）
 *
 * 1. **默认什么都不说。** 一切就绪时**渲染 `null`**；有问题时也只占**一行**，
 *    点开才展开明细。这是本地自用工具，用户反复说过"别搞那么复杂"。
 * 2. **可修复的配置状态 ≠ 产品缺陷。** 分词器没装是"去装一下"，
 *    不该像崩溃那样长期霸占首屏。所以每一项都带**可点的动作**，
 *    而不是只陈述一句让人干着急的事实。
 * 3. **能自己消失就自己消失。** 数据源是 `/api/health` 轮询 + 运行时特性检测，
 *    装好 / 换成 localhost 之后横幅自行消失，不需要谁回来删代码。
 *
 * ⚠️ 我之前写过"给可点的动作而不是让用户猜"，但那一版把七行文字全铺开了 ——
 * **七行文字不是动作，是墙。** 这次的教训：可操作性和信息量是两回事，
 * 前者要的是一个按钮，不是一段说明。
 */

interface HealthDegradation {
  db?: { extensions?: { tokenizer?: string; libsimple?: boolean; sqliteVec?: boolean } };
  pipeline?: { missing?: string[] };
  restartRequired?: { required?: boolean; extensions?: string[]; endpoint?: string };
}

export interface ReadinessItem {
  key: string;
  /** 一行结论。**不含原因和办法** —— 那些进 `hint`，只在展开时出现。 */
  text: string;
  hint?: string;
  /**
   * T-135：**逐项明细**，只在展开态出现。
   *
   * 折叠态仍然是一行（上面那条约束没变），但"到底是哪几项"不能只活在
   * 一个计数里 —— 见下面 `secure-context` 那一段的说明。
   * 每一条按 `<Emphasis>` 渲染：词条里的 `**…**` 是写文案的人挑出来的重点，
   * 直接吐给用户就是裸星号（`components/common/Emphasis.tsx`）。
   */
  details?: readonly string[];
  actionLabel?: string;
  onAction?: () => void;
  /**
   * T-114：严重度必填。
   *
   * 之前折叠态的图标写死 `text-warning`（琥珀 = "该修一下"），
   * 但同一件「流水线缺件」在诊断页是 `fail`（红 = "这坏了"）——
   * **条幅报的严重度比真相轻**，用户据此判断"不急"，点进去才发现根本跑不了。
   * 条幅的全部作用就是预警，报轻了等于没报。
   */
  tone: StatusTone;
}

export function ReadinessBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const multiTabDegraded = useConnectionStore((s) => s.multiTabDegraded);

  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: async (): Promise<HealthDegradation | null> => {
      try {
        const res = await rawFetch('/api/health');
        return res.ok ? ((await res.json()) as HealthDegradation) : null;
      } catch {
        // daemon 没起 —— 由连通性摘要负责，这里不抢着报第二遍
        return null;
      }
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const items: ReadinessItem[] = [];

  /* ── 1. 环境能力（安全上下文）── */
  if (!isSecureContext()) {
    const blocked = detectBlockedCapabilities();
    if (blocked.length > 0) {
      const local = localhostEquivalent();
      /*
       * ★ 合并成**一条**。
       *
       * 原来这里是「安全上下文横幅」+「multiTab 横幅」两条，前者内部还列四行。
       * 但对用户而言这就是一件事：**这个地址下有几个浏览器功能用不了**。
       * `multiTab` 只是它的一个后果，不配单独占一行 —— 已从 App.tsx 移除。
       */
      items.push({
        key: 'secure-context',
        tone: 'warning',
        text: t('readiness.items.secureContext', { count: blocked.length }),
        hint: t('readiness.items.secureContextHint'),
        /*
         * ★ T-135：**逐项列出来，而不是只给一个数字。**
         *
         * `detectBlockedCapabilities()` 一直就是逐项算的（`lib/secure-context.ts`
         * 明写着"按实际 undefined 来报，用户看到的才是他真正失去的那几项"），
         * 而这里此前**只取了 `blocked.length`** 去填计数文案 ——
         * 逐项结论连同 `secureContext.caps.*` 四条词条一起被算出来又扔掉了。
         *
         * 这不是文案粗糙，是**信息算出来了不给**：四项里只有「麦克风」是
         * **功能级不可用**（F3 录音在这个地址下根本跑不了），其余三项是体验降级。
         * 用户看到「有 3 项能力不可用」时，没有任何办法知道自己撞上的是哪一档 ——
         * 而这正是他要决定"要不要换地址"的唯一依据。
         *
         * 顺序就是 `detectBlockedCapabilities()` 的顺序：麦克风在最前，
         * 那条既有断言（"录音排在最前 —— 它是唯一功能级不可用的"）在这里继续生效。
         */
        details: blocked.map((c) => t(`secureContext.caps.${c.key}`)),
        ...(local
          ? {
              actionLabel: t('secureContext.tryLocalhost'),
              onAction: () => window.location.assign(local),
            }
          : {}),
      });
    }
  } else if (multiTabDegraded) {
    // 安全上下文正常却仍然没有 Web Locks（很旧的浏览器）—— 这时才单独说
    items.push({ key: 'multi-tab', tone: 'warning', text: t('readiness.items.multiTab') });
  }

  /* ── 2. 后端能力（health 轮询）── */
  const ext = data?.db?.extensions;
  const missing = data?.pipeline?.missing ?? [];
  const pendingRestart =
    data?.restartRequired?.required === true ? (data.restartRequired.extensions ?? []) : [];
  const awaits = (n: string) => pendingRestart.includes(n);

  // ★ 「装好了待重启」优先：否则会把已经装好的用户送回去再装一遍（装了也出不去的圈）
  if (pendingRestart.length > 0) {
    items.push({
      key: 'restart',
      tone: 'warning',
      text: t('health.restartRequired', { items: pendingRestart.join('、') }),
      actionLabel: restarting ? t('health.restarting') : t('health.restartNow'),
      onAction: () => {
        setRestarting(true);
        void rawFetch(data?.restartRequired?.endpoint ?? '/api/daemon/restart', {
          method: 'POST',
        }).catch(() => setRestarting(false));
      },
    });
  }
  if (ext?.libsimple === false && !awaits('libsimple')) {
    items.push({
      key: 'tokenizer',
      tone: 'warning',
      text: t('readiness.items.tokenizer'),
      hint: t('health.tokenizerDegraded', { tokenizer: ext.tokenizer ?? 'trigram' }),
      actionLabel: t('health.fix'),
      onAction: () => navigate('/runtime'),
    });
  }
  if (ext?.sqliteVec === false && !awaits('sqlite-vec') && !awaits('sqliteVec')) {
    items.push({
      key: 'vec',
      tone: 'warning',
      text: t('readiness.items.vec'),
      hint: t('health.semanticDisabled'),
      actionLabel: t('health.fix'),
      onAction: () => navigate('/runtime'),
    });
  }
  if (missing.length > 0) {
    items.push({
      key: 'pipeline',
      // 缺 ffmpeg / ASR 引擎 = 转写这件事**根本跑不了**，与诊断页的 `fail` 对齐
      tone: 'critical',
      text: t('readiness.items.pipeline'),
      hint: t('health.pipelineMissing', { items: missing.join(', ') }),
      actionLabel: t('health.fix'),
      onAction: () => navigate(missing.includes('asr-model') ? '/models' : '/runtime'),
    });
  }

  // ★ 一切就绪 = 一个像素都不占
  if (items.length === 0) return null;

  // 汇总取最严重的一条，不取第一条也不写死（statusTone.ts）
  const worst = worstTone(items.map((i) => i.tone));

  return (
    <div role="status" aria-live="polite" className="border-b border-b-line bg-surface-1 text-xs">
      {/* ── 折叠态：一行 ── */}
      <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-4 py-1">
        {worst === 'critical' ? (
          <XCircle className="size-3.5 shrink-0 text-critical" aria-hidden />
        ) : (
          <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden />
        )}
        <span className="min-w-0 truncate text-ink-secondary">
          {t('readiness.summary', { count: items.length })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="-my-0.5 h-5 shrink-0 px-1.5 text-xs text-accent-ink hover:text-accent-ink"
          data-testid="readiness-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {open ? t('readiness.hide') : t('readiness.details')}
        </Button>
        {/*
          ★ 与 `AsrModelPicker` 的「去安装模型」是**同一个形状**（真浏览器横扫查出来的）：
          这个横幅在**每一页**都渲染，包括 `/diagnostics` 本身 ——
          在那一页上点它就是 `navigate` 到你已经在的地方，**什么都不会发生**。
          `[真浏览器实测]` URL 没变、DOM 没变、0 个 /api 请求、0 条异常。
          已经在目标页上就别渲染它，而不是留一个点不动的按钮。
        */}
        {location.pathname.startsWith('/diagnostics') ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="-my-0.5 ml-auto h-5 shrink-0 px-1.5 text-xs"
            onClick={() => navigate('/diagnostics')}
          >
            {t('diagnostics.title')}
          </Button>
        )}
      </div>

      {/* ── 展开态：明细 + 每项一个动作 ── */}
      {open ? (
        <ul className="mx-auto w-full max-w-5xl px-4 pb-1.5" data-testid="readiness-details">
          {items.map((it) => (
            <li key={it.key} className="flex items-start gap-2 border-t border-line/60 py-1">
              {/* 展开后每条也要带自己的严重度 —— 否则用户看不出四条里哪条是"坏了" */}
              {it.tone === 'critical' ? (
                <XCircle className="mt-0.5 size-3 shrink-0 text-critical" aria-hidden />
              ) : (
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-ink-secondary">{it.text}</div>
                {/* 原因只在展开后出现 —— 折叠态一个字都不占 */}
                {it.hint ? <div className="mt-0.5 text-ink-muted">{it.hint}</div> : null}
                {/* 逐项明细：算出来的东西必须给得出来，不能只剩一个计数 */}
                {it.details && it.details.length > 0 ? (
                  <ul className="mt-1 space-y-0.5" data-testid={`readiness-caps-${it.key}`}>
                    {it.details.map((d) => (
                      <li key={d} className="flex gap-1.5 text-ink-muted">
                        <span className="select-none text-ink-muted" aria-hidden>
                          ·
                        </span>
                        <Emphasis text={d} className="min-w-0" />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {it.onAction ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-my-0.5 h-5 shrink-0 px-1.5 text-xs text-accent-ink hover:text-accent-ink"
                  data-testid={`readiness-action-${it.key}`}
                  onClick={it.onAction}
                >
                  {it.actionLabel}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
