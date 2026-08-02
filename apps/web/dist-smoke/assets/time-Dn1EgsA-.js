import { t as cn } from "./utils-BYK1OtKK.js";
import { jsx } from "react/jsx-runtime";
import { cva } from "class-variance-authority";
//#region src/components/common/Button.tsx
/**
* 基础按钮。
*
* ⚠️ **为什么放在 `components/common/` 而不是 `components/ui/`**：
* `components/ui/` 是 ADR-002 决策 2 的 shadcn 豁免区，规则是"只能通过 CLI 添加，
* 且必须在 SOURCE.md 登记来源"。手写组件放进去会让那份豁免的可追溯性失效。
* 我们自己写的基础件一律放 `common/`。
*/
var button = cva("inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 select-none", {
	variants: {
		variant: {
			primary: "bg-accent text-accent-fg hover:opacity-90",
			secondary: "border border-line bg-surface-1 text-ink hover:bg-surface-2",
			ghost: "text-ink-secondary hover:bg-surface-2 hover:text-ink",
			danger: "bg-critical text-white hover:opacity-90"
		},
		size: {
			sm: "h-7 px-2.5 text-xs",
			md: "h-9 px-3.5",
			lg: "h-11 px-5 text-base",
			icon: "size-8"
		}
	},
	defaultVariants: {
		variant: "secondary",
		size: "md"
	}
});
function Button({ className, variant, size, type = "button", ...rest }) {
	return /* @__PURE__ */ jsx("button", {
		type,
		className: cn(button({
			variant,
			size
		}), className),
		...rest
	});
}
//#endregion
//#region src/components/common/ProgressMeter.tsx
var TONE_BG = {
	accent: "bg-accent",
	warning: "bg-warning",
	critical: "bg-critical",
	good: "bg-good"
};
function ProgressMeter({ value, tone = "accent", size = "sm", indeterminate = false, className, label }) {
	const pct = Math.min(100, Math.max(0, (Number.isFinite(value) ? value : 0) * 100));
	return /* @__PURE__ */ jsx("div", {
		role: "progressbar",
		"aria-label": label,
		"aria-valuemin": 0,
		"aria-valuemax": 100,
		"aria-valuenow": indeterminate ? void 0 : Math.round(pct),
		className: cn("w-full overflow-hidden rounded-full bg-accent-track", size === "sm" ? "h-1.5" : "h-2", className),
		children: /* @__PURE__ */ jsx("div", {
			className: cn("h-full transition-[width] duration-200 ease-out", "rounded-l-none rounded-r-[4px]", TONE_BG[tone], indeterminate && "animate-pulse"),
			style: { width: indeterminate ? "40%" : `${pct}%` }
		})
	});
}
//#endregion
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
//#endregion
export { ProgressMeter as a, timecode as i, humanDuration as n, Button as o, relativeTime as r, approxEta as t };
