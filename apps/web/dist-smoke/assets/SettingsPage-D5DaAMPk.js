import { n as useUiStore } from "./ui.store-2aoWFaa7.js";
import { r as setLocale, t as SUPPORTED_LOCALES } from "./i18n-CM4uFOy_.js";
import { t as Banner } from "./Banner-C-cOOcHq.js";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
//#region src/features/settings/SettingsPage.tsx
/** 设置（最小可用版）。运行时/模型/存储页归 T-022。 */
function SettingsPage() {
	const { t, i18n } = useTranslation();
	const theme = useUiStore((s) => s.theme);
	const setTheme = useUiStore((s) => s.setTheme);
	return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8",
		children: [
			/* @__PURE__ */ jsx("h1", {
				className: "text-xl font-semibold text-ink",
				children: t("settings.title")
			}),
			/* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: [
					/* @__PURE__ */ jsx("h2", {
						className: "mb-3 text-sm font-medium text-ink",
						children: t("settings.general")
					}),
					/* @__PURE__ */ jsxs("label", {
						className: "mb-3 flex items-center justify-between gap-4 text-sm",
						children: [/* @__PURE__ */ jsx("span", {
							className: "text-ink-secondary",
							children: t("app.language")
						}), /* @__PURE__ */ jsx("select", {
							value: i18n.language,
							onChange: (e) => setLocale(e.target.value),
							className: "h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink",
							children: SUPPORTED_LOCALES.map((l) => /* @__PURE__ */ jsx("option", {
								value: l.code,
								children: l.label
							}, l.code))
						})]
					}),
					/* @__PURE__ */ jsxs("label", {
						className: "flex items-center justify-between gap-4 text-sm",
						children: [/* @__PURE__ */ jsx("span", {
							className: "text-ink-secondary",
							children: t("app.theme")
						}), /* @__PURE__ */ jsxs("select", {
							value: theme,
							onChange: (e) => setTheme(e.target.value),
							className: "h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink",
							children: [
								/* @__PURE__ */ jsx("option", {
									value: "system",
									children: "system"
								}),
								/* @__PURE__ */ jsx("option", {
									value: "light",
									children: "light"
								}),
								/* @__PURE__ */ jsx("option", {
									value: "dark",
									children: "dark"
								})
							]
						})]
					})
				]
			}),
			/* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: [/* @__PURE__ */ jsx("h2", {
					className: "mb-3 text-sm font-medium text-ink",
					children: t("settings.llm")
				}), /* @__PURE__ */ jsx(Banner, {
					tone: "warning",
					title: t("settings.apiKeyPlaintextWarning", { path: "~/.local/share/openmemo/openmemo.db" }),
					className: "border-b-0"
				})]
			}),
			/* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4 text-sm",
				children: [
					/* @__PURE__ */ jsx("h2", {
						className: "mb-3 font-medium text-ink",
						children: t("settings.about")
					}),
					/* @__PURE__ */ jsxs("dl", {
						className: "grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ink-secondary",
						children: [/* @__PURE__ */ jsx("dt", { children: t("settings.contractVersion") }), /* @__PURE__ */ jsx("dd", {
							className: "tabular-nums text-ink",
							children: 1
						})]
					}),
					/* @__PURE__ */ jsx("p", {
						className: "mt-3 text-xs text-ink-muted",
						children: t("settings.telemetryNote")
					})
				]
			})
		]
	});
}
//#endregion
export { SettingsPage as default };
