import { i as api, m as qk } from "./ErrorBlock-NhqIUn2X.js";
import { n as useProgressStore } from "./progress.store-CB1TnKEq.js";
import { t as ProgressMeter } from "./ProgressMeter--rPJ_6mH.js";
import { t as approxEta } from "./time-BT6YJuzy.js";
import { n as formatPercent } from "./bytes-JyzdoODc.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
//#region src/features/notes/api.ts
function useNotesQuery() {
	return useQuery({
		queryKey: qk.notes.list(),
		queryFn: () => api("notes", "/notes"),
		select: (d) => d.notes
	});
}
function useNoteQuery(uid) {
	return useQuery({
		queryKey: qk.notes.detail(uid ?? ""),
		queryFn: () => api("notes", `/notes/${uid}`),
		enabled: Boolean(uid)
	});
}
function useTranscriptQuery(uid) {
	return useQuery({
		queryKey: qk.transcript(uid ?? ""),
		queryFn: () => api("transcript", `/notes/${uid}/transcript`),
		enabled: Boolean(uid)
	});
}
/** probe：秒级返回，**先于下载**。让"认对了没有"和"需要登录"都提前暴露（D-01 §5 F1）。 */
function useProbeMutation() {
	return useMutation({ mutationFn: (url) => api("import", "/import/probe", {
		method: "POST",
		body: { url }
	}) });
}
/**
* D-01 §3.2 规则 2：写操作一律异步化 —— 返回 202 + jobId，进度走 SSE。
* 因此 `onSuccess` **只把 job 塞进缓存，不做乐观业务更新**（D-05 §2.5：
* 触发转写/下载绝不乐观，它们会失败、会 blocked、会排队，假装成功是欺骗）。
*/
function useImportUrlMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (req) => api("import", "/import/url", {
			method: "POST",
			body: req,
			idempotencyKey: `import:${req.url}`
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.notes.all });
			qc.invalidateQueries({ queryKey: qk.jobs.all });
		}
	});
}
//#endregion
//#region src/features/notes/NoteProgressLine.tsx
/**
* 单个作业的进度行。
*
* ★ 关键：用 **selector 只订阅自己那一个 jobId**。
* 这样 5 个任务同时跑时，每条进度行只在自己的数据变化时重渲染，
* 互不牵连（D-05 §2.4）。
*/
function NoteProgressLine({ jobId, className }) {
	const { t, i18n } = useTranslation();
	const snap = useProgressStore((s) => s.byJob[jobId]);
	if (!snap) return null;
	const stepLabel = snap.step ? t(`progress.${snap.step}`, { defaultValue: snap.step }) : null;
	const eta = approxEta(snap.etaSeconds, i18n.language);
	return /* @__PURE__ */ jsxs("div", {
		className,
		children: [/* @__PURE__ */ jsxs("div", {
			className: "mb-1 flex items-center justify-between gap-2 text-xs text-ink-secondary",
			children: [/* @__PURE__ */ jsxs("span", {
				className: "truncate",
				children: [stepLabel, snap.stepIndex && snap.stepCount ? ` · ${snap.stepIndex}/${snap.stepCount}` : ""]
			}), /* @__PURE__ */ jsxs("span", {
				className: "shrink-0 tabular-nums text-ink-muted",
				children: [formatPercent(snap.progress, i18n.language), eta ? ` · ${eta}` : ""]
			})]
		}), /* @__PURE__ */ jsx(ProgressMeter, {
			value: snap.progress,
			label: stepLabel ?? t("common.loading")
		})]
	});
}
//#endregion
export { useProbeMutation as a, useNotesQuery as i, useImportUrlMutation as n, useTranscriptQuery as o, useNoteQuery as r, NoteProgressLine as t };
