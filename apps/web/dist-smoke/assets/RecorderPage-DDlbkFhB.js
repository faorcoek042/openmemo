import { t as cn } from "./utils-BYK1OtKK.js";
import { t as useConnectionStore } from "./connection.store-CA7IyQ1M.js";
import { t as Banner } from "./Banner-C-cOOcHq.js";
import { a as ProgressMeter, i as timecode, o as Button } from "./time-Dn1EgsA-.js";
import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
import { Mic, MicOff, RefreshCw, Square } from "lucide-react";
//#region src/features/recorder/RecorderPage.tsx
/**
* F3 录音转文字（D-05 §4.3）。
*
* ★ 本页最重要的不是波形好不好看，而是**把两阶段转写说清楚** ★
*
* 设计（D-01 §5 F3）：录音时用流式模型出稿（低延迟、准确率低），
* 停止后自动用离线大模型重跑并覆盖。如果不说清楚，用户会以为
* **软件在乱改自己的字** —— 这是产品成败点，不是文案润色。
*
* 四道保险：
* 1. 录音时就**预告**（底部常驻提示），不等事后解释；
* 2. partial 灰斜体 / final 正常字重，"还没定稿"用通用视觉语义表达，不用动画；
* 3. 重跑时不遮挡内容，并明说"你现在看到的是初稿，可以先编辑，编辑不会被覆盖"；
* 4. 完成后给「已更新 N 段 · 你编辑过的 M 段已保留 · [撤销]」。**撤销必须存在** ——
*    否则"重跑让结果变差了"就无解。
*/
function RecorderPage() {
	const { t } = useTranslation();
	const [perm, setPerm] = useState("unknown");
	const [phase, setPhase] = useState("idle");
	const [elapsed, setElapsed] = useState(0);
	const [captions, setCaptions] = useState([]);
	const [rerunProgress, setRerunProgress] = useState(0);
	const [replaced, setReplaced] = useState(null);
	const portDrift = useConnectionStore((s) => s.portDrift);
	const levelRef = useRef(null);
	const timerRef = useRef(null);
	useEffect(() => {
		if (typeof navigator === "undefined" || !navigator.permissions) return;
		navigator.permissions.query({ name: "microphone" }).then((s) => setPerm(s.state === "granted" ? "granted" : s.state === "denied" ? "denied" : "unknown")).catch(() => setPerm("unknown"));
	}, []);
	const requestMic = async () => {
		try {
			(await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((tr) => tr.stop());
			setPerm("granted");
		} catch {
			setPerm("denied");
		}
	};
	const start = () => {
		setPhase("recording");
		setCaptions([]);
		setReplaced(null);
		setElapsed(0);
		timerRef.current = setInterval(() => setElapsed((e) => e + 1e3), 1e3);
		let i = 0;
		const feed = setInterval(() => {
			i += 1;
			setCaptions((c) => {
				return [...c.map((x) => ({
					...x,
					final: true
				})), {
					id: i,
					text: MOCK_LINES[i % MOCK_LINES.length],
					final: false
				}];
			});
			if (i > 6) clearInterval(feed);
		}, 1800);
	};
	const stop = () => {
		if (timerRef.current) clearInterval(timerRef.current);
		setCaptions((c) => c.map((x) => ({
			...x,
			final: true
		})));
		setPhase("rerunning");
		let p = 0;
		const iv = setInterval(() => {
			p += .08;
			setRerunProgress(Math.min(1, p));
			if (p >= 1) {
				clearInterval(iv);
				setPhase("done");
				setReplaced({
					updated: 47,
					preserved: 3
				});
			}
		}, 220);
	};
	return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8",
		children: [
			/* @__PURE__ */ jsx("h1", {
				className: "text-xl font-semibold text-ink",
				children: t("recorder.title")
			}),
			portDrift ? /* @__PURE__ */ jsx(Banner, {
				tone: "warning",
				title: t("banner.portDrift", {
					expected: portDrift.expected,
					actual: portDrift.actual
				})
			}) : null,
			perm === "denied" ? /* @__PURE__ */ jsx("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: /* @__PURE__ */ jsxs("div", {
					className: "flex items-start gap-2.5",
					children: [/* @__PURE__ */ jsx(MicOff, {
						className: "mt-0.5 size-4 text-critical",
						"aria-hidden": true
					}), /* @__PURE__ */ jsxs("div", { children: [
						/* @__PURE__ */ jsx("div", {
							className: "text-sm font-medium text-ink",
							children: t("recorder.permDenied")
						}),
						/* @__PURE__ */ jsx("p", {
							className: "mt-1 text-sm text-ink-secondary",
							children: t("recorder.permDeniedHelp")
						}),
						/* @__PURE__ */ jsxs(Button, {
							size: "sm",
							variant: "secondary",
							className: "mt-3",
							onClick: requestMic,
							children: [/* @__PURE__ */ jsx(RefreshCw, { className: "size-3.5" }), t("recorder.recheck")]
						})
					] })]
				})
			}) : perm !== "granted" ? /* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-6 text-center",
				children: [
					/* @__PURE__ */ jsx(Mic, {
						className: "mx-auto mb-2 size-6 text-ink-muted",
						"aria-hidden": true
					}),
					/* @__PURE__ */ jsx("p", {
						className: "text-sm text-ink-secondary",
						children: t("recorder.permNeeded")
					}),
					/* @__PURE__ */ jsx(Button, {
						variant: "primary",
						className: "mt-3",
						onClick: requestMic,
						children: t("recorder.permAllow")
					})
				]
			}) : /* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "flex items-center justify-between",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "flex items-center gap-2 text-sm",
						children: [phase === "recording" ? /* @__PURE__ */ jsxs("span", {
							className: "inline-flex items-center gap-1.5 font-medium text-critical",
							children: [/* @__PURE__ */ jsx("span", {
								className: "size-2 rounded-full bg-critical",
								"aria-hidden": true
							}), t("recorder.recording")]
						}) : /* @__PURE__ */ jsx("span", {
							className: "text-ink-secondary",
							children: t("recorder.device")
						}), /* @__PURE__ */ jsx("span", {
							className: "tabular-nums text-ink-muted",
							children: timecode(elapsed)
						})]
					}), phase === "recording" ? /* @__PURE__ */ jsxs(Button, {
						variant: "danger",
						size: "sm",
						onClick: stop,
						children: [/* @__PURE__ */ jsx(Square, { className: "size-3.5" }), t("recorder.stop")]
					}) : phase === "idle" ? /* @__PURE__ */ jsxs(Button, {
						variant: "primary",
						size: "sm",
						onClick: start,
						children: [/* @__PURE__ */ jsx(Mic, { className: "size-3.5" }), t("recorder.start")]
					}) : null]
				}), /* @__PURE__ */ jsx("div", {
					ref: levelRef,
					className: "mt-3 h-10 rounded bg-surface-0",
					"aria-hidden": true
				})]
			}),
			captions.length > 0 ? /* @__PURE__ */ jsx("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: /* @__PURE__ */ jsx("ul", {
					className: "flex flex-col gap-1.5",
					role: "list",
					children: captions.map((c) => /* @__PURE__ */ jsx("li", {
						className: cn("text-transcript", c.final ? "text-ink" : "text-ink-muted italic"),
						children: c.text
					}, c.id))
				})
			}) : null,
			phase === "recording" || phase === "idle" ? /* @__PURE__ */ jsxs("p", {
				className: "text-xs text-ink-muted",
				children: ["ⓘ ", t("recorder.twoPhaseNotice")]
			}) : null,
			phase === "rerunning" ? /* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "mb-2 flex items-center justify-between text-sm",
						children: [/* @__PURE__ */ jsx("span", {
							className: "text-ink",
							children: t("recorder.rerunning", { model: "large-v3-turbo" })
						}), /* @__PURE__ */ jsx(Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => setPhase("done"),
							children: t("recorder.skipRerun")
						})]
					}),
					/* @__PURE__ */ jsx(ProgressMeter, {
						value: rerunProgress,
						label: t("recorder.rerunning", { model: "" }),
						size: "md"
					}),
					/* @__PURE__ */ jsx("p", {
						className: "mt-2 text-xs text-ink-secondary",
						children: t("recorder.rerunHint")
					})
				]
			}) : null,
			replaced ? /* @__PURE__ */ jsx(Banner, {
				tone: "info",
				title: t("recorder.replaced", {
					updated: replaced.updated,
					preserved: replaced.preserved
				}),
				action: /* @__PURE__ */ jsxs("div", {
					className: "flex gap-2",
					children: [/* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "ghost",
						children: t("recorder.viewDiff")
					}), /* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "secondary",
						children: t("recorder.undoReplace")
					})]
				})
			}) : null
		]
	});
}
var MOCK_LINES = [
	"好，我们今天先过一下上周的进度。",
	"第一个是转写流水线，已经能跑通链接导入了。",
	"第二个是模型管理页，还在等后端接口。",
	"那我这边补充一下，运行时检测的部分",
	"已经能在 Linux 上实测出可用后端了。",
	"好，那我们下周同步一次打包的进度。",
	"另外提醒一下，录音这块要注意两阶段的提示。"
];
//#endregion
export { RecorderPage as default };
