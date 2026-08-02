import { r as MockNotice, t as ErrorBlock } from "./ErrorBlock-NhqIUn2X.js";
import { t as EmptyState } from "./EmptyState-Bc3D_rF1.js";
import { n as useSaveMindmapMutation, r as MindmapView, t as useMindmapQuery } from "./api-CcIiObhZ.js";
import { useRef } from "react";
import { useParams } from "react-router";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
//#region src/features/mindmap/MindmapPage.tsx
/** F4 全屏编辑页。笔记详情里的 Tab 复用同一个 `MindmapView`。 */
function MindmapPage() {
	const { t } = useTranslation();
	const { noteUid } = useParams();
	const { data, isLoading, isError, error, refetch } = useMindmapQuery(noteUid);
	const save = useSaveMindmapMutation(noteUid);
	const timer = useRef(null);
	const onChange = (next) => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => save.mutate(next), 600);
	};
	if (isError) return /* @__PURE__ */ jsx(ErrorBlock, {
		error,
		onRetry: () => void refetch(),
		className: "m-6"
	});
	if (isLoading) return /* @__PURE__ */ jsx("div", {
		className: "p-6 text-sm text-ink-muted",
		children: t("common.loading")
	});
	if (!data) return /* @__PURE__ */ jsx(EmptyState, {
		title: t("mindmap.empty"),
		hint: t("mindmap.emptyHint")
	});
	return /* @__PURE__ */ jsxs("div", {
		className: "flex h-full flex-col",
		children: [/* @__PURE__ */ jsx(MockNotice, {
			surface: "notes",
			className: "m-3"
		}), /* @__PURE__ */ jsx("div", {
			className: "min-h-0 flex-1",
			children: /* @__PURE__ */ jsx(MindmapView, {
				doc: data,
				onChange
			})
		})]
	});
}
//#endregion
export { MindmapPage as default };
