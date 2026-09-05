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

/*
 * ★ 这里原来还有一个 `timecodeFull(ms)`（SRT/VTT 的 `HH:MM:SS.mmm`）。**已删。**
 *
 * 它是一次搬家的残留：字幕导出连同它的整套用例都搬去了服务端
 * （`apps/daemon/src/http/rest/content.ts` 的 `HH:MM:SS,mmm`，用例在
 * `content.export.test.ts`），而前端这一份没人跟着删，从此零调用方。
 *
 * ⚠️ 它带的那条知识**没有丢，只是不在这里**：`Math.max(0, Math.floor(NaN))` 仍是 `NaN`，
 * 会往字幕文件里写 `NaN:NaN:NaN,NaN`，而这在 UI 里完全看不出来（转写稿照常显示），
 * 只有用户把 .srt 拖进播放器才发现整个文件失效。守着它的是服务端那份实现与用例。
 * 前端再留一份**没有用例的拷贝**是负资产：它只会在某天被人接上时和服务端那份分叉。
 */

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
