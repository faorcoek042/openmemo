import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  HardDrive,
  OctagonAlert,
  XCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { FitResult, FitTier } from '@openmemo/shared';
import { cn } from '../../lib/utils';
import { pickLocalized } from '../../lib/format/localized';

/**
 * "这台机器能跑吗" 徽标（章程要求 2.2 的核心可视化）。
 *
 * ★ 硬规则：**只渲染，绝不重算。**
 * `packages/shared/src/api.ts` 的注释写得很直白 —— fitness 由服务端算好下发，
 * 前端再实现一套判断迟早会和 `fitness.ts` 漂移，而且出问题时分不清是哪一层算错的。
 * 因此本组件只接收 `FitResult`，不接收硬件参数，**从类型上就没法重算**。
 *
 * ★ 硬规则：**状态绝不只用颜色。**
 * 明档 `--status-warning` 对比度 1.79:1、`--status-serious` 2.57:1，都低于 3:1。
 * 所以图标 + 文字标签是必需的，不是装饰（同 `StatusChip` 的取舍）。
 */

/** ⚠️ 表里存**词条 key** 而不是文案：存文案的话切语言不会重算这张模块级常量表。 */
const TIER_STYLE: Record<FitTier, { text: string; icon: ReactNode; labelKey: string }> = {
  recommended: {
    text: 'text-good',
    icon: <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />,
    labelKey: 'models.fit.recommended',
  },
  slow_partial: {
    text: 'text-warning',
    icon: <AlertTriangle className="size-3.5 shrink-0" aria-hidden />,
    labelKey: 'models.fit.slow',
  },
  slow_cpu: {
    text: 'text-warning',
    icon: <AlertTriangle className="size-3.5 shrink-0" aria-hidden />,
    labelKey: 'models.fit.slow',
  },
  unsupported: {
    text: 'text-critical',
    icon: <XCircle className="size-3.5 shrink-0" aria-hidden />,
    labelKey: 'models.fit.unsupported',
  },
  blocked_disk: {
    text: 'text-serious',
    icon: <HardDrive className="size-3.5 shrink-0" aria-hidden />,
    labelKey: 'models.fit.blockedDisk',
  },
  /*
   * ★ T-201 A-5：「没测到」不是「不够」。
   * 用中性色 + 问号，**不给 serious/critical** —— 它不是坏消息，是"这一格我们没查到"。
   * 拿 `blocked_disk` 的橙色去表达它，等于把"不知道"说成"装不下"。
   */
  unknown_disk: {
    text: 'text-ink-muted',
    icon: <CircleHelp className="size-3.5 shrink-0" aria-hidden />,
    labelKey: 'models.fit.unknownDisk',
  },
};

const FALLBACK = {
  text: 'text-ink-muted',
  icon: <OctagonAlert className="size-3.5 shrink-0" aria-hidden />,
  labelKey: 'models.fit.unknown',
};

export interface FitBadgeProps {
  fitness: FitResult;
  /** 同时显示服务端给的原因说明（列表卡片用；紧凑场景可关掉） */
  showReason?: boolean;
  className?: string;
}

