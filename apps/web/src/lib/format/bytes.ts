/** 字节与速率格式化。走 `Intl.NumberFormat`，不手写千分位。 */

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

/** `0.29` → `"29%"` */
export function formatPercent(ratio: number, locale: string): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    clamped,
  );
}
