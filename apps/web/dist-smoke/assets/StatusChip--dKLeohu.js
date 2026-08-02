import { t as cn } from "./utils-BYK1OtKK.js";
import { jsx, jsxs } from "react/jsx-runtime";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, OctagonAlert, XCircle } from "lucide-react";
//#region src/components/common/StatusChip.tsx
var TONE_TEXT = {
	good: "text-good",
	warning: "text-warning",
	serious: "text-serious",
	critical: "text-critical",
	neutral: "text-ink-muted",
	running: "text-accent"
};
var DEFAULT_ICON = {
	good: /* @__PURE__ */ jsx(CheckCircle2, {
		className: "size-3.5",
		"aria-hidden": true
	}),
	warning: /* @__PURE__ */ jsx(AlertTriangle, {
		className: "size-3.5",
		"aria-hidden": true
	}),
	serious: /* @__PURE__ */ jsx(OctagonAlert, {
		className: "size-3.5",
		"aria-hidden": true
	}),
	critical: /* @__PURE__ */ jsx(XCircle, {
		className: "size-3.5",
		"aria-hidden": true
	}),
	neutral: /* @__PURE__ */ jsx(CircleDashed, {
		className: "size-3.5",
		"aria-hidden": true
	}),
	running: /* @__PURE__ */ jsx(Loader2, {
		className: "size-3.5 animate-spin",
		"aria-hidden": true
	})
};
function StatusChip({ tone, label, icon, className }) {
	return /* @__PURE__ */ jsxs("span", {
		className: cn("inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap", TONE_TEXT[tone], className),
		children: [icon ?? DEFAULT_ICON[tone], /* @__PURE__ */ jsx("span", { children: label })]
	});
}
//#endregion
export { StatusChip as t };
