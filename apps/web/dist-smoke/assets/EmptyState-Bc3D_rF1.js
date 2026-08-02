import { t as cn } from "./utils-BYK1OtKK.js";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/common/EmptyState.tsx
function EmptyState({ icon, title, hint, action, className }) {
	return /* @__PURE__ */ jsxs("div", {
		className: cn("flex flex-col items-center justify-center px-6 py-16 text-center", className),
		children: [
			icon ? /* @__PURE__ */ jsx("div", {
				className: "mb-4 text-ink-muted",
				children: icon
			}) : null,
			/* @__PURE__ */ jsx("h2", {
				className: "text-base font-medium text-ink",
				children: title
			}),
			hint ? /* @__PURE__ */ jsx("p", {
				className: "mt-1 max-w-md text-sm text-ink-secondary",
				children: hint
			}) : null,
			action ? /* @__PURE__ */ jsx("div", {
				className: "mt-5",
				children: action
			}) : null
		]
	});
}
//#endregion
export { EmptyState as t };
