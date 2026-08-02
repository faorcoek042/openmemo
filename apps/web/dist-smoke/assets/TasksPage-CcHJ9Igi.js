import { n as useProgressStore } from "./progress.store-CB1TnKEq.js";
import { t as EmptyState } from "./EmptyState-Bc3D_rF1.js";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
//#region src/features/tasks/TasksPage.tsx
/** 任务中心整页版（抽屉的完整形态）。历史与失败重试待接后端。 */
function TasksPage() {
	const { t } = useTranslation();
	const jobs = useProgressStore((s) => Object.values(s.byJob));
	return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto w-full max-w-3xl px-6 py-8",
		children: [/* @__PURE__ */ jsx("h1", {
			className: "mb-4 text-xl font-semibold text-ink",
			children: t("tasks.title")
		}), jobs.length === 0 ? /* @__PURE__ */ jsx(EmptyState, {
			title: t("tasks.empty"),
			hint: t("tasks.backgroundNotice")
		}) : /* @__PURE__ */ jsx("ul", {
			className: "flex flex-col gap-2",
			role: "list",
			children: jobs.map((j) => /* @__PURE__ */ jsxs("li", {
				className: "rounded-lg border border-line bg-surface-1 p-3 text-sm text-ink",
				children: [
					j.jobType,
					" · ",
					j.step
				]
			}, j.jobId))
		})]
	});
}
//#endregion
export { TasksPage as default };
