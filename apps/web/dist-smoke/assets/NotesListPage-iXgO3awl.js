import { t as ErrorBlock } from "./ErrorBlock-yofocnTu.js";
import { n as humanDuration, o as Button, r as relativeTime } from "./time-Dn1EgsA-.js";
import { t as StatusChip } from "./StatusChip--dKLeohu.js";
import { t as EmptyState } from "./EmptyState-Bc3D_rF1.js";
import { i as useNotesQuery, t as NoteProgressLine } from "./NoteProgressLine-BwF8tE2y.js";
import { Link, useNavigate } from "react-router";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
import { FileAudio, Mic, Star } from "lucide-react";
//#region src/features/notes/NotesListPage.tsx
/** F5 笔记列表。 */
function NotesListPage() {
	const { t, i18n } = useTranslation();
	const navigate = useNavigate();
	const { data: notes, isLoading, isError, error, refetch } = useNotesQuery();
	if (isError) return /* @__PURE__ */ jsx(ErrorBlock, {
		error,
		onRetry: () => void refetch(),
		className: "m-6"
	});
	if (isLoading) return /* @__PURE__ */ jsx("div", {
		className: "p-6 text-sm text-ink-muted",
		children: t("common.loading")
	});
	if (!notes || notes.length === 0) return /* @__PURE__ */ jsx(EmptyState, {
		icon: /* @__PURE__ */ jsx(FileAudio, { className: "size-10" }),
		title: t("notes.empty"),
		hint: t("notes.emptyHint"),
		action: /* @__PURE__ */ jsx(Button, {
			variant: "primary",
			onClick: () => navigate("/capture"),
			children: t("nav.newCapture")
		})
	});
	return /* @__PURE__ */ jsxs("div", {
		className: "px-6 py-6",
		children: [/* @__PURE__ */ jsx("h1", {
			className: "mb-4 text-xl font-semibold text-ink",
			children: t("notes.title")
		}), /* @__PURE__ */ jsx("ul", {
			className: "flex flex-col gap-2",
			role: "list",
			children: notes.map((n) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(Link, {
				to: `/notes/${n.uid}`,
				className: "block rounded-lg border border-line bg-surface-1 p-3 transition-colors hover:bg-surface-2",
				children: /* @__PURE__ */ jsxs("div", {
					className: "flex items-start gap-3",
					children: [
						/* @__PURE__ */ jsx("div", {
							className: "mt-0.5 text-ink-muted",
							"aria-hidden": true,
							children: n.kind === "recording" ? /* @__PURE__ */ jsx(Mic, { className: "size-4" }) : /* @__PURE__ */ jsx(FileAudio, { className: "size-4" })
						}),
						/* @__PURE__ */ jsxs("div", {
							className: "min-w-0 flex-1",
							children: [
								/* @__PURE__ */ jsxs("div", {
									className: "flex items-center gap-2",
									children: [/* @__PURE__ */ jsx("h2", {
										className: "truncate text-sm font-medium text-ink",
										children: n.title || t("notes.untitled")
									}), n.starred ? /* @__PURE__ */ jsx(Star, {
										className: "size-3.5 shrink-0 text-warning",
										"aria-label": t("nav.starred")
									}) : null]
								}),
								/* @__PURE__ */ jsxs("div", {
									className: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted",
									children: [
										n.durationMs ? /* @__PURE__ */ jsx("span", { children: humanDuration(n.durationMs, i18n.language) }) : null,
										n.source?.site ? /* @__PURE__ */ jsx("span", { children: n.source.site }) : null,
										/* @__PURE__ */ jsx("span", { children: relativeTime(Date.parse(n.updatedAt), i18n.language) }),
										n.tags.map((tag) => /* @__PURE__ */ jsx("span", {
											className: "rounded bg-surface-0 px-1.5 py-0.5 text-ink-secondary",
											children: tag.name
										}, tag.uid))
									]
								}),
								n.activeJobId ? /* @__PURE__ */ jsx(NoteProgressLine, {
									jobId: n.activeJobId,
									className: "mt-2"
								}) : null
							]
						}),
						/* @__PURE__ */ jsx("div", {
							className: "shrink-0",
							children: n.status === "processing" ? /* @__PURE__ */ jsx(StatusChip, {
								tone: "running",
								label: t("notes.processing")
							}) : n.status === "failed" ? /* @__PURE__ */ jsx(StatusChip, {
								tone: "critical",
								label: t("notes.failed")
							}) : n.status === "partial" ? /* @__PURE__ */ jsx(StatusChip, {
								tone: "warning",
								label: t("notes.partial")
							}) : null
						})
					]
				})
			}) }, n.uid))
		})]
	});
}
//#endregion
export { NotesListPage as default };
