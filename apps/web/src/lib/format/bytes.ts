/** 字节与速率格式化。走 `Intl.NumberFormat`，不手写千分位。 */

import { reportProgressDimensionViolation } from '@openmemo/shared';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * 十进制 MB（`bytes / 1e6`），与 R-04 §7.2 的口径一致 —— 模型体积、显存需求全用十进制，
 * 避免"下载页显示 574 MB、系统显示 547 MiB"这种对不上的困惑。
 */
export function formatBytes(bytes: number | null | undefined, locale: string): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i += 1;
  }
  const digits = v < 10 && i > 0 ? 1 : 0;
  const nf = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${nf.format(v)} ${UNITS[i]}`;
}

/** `8_200_000` → `"8.2 MB/s"` */
export function formatSpeed(bps: number | null | undefined, locale: string): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return '—';
  return `${formatBytes(bps, locale)}/s`;
}

/**
 * `0.29` → `"29%"`。入参是**比例（0..1）**，不是百分数。
 *
 * ── ★ #90：为什么越界不再被静默夹紧 ──────────────────────────────────────────
 *
 * 这里原本是 `Math.min(1, Math.max(0, ratio))`，然后直接格式化。夹紧本身是对的
 * （防越界），错的是**夹完什么都不说**：上游把 0–100 的百分比当 0–1 传进来时，
 * `90` 被夹成 `1`，界面显示一个**理直气壮的 `100%`**。
 *
 * 那正是 #90 那条 bug 能躲过十几个 agent 的原因 —— 一条 40 分钟的音频转到 72%，
 * 界面说 100%，**看起来只是"跑得快"，没有任何一处报错**。
 * 一个 90 倍的偏差被这行代码翻译成了一个合理的数字。
 *
 * 现在：越界 ⇒ 出声（`console.error` 带现场）+ 返回 `'—'`。
 * `'—'` 是本文件对"说不出来"的既有表达（`formatBytes` / `formatSpeed` 都用它）。
 * **说不出来就说不出来，不许编一个看起来精确的 100%。**
 */
export function formatPercent(ratio: number, locale: string): string {
  if (!Number.isFinite(ratio)) return '—';
  if (ratio < 0 - PERCENT_EPSILON || ratio > 1 + PERCENT_EPSILON) {
    reportProgressDimensionViolation('formatPercent', ratio);
    return '—';
  }
  const clamped = Math.min(1, Math.max(0, ratio));
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    clamped,
  );
}

/** 浮点累加出来的 `1.0000000000000002` 不该被当成量纲错。 */
const PERCENT_EPSILON = 1e-9;
