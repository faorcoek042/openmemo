import { t as cn } from "./utils-BYK1OtKK.js";
import { jsx } from "react/jsx-runtime";
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
export { ProgressMeter as t };