export function FitBadge({ fitness, showReason = false, className }: FitBadgeProps) {
  const { t, i18n } = useTranslation();
  const s = TIER_STYLE[fitness.tier] ?? FALLBACK;
  return (
    <div className={cn('flex flex-col gap-0.5', className)} data-testid="fit-badge">
      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', s.text)}>
        {s.icon}
        <span>{t(s.labelKey)}</span>
      </span>
      {showReason ? (
        /*
         * 这句话来自服务端（`shared/fitness.ts` 生成），前端不拼装它 ——
         * 但**要挑对语言**（#106）。这里原来写死取 `reasonZh`，而契约里
         * `reasonEn` **十条分支每一条都填了**：不是缺翻译，是有翻译没用上。
         * 与 `localized.ts` 开头那段说的是同一件事。
         */
        <span className="text-xs text-ink-secondary">
          {pickLocalized(i18n.language, fitness.reasonZh, fitness.reasonEn)}
        </span>
      ) : null}
      {/*
        ★ 「我们没查过」是**第三种说法**，不是上面那个结论的修饰。

        契约（`shared/fitness.ts:61-74`）把话说死了：
        「"Your CPU lacks AVX2" and "we could not check whether your CPU has AVX2"
         are different sentences, and only one of them is ever true on Windows today:
         `detectCpuWin32()` returns an empty feature set unconditionally」——
        **daemon 从没查过任何指令集标志位**，却照样给出了结论。

        真机损失有记录：Windows 用户看到「CPU 不支持所需指令集（avx2）」，
        而真相是"我们从没查过"。**产品对用户说了一句它并不知道的话。**

        daemon 早就把三态算好发下来了（`cpuFeaturesUnverified` 非空 = 结论是
        **假设该要求已满足**算出来的），而 `FitBadge` 里此前连 `cpuFeatures`
        这个词都没有出现过 —— 又一次「算好发出、离终点一行被丢掉」。

        ⚠️ 措辞不许含糊成"可能不支持"：那会把"没查过"重新说成"查过且不行"，
        等于把这条修复变回原来的谎。
      */}
      {/*
        ⚠️ `?? []`：契约上 `cpuFeaturesUnverified` 是必填 `string[]`，但**实际响应里可能没有**
        （老 daemon、以及仓库里既有的一批夹具都不带它）。直接 `.length` 会把**整张模型卡打崩**
        —— 一个"让判断更诚实"的改动，反而让页面渲染不出来，那是比原缺陷更糟的交易。
        缺席的语义只能是"没有要 caveat 的东西"，与空数组同义。
      */}
      {(fitness.cpuFeaturesUnverified ?? []).length > 0 ? (
        <span className="text-xs text-warning" data-testid="fit-cpu-unverified">
          {t('models.fit.cpuUnverified', {
            features: fitness.cpuFeaturesUnverified.join(', '),
          })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 预计耗时。
 *
 * ADR-004 决策 3：宁可显示"未测量"，也不显示编造的数字。
 * 但**真实测量 + 诚实出处**是允许的，所以这里区分三种来源，措辞各不相同：
 *   - `measured_here`      本机实测 → 说"本机实测"
 *   - `reference_machine`  我们在参考机上实测 → 必须说明"参考机"，不能冒充本机数据
 *   - `none`               没有任何测量 → 说"未测量"，不外推
 *
 * ADR-011 决策 2 让这一栏变得重要：中文必须用 large-v3-turbo，而它在 CPU 上
 * 1 小时录音要跑 22 分钟。"装得下"和"用得了"是两件事，只答前者会误导用户。
 */
export function FitEta({ fitness }: { fitness: FitResult }) {
  const { t } = useTranslation();
  const mins = fitness.estMinutesPerAudioHour;
  if (mins == null || fitness.speedSource === 'none') {
    return <span className="text-xs text-ink-muted">{t('models.fit.speedUnmeasured')}</span>;
  }
  const slow = fitness.speedTier === 'slow' || fitness.speedTier === 'very_slow';
  return (
    <span className={cn('text-xs', slow ? 'text-warning' : 'text-ink-secondary')}>
      {slow ? <AlertTriangle className="mr-0.5 inline size-3" aria-hidden /> : null}
      {t('models.fit.etaPerHour', { minutes: Math.round(mins) })}
      <span className="text-ink-muted">
        {fitness.speedSource === 'measured_here'
          ? t('models.fit.sourceMeasuredHere')
          : t('models.fit.sourceReference')}
      </span>
    </span>
  );
}

/**
 * 部分卸载时的层数提示。
 *
 * ⚠️ 必须写"约"：`estimateGpuLayers` 假设各层等大，而 embedding/output 层更大，
 * 因此这是**乐观估计**且未经标定（D-03 §11 第 3 项）。不许显示成确定值。
 */
export function FitGpuLayers({ fitness }: { fitness: FitResult }) {
  const { t } = useTranslation();
  if (fitness.estGpuLayers == null || fitness.tier !== 'slow_partial') return null;
  return (
    <span className="text-xs text-ink-muted">
      {t('models.fit.gpuLayers', { layers: fitness.estGpuLayers })}
    </span>
  );
}
