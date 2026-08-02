import { t as cn } from "./utils-BYK1OtKK.js";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/common/Banner.tsx
var TONE_STYLES = {
	info: "border-l-accent bg-surface-1",
	warning: "border-l-warning bg-surface-1",
	critical: "border-l-critical bg-surface-1",
	mock: "border-l-serious bg-surface-1"
};
function Banner({ tone, icon, title, detail, action, className }) {
	return /* @__PURE__ */ jsxs("div", {
		role: "status",
		"aria-live": tone === "critical" ? "assertive" : "polite",
		className: cn("flex items-start gap-3 border-b border-l-4 border-b-line px-4 py-2 text-sm", TONE_STYLES[tone], className),
		children: [
			icon ? /* @__PURE__ */ jsx("span", {
				className: "mt-0.5 shrink-0",
				children: icon
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "min-w-0 flex-1",
				children: [/* @__PURE__ */ jsx("div", {
					className: "font-medium text-ink",
					children: title
				}), detail ? /* @__PURE__ */ jsx("div", {
					className: "mt-0.5 text-ink-secondary",
					children: detail
				}) : null]
			}),
			action ? /* @__PURE__ */ jsx("div", {
				className: "shrink-0",
				children: action
			}) : null
		]
	});
}
//#endregion
export { Banner as t };
