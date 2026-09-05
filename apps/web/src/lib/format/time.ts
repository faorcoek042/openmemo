/**
 * 时间格式化。全部走 `Intl`，禁止各 feature 自己写"3 分钟前"（D-05 §6.1）。
 *
 * 媒体时间一律 **毫秒整数**（D-02 §1.1）——浮点秒在字幕对齐上会累积误差。
 */
import { formatTimecode } from '@openmemo/shared';

/**
 * `754000` → `"12:34"`；超过 1 小时 → `"1:12:34"`。时间码不随 locale 变，是媒体惯例。
 *
 * ★ **实现搬去了 `@openmemo/shared` 的 `formatTimecode()`，这里只剩转发。**
 *
 * 不是洁癖：同一个函数当时在仓里有**三份**（本文件、`packages/mindmap/src/timecode.ts`
 * 的 `formatTimestamp()`、`apps/daemon/src/http/rest/content.ts` 的 `msToClock()`），
 * 而本轮要加的**第四份**在 daemon 的 `db/richText.ts` 里 —— 那一份产出的字符串
 * 会**直接进 FTS5 索引**。它与这里这一份一旦漂移，用户照着屏幕上的时间码搜自己的
 * 锚点就会搜不到，且没有任何一处报错（这次的缺陷正是同族，只是更彻底：
 * 那一份**根本没写**，锚点对索引的贡献是零）。
 *
 * 保留这个名字与这个入口，是因为 `apps/web` 有十几处在用它，而
 * `lib/format/singleSource.test.ts` 那条结构守卫也按"格式化只许出现在 lib/format/"判。
 */
export function timecode(ms: number): string {
  return formatTimecode(ms);
}

/**
 * SRT/VTT 用的完整时间码 `HH:MM:SS.mmm`（整数毫秒 → 无浮点误差，D-02 §3.6）。
 *
 * ⚠️ **必须挡住 NaN/Infinity。**（本函数早期版本漏了这层，由
 * `apps/daemon/src/http/rest/content.export.test.ts` 逮到 —— 前端那份 `export.test.ts`
 * 随导出实现一起搬去了服务端，用例整套跟着搬，没有消失。）
 * `Math.max(0, Math.floor(NaN))` 仍是 `NaN`，会产出 `NaN:NaN:NaN,NaN` 写进字幕文件 ——
 * 而这在我们自己的 UI 里**完全看不出来**（转写稿照常显示），
 * 只有用户把 .srt 拖进播放器、发现整个文件失效时才会暴露。
 */
export function timecodeFull(ms: number): string {
  const t = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:${pad(
    Math.floor(t / 1000) % 60,
  )}.${pad(t % 1000, 3)}`;
}

/** 人类可读时长，用于列表页："1 小时 47 分" / "1 hr 47 min"。 */
export function humanDuration(ms: number, locale: string): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const nf = new Intl.NumberFormat(locale);
  if (h === 0) return locale.startsWith('zh') ? `${nf.format(m)} 分钟` : `${nf.format(m)} min`;
  return locale.startsWith('zh')
    ? `${nf.format(h)} 小时 ${nf.format(m)} 分`
    : `${nf.format(h)} hr ${nf.format(m)} min`;
}

const RTF_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
];

/** "3 分钟前"。用 `Intl.RelativeTimeFormat`，无需 polyfill（已 Baseline 多年）。 */
export function relativeTime(epochMs: number, locale: string, now = Date.now()): string {
  const diff = epochMs - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of RTF_UNITS) {
    if (abs >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return rtf.format(0, 'second');
}

/**
 * ETA。**只在有依据时显示，且四舍五入到"约 X 分钟"**（D-05 §4.1 规则 4）——
 * 不显示"剩余 03:47"这种假精确，因为 RTF 会波动。
 */
export function approxEta(seconds: number | null | undefined, locale: string): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const zh = locale.startsWith('zh');
  if (seconds < 60) return zh ? '不到 1 分钟' : 'less than a minute';
  const min = Math.round(seconds / 60);
  if (min < 60) return zh ? `约 ${min} 分钟` : `about ${min} min`;
  const hr = Math.round(seconds / 3600);
  return zh ? `约 ${hr} 小时` : `about ${hr} hr`;
}

/**
 * 估算"离线重跑"要多久（F3 两阶段的预告文案用）。
 *
 * ⚠️ 这不是锦上添花的文案 —— `gpu-runtime` 实测：中文必须用 `large-v3-turbo`，
 * 它在 **CPU 上只有 2.7x 实时**，也就是 **1 小时录音要跑 22 分钟**。
 * 不给时间预期，用户会以为卡死了然后去关窗口。
 *
 * @param audioMs 音频时长
 * @param speedRatio 相对实时的倍数（2.7 表示 2.7 倍速）。为 null 时返回 null ——
 *        **宁可不显示，也不编一个数字**（ADR-004 决策 3 的项目标准）。
 */
export function estimateRerunMs(audioMs: number, speedRatio: number | null): number | null {
  if (!speedRatio || speedRatio <= 0 || !Number.isFinite(audioMs)) return null;
  return Math.round(audioMs / speedRatio);
}
