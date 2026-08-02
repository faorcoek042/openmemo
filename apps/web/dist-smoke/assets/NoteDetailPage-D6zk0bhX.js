import { f as qk, s as mediaUrl, t as ErrorBlock } from "./ErrorBlock-yofocnTu.js";
import { n as isMockEnabled, r as SEGMENT_FLAG } from "./mock-D4lXt2Xs.js";
import { n as useUiStore } from "./ui.store-Ycv0FflS.js";
import { t as cn } from "./utils-BYK1OtKK.js";
import { i as timecode, o as Button } from "./time-Dn1EgsA-.js";
import { o as useTranscriptQuery, r as useNoteQuery, t as NoteProgressLine } from "./NoteProgressLine-BwF8tE2y.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Pause, Play } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
//#region src/lib/stores/player.store.ts
/**
* 播放器状态（D-05 §2.4：高频瞬时流）。
*
* **播放位置不进这个 store 的响应式路径。**
* 位置以 ~10Hz 更新，若每次都 setState，3000 行的转写稿虚拟列表会掉帧。
* 做法：位置写进模块级 ref（`positionRef`），由 canvas / 游标直接读；
* 只有"当前高亮段变了"这件事才进 store（低频，通常几秒一次）。
*/
var positionMs = 0;
var positionListeners = /* @__PURE__ */ new Set();
/** 高频写入：不触发 React 渲染。 */
function setPositionMs(ms) {
	positionMs = ms;
	for (const fn of positionListeners) fn(ms);
}
function getPositionMs() {
	return positionMs;
}
/** 给 canvas / 游标等非 React 消费者订阅。 */
function subscribePosition(fn) {
	positionListeners.add(fn);
	return () => positionListeners.delete(fn);
}
var seekNonce = 0;
var usePlayerStore = create()(subscribeWithSelector((set) => ({
	assetUid: null,
	durationMs: 0,
	playing: false,
	rate: 1,
	activeSeq: null,
	seekRequest: null,
	setSource: (assetUid, durationMs) => set({
		assetUid,
		durationMs,
		activeSeq: null,
		playing: false
	}),
	setPlaying: (playing) => set({ playing }),
	setRate: (rate) => set({ rate }),
	setActiveSeq: (activeSeq) => set({ activeSeq }),
	requestSeek: (ms) => {
		seekNonce += 1;
		setPositionMs(ms);
		set({ seekRequest: {
			ms,
			nonce: seekNonce
		} });
	}
})));
/**
* 二分查找当前段（D-05 §4.4）。
* 一场 3 小时讲座有 3000+ 段，每帧线性扫会掉帧 → O(log n)。
* `starts` 必须是升序数组。
*/
function findActiveIndex(starts, ends, t) {
	let lo = 0;
	let hi = starts.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = lo + hi >> 1;
		if (starts[mid] <= t) {
			ans = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	if (ans >= 0 && t > ends[ans]) return -1;
	return ans;
}
//#endregion
//#region src/features/transcript/TranscriptList.tsx
/**
* F5 转写稿（D-05 §4.4）。
*
* 三个性能/体验要点：
* 1. **虚拟滚动**：3 小时讲座有 3000+ 段，全量 DOM 会卡死。
* 2. **高亮只重渲染受影响的段**：activeSeq 是低频状态（几秒一次），
*    播放位置本身走 transient 通道不进 React。
* 3. **用户手动滚动 → 自动关闭"跟随播放"**。不做这一条的话，
*    用户想往回翻看前面的内容会被强行拽回当前位置 —— 这是最容易被忽略、
*    但一旦缺失就非常恼人的细节。
*/
function TranscriptList({ segments, speakerNames }) {
	const { t } = useTranslation();
	const parentRef = useRef(null);
	const activeSeq = usePlayerStore((s) => s.activeSeq);
	const setActiveSeq = usePlayerStore((s) => s.setActiveSeq);
	const requestSeek = usePlayerStore((s) => s.requestSeek);
	const setFollow = useUiStore((s) => s.setFollowPlayback);
	const starts = useMemo(() => segments.map((s) => s.startMs), [segments]);
	const ends = useMemo(() => segments.map((s) => s.endMs), [segments]);
	const virtualizer = useVirtualizer({
		count: segments.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 62,
		overscan: 8
	});
	useEffect(() => {
		let raf = 0;
		let lastIdx = -2;
		const tick = () => {
			const idx = findActiveIndex(starts, ends, getPositionMs());
			if (idx !== lastIdx) {
				lastIdx = idx;
				setActiveSeq(idx >= 0 ? segments[idx].seq : null);
				if (idx >= 0 && useUiStore.getState().followPlayback) virtualizer.scrollToIndex(idx, {
					align: "center",
					behavior: "auto"
				});
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [
		starts,
		ends,
		segments
	]);
	const suppress = useRef(false);
	useEffect(() => {
		const el = parentRef.current;
		if (!el) return;
		const onWheel = () => {
			if (suppress.current) return;
			if (useUiStore.getState().followPlayback) setFollow(false);
		};
		el.addEventListener("wheel", onWheel, { passive: true });
		el.addEventListener("touchmove", onWheel, { passive: true });
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("touchmove", onWheel);
		};
	}, [setFollow]);
	if (segments.length === 0) return /* @__PURE__ */ jsx("p", {
		className: "px-4 py-8 text-sm text-ink-muted",
		children: t("detail.noTranscript")
	});
	return /* @__PURE__ */ jsx("div", {
		ref: parentRef,
		className: "h-full overflow-auto",
		role: "list",
		"aria-label": t("detail.transcript"),
		children: /* @__PURE__ */ jsx("div", {
			style: {
				height: virtualizer.getTotalSize(),
				position: "relative"
			},
			children: virtualizer.getVirtualItems().map((row) => {
				const seg = segments[row.index];
				const active = seg.seq === activeSeq;
				const hallucination = (seg.flags & SEGMENT_FLAG.HALLUCINATION) !== 0;
				const lowConf = (seg.flags & SEGMENT_FLAG.LOW_CONFIDENCE) !== 0;
				return /* @__PURE__ */ jsx("div", {
					role: "listitem",
					"data-index": row.index,
					ref: virtualizer.measureElement,
					style: {
						position: "absolute",
						top: 0,
						left: 0,
						width: "100%",
						transform: `translateY(${row.start}px)`
					},
					children: /* @__PURE__ */ jsxs("button", {
						type: "button",
						onClick: () => {
							suppress.current = true;
							requestSeek(seg.startMs);
							setTimeout(() => suppress.current = false, 300);
						},
						className: cn("flex w-full gap-3 rounded-md px-3 py-2 text-left transition-colors", active ? "bg-accent-track/40" : "hover:bg-surface-2", hallucination && "border-l-2 border-l-warning"),
						children: [/* @__PURE__ */ jsx("span", {
							className: "mt-0.5 shrink-0 tabular-nums text-xs text-ink-muted",
							children: timecode(seg.startMs)
						}), /* @__PURE__ */ jsxs("span", {
							className: "min-w-0 flex-1",
							children: [
								seg.speakerLabel ? /* @__PURE__ */ jsx("span", {
									className: "mr-1.5 text-xs font-medium text-ink-secondary",
									children: speakerNames[seg.speakerLabel] ?? seg.speakerLabel
								}) : null,
								/* @__PURE__ */ jsx("span", {
									className: cn("text-transcript text-ink", lowConf && "opacity-80"),
									children: seg.text
								}),
								hallucination ? /* @__PURE__ */ jsxs("span", {
									className: "mt-1 flex items-center gap-1 text-xs text-warning",
									children: [/* @__PURE__ */ jsx(AlertTriangle, {
										className: "size-3",
										"aria-hidden": true
									}), t("detail.hallucination")]
								}) : null
							]
						})]
					})
				}, seg.seq);
			})
		})
	});
}
//#endregion
//#region src/features/player/Waveform.tsx
/**
* 波形（D-05 §7.3 + §4.4）。
*
* **canvas 直写，完全不进 React。** 播放位置以 ~10Hz 变化，走 React 会拖垮整页。
*
* 峰值来自 daemon 预计算的 `.ompk`（D-02 §3.4）——
* 浏览器 `decodeAudioData` 一个 2 小时的文件会占数百 MB 内存并阻塞主线程。
*
* 配色用语义令牌：已播 = accent，未播 = ink-muted，游标 2px accent。
* 这里读的是 CSS 变量，所以明暗主题切换会自动跟随，无需 JS 参与。
*/
function Waveform({ peaks, durationMs, onSeek, className }) {
	const canvasRef = useRef(null);
	const posRef = useRef(0);
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		let raf = 0;
		const draw = () => {
			const dpr = window.devicePixelRatio || 1;
			const w = canvas.clientWidth;
			const h = canvas.clientHeight;
			if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
				canvas.width = w * dpr;
				canvas.height = h * dpr;
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);
			const styles = getComputedStyle(document.documentElement);
			const accent = styles.getPropertyValue("--accent").trim() || "#2a78d6";
			const muted = styles.getPropertyValue("--ink-muted").trim() || "#898781";
			const data = peaks?.channels[0];
			const playedX = w * (durationMs > 0 ? Math.min(1, posRef.current / durationMs) : 0);
			if (data && data.length > 0) {
				const mid = h / 2;
				const step = data.length / w;
				for (let x = 0; x < w; x += 1) {
					const v = Math.abs(data[Math.floor(x * step)] ?? 0);
					const barH = Math.max(1, v * (h - 4));
					ctx.fillStyle = x <= playedX ? accent : muted;
					ctx.globalAlpha = x <= playedX ? 1 : .4;
					ctx.fillRect(x, mid - barH / 2, 1, barH);
				}
				ctx.globalAlpha = 1;
			} else {
				ctx.strokeStyle = muted;
				ctx.globalAlpha = .3;
				ctx.beginPath();
				ctx.moveTo(0, h / 2);
				ctx.lineTo(w, h / 2);
				ctx.stroke();
				ctx.globalAlpha = 1;
			}
			ctx.fillStyle = accent;
			ctx.fillRect(Math.max(0, playedX - 1), 0, 2, h);
			raf = requestAnimationFrame(draw);
		};
		raf = requestAnimationFrame(draw);
		const unsub = subscribePosition((ms) => {
			posRef.current = ms;
		});
		return () => {
			cancelAnimationFrame(raf);
			unsub();
		};
	}, [peaks, durationMs]);
	return /* @__PURE__ */ jsx("canvas", {
		ref: canvasRef,
		className,
		role: "slider",
		"aria-label": "waveform",
		"aria-valuemin": 0,
		"aria-valuemax": durationMs,
		tabIndex: 0,
		onClick: (e) => {
			const rect = e.currentTarget.getBoundingClientRect();
			const ratio = (e.clientX - rect.left) / rect.width;
			onSeek(Math.max(0, Math.min(durationMs, ratio * durationMs)));
		}
	});
}
//#endregion
//#region src/features/player/PlayerBar.tsx
/**
* F5 播放器（D-05 §4.4）。
*
* 用**原生 `<audio>`** 而不是让波形库自建媒体元素：
* - Range 请求、cookie 鉴权、缓存策略全部仍由我们掌握（`/media/asset/<uid>`）；
* - 原生元素本身就是无障碍回退（D-05 §6.3）。
*
* 播放位置以 ~10Hz 写进 transient 通道（`setPositionMs`），**不进 React state** ——
* 否则每次 tick 都会重渲染 3000 行的转写稿（D-05 §2.4）。
*/
function PlayerBar({ peaks }) {
	const { t } = useTranslation();
	const audioRef = useRef(null);
	const assetUid = usePlayerStore((s) => s.assetUid);
	const durationMs = usePlayerStore((s) => s.durationMs);
	const playing = usePlayerStore((s) => s.playing);
	const setPlaying = usePlayerStore((s) => s.setPlaying);
	const seekRequest = usePlayerStore((s) => s.seekRequest);
	const requestSeek = usePlayerStore((s) => s.requestSeek);
	const labelRef = useRef(null);
	useEffect(() => {
		if (!seekRequest || !audioRef.current) return;
		audioRef.current.currentTime = seekRequest.ms / 1e3;
	}, [seekRequest]);
	useEffect(() => {
		let raf = 0;
		let last = 0;
		const tick = () => {
			const el = audioRef.current;
			if (el) {
				const now = performance.now();
				if (now - last > 100) {
					last = now;
					const ms = el.currentTime * 1e3;
					setPositionMs(ms);
					if (labelRef.current) labelRef.current.textContent = timecode(ms);
				}
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);
	useEffect(() => {
		const onKey = (e) => {
			const tag = e.target?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA") return;
			const el = audioRef.current;
			if (!el) return;
			if (e.code === "Space") {
				e.preventDefault();
				el.paused ? el.play() : el.pause();
			} else if (e.code === "ArrowLeft") el.currentTime = Math.max(0, el.currentTime - 5);
			else if (e.code === "ArrowRight") el.currentTime += 5;
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const toggle = () => {
		const el = audioRef.current;
		if (!el) return;
		el.paused ? el.play() : el.pause();
	};
	return /* @__PURE__ */ jsxs("div", {
		className: "flex items-center gap-3 border-t border-line bg-surface-1 px-4 py-2",
		children: [
			/* @__PURE__ */ jsx(Button, {
				size: "icon",
				variant: "primary",
				onClick: toggle,
				"aria-label": playing ? t("recorder.pause") : t("capture.start"),
				children: playing ? /* @__PURE__ */ jsx(Pause, { className: "size-4" }) : /* @__PURE__ */ jsx(Play, { className: "size-4" })
			}),
			/* @__PURE__ */ jsxs("span", {
				className: "shrink-0 tabular-nums text-xs text-ink-secondary",
				children: [/* @__PURE__ */ jsx("span", {
					ref: labelRef,
					children: timecode(getPositionMs())
				}), /* @__PURE__ */ jsxs("span", {
					className: "text-ink-muted",
					children: [" / ", timecode(durationMs)]
				})]
			}),
			/* @__PURE__ */ jsx(Waveform, {
				peaks,
				durationMs,
				onSeek: requestSeek,
				className: "h-10 flex-1"
			}),
			assetUid ? /* @__PURE__ */ jsx("audio", {
				ref: audioRef,
				src: mediaUrl(assetUid),
				preload: "metadata",
				onPlay: () => setPlaying(true),
				onPause: () => setPlaying(false),
				className: "hidden"
			}) : null
		]
	});
}
//#endregion
//#region src/lib/format/peaks.ts
/**
* 在没有真实 `.ompk` 时生成一条占位波形，让 UI 能被看到与评审。
* **调用处必须把它标成 mock**，不许假装是真数据（诚实规则）。
*/
function mockPeaks(durationMs, buckets = 800) {
	const arr = new Float32Array(buckets);
	for (let i = 0; i < buckets; i += 1) {
		const t = i / buckets;
		const env = .35 + .4 * Math.sin(t * Math.PI * 6) ** 2;
		const detail = .55 + .45 * Math.sin(i * 1.7) * Math.cos(i * .31);
		arr[i] = Math.min(1, Math.abs(env * detail));
	}
	return {
		channels: [arr],
		durationMs,
		samplesPerPixel: 256
	};
}
//#endregion
//#region src/features/notes/NoteDetailPage.tsx
/** F5 笔记详情 —— 产品心脏（D-05 §4.4）。 */
function NoteDetailPage() {
	const { t } = useTranslation();
	const { noteUid } = useParams();
	const [params, setParams] = useSearchParams();
	const tab = params.get("tab") ?? "summary";
	const note = useNoteQuery(noteUid);
	const transcript = useTranscriptQuery(noteUid);
	const setSource = usePlayerStore((s) => s.setSource);
	const follow = useUiStore((s) => s.followPlayback);
	const setFollow = useUiStore((s) => s.setFollowPlayback);
	const { data: streamedSummary } = useQuery({
		queryKey: qk.summary(noteUid ?? ""),
		queryFn: () => "",
		enabled: Boolean(noteUid),
		staleTime: Infinity
	});
	const audioAsset = note.data?.assets.find((a) => a.role === "audio16k" && a.state === "ready");
	const peaksAsset = note.data?.assets.find((a) => a.role === "peaks" && a.state === "ready");
	useEffect(() => {
		if (!note.data) return;
		setSource(audioAsset?.uid ?? null, note.data.durationMs ?? 0);
	}, [
		note.data,
		audioAsset?.uid,
		setSource
	]);
	const [peaks, setPeaks] = useState(null);
	useEffect(() => {
		if (!note.data) return;
		if (peaksAsset && !isMockEnabled()) setPeaks(null);
		else setPeaks(mockPeaks(note.data.durationMs ?? 6e4));
	}, [note.data, peaksAsset]);
	const speakerNames = useMemo(() => {
		const m = {};
		for (const s of transcript.data?.speakers ?? []) m[s.label] = s.displayName ?? s.label;
		return m;
	}, [transcript.data]);
	if (note.isError) return /* @__PURE__ */ jsx(ErrorBlock, {
		error: note.error,
		onRetry: () => void note.refetch(),
		className: "m-6"
	});
	if (!note.data) return /* @__PURE__ */ jsx("div", {
		className: "p-6 text-sm text-ink-muted",
		children: t("common.loading")
	});
	const n = note.data;
	return /* @__PURE__ */ jsxs("div", {
		className: "flex h-full flex-col",
		children: [
			n.activeJobId ? /* @__PURE__ */ jsxs("div", {
				className: "border-b border-line bg-surface-1 px-4 py-2",
				children: [/* @__PURE__ */ jsx(NoteProgressLine, { jobId: n.activeJobId }), /* @__PURE__ */ jsxs("p", {
					className: "mt-1 text-xs text-ink-muted",
					children: ["▸ ", t("detail.backgroundHint")]
				})]
			}) : null,
			/* @__PURE__ */ jsx("header", {
				className: "flex items-start justify-between gap-4 border-b border-line px-4 py-3",
				children: /* @__PURE__ */ jsx("h1", {
					className: "min-w-0 truncate text-base font-semibold text-ink",
					children: n.title
				})
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex min-h-0 flex-1",
				children: [/* @__PURE__ */ jsxs("section", {
					className: "flex min-w-0 flex-1 flex-col border-r border-line",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "flex items-center justify-between border-b border-line px-3 py-1.5",
						children: [/* @__PURE__ */ jsx("h2", {
							className: "text-xs font-medium text-ink-secondary",
							children: t("detail.transcript")
						}), /* @__PURE__ */ jsxs("label", {
							className: "flex items-center gap-1.5 text-xs text-ink-secondary",
							children: [/* @__PURE__ */ jsx("input", {
								type: "checkbox",
								checked: follow,
								onChange: (e) => setFollow(e.target.checked),
								className: "size-3.5 accent-[var(--accent)]"
							}), t("detail.followPlayback")]
						})]
					}), /* @__PURE__ */ jsx("div", {
						className: "min-h-0 flex-1",
						children: /* @__PURE__ */ jsx(TranscriptList, {
							segments: transcript.data?.segments ?? [],
							speakerNames
						})
					})]
				}), /* @__PURE__ */ jsxs("aside", {
					className: "hidden w-[420px] shrink-0 flex-col lg:flex",
					children: [/* @__PURE__ */ jsx("nav", {
						className: "flex border-b border-line",
						role: "tablist",
						children: [
							"summary",
							"mindmap",
							"notes"
						].map((k) => /* @__PURE__ */ jsx("button", {
							role: "tab",
							"aria-selected": tab === k,
							onClick: () => setParams((p) => {
								p.set("tab", k);
								return p;
							}),
							className: cn("flex-1 px-3 py-2 text-sm transition-colors", tab === k ? "border-b-2 border-b-accent text-ink" : "text-ink-muted hover:text-ink-secondary"),
							children: t(`detail.tabs.${k}`)
						}, k))
					}), /* @__PURE__ */ jsx("div", {
						className: "min-h-0 flex-1 overflow-auto p-4 text-sm text-ink-secondary",
						children: tab === "summary" ? n.summaryMd ?? streamedSummary ? /* @__PURE__ */ jsx("p", {
							className: "whitespace-pre-wrap",
							children: n.summaryMd || streamedSummary
						}) : /* @__PURE__ */ jsx("p", {
							className: "text-ink-muted",
							children: t("detail.summaryEmpty")
						}) : tab === "mindmap" ? /* @__PURE__ */ jsx("p", {
							className: "text-ink-muted",
							children: "思维导图由 T-023 实现（features/mindmap/）。"
						}) : /* @__PURE__ */ jsx("p", {
							className: "text-ink-muted",
							children: "笔记编辑器（TipTap）待接入。"
						})
					})]
				})]
			}),
			/* @__PURE__ */ jsx(PlayerBar, { peaks })
		]
	});
}
//#endregion
export { NoteDetailPage as default };
