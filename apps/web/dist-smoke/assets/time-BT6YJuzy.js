//#region src/lib/format/time.ts
/**
* 时间格式化。全部走 `Intl`，禁止各 feature 自己写"3 分钟前"（D-05 §6.1）。
*
* 媒体时间一律 **毫秒整数**（D-02 §1.1）——浮点秒在字幕对齐上会累积误差。
*/
/** `754000` → `"12:34"`；超过 1 小时 → `"1:12:34"`。时间码不随 locale 变，是媒体惯例。 */
function timecode(ms) {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	const total = Math.floor(ms / 1e3);
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const pad = (n) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
/** 人类可读时长，用于列表页："1 小时 47 分" / "1 hr 47 min"。 */
function humanDuration(ms, locale) {
	const totalMin = Math.round(ms / 6e4);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	const nf = new Intl.NumberFormat(locale);
	if (h === 0) return locale.startsWith("zh") ? `${nf.format(m)} 分钟` : `${nf.format(m)} min`;
	return locale.startsWith("zh") ? `${nf.format(h)} 小时 ${nf.format(m)} 分` : `${nf.format(h)} hr ${nf.format(m)} min`;
}
var RTF_UNITS = [
	["year", 31536e6],
	["month", 2592e6],
	["day", 864e5],
	["hour", 36e5],
	["minute", 6e4],
	["second", 1e3]
];
/** "3 分钟前"。用 `Intl.RelativeTimeFormat`，无需 polyfill（已 Baseline 多年）。 */
function relativeTime(epochMs, locale, now = Date.now()) {
	const diff = epochMs - now;
	const abs = Math.abs(diff);
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	for (const [unit, size] of RTF_UNITS) if (abs >= size) return rtf.format(Math.round(diff / size), unit);
	return rtf.format(0, "second");
}
/**
* ETA。**只在有依据时显示，且四舍五入到"约 X 分钟"**（D-05 §4.1 规则 4）——
* 不显示"剩余 03:47"这种假精确，因为 RTF 会波动。
*/
function approxEta(seconds, locale) {
	if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
	const zh = locale.startsWith("zh");
	if (seconds < 60) return zh ? "不到 1 分钟" : "less than a minute";
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
function estimateRerunMs(audioMs, speedRatio) {
	if (!speedRatio || speedRatio <= 0 || !Number.isFinite(audioMs)) return null;
	return Math.round(audioMs / speedRatio);
}
//#endregion
export { timecode as a, relativeTime as i, estimateRerunMs as n, humanDuration as r, approxEta as t };
