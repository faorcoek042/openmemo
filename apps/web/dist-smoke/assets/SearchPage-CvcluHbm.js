import { r as MockNotice, t as ErrorBlock } from "./ErrorBlock-NhqIUn2X.js";
import { t as cn } from "./utils-BYK1OtKK.js";
import { t as useSearchQuery } from "./api-DQD1-1um.js";
import { a as timecode } from "./time-BT6YJuzy.js";
import { t as EmptyState } from "./EmptyState-Bc3D_rF1.js";
import { useNavigate, useSearchParams } from "react-router";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
//#region src/features/search/SearchPage.tsx
var MODES = [
	"hybrid",
	"keyword",
	"semantic"
];
/**
* F5 全局搜索（章程明确要求"搜索"）。
*
* ## 这一页的关键体验：**结果直达时间点**
*
* 命中的是转写段落时，结果带 `startMs` —— 点一下不是"打开这篇笔记"，
* 而是**打开并跳到那一秒**。这是 D-05 §4.4 说的杀手级体验，
* 也是"转写稿 ↔ 时间轴"数据结构的最终检验：如果搜索结果跳不到那一秒，
* 说明时间轴模型没设计对。
*
* 三档模式对应 D-02 §4.4：关键词（FTS5 bm25 + 中文分词）/ 语义（sqlite-vec）/
* 混合（RRF 融合）。向量索引不可用时服务端会降级，UI 相应隐藏后两档。
*/
function SearchPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const [params, setParams] = useSearchParams();
	const q = params.get("q") ?? "";
	const mode = params.get("mode") ?? "hybrid";
	const { data: hits, isLoading, isError, error, refetch } = useSearchQuery(q, mode);
	const setQ = (next) => {
		setParams((p) => {
			if (next) p.set("q", next);
			else p.delete("q");
			return p;
		});
	};
	return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8",
		children: [
			/* @__PURE__ */ jsx("h1", {
				className: "text-xl font-semibold text-ink",
				children: t("search.title")
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "relative",
				children: [/* @__PURE__ */ jsx(Search, {
					className: "absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted",
					"aria-hidden": true
				}), /* @__PURE__ */ jsx("input", {
					value: q,
					onChange: (e) => setQ(e.target.value),
					placeholder: t("search.placeholder"),
					"aria-label": t("search.title"),
					autoFocus: true,
					className: "h-10 w-full rounded-md border border-line bg-surface-1 pr-3 pl-9 text-sm text-ink placeholder:text-ink-muted"
				})]
			}),
			/* @__PURE__ */ jsx("div", {
				className: "flex gap-1",
				role: "tablist",
				"aria-label": t("search.mode"),
				children: MODES.map((m) => /* @__PURE__ */ jsx("button", {
					role: "tab",
					"aria-selected": mode === m,
					onClick: () => setParams((p) => {
						p.set("mode", m);
						return p;
					}),
					className: cn("rounded-md px-2.5 py-1 text-xs transition-colors", mode === m ? "bg-accent text-accent-fg" : "text-ink-secondary hover:bg-surface-2"),
					children: t(`search.modes.${m}`)
				}, m))
			}),
			/* @__PURE__ */ jsx(MockNotice, { surface: "notes" }),
			isError ? /* @__PURE__ */ jsx(ErrorBlock, {
				error,
				onRetry: () => void refetch()
			}) : null,
			!q.trim() ? /* @__PURE__ */ jsx(EmptyState, {
				title: t("search.idle"),
				hint: t("search.idleHint")
			}) : isLoading ? /* @__PURE__ */ jsx("p", {
				className: "text-sm text-ink-muted",
				children: t("common.loading")
			}) : !hits || hits.length === 0 ? /* @__PURE__ */ jsx(EmptyState, {
				title: t("search.noResults"),
				hint: t("search.noResultsHint")
			}) : /* @__PURE__ */ jsx("ul", {
				className: "flex flex-col gap-2",
				role: "list",
				children: hits.map((h, i) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs("button", {
					type: "button",
					onClick: () => navigate(h.startMs != null ? `/notes/${h.noteUid}?t=${h.startMs}` : `/notes/${h.noteUid}`),
					className: "w-full rounded-lg border border-line bg-surface-1 p-3 text-left transition-colors hover:bg-surface-2",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "flex items-baseline gap-2",
						children: [/* @__PURE__ */ jsx("span", {
							className: "truncate text-sm font-medium text-ink",
							children: h.noteTitle
						}), h.startMs != null ? /* @__PURE__ */ jsx("span", {
							className: "shrink-0 tabular-nums text-xs text-accent",
							children: timecode(h.startMs)
						}) : null]
					}), /* @__PURE__ */ jsx("p", {
						className: "mt-1 text-sm text-ink-secondary [&_mark]:bg-accent-track [&_mark]:text-ink",
						dangerouslySetInnerHTML: { __html: h.snippet }
					})]
				}) }, `${h.noteUid}-${h.startMs ?? i}`))
			})
		]
	});
}
//#endregion
export { SearchPage as default };
