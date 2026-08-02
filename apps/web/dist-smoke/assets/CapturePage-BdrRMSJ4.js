import { r as MockNotice, t as ErrorBlock } from "./ErrorBlock-NhqIUn2X.js";
import { t as Button } from "./Button-CCMyJCPF.js";
import { r as humanDuration } from "./time-BT6YJuzy.js";
import { a as useProbeMutation, n as useImportUrlMutation } from "./NoteProgressLine-8XPY9COY.js";
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
import { Link2, Loader2, Upload } from "lucide-react";
//#region src/features/capture/CapturePage.tsx
/**
* F1 链接导入 + F2 本地文件（D-05 §4.1 / §4.2）。
*
* 核心节奏：**probe 先行**。
* 拿到标题/时长/封面只要秒级，用户立刻知道"认对了没有"；而"需要登录/格式不支持"
* 这类失败也在此刻暴露，而不是下了 400 MB 之后才说。
*/
function CapturePage() {
	const { t, i18n } = useTranslation();
	const navigate = useNavigate();
	const [url, setUrl] = useState("");
	const [probe, setProbe] = useState(null);
	const [dragging, setDragging] = useState(false);
	const fileRef = useRef(null);
	const [opts, setOpts] = useState({
		diarize: true,
		keepVideo: false,
		structure: true
	});
	const probeMut = useProbeMutation();
	const importMut = useImportUrlMutation();
	const runProbe = useCallback(() => {
		const trimmed = url.trim();
		if (!trimmed) return;
		probeMut.mutate(trimmed, { onSuccess: setProbe });
	}, [url, probeMut]);
	const start = () => {
		importMut.mutate({
			url: url.trim(),
			diarize: opts.diarize,
			keepVideo: opts.keepVideo,
			generateStructure: opts.structure
		}, { onSuccess: (r) => navigate(`/notes/${r.noteUid}`) });
	};
	return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10",
		onDragOver: (e) => {
			e.preventDefault();
			setDragging(true);
		},
		onDragLeave: () => setDragging(false),
		onDrop: (e) => {
			e.preventDefault();
			setDragging(false);
		},
		children: [
			/* @__PURE__ */ jsx("h1", {
				className: "text-xl font-semibold text-ink",
				children: t("capture.title")
			}),
			/* @__PURE__ */ jsx(MockNotice, { surface: "import" }),
			/* @__PURE__ */ jsxs("div", { children: [
				/* @__PURE__ */ jsx("label", {
					htmlFor: "capture-url",
					className: "mb-2 block text-sm text-ink-secondary",
					children: t("capture.urlLabel")
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "flex gap-2",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "relative flex-1",
						children: [/* @__PURE__ */ jsx(Link2, {
							className: "absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted",
							"aria-hidden": true
						}), /* @__PURE__ */ jsx("input", {
							id: "capture-url",
							value: url,
							onChange: (e) => {
								setUrl(e.target.value);
								setProbe(null);
							},
							onKeyDown: (e) => e.key === "Enter" && runProbe(),
							placeholder: t("capture.urlPlaceholder"),
							className: "h-10 w-full rounded-md border border-line bg-surface-1 pr-3 pl-9 text-sm text-ink placeholder:text-ink-muted",
							spellCheck: false,
							autoComplete: "off"
						})]
					}), /* @__PURE__ */ jsx(Button, {
						variant: "primary",
						onClick: runProbe,
						disabled: !url.trim() || probeMut.isPending,
						children: probeMut.isPending ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Loader2, {
							className: "size-4 animate-spin",
							"aria-hidden": true
						}), t("capture.probing")] }) : t("capture.start")
					})]
				}),
				/* @__PURE__ */ jsx("p", {
					className: "mt-2 text-xs text-ink-muted",
					children: t("capture.supported")
				})
			] }),
			probeMut.isError ? /* @__PURE__ */ jsx(ErrorBlock, {
				error: probeMut.error,
				onRetry: runProbe
			}) : null,
			probe ? /* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				"data-testid": "capture-probe",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "flex gap-4",
						children: [/* @__PURE__ */ jsx("div", {
							className: "flex size-20 shrink-0 items-center justify-center rounded-md bg-surface-0 text-xs text-ink-muted",
							"aria-hidden": true,
							children: probe.thumbnailUrl ? null : "封面"
						}), /* @__PURE__ */ jsxs("div", {
							className: "min-w-0 flex-1",
							children: [
								/* @__PURE__ */ jsx("h2", {
									className: "truncate text-base font-medium text-ink",
									children: probe.title
								}),
								/* @__PURE__ */ jsx("p", {
									className: "mt-0.5 text-sm text-ink-secondary",
									children: [
										probe.author,
										probe.durationMs ? humanDuration(probe.durationMs, i18n.language) : null,
										probe.site
									].filter(Boolean).join(" · ")
								}),
								/* @__PURE__ */ jsxs("p", {
									className: "mt-1 text-xs text-ink-muted",
									children: ["adapter: ", probe.adapterId]
								})
							]
						})]
					}),
					/* @__PURE__ */ jsx("div", {
						className: "mt-4 flex flex-wrap gap-4 border-t border-line pt-4 text-sm",
						children: [
							"diarize",
							"keepVideo",
							"structure"
						].map((k) => /* @__PURE__ */ jsxs("label", {
							className: "flex items-center gap-2 text-ink-secondary",
							children: [/* @__PURE__ */ jsx("input", {
								type: "checkbox",
								checked: opts[k],
								onChange: (e) => setOpts((o) => ({
									...o,
									[k]: e.target.checked
								})),
								className: "size-4 accent-[var(--accent)]"
							}), t(`capture.options.${k}`)]
						}, k))
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "mt-4 flex justify-end gap-2",
						children: [/* @__PURE__ */ jsx(Button, {
							variant: "ghost",
							onClick: () => setProbe(null),
							children: t("capture.cancel")
						}), /* @__PURE__ */ jsx(Button, {
							variant: "primary",
							onClick: start,
							disabled: importMut.isPending,
							children: t("capture.confirm")
						})]
					})
				]
			}) : null,
			importMut.isError ? /* @__PURE__ */ jsx(ErrorBlock, { error: importMut.error }) : null,
			/* @__PURE__ */ jsxs("section", {
				className: ["rounded-lg border-2 border-dashed p-8 text-center transition-colors", dragging ? "border-accent bg-accent-track/30" : "border-line"].join(" "),
				children: [
					/* @__PURE__ */ jsx(Upload, {
						className: "mx-auto mb-2 size-6 text-ink-muted",
						"aria-hidden": true
					}),
					/* @__PURE__ */ jsx("p", {
						className: "text-sm text-ink-secondary",
						children: dragging ? t("capture.dropHint") : t("capture.urlLabel")
					}),
					/* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "secondary",
						className: "mt-3",
						onClick: () => fileRef.current?.click(),
						children: t("nav.newCapture")
					}),
					/* @__PURE__ */ jsx("input", {
						ref: fileRef,
						type: "file",
						accept: "audio/*,video/*",
						multiple: true,
						hidden: true
					}),
					/* @__PURE__ */ jsx("p", {
						className: "mt-3 text-xs text-ink-muted",
						children: t("capture.uploadExplain")
					})
				]
			})
		]
	});
}
//#endregion
export { CapturePage as default };
