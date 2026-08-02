import { a as consumeHandoffToken, d as useSurfaceStore, f as STALE_TIME_OVERRIDES, i as api, l as setCsrf, m as qk, n as ConnectivitySummary, p as createQueryClient, s as rawFetch, t as ErrorBlock, u as markSurface } from "./assets/ErrorBlock-NhqIUn2X.js";
import { a as isSequenced, o as KEEPALIVE_INTERVAL_MS, r as ALL_SSE_EVENT_TYPES, s as bus, t as installMockApi } from "./assets/mock-8ZZ8pRo5.js";
import { n as useUiStore, t as applyTheme } from "./assets/ui.store-2aoWFaa7.js";
import { t as cn } from "./assets/utils-BYK1OtKK.js";
import { n as useProgressStore, t as pushProgress } from "./assets/progress.store-CB1TnKEq.js";
import { t as useConnectionStore } from "./assets/connection.store-CA7IyQ1M.js";
import { n as initI18n } from "./assets/i18n-CM4uFOy_.js";
import { t as Banner } from "./assets/Banner-C-cOOcHq.js";
import "./assets/api-DQD1-1um.js";
import { t as Button } from "./assets/Button-CCMyJCPF.js";
import { t as ProgressMeter } from "./assets/ProgressMeter--rPJ_6mH.js";
import { t as StatusChip } from "./assets/StatusChip--dKLeohu.js";
import { t as approxEta } from "./assets/time-BT6YJuzy.js";
import { n as formatPercent, r as formatSpeed, t as formatBytes } from "./assets/bytes-JyzdoODc.js";
import { t as EmptyState } from "./assets/EmptyState-Bc3D_rF1.js";
import { Suspense, act, createElement, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, NavLink, Navigate, Outlet, createMemoryRouter, useNavigate, useParams } from "react-router";
import { RouterProvider } from "react-router/dom";
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
import { Activity, AlertTriangle, ArrowLeft, Ban, Boxes, Check, CheckCircle2, ChevronDown, CircleDashed, Cpu, Download, ExternalLink, FileAudio, Gauge, HardDrive, Info, Lock, MemoryStick, Mic, MonitorCog, OctagonAlert, Package, Play, Plus, RefreshCw, Search, Settings, ShieldCheck, Star, Trash2, X, XCircle, Zap } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
//#region src/features/notes/sse.ts
/**
* ② `transcribe.segment` / `transcribe.partial` **不带 `noteUid`**
* （与 D-05 §11.0 总则 3 不一致，已上报）。
* 这里用 `transcribe.started` 建立 transcriptUid → noteUid 的映射来补齐。
* 若映射缺失（例如刷新页面后中途接上流），退化为全量失效，保证不出错。
*/
var transcriptToNote = /* @__PURE__ */ new Map();
/** ① 秒 → 毫秒。内部一律整数毫秒（D-02 §1.1：浮点秒会在字幕对齐上累积误差）。 */
var toMs = (sec) => Math.round(sec * 1e3);
function upsertSegment(qc, noteUid, seg) {
	qc.setQueryData(qk.transcript(noteUid), (old) => {
		if (!old) return old ?? null;
		if (old.segments.some((s) => s.seq === seg.seq)) return old;
		return {
			...old,
			segments: [...old.segments, seg].sort((a, b) => a.seq - b.seq)
		};
	});
}
var notesSse = (qc) => [
	bus.on("note.created", (_e) => {
		qc.invalidateQueries({ queryKey: qk.notes.all });
	}),
	bus.on("note.updated", (e) => {
		qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
		if (e.changed.some((c) => c === "title" || c === "tags" || c === "folder")) qc.invalidateQueries({ queryKey: qk.notes.all });
		if (e.changed.includes("transcript")) qc.invalidateQueries({ queryKey: qk.transcript(e.noteUid) });
		if (e.changed.includes("mindmap")) qc.invalidateQueries({ queryKey: qk.mindmap(e.noteUid) });
	}),
	bus.on("note.deleted", (_e) => {
		qc.invalidateQueries({ queryKey: qk.notes.all });
	}),
	bus.on("media.ready", (e) => {
		qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
	}),
	bus.on("x.media.asset.ready", (e) => {
		qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
	}),
	bus.on("transcribe.started", (e) => {
		transcriptToNote.set(e.transcriptUid, e.noteUid);
		qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
	}),
	bus.on("transcribe.segment", (e) => {
		const noteUid = transcriptToNote.get(e.transcriptUid);
		if (!noteUid) {
			qc.invalidateQueries({ queryKey: ["transcript"] });
			return;
		}
		upsertSegment(qc, noteUid, {
			seq: e.seq,
			startMs: toMs(e.startSec),
			endMs: toMs(e.endSec),
			text: e.text,
			speakerLabel: e.speaker,
			confidence: e.confidence,
			noSpeechProb: null,
			words: null,
			chunkIdx: null,
			flags: 0
		});
	}),
	bus.on("transcribe.partial", (_e) => {}),
	bus.on("transcribe.done", (e) => {
		transcriptToNote.set(e.transcriptUid, e.noteUid);
		qc.invalidateQueries({ queryKey: qk.transcript(e.noteUid) });
		qc.invalidateQueries({ queryKey: qk.notes.detail(e.noteUid) });
	}),
	bus.on("x.transcribe.replaced", (e) => {
		qc.invalidateQueries({ queryKey: qk.transcript(e.noteUid) });
	}),
	bus.on("x.summary.delta", (e) => {
		qc.setQueryData(qk.summary(e.noteUid), (old) => (old ?? "") + e.textDelta);
	})
];
//#endregion
//#region ../../packages/shared/dist/jobs.js
var TERMINAL_JOB_STATES = [
	"succeeded",
	"failed",
	"cancelled"
];
//#endregion
//#region src/features/tasks/sse.ts
var tasksSse = (qc) => [
	bus.on("job.progress", (e) => {
		pushProgress({
			jobId: e.jobId,
			jobType: "job",
			state: e.state,
			progress: e.pct ?? 0,
			step: e.step,
			completedBytes: e.completedBytes,
			totalBytes: e.totalBytes,
			speedBps: e.speedBps,
			etaSeconds: e.etaSeconds
		});
		if (TERMINAL_JOB_STATES.includes(e.state)) {
			useProgressStore.getState().clear(e.jobId);
			qc.invalidateQueries({ queryKey: qk.jobs.all });
			qc.invalidateQueries({ queryKey: qk.notes.all });
		}
	}),
	bus.on("job.created", () => {
		qc.invalidateQueries({ queryKey: qk.jobs.all });
	}),
	bus.on("job.state", (_e) => {
		qc.invalidateQueries({ queryKey: qk.jobs.all });
	}),
	bus.on("job.done", () => {
		qc.invalidateQueries({ queryKey: qk.jobs.all });
		qc.invalidateQueries({ queryKey: qk.notes.all });
	}),
	bus.on("job.blocked", () => {
		qc.invalidateQueries({ queryKey: qk.jobs.all });
	}),
	bus.on("job.failed", (e) => {
		qc.invalidateQueries({ queryKey: qk.jobs.all });
		if (!e.willRetry) bus.emit("ui.toast.jobFailed", e);
	})
];
//#endregion
//#region src/lib/events/system.sse.ts
var systemSse = (qc) => [
	bus.on("sync.required", () => {
		qc.invalidateQueries();
	}),
	bus.on("x.daemon.shutdown", () => {
		useConnectionStore.getState().setState("degraded");
	}),
	bus.on("x.index.progress", () => {})
];
//#endregion
//#region src/features/models/sse.ts
var modelsSse = (qc) => [
	bus.on("job.progress", (e) => {
		pushProgress({
			jobId: e.jobId,
			jobType: "download",
			state: e.state,
			progress: e.pct ?? (e.totalBytes && e.completedBytes != null ? e.completedBytes / e.totalBytes : 0),
			step: e.step,
			completedBytes: e.completedBytes,
			totalBytes: e.totalBytes,
			speedBps: e.speedBps,
			etaSeconds: e.etaSeconds
		});
	}),
	bus.on("model.installed", (_e) => {
		qc.invalidateQueries({ queryKey: qk.models.installed });
		qc.invalidateQueries({ queryKey: qk.models.catalog });
		qc.invalidateQueries({ queryKey: qk.models.storage });
	}),
	bus.on("model.removed", (_e) => {
		qc.invalidateQueries({ queryKey: qk.models.installed });
		qc.invalidateQueries({ queryKey: qk.models.catalog });
		qc.invalidateQueries({ queryKey: qk.models.storage });
	}),
	bus.on("model.activated", (_e) => {
		qc.invalidateQueries({ queryKey: qk.models.installed });
	}),
	bus.on("storage.changed", (_e) => {
		qc.invalidateQueries({ queryKey: qk.models.storage });
	}),
	bus.on("catalog.updated", (_e) => {
		qc.invalidateQueries({ queryKey: qk.models.catalog });
	}),
	bus.on("sources.probed", (_e) => {
		qc.invalidateQueries({ queryKey: qk.models.sources });
	})
];
//#endregion
//#region src/features/runtime/sse.ts
var runtimeSse = (qc) => [
	bus.on("backend.installed", (e) => {
		qc.invalidateQueries({ queryKey: qk.backends.installed });
		qc.invalidateQueries({ queryKey: qk.backends.catalog });
		qc.invalidateQueries({ queryKey: qk.models.catalog });
		if (e.selfTestPassed === false) bus.emit("ui.toast.backendSelfTestFailed", e);
	}),
	bus.on("backend.removed", (_e) => {
		qc.invalidateQueries({ queryKey: qk.backends.installed });
		qc.invalidateQueries({ queryKey: qk.backends.catalog });
		qc.invalidateQueries({ queryKey: qk.models.catalog });
		qc.invalidateQueries({ queryKey: qk.models.storage });
	}),
	bus.on("hardware.changed", (_e) => {
		qc.invalidateQueries({ queryKey: qk.runtime.hardware });
		qc.invalidateQueries({ queryKey: qk.models.catalog });
	})
];
//#endregion
//#region src/lib/events/bindings.ts
var BINDINGS = [
	systemSse,
	notesSse,
	tasksSse,
	modelsSse,
	runtimeSse
];
/** 注册全部绑定，返回统一的注销函数。 */
function registerAllSseBindings(qc) {
	const disposers = BINDINGS.flatMap((b) => b(qc));
	return () => disposers.forEach((d) => d());
}
//#endregion
//#region src/lib/events/source.ts
/**
* SSE 单例（D-05 §2.3）—— 全应用**唯一**一条 EventSource。
*
* 三个必须做对的地方，每一个都是踩过/预判到的坑：
*
* 1. ★ **`onmessage` 永远不会触发。**
*    `packages/shared` 的 `formatSseFrame()` 发的是 `event: <type>`（具名事件）。
*    按 SSE 规范，带具名 `event:` 的帧只会派发到 `addEventListener('<type>')`，
*    `onmessage` 只接 `event: message` 或无 `event:` 的帧。
*    → 必须遍历类型逐一 addEventListener。写成 onmessage 会得到
*      "连上了但什么都收不到"的**静默失败**。
*
* 2. ★ **多标签页会吃掉 HTTP/1.1 的 6 连接预算。**
*    3 个标签各开一条 SSE = 预算去掉一半，媒体 Range 与 REST 会随机排队卡住。
*    → Web Locks 选主：全浏览器只有一个标签持有 EventSource，其余靠 BroadcastChannel 收转播。
*    ADR-007 决策 5 的硬要求：**必须特性检测**，`navigator.locks` 不可用时降级回
*    "每个标签各开一条"（即 D-01 的原行为），不让这个 UNKNOWN 变成阻塞。
*
* 3. ★ **StrictMode 会双挂载。**
*    绝不在组件里 `new EventSource`。这里用模块级单例 + 引用计数。
*/
var CHANNEL = "openmemo-sse";
var LOCK_NAME = "openmemo-sse-leader";
/** 连续这么多次重连失败后降级为轮询（约 15s） */
var MAX_RECONNECT_BEFORE_DEGRADE = 5;
/** 超过 keepalive 间隔这么多倍没收到任何帧，判定连接已死 */
var WATCHDOG_FACTOR = 2;
/** `data` 类事件的 seq 缺口检测状态：streamKey → 上一个 seq */
var seqCursors = /* @__PURE__ */ new Map();
/** 判断一条 data 事件属于哪条"流"（缺口检测按流独立进行）。 */
function streamKeyOf(type, payload) {
	if (type === "transcribe.segment") return `t:${String(payload.transcriptUid)}`;
	if (type === "mindmap.delta") return `m:${String(payload.mindmapUid)}`;
	if (type === "summary.delta") return `s:${String(payload.noteUid)}`;
	return type;
}
var started = false;
var refCount = 0;
var es = null;
var channel = null;
var isLeader = false;
var reconnectAttempts = 0;
var watchdog = null;
var lastFrameAt = Date.now();
var releaseLock = null;
function setState(s) {
	useConnectionStore.getState().setState(s);
}
/**
* 分发一条事件。data 类做 seq 缺口检测；缺口时发 `sync.required`，
* 由 bindings 层触发整篇重拉（D-05 §11.0 总则 2）。
*/
function dispatch(type, payload) {
	lastFrameAt = Date.now();
	if (type === "keepalive") return;
	if (isSequenced(type) && payload && typeof payload === "object") {
		const p = payload;
		const seq = typeof p.seq === "number" ? p.seq : null;
		if (seq !== null) {
			const key = streamKeyOf(type, p);
			const prev = seqCursors.get(key);
			if (prev !== void 0 && seq !== prev + 1) {
				console.warn(`[sse] ${type} seq 缺口: 期望 ${prev + 1}, 收到 ${seq} → 触发重拉`);
				bus.emit("sync.required", {
					type: "sync.required",
					reason: "replay_gap"
				});
			}
			seqCursors.set(key, seq);
		}
	}
	bus.emit(type, payload);
}
function attach(source) {
	for (const type of ALL_SSE_EVENT_TYPES) source.addEventListener(type, (e) => {
		lastFrameAt = Date.now();
		let payload;
		try {
			payload = JSON.parse(e.data);
		} catch {
			console.error(`[sse] 无法解析 ${type} 的 data`, e.data);
			return;
		}
		dispatch(type, payload);
		if (isLeader && channel) channel.postMessage({
			type,
			payload
		});
	});
	source.onopen = () => {
		reconnectAttempts = 0;
		const wasDown = useConnectionStore.getState().state !== "open";
		setState("open");
		if (wasDown) bus.emit("sync.required", {
			type: "sync.required",
			reason: "replay_gap"
		});
	};
	source.onerror = () => {
		reconnectAttempts += 1;
		setState(reconnectAttempts >= MAX_RECONNECT_BEFORE_DEGRADE ? "degraded" : "reconnecting");
	};
}
function openStream(opts) {
	const factory = opts.factory ?? ((url) => new EventSource(url, { withCredentials: true }));
	setState("connecting");
	es = factory(opts.url);
	attach(es);
	watchdog = setInterval(() => {
		if (Date.now() - lastFrameAt > 15e3 * WATCHDOG_FACTOR) {
			console.warn("[sse] 看门狗超时，重建连接");
			es?.close();
			es = null;
			lastFrameAt = Date.now();
			openStream(opts);
		}
	}, KEEPALIVE_INTERVAL_MS);
}
function becomeFollower() {
	isLeader = false;
	setState("open");
	channel?.addEventListener("message", (e) => {
		const { type, payload } = e.data;
		dispatch(type, payload);
	});
}
/**
* 启动 SSE。幂等 + 引用计数，StrictMode 双挂载安全。
* 返回 stop 函数。
*/
function startSse(opts) {
	refCount += 1;
	if (started) return makeStop();
	started = true;
	channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
	if (typeof navigator !== "undefined" && "locks" in navigator && !!navigator.locks && channel) {
		navigator.locks.request(LOCK_NAME, { mode: "exclusive" }, () => {
			isLeader = true;
			openStream(opts);
			return new Promise((resolve) => {
				releaseLock = resolve;
			});
		});
		becomeFollower();
	} else {
		console.info("[sse] navigator.locks 不可用，降级为每标签一条流");
		useConnectionStore.getState().setMultiTabDegraded(true);
		isLeader = true;
		openStream(opts);
	}
	return makeStop();
}
function makeStop() {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		refCount -= 1;
		if (refCount > 0) return;
		started = false;
		if (watchdog) clearInterval(watchdog);
		watchdog = null;
		es?.close();
		es = null;
		releaseLock?.();
		releaseLock = null;
		channel?.close();
		channel = null;
		isLeader = false;
		seqCursors.clear();
	};
}
//#endregion
//#region src/lib/api/connect.ts
/**
* daemon 连接与鉴权握手（D-01 §2.4）。
*
* 顺序（每一步都可能失败，失败不阻断其余功能）：
*   1. GET /api/health          —— **公开**，不需要鉴权。确认 daemon 在跑 + 契约版本一致
*   2. 从 URL fragment 取 token —— daemon 启动时放的 `#t=…`，取完立刻抹掉 URL
*   3. POST /api/auth/session   —— Bearer token 换 HttpOnly cookie + CSRF token
*   4. 打开 SSE                 —— cookie 已就位，EventSource 才能带上鉴权
*
* 为什么必须换 cookie：SSE / WebSocket / `<audio src>` 这三类通道
* **都带不了 Authorization header**，cookie 是唯一同时覆盖它们的方案（D-01 §2.4）。
*/
async function connectToDaemon() {
	const store = useSurfaceStore.getState();
	let health = null;
	try {
		const res = await rawFetch("/api/health", { method: "GET" });
		if (res.ok) {
			health = await res.json();
			markSurface("health", "live");
			store.setHealth({
				version: health.version,
				instanceId: health.instanceId,
				contractVersion: health.contractVersion,
				dataDir: health.dataDir,
				port: health.port,
				pid: health.pid
			});
		} else markSurface("health", "offline");
	} catch {
		markSurface("health", "offline");
		return {
			reachable: false,
			authed: false,
			health: null,
			contractMismatch: false
		};
	}
	if (!health) return {
		reachable: false,
		authed: false,
		health: null,
		contractMismatch: false
	};
	if (health.contractVersion !== 1) {
		useConnectionStore.getState().setContractMismatch({
			web: 1,
			daemon: health.contractVersion
		});
		return {
			reachable: true,
			authed: false,
			health,
			contractMismatch: true
		};
	}
	const expected = 17650;
	if (health.port !== expected) useConnectionStore.getState().setPortDrift({
		expected,
		actual: health.port
	});
	let authed = false;
	const token = consumeHandoffToken();
	try {
		const res = await rawFetch("/api/auth/session", {
			method: "POST",
			headers: token ? { Authorization: `Bearer ${token}` } : void 0
		});
		if (res.ok) {
			const body = await res.json();
			setCsrf(body.csrf);
			authed = true;
			markSurface("auth", "live");
		} else markSurface("auth", "offline");
	} catch {
		markSurface("auth", "offline");
	}
	useSurfaceStore.getState().setAuthed(authed);
	return {
		reachable: true,
		authed,
		health,
		contractMismatch: false
	};
}
//#endregion
//#region src/app/providers.tsx
/**
* 应用级 Provider 装配。
*
* ⚠️ SSE 单例与 mock 注册都在这里做，**绝不在业务组件里**：
* StrictMode 会双挂载组件，在组件里 `new EventSource` 会开出两条流
* （D-05 §2.6 硬禁忌 4）。这里靠模块级单例 + 引用计数保证幂等。
*
* ## T-029 改动
* 不再用 `VITE_OPENMEMO_LIVE` 环境变量决定真假 —— 那是个"全有或全无"的开关，
* 表达不了 daemon 正在逐个端点接通的真实状态。
* 现在启动时**真的去连 daemon**：连上并鉴权成功就开真 SSE、走真接口；
* 连不上或某个端点还没实现，就**按面**回落 mock（见 `lib/api/client.ts`）。
*/
function Providers({ children }) {
	const [queryClient] = useState(createQueryClient);
	const theme = useUiStore((s) => s.theme);
	useEffect(() => {
		applyTheme(theme);
	}, [theme]);
	useEffect(() => {
		let stopSse = null;
		let cancelled = false;
		const uninstallMock = installMockApi();
		const unbind = registerAllSseBindings(queryClient);
		(async () => {
			const result = await connectToDaemon();
			if (cancelled) return;
			if (result.reachable && result.authed && !result.contractMismatch) {
				markSurface("events", "live");
				stopSse = startSse({ url: "/api/events" });
			} else markSurface("events", result.reachable ? "mock" : "offline");
		})();
		return () => {
			cancelled = true;
			stopSse?.();
			unbind();
			uninstallMock();
		};
	}, [queryClient]);
	return /* @__PURE__ */ jsx(QueryClientProvider, {
		client: queryClient,
		children
	});
}
//#endregion
//#region src/features/search/SearchBox.tsx
/**
* 顶栏搜索入口 + `⌘K` / `Ctrl+K` 快捷键。
*
* 之前这个入口**完全不存在** —— 章程 F5 明确要求搜索，后端 FTS5 也早就就绪，
* 但用户在界面上没有任何地方可以发起搜索。这属于"功能有入口才算有"的典型缺口。
*/
function SearchBox() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const ref = useRef(null);
	useEffect(() => {
		const onKey = (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				ref.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return /* @__PURE__ */ jsxs("div", {
		className: "relative w-64",
		children: [/* @__PURE__ */ jsx(Search, {
			className: "absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted",
			"aria-hidden": true
		}), /* @__PURE__ */ jsx("input", {
			ref,
			placeholder: `${t("app.search")}  ⌘K`,
			"aria-label": t("app.search"),
			onKeyDown: (e) => {
				if (e.key === "Enter") {
					const v = e.target.value.trim();
					if (v) navigate(`/search?q=${encodeURIComponent(v)}`);
				}
			},
			className: "h-7 w-full rounded-md border border-line bg-surface-0 pr-2 pl-7 text-xs text-ink placeholder:text-ink-muted"
		})]
	});
}
//#endregion
//#region src/features/tasks/TasksDrawer.tsx
/**
* 任务中心抽屉（D-05 §4.5）。
*
* ★ 用户的真实心智是"关掉页面 = 任务没了"。事实相反（任务在 daemon 里），
* 所以**产品必须主动说**——底部那句常驻提示不是装饰。
*
* 分组用 `JOB_STATES` 的语义，且 **"需要处理"排在"已完成"之前**：
* blocked/failed 是唯一需要用户动作的一类，埋在最下面等于没有。
*/
function TasksDrawer() {
	const { t, i18n } = useTranslation();
	const open = useUiStore((s) => s.tasksDrawerOpen);
	const setOpen = useUiStore((s) => s.setTasksDrawer);
	const byJob = useProgressStore((s) => s.byJob);
	if (!open) return null;
	const jobs = Object.values(byJob);
	return /* @__PURE__ */ jsxs("aside", {
		className: "fixed inset-y-0 right-0 z-30 flex w-[380px] flex-col border-l border-line bg-surface-1 shadow-e2",
		role: "dialog",
		"aria-label": t("tasks.title"),
		children: [
			/* @__PURE__ */ jsxs("header", {
				className: "flex items-center justify-between border-b border-line px-4 py-2.5",
				children: [/* @__PURE__ */ jsx("h2", {
					className: "text-sm font-semibold text-ink",
					children: t("tasks.title")
				}), /* @__PURE__ */ jsx(Button, {
					size: "icon",
					variant: "ghost",
					onClick: () => setOpen(false),
					"aria-label": t("common.close"),
					children: /* @__PURE__ */ jsx(X, { className: "size-4" })
				})]
			}),
			/* @__PURE__ */ jsx("div", {
				className: "min-h-0 flex-1 overflow-auto p-3",
				children: jobs.length === 0 ? /* @__PURE__ */ jsx("p", {
					className: "px-1 py-8 text-center text-sm text-ink-muted",
					children: t("tasks.empty")
				}) : /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("h3", {
					className: "mb-2 px-1 text-xs font-medium text-ink-secondary",
					children: t("tasks.running")
				}), /* @__PURE__ */ jsx("ul", {
					className: "flex flex-col gap-2",
					role: "list",
					children: jobs.map((j) => {
						const eta = approxEta(j.etaSeconds, i18n.language);
						const stepLabel = j.step ? t(`progress.${j.step}`, { defaultValue: j.step }) : "";
						return /* @__PURE__ */ jsxs("li", {
							className: "rounded-lg border border-line bg-surface-0 p-3",
							children: [
								/* @__PURE__ */ jsxs("div", {
									className: "mb-1 flex items-start justify-between gap-2",
									children: [/* @__PURE__ */ jsx("span", {
										className: "min-w-0 truncate text-sm text-ink",
										children: j.jobType
									}), /* @__PURE__ */ jsx(StatusChip, {
										tone: "running",
										label: stepLabel
									})]
								}),
								/* @__PURE__ */ jsxs("div", {
									className: "mb-1.5 flex items-center justify-between text-xs text-ink-muted",
									children: [/* @__PURE__ */ jsxs("span", { children: [j.totalBytes ? `${formatBytes(j.completedBytes, i18n.language)} / ${formatBytes(j.totalBytes, i18n.language)}` : stepLabel, j.speedBps ? ` · ${formatSpeed(j.speedBps, i18n.language)}` : ""] }), /* @__PURE__ */ jsxs("span", {
										className: "tabular-nums",
										children: [formatPercent(j.progress, i18n.language), eta ? ` · ${eta}` : ""]
									})]
								}),
								/* @__PURE__ */ jsx(ProgressMeter, {
									value: j.progress,
									size: "md",
									label: stepLabel
								})
							]
						}, j.jobId);
					})
				})] })
			}),
			/* @__PURE__ */ jsxs("footer", {
				className: "border-t border-line px-4 py-2.5 text-xs text-ink-muted",
				children: ["ⓘ ", t("tasks.backgroundNotice")]
			})
		]
	});
}
//#endregion
//#region src/App.tsx
/** 应用外壳：顶栏 + 侧栏 + 路由出口（D-05 §1.1）。 */
function App() {
	const { t } = useTranslation();
	const setTasksDrawer = useUiStore((s) => s.setTasksDrawer);
	const conn = useConnectionStore((s) => s.state);
	const multiTab = useConnectionStore((s) => s.multiTabDegraded);
	const activeCount = useProgressStore((s) => Object.keys(s.byJob).length);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex h-full flex-col",
		children: [
			conn === "degraded" ? /* @__PURE__ */ jsx(Banner, {
				tone: "warning",
				title: t("banner.sseDegraded")
			}) : null,
			conn === "reconnecting" ? /* @__PURE__ */ jsx(Banner, {
				tone: "info",
				title: t("banner.sseReconnecting")
			}) : null,
			multiTab ? /* @__PURE__ */ jsx(Banner, {
				tone: "info",
				title: t("banner.multiTab")
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "flex min-h-0 flex-1",
				children: [/* @__PURE__ */ jsxs("nav", {
					className: "flex w-52 shrink-0 flex-col gap-1 border-r border-line bg-surface-1 p-3",
					"aria-label": t("app.name"),
					children: [
						/* @__PURE__ */ jsx(NavLink, {
							to: "/capture",
							className: "mb-2 block",
							children: ({ isActive }) => /* @__PURE__ */ jsxs(Button, {
								variant: isActive ? "primary" : "secondary",
								className: "w-full justify-start",
								children: [/* @__PURE__ */ jsx(Plus, { className: "size-4" }), t("nav.newCapture")]
							})
						}),
						/* @__PURE__ */ jsx(SideLink, {
							to: "/notes",
							icon: /* @__PURE__ */ jsx(FileAudio, { className: "size-4" }),
							label: t("nav.allNotes")
						}),
						/* @__PURE__ */ jsx(SideLink, {
							to: "/notes?starred=1",
							icon: /* @__PURE__ */ jsx(Star, { className: "size-4" }),
							label: t("nav.starred")
						}),
						/* @__PURE__ */ jsx(SideLink, {
							to: "/record",
							icon: /* @__PURE__ */ jsx(Mic, { className: "size-4" }),
							label: t("nav.record")
						}),
						/* @__PURE__ */ jsx("hr", { className: "my-2 border-line" }),
						/* @__PURE__ */ jsx(SideLink, {
							to: "/runtime",
							icon: /* @__PURE__ */ jsx(Cpu, { className: "size-4" }),
							label: t("nav.runtime"),
							pending: true
						}),
						/* @__PURE__ */ jsx(SideLink, {
							to: "/models",
							icon: /* @__PURE__ */ jsx(Package, { className: "size-4" }),
							label: t("nav.models"),
							pending: true
						}),
						/* @__PURE__ */ jsx(SideLink, {
							to: "/tasks",
							icon: /* @__PURE__ */ jsx(Activity, { className: "size-4" }),
							label: t("nav.tasks")
						}),
						/* @__PURE__ */ jsx(SideLink, {
							to: "/settings",
							icon: /* @__PURE__ */ jsx(Settings, { className: "size-4" }),
							label: t("nav.settings")
						})
					]
				}), /* @__PURE__ */ jsxs("div", {
					className: "flex min-w-0 flex-1 flex-col",
					children: [/* @__PURE__ */ jsxs("header", {
						className: "flex h-11 shrink-0 items-center justify-end gap-3 border-b border-line bg-surface-1 px-4",
						children: [
							/* @__PURE__ */ jsx(SearchBox, {}),
							/* @__PURE__ */ jsx(ConnectivitySummary, { className: "mr-auto" }),
							activeCount > 0 ? /* @__PURE__ */ jsxs(Button, {
								size: "sm",
								variant: "ghost",
								onClick: () => setTasksDrawer(true),
								children: [/* @__PURE__ */ jsx(Activity, { className: "size-3.5 text-accent" }), t("app.tasksBadge", { count: activeCount })]
							}) : null
						]
					}), /* @__PURE__ */ jsx("main", {
						className: "min-h-0 flex-1 overflow-auto",
						children: /* @__PURE__ */ jsx(Suspense, {
							fallback: /* @__PURE__ */ jsx("div", {
								className: "p-6 text-sm text-ink-muted",
								children: t("common.loading")
							}),
							children: /* @__PURE__ */ jsx(Outlet, {})
						})
					})]
				})]
			}),
			/* @__PURE__ */ jsx(TasksDrawer, {})
		]
	});
}
function SideLink({ to, icon, label, pending }) {
	if (pending) return /* @__PURE__ */ jsxs("span", {
		className: "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink-muted opacity-50",
		title: "Wave 3 · T-022",
		children: [icon, label]
	});
	return /* @__PURE__ */ jsxs(NavLink, {
		to,
		className: ({ isActive }) => cn("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors", isActive ? "bg-surface-2 text-ink" : "text-ink-secondary hover:bg-surface-2 hover:text-ink"),
		children: [icon, label]
	});
}
//#endregion
//#region src/features/capture/Capture.routes.tsx
/**
* 路由片段（D-05 §3.4）。
*
* ★ 每个 feature 导出自己的片段，`src/routes.tsx` 只做聚合 ★
* 于是 T-021 / T-022 / T-023 各改各的文件，聚合文件只在新增 feature 时动一行。
* 这是把写冲突**结构性消灭**，而不是靠"记得别同时改"的君子协议。
*/
var CapturePage = lazy(() => import("./assets/CapturePage-BdrRMSJ4.js"));
var captureRoutes = [{
	path: "capture",
	element: /* @__PURE__ */ jsx(CapturePage, {})
}];
//#endregion
//#region src/features/models/api.ts
/**
* 模型域的 Query / Mutation hooks（T-022 独占）。
*
* 全部 endpoint 与类型来自 `@openmemo/shared`（我在 T-013 里定义的 27 个 endpoint），
* query key 一律取 `app/query.ts` 的 `qk` 工厂，不在本文件拼字符串数组。
*/
/**
* @param lang 用户打算转写的语言。服务端据此把"实测在该语言下不可用"的模型
*             标为 `notRecommendedForLanguage`（ADR-011 决策 1）。
*/
function useModelsCatalogQuery(role = "all", lang) {
	return useQuery({
		queryKey: [
			...qk.models.catalog,
			role,
			lang ?? ""
		],
		queryFn: () => api(`/models/catalog?role=${role}${lang ? `&lang=${encodeURIComponent(lang)}` : ""}`),
		staleTime: STALE_TIME_OVERRIDES.catalog
	});
}
function useModelsInstalledQuery() {
	return useQuery({
		queryKey: qk.models.installed,
		queryFn: () => api("/models/installed")
	});
}
function useModelsStorageQuery() {
	return useQuery({
		queryKey: qk.models.storage,
		queryFn: () => api("/models/storage")
	});
}
/** 下载任务快照。★ 挂载时必须先拉这个再订阅 SSE，否则会漏掉订阅前发生的事件。 */
function useJobsQuery() {
	return useQuery({
		queryKey: qk.jobs.all,
		queryFn: () => api("/jobs")
	});
}
/**
* 触发下载。
*
* 返回 202 + jobId，**不返回结果** —— 进度走全局单条 SSE（D-01 §3.2 规则 2）。
* 因此 `onSuccess` 只把新 job 塞进缓存，不做乐观业务更新。
* `idempotencyKey` 防用户狂点：服务端对同一 target 已有活跃 job 时会返回既有 job
* （`deduplicated: true`），不会重复下载几 GB。
*/
function useModelPullMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (req) => api("/models/pull", {
			method: "POST",
			body: req,
			idempotencyKey: `pull:${req.id}`
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.jobs.all });
		}
	});
}
function useModelDeleteMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id) => api(`/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.models.installed });
			qc.invalidateQueries({ queryKey: qk.models.storage });
			qc.invalidateQueries({ queryKey: qk.models.catalog });
		}
	});
}
function useModelActivateMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (req) => api("/models/activate", {
			method: "POST",
			body: req
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.models.installed });
		}
	});
}
function useModelVerifyMutation() {
	return useMutation({ mutationFn: (id) => api("/models/verify", {
		method: "POST",
		body: { id }
	}) });
}
function useGcMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (req) => api("/models/gc", {
			method: "POST",
			body: req
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.models.storage });
		}
	});
}
function useJobCancelMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (jobId) => api(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.jobs.all });
		}
	});
}
function useJobRetryMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (jobId) => api(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.jobs.all });
		}
	});
}
/**
* 跑基准 —— ADR-004 决策 3 的落地入口。
*
* 模型详情页的"准确率/速度"初始为空；用户点这个按钮，服务端用内嵌测试音频在**本机**实测，
* 把真实 RTF 写回 `benchmark` 字段。**绝不填论文 WER 数字。**
*/
function useModelBenchmarkMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id) => api("/models/benchmark", {
			method: "POST",
			body: { id }
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.models.installed });
		}
	});
}
//#endregion
//#region src/components/common/FitBadge.tsx
/**
* "这台机器能跑吗" 徽标（章程要求 2.2 的核心可视化）。
*
* ★ 硬规则：**只渲染，绝不重算。**
* `packages/shared/src/api.ts` 的注释写得很直白 —— fitness 由服务端算好下发，
* 前端再实现一套判断迟早会和 `fitness.ts` 漂移，而且出问题时分不清是哪一层算错的。
* 因此本组件只接收 `FitResult`，不接收硬件参数，**从类型上就没法重算**。
*
* ★ 硬规则：**状态绝不只用颜色。**
* 明档 `--status-warning` 对比度 1.79:1、`--status-serious` 2.57:1，都低于 3:1。
* 所以图标 + 文字标签是必需的，不是装饰（同 `StatusChip` 的取舍）。
*/
var TIER_STYLE = {
	recommended: {
		text: "text-good",
		icon: /* @__PURE__ */ jsx(CheckCircle2, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		}),
		labelZh: "推荐"
	},
	slow_partial: {
		text: "text-warning",
		icon: /* @__PURE__ */ jsx(AlertTriangle, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		}),
		labelZh: "可跑但慢"
	},
	slow_cpu: {
		text: "text-warning",
		icon: /* @__PURE__ */ jsx(AlertTriangle, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		}),
		labelZh: "可跑但慢"
	},
	unsupported: {
		text: "text-critical",
		icon: /* @__PURE__ */ jsx(XCircle, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		}),
		labelZh: "跑不动"
	},
	blocked_disk: {
		text: "text-serious",
		icon: /* @__PURE__ */ jsx(HardDrive, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		}),
		labelZh: "空间不足"
	}
};
var FALLBACK = {
	text: "text-ink-muted",
	icon: /* @__PURE__ */ jsx(OctagonAlert, {
		className: "size-3.5 shrink-0",
		"aria-hidden": true
	}),
	labelZh: "未知"
};
function FitBadge({ fitness, showReason = false, className }) {
	const s = TIER_STYLE[fitness.tier] ?? FALLBACK;
	return /* @__PURE__ */ jsxs("div", {
		className: cn("flex flex-col gap-0.5", className),
		"data-testid": "fit-badge",
		children: [/* @__PURE__ */ jsxs("span", {
			className: cn("inline-flex items-center gap-1 text-xs font-medium", s.text),
			children: [s.icon, /* @__PURE__ */ jsx("span", { children: s.labelZh })]
		}), showReason ? /* @__PURE__ */ jsx("span", {
			className: "text-xs text-ink-secondary",
			children: fitness.reasonZh
		}) : null]
	});
}
/**
* 预计耗时。
*
* ADR-004 决策 3：宁可显示"未测量"，也不显示编造的数字。
* 但**真实测量 + 诚实出处**是允许的，所以这里区分三种来源，措辞各不相同：
*   - `measured_here`      本机实测 → 说"本机实测"
*   - `reference_machine`  我们在参考机上实测 → 必须说明"参考机"，不能冒充本机数据
*   - `none`               没有任何测量 → 说"未测量"，不外推
*
* ADR-011 决策 2 让这一栏变得重要：中文必须用 large-v3-turbo，而它在 CPU 上
* 1 小时录音要跑 22 分钟。"装得下"和"用得了"是两件事，只答前者会误导用户。
*/
function FitEta({ fitness }) {
	const mins = fitness.estMinutesPerAudioHour;
	if (mins == null || fitness.speedSource === "none") return /* @__PURE__ */ jsx("span", {
		className: "text-xs text-ink-muted",
		children: "速度未测量"
	});
	const slow = fitness.speedTier === "slow" || fitness.speedTier === "very_slow";
	return /* @__PURE__ */ jsxs("span", {
		className: cn("text-xs", slow ? "text-warning" : "text-ink-secondary"),
		children: [
			slow ? /* @__PURE__ */ jsx(AlertTriangle, {
				className: "mr-0.5 inline size-3",
				"aria-hidden": true
			}) : null,
			"1 小时音频约 ",
			Math.round(mins),
			" 分钟",
			/* @__PURE__ */ jsx("span", {
				className: "text-ink-muted",
				children: fitness.speedSource === "measured_here" ? "（本机实测）" : "（参考机实测，仅供参考）"
			})
		]
	});
}
/**
* 部分卸载时的层数提示。
*
* ⚠️ 必须写"约"：`estimateGpuLayers` 假设各层等大，而 embedding/output 层更大，
* 因此这是**乐观估计**且未经标定（D-03 §11 第 3 项）。不许显示成确定值。
*/
function FitGpuLayers({ fitness }) {
	if (fitness.estGpuLayers == null || fitness.tier !== "slow_partial") return null;
	return /* @__PURE__ */ jsxs("span", {
		className: "text-xs text-ink-muted",
		children: [
			"约 ",
			fitness.estGpuLayers,
			" 层可载入显存（估算）"
		]
	});
}
//#endregion
//#region src/features/models/components/QuantSelector.tsx
function QuantSelector({ variants, selectedId, onSelect, locale }) {
	const [open, setOpen] = useState(false);
	const selected = variants.find((v) => v.id === selectedId) ?? variants[0];
	if (!selected) return null;
	return /* @__PURE__ */ jsxs("div", {
		className: "relative",
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			className: cn("inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-1 px-2.5 py-1", "text-xs font-medium text-ink hover:bg-surface-2"),
			"aria-expanded": open,
			"aria-haspopup": "listbox",
			"data-testid": "models-quant-selector",
			onClick: () => setOpen((v) => !v),
			children: [
				/* @__PURE__ */ jsxs("span", { children: ["量化 ", selected.quantization.toUpperCase()] }),
				/* @__PURE__ */ jsx("span", {
					className: "text-ink-secondary",
					children: formatBytes(selected.totalSizeBytes, locale)
				}),
				/* @__PURE__ */ jsx(ChevronDown, {
					className: "size-3.5",
					"aria-hidden": true
				})
			]
		}), open ? /* @__PURE__ */ jsxs("div", {
			role: "listbox",
			className: "absolute z-20 mt-1 w-[26rem] max-w-[85vw] rounded-lg border border-line bg-surface-2 p-1 shadow-lg",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "grid grid-cols-[auto_5.5rem_5.5rem_1fr] gap-x-3 border-b border-line px-2 pb-1.5 text-[11px] text-ink-muted",
					children: [
						/* @__PURE__ */ jsx("span", { children: "量化" }),
						/* @__PURE__ */ jsx("span", { children: "体积" }),
						/* @__PURE__ */ jsx("span", { children: "需显存" }),
						/* @__PURE__ */ jsx("span", { children: "这台机器" })
					]
				}),
				variants.map((v) => /* @__PURE__ */ jsxs("button", {
					type: "button",
					role: "option",
					"aria-selected": v.id === selectedId,
					className: cn("grid w-full grid-cols-[auto_5.5rem_5.5rem_1fr] items-center gap-x-3 rounded px-2 py-1.5 text-left text-xs", v.id === selectedId ? "bg-surface-1" : "hover:bg-surface-1"),
					onClick: () => {
						onSelect(v.id);
						setOpen(false);
					},
					children: [
						/* @__PURE__ */ jsxs("span", {
							className: "inline-flex items-center gap-1 font-medium text-ink",
							children: [v.id === selectedId ? /* @__PURE__ */ jsx(Check, {
								className: "size-3 text-accent",
								"aria-hidden": true
							}) : /* @__PURE__ */ jsx("span", { className: "size-3" }), v.quantization.toUpperCase()]
						}),
						/* @__PURE__ */ jsx("span", {
							className: "text-ink-secondary",
							children: formatBytes(v.totalSizeBytes, locale)
						}),
						/* @__PURE__ */ jsx("span", {
							className: "text-ink-secondary",
							children: formatBytes(v.requirements.vramRequiredMB * 1e6, locale)
						}),
						/* @__PURE__ */ jsx(FitBadge, { fitness: v.fitness })
					]
				}, v.id)),
				/* @__PURE__ */ jsxs("p", {
					className: "px-2 pt-1.5 text-[11px] text-ink-muted",
					children: [
						"显存需求含 KV 缓存",
						selected.requirements.computedAtContext ? `（按 ${selected.requirements.computedAtContext} 上下文计算）` : "",
						"。本表不含质量星级 —— 我们没有可信的准确率数据源，不编造。"
					]
				})
			]
		}) : null]
	});
}
//#endregion
//#region src/features/models/components/ModelCard.tsx
function ModelCard({ group, locale, installedIds, activeId, onPull, onDelete, onActivate, pendingId }) {
	const [selectedId, setSelectedId] = useState(() => group.variants.find((v) => v.fitness.tier === "recommended")?.id ?? group.variants[0]?.id ?? "");
	const variant = group.variants.find((v) => v.id === selectedId) ?? group.variants[0];
	if (!variant) return null;
	const installed = installedIds.has(variant.id);
	const isActive = activeId === variant.id;
	const isDefault = group.tags.includes("recommended-default");
	const pending = pendingId === variant.id;
	const hardBlocked = variant.fitness.tier === "blocked_disk";
	return /* @__PURE__ */ jsxs("article", {
		className: "rounded-lg border border-line bg-surface-1 p-4",
		"data-testid": `model-card-${group.groupId}`,
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-start justify-between gap-3",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "min-w-0",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "flex flex-wrap items-center gap-2",
						children: [
							/* @__PURE__ */ jsx(FitBadge, { fitness: variant.fitness }),
							/* @__PURE__ */ jsx("h3", {
								className: "text-sm font-medium text-ink",
								children: group.displayNameZh
							}),
							isDefault ? /* @__PURE__ */ jsx(StatusChip, {
								tone: "neutral",
								label: "官方默认",
								icon: /* @__PURE__ */ jsx(Star, { className: "size-3.5" })
							}) : null,
							installed ? /* @__PURE__ */ jsx(StatusChip, {
								tone: "good",
								label: "已安装"
							}) : null,
							isActive ? /* @__PURE__ */ jsx(StatusChip, {
								tone: "running",
								label: "使用中"
							}) : null
						]
					}), /* @__PURE__ */ jsx("p", {
						className: "mt-1 text-xs text-ink-secondary",
						children: group.descriptionZh
					})]
				}), /* @__PURE__ */ jsx(Link, {
					to: `/models/${encodeURIComponent(variant.id)}`,
					className: "shrink-0 text-xs text-accent hover:underline",
					children: /* @__PURE__ */ jsxs("span", {
						className: "inline-flex items-center gap-1",
						children: [/* @__PURE__ */ jsx(Info, {
							className: "size-3.5",
							"aria-hidden": true
						}), "详情"]
					})
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "mt-3 flex flex-wrap items-center gap-x-4 gap-y-2",
				children: [
					/* @__PURE__ */ jsx(QuantSelector, {
						variants: group.variants,
						selectedId: variant.id,
						onSelect: setSelectedId,
						locale
					}),
					/* @__PURE__ */ jsxs("span", {
						className: "text-xs text-ink-secondary",
						children: ["需显存 ~", formatBytes(variant.requirements.vramRequiredMB * 1e6, locale)]
					}),
					/* @__PURE__ */ jsx(FitEta, { fitness: variant.fitness })
				]
			}),
			/* @__PURE__ */ jsx("p", {
				className: "mt-2 text-xs text-ink-secondary",
				children: variant.fitness.reasonZh
			}),
			/* @__PURE__ */ jsx(FitGpuLayers, { fitness: variant.fitness }),
			/* @__PURE__ */ jsx("div", {
				className: "mt-3 flex items-center justify-end gap-2",
				children: installed ? /* @__PURE__ */ jsxs(Fragment, { children: [!isActive ? /* @__PURE__ */ jsxs(Button, {
					size: "sm",
					variant: "secondary",
					onClick: () => onActivate(variant.id),
					children: [/* @__PURE__ */ jsx(Star, {
						className: "size-3.5",
						"aria-hidden": true
					}), "设为默认"]
				}) : null, /* @__PURE__ */ jsxs(Button, {
					size: "sm",
					variant: "ghost",
					onClick: () => onDelete(variant.id),
					"data-testid": "model-delete",
					children: [/* @__PURE__ */ jsx(Trash2, {
						className: "size-3.5",
						"aria-hidden": true
					}), "删除"]
				})] }) : /* @__PURE__ */ jsxs(Button, {
					size: "sm",
					variant: variant.fitness.tier === "recommended" ? "primary" : "secondary",
					disabled: hardBlocked || pending,
					onClick: () => onPull(variant),
					"data-testid": "models-download-button",
					children: [/* @__PURE__ */ jsx(Download, {
						className: "size-3.5",
						"aria-hidden": true
					}), pending ? "正在开始…" : hardBlocked ? "空间不足" : variant.fitness.tier === "unsupported" ? `仍要下载 ${formatBytes(variant.totalSizeBytes, locale)}` : `下载 ${formatBytes(variant.totalSizeBytes, locale)}`]
				})
			})
		]
	});
}
//#endregion
//#region src/features/models/components/DownloadRow.tsx
/**
* 下载中的一行（R-04 §9.3 线框）。
*
* ★ 进度**只从 transient store 读，不从 Query 缓存读**（D-05 §2.4）：
* 用 selector 只订阅自己那一个 jobId，别的任务刷新不会让这一行重渲染。
* store 内部已节流到 200ms，服务端也限流到 4 次/秒/job。
*/
var STEP_LABEL = {
	resolving: "正在选择下载源",
	downloading: "下载中",
	verifying: "正在校验完整性",
	installing: "正在安装"
};
/** ETA 文案：D-05 §4.1 规则 4 —— 只在有依据时显示，且四舍五入到"约 X 分钟"。
*  不显示"剩余 03:47"这种假精确：实测速率波动很大。 */
function formatEta(sec) {
	if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
	if (sec < 60) return "剩余不到 1 分钟";
	return `剩余约 ${Math.round(sec / 60)} 分钟`;
}
function DownloadRow({ job, locale, onCancel, onRetry }) {
	const live = useProgressStore(useShallow((s) => s.byJob[job.jobId]));
	const completed = live?.completedBytes ?? job.completedBytes;
	const total = live?.totalBytes ?? job.totalBytes;
	const step = live?.step ?? job.step;
	const state = live?.state ?? job.state;
	const speed = live?.speedBps ?? job.speedBps;
	const eta = formatEta(live?.etaSeconds ?? job.etaSeconds);
	const ratio = total ? Math.min(1, (completed ?? 0) / total) : 0;
	const isVerifying = step === "verifying";
	const failed = state === "failed";
	return /* @__PURE__ */ jsxs("div", {
		className: "rounded-lg border border-line bg-surface-1 p-3",
		"data-testid": `models-download-row-${job.targetId}`,
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center justify-between gap-3",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "min-w-0",
					children: [/* @__PURE__ */ jsx("p", {
						className: "truncate text-sm font-medium text-ink",
						children: job.displayName
					}), /* @__PURE__ */ jsx("p", {
						className: "mt-0.5 text-xs text-ink-secondary",
						children: failed ? /* @__PURE__ */ jsxs("span", {
							className: "text-critical",
							children: [job.error?.messageZh ?? job.error?.message ?? "下载失败", job.attempt > 1 ? `（第 ${job.attempt}/${job.maxAttempts} 次）` : ""]
						}) : /* @__PURE__ */ jsxs(Fragment, { children: [STEP_LABEL[step ?? ""] ?? "排队中", job.provider ? ` · 来源 ${job.provider}` : ""] })
					})]
				}), /* @__PURE__ */ jsxs("div", {
					className: "flex shrink-0 items-center gap-1.5",
					children: [isVerifying ? /* @__PURE__ */ jsx(StatusChip, {
						tone: "running",
						label: "校验中",
						icon: /* @__PURE__ */ jsx(ShieldCheck, { className: "size-3.5" })
					}) : null, failed ? /* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "secondary",
						onClick: () => onRetry(job.jobId),
						children: [/* @__PURE__ */ jsx(RefreshCw, {
							className: "size-3.5",
							"aria-hidden": true
						}), "重试"]
					}) : /* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "ghost",
						onClick: () => onCancel(job.jobId),
						"data-testid": "models-download-cancel",
						children: [/* @__PURE__ */ jsx(Ban, {
							className: "size-3.5",
							"aria-hidden": true
						}), "取消"]
					})]
				})]
			}),
			/* @__PURE__ */ jsx(ProgressMeter, {
				className: "mt-2",
				value: ratio,
				tone: failed ? "critical" : isVerifying ? "good" : "accent",
				indeterminate: isVerifying,
				label: `${job.displayName} 下载进度`
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "mt-1.5 flex items-center justify-between text-xs text-ink-secondary",
				children: [/* @__PURE__ */ jsxs("span", {
					className: "tabular-nums",
					children: [
						formatBytes(completed ?? 0, locale),
						" / ",
						formatBytes(total ?? 0, locale),
						total ? ` · ${Math.round(ratio * 100)}%` : ""
					]
				}), /* @__PURE__ */ jsxs("span", {
					className: "tabular-nums",
					children: [speed ? formatSpeed(speed, locale) : "", eta ? ` · ${eta}` : ""]
				})]
			})
		]
	});
}
//#endregion
//#region src/features/models/components/StorageBreakdown.tsx
/**
* 磁盘占用分解条。
*
* ★ 硬性要求（features/models/README.md，`architect` 实测对比度后写死）：
* **必须配图例和字节数标签，不能只画色条。**
* 明档 `--data-3`（aqua）对比度 2.74:1、`--data-4`（yellow）2.11:1，都低于 3:1 ——
* 纯靠颜色区分分类对部分用户根本不可读。所以每一段都有图例方块 + 名称 + 字节数，
* 色条只是辅助，删掉颜色信息依然完整。
*
* 分类色固定顺序（tokens.css）：data-1 模型 / data-2 后端 / data-3 媒体 / data-4 缓存。
*/
var CAT_COLOR = [
	"bg-data-1",
	"bg-data-2",
	"bg-data-3",
	"bg-data-4"
];
function StorageBreakdown({ storage, locale, onGc, gcPending }) {
	const { reclaimable } = storage;
	const reclaimableBytes = reclaimable.orphanBlobsBytes + reclaimable.stalePartialsBytes;
	const sorted = [...storage.breakdown].sort((a, b) => b.bytes - a.bytes);
	const top = sorted.slice(0, 4);
	const restBytes = sorted.slice(4).reduce((a, x) => a + x.bytes, 0);
	const segments = [...top.map((x, i) => ({
		label: x.displayName,
		bytes: x.bytes,
		color: CAT_COLOR[i],
		active: x.active
	})), ...restBytes > 0 ? [{
		label: "其他",
		bytes: restBytes,
		color: "bg-ink-muted",
		active: false
	}] : []];
	const total = segments.reduce((a, s) => a + s.bytes, 0) || 1;
	return /* @__PURE__ */ jsxs("section", {
		className: "rounded-lg border border-line bg-surface-1 p-4",
		"aria-label": "磁盘占用",
		"data-testid": "models-storage",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-baseline justify-between",
				children: [/* @__PURE__ */ jsx("h2", {
					className: "text-sm font-medium text-ink",
					children: "磁盘占用"
				}), /* @__PURE__ */ jsxs("span", {
					className: "text-xs text-ink-secondary",
					children: [
						"模型共占用 ",
						formatBytes(storage.usedBytes, locale),
						" · 卷剩余",
						" ",
						formatBytes(storage.volume.freeBytes, locale)
					]
				})]
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-3 flex h-2 w-full overflow-hidden rounded-full bg-accent-track",
				children: segments.map((s) => /* @__PURE__ */ jsx("div", {
					className: cn("h-full", s.color),
					style: { width: `${s.bytes / total * 100}%` },
					"aria-hidden": true
				}, s.label))
			}),
			/* @__PURE__ */ jsxs("ul", {
				className: "mt-3 space-y-1.5",
				children: [segments.map((s) => /* @__PURE__ */ jsxs("li", {
					className: "flex items-center gap-2 text-xs",
					children: [
						/* @__PURE__ */ jsx("span", {
							className: cn("size-2.5 shrink-0 rounded-sm", s.color),
							"aria-hidden": true
						}),
						/* @__PURE__ */ jsx("span", {
							className: "min-w-0 flex-1 truncate text-ink",
							children: s.label
						}),
						s.active ? /* @__PURE__ */ jsx("span", {
							className: "shrink-0 text-good",
							children: "使用中"
						}) : null,
						/* @__PURE__ */ jsx("span", {
							className: "shrink-0 tabular-nums text-ink-secondary",
							children: formatBytes(s.bytes, locale)
						})
					]
				}, s.label)), segments.length === 0 ? /* @__PURE__ */ jsx("li", {
					className: "text-xs text-ink-muted",
					children: "还没有安装任何模型"
				}) : null]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "mt-3 flex items-center justify-between border-t border-line pt-3",
				children: [/* @__PURE__ */ jsxs("span", {
					className: "text-xs text-ink-secondary",
					children: [
						"可清理：未完成的下载 ",
						formatBytes(reclaimable.stalePartialsBytes, locale),
						" · 孤立文件",
						" ",
						formatBytes(reclaimable.orphanBlobsBytes, locale)
					]
				}), /* @__PURE__ */ jsxs(Button, {
					size: "sm",
					variant: "secondary",
					disabled: reclaimableBytes === 0 || gcPending,
					onClick: onGc,
					"data-testid": "models-gc-button",
					children: [
						/* @__PURE__ */ jsx(Trash2, {
							className: "size-3.5",
							"aria-hidden": true
						}),
						"清理 ",
						formatBytes(reclaimableBytes, locale)
					]
				})]
			})
		]
	});
}
//#endregion
//#region src/features/models/ModelsPage.tsx
/**
* 模型管理页 —— 章程要求 2.2 的主界面。
*
* 原文：「模型的浏览、下载、切换、删除、量化选择，**全部通过网页完成**」。
* 这一页要闭环覆盖这五件事，用户全程不碰命令行。
*
* ★ 挂载顺序（R-04 §9.6 第 2 条）：**并行拉 catalog / jobs / storage 快照，再由
* `lib/events/bindings.ts` 订阅 SSE**。反过来（先订阅再拉）会漏掉订阅前发生的事件，
* 或在快照与增量之间重复计数。这里三个 useQuery 天然并行，SSE 订阅在 App 层已建立。
*/
var ROLE_TABS = [{
	role: "asr",
	labelZh: "转写模型",
	icon: /* @__PURE__ */ jsx(Mic, {
		className: "size-4",
		"aria-hidden": true
	})
}, {
	role: "llm",
	labelZh: "语言模型",
	icon: /* @__PURE__ */ jsx(Boxes, {
		className: "size-4",
		"aria-hidden": true
	})
}];
function ModelsPage() {
	const { i18n } = useTranslation();
	const locale = i18n.language;
	const [role, setRole] = useState("asr");
	const [onlyRunnable, setOnlyRunnable] = useState(false);
	const [pendingId, setPendingId] = useState(null);
	/**
	* 用户打算转写的语言。默认跟随界面语言。
	* ADR-011 决策 1：中文场景下**默认过滤掉**实测不可用的模型。
	*/
	const targetLanguage = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
	/** 允许用户手动解除过滤 —— 英文转写时 base 在弱机器上仍然合理，一刀切会误伤。 */
	const [showNotRecommended, setShowNotRecommended] = useState(false);
	const catalog = useModelsCatalogQuery("all", targetLanguage);
	const installed = useModelsInstalledQuery();
	const storage = useModelsStorageQuery();
	const jobs = useJobsQuery();
	const pull = useModelPullMutation();
	const del = useModelDeleteMutation();
	const activate = useModelActivateMutation();
	const gc = useGcMutation();
	const cancelJob = useJobCancelMutation();
	const retryJob = useJobRetryMutation();
	const installedIds = useMemo(() => new Set((installed.data?.models ?? []).map((m) => m.id)), [installed.data]);
	/** 被语言过滤掉的变体数量 —— 必须显式告诉用户"我们藏了几个"，不能静默。 */
	const hiddenByLanguage = useMemo(() => (catalog.data?.groups ?? []).filter((g) => g.role === role).flatMap((g) => g.variants).filter((v) => v.fitness.notRecommendedForLanguage).length, [catalog.data, role]);
	const groups = useMemo(() => {
		return (catalog.data?.groups ?? []).filter((g) => g.role === role).map((g) => ({
			...g,
			variants: showNotRecommended ? g.variants : g.variants.filter((v) => !v.fitness.notRecommendedForLanguage)
		})).filter((g) => g.variants.length > 0).filter((g) => onlyRunnable ? g.variants.some((v) => v.fitness.tier === "recommended" || v.fitness.tier === "slow_partial") : true);
	}, [
		catalog.data,
		role,
		onlyRunnable,
		showNotRecommended
	]);
	const activeJobs = useMemo(() => (jobs.data?.jobs ?? []).filter((j) => j.kind === "model" && !["succeeded", "cancelled"].includes(j.state)), [jobs.data]);
	async function handlePull(v) {
		if (v.fitness.tier === "unsupported") {
			if (!window.confirm(`${v.displayNameZh}\n\n${v.fitness.reasonZh}\n\n这台机器很可能无法运行它，或者极慢。仍要下载吗？`)) return;
		}
		if (v.license.requiresAcceptance || v.license.gated) {
			if (!window.confirm(`${v.displayNameZh} 使用 ${v.license.id} 许可，需要你先到上游页面接受条款。\n\n${v.license.url}\n\n已接受并继续下载？`)) return;
			window.open(v.license.url, "_blank", "noopener");
		}
		setPendingId(v.id);
		try {
			await pull.mutateAsync({
				id: v.id,
				kind: "model",
				provider: "auto",
				licenseAccepted: true
			});
		} finally {
			setPendingId(null);
		}
	}
	const active = installed.data?.active ?? {
		asr: null,
		llm: null
	};
	const asrActive = installed.data?.models.find((m) => m.id === active.asr);
	const llmActive = installed.data?.models.find((m) => m.id === active.llm);
	return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto w-full max-w-4xl space-y-4 p-4",
		"data-testid": "models-page",
		children: [
			/* @__PURE__ */ jsxs("header", { children: [/* @__PURE__ */ jsx("h1", {
				className: "text-lg font-semibold text-ink",
				children: "模型管理"
			}), /* @__PURE__ */ jsx("p", {
				className: "mt-0.5 text-xs text-ink-secondary",
				children: "浏览、下载、切换、删除、选择量化档 —— 全部在网页里完成，不需要命令行。"
			})] }),
			catalog.data?.stale ? /* @__PURE__ */ jsx(Banner, {
				tone: "warning",
				title: "当前使用离线模型目录",
				detail: `最后更新于 ${new Date(catalog.data.fetchedAt).toLocaleString(locale)}。联网后会自动更新。`
			}) : null,
			/* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: [/* @__PURE__ */ jsx("h2", {
					className: "text-sm font-medium text-ink",
					children: "当前使用"
				}), /* @__PURE__ */ jsxs("ul", {
					className: "mt-2 space-y-2 text-xs",
					children: [/* @__PURE__ */ jsxs("li", {
						className: "flex items-center gap-2",
						children: [
							/* @__PURE__ */ jsx(Mic, {
								className: "size-4 shrink-0 text-ink-muted",
								"aria-hidden": true
							}),
							/* @__PURE__ */ jsx("span", {
								className: "w-16 shrink-0 text-ink-secondary",
								children: "转写模型"
							}),
							asrActive ? /* @__PURE__ */ jsxs(Fragment, { children: [
								/* @__PURE__ */ jsx("span", {
									className: "text-ink",
									children: asrActive.displayName
								}),
								/* @__PURE__ */ jsx("span", {
									className: "text-ink-secondary",
									children: formatBytes(asrActive.totalSizeBytes, locale)
								}),
								/* @__PURE__ */ jsx(StatusChip, {
									tone: asrActive.integrity === "ok" ? "good" : "warning",
									label: asrActive.integrity === "ok" ? "已校验" : "未校验"
								})
							] }) : /* @__PURE__ */ jsx(StatusChip, {
								tone: "warning",
								label: "未选择 —— 无法转写"
							})
						]
					}), /* @__PURE__ */ jsxs("li", {
						className: "flex items-center gap-2",
						children: [
							/* @__PURE__ */ jsx(Boxes, {
								className: "size-4 shrink-0 text-ink-muted",
								"aria-hidden": true
							}),
							/* @__PURE__ */ jsx("span", {
								className: "w-16 shrink-0 text-ink-secondary",
								children: "语言模型"
							}),
							llmActive ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("span", {
								className: "text-ink",
								children: llmActive.displayName
							}), /* @__PURE__ */ jsx("span", {
								className: "text-ink-secondary",
								children: formatBytes(llmActive.totalSizeBytes, locale)
							})] }) : /* @__PURE__ */ jsx(StatusChip, {
								tone: "warning",
								label: "未选择 —— 思维导图功能不可用"
							})
						]
					})]
				})]
			}),
			activeJobs.length > 0 ? /* @__PURE__ */ jsxs("section", {
				className: "space-y-2",
				"aria-label": "下载中",
				children: [/* @__PURE__ */ jsxs("h2", {
					className: "text-sm font-medium text-ink",
					children: [
						"下载中（",
						activeJobs.length,
						"）"
					]
				}), activeJobs.map((j) => /* @__PURE__ */ jsx(DownloadRow, {
					job: j,
					locale,
					onCancel: (id) => void cancelJob.mutateAsync(id),
					onRetry: (id) => void retryJob.mutateAsync(id)
				}, j.jobId))]
			}) : null,
			/* @__PURE__ */ jsxs("section", {
				className: "space-y-3",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "flex flex-wrap items-center gap-2",
						children: [/* @__PURE__ */ jsx("div", {
							className: "flex rounded-md border border-line bg-surface-1 p-0.5",
							children: ROLE_TABS.map((t) => /* @__PURE__ */ jsxs("button", {
								type: "button",
								onClick: () => setRole(t.role),
								className: `inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium ${role === t.role ? "bg-accent text-accent-fg" : "text-ink-secondary"}`,
								"data-testid": `models-tab-${t.role}`,
								children: [t.icon, t.labelZh]
							}, t.role))
						}), /* @__PURE__ */ jsxs("label", {
							className: "ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary",
							children: [/* @__PURE__ */ jsx("input", {
								type: "checkbox",
								checked: onlyRunnable,
								onChange: (e) => setOnlyRunnable(e.target.checked),
								className: "size-3.5 accent-[var(--accent)]"
							}), "只显示这台机器能跑的"]
						})]
					}),
					role === "asr" && hiddenByLanguage > 0 && !showNotRecommended ? /* @__PURE__ */ jsxs("div", {
						className: "rounded-md border border-line bg-surface-1 px-3 py-2 text-xs text-ink-secondary",
						children: [
							"已隐藏 ",
							hiddenByLanguage,
							" 个在",
							targetLanguage === "zh" ? "中文" : "该语言",
							"下实测识别质量不可接受的模型（小模型会把「维基百科」听成「危机摆科」）。",
							/* @__PURE__ */ jsx("button", {
								type: "button",
								className: "ml-1 text-accent hover:underline",
								onClick: () => setShowNotRecommended(true),
								"data-testid": "models-show-not-recommended",
								children: "仍要显示"
							})
						]
					}) : null,
					showNotRecommended && hiddenByLanguage > 0 ? /* @__PURE__ */ jsxs("div", {
						className: "rounded-md border border-line bg-surface-1 px-3 py-2 text-xs text-ink-secondary",
						children: [
							"正在显示全部模型，含 ",
							hiddenByLanguage,
							" 个不适合",
							targetLanguage === "zh" ? "中文" : "该语言",
							"的。",
							/* @__PURE__ */ jsx("button", {
								type: "button",
								className: "ml-1 text-accent hover:underline",
								onClick: () => setShowNotRecommended(false),
								children: "重新隐藏"
							})
						]
					}) : null,
					catalog.isError ? /* @__PURE__ */ jsx(ErrorBlock, {
						error: catalog.error,
						onRetry: () => void catalog.refetch()
					}) : null,
					catalog.isLoading ? /* @__PURE__ */ jsx("p", {
						className: "text-xs text-ink-muted",
						children: "正在读取模型目录…"
					}) : null,
					!catalog.isLoading && groups.length === 0 ? /* @__PURE__ */ jsx(EmptyState, {
						icon: /* @__PURE__ */ jsx(Cpu, {
							className: "size-8",
							"aria-hidden": true
						}),
						title: onlyRunnable ? "这台机器暂时跑不动任何该类模型" : "目录里还没有该类模型",
						hint: onlyRunnable ? "取消勾选可以看到全部模型 —— 我们的估算可能偏保守，你仍然可以选择下载。" : void 0,
						action: onlyRunnable ? /* @__PURE__ */ jsx(Button, {
							variant: "secondary",
							size: "sm",
							onClick: () => setOnlyRunnable(false),
							children: "显示全部"
						}) : void 0
					}) : null,
					groups.map((g) => /* @__PURE__ */ jsx(ModelCard, {
						group: g,
						locale,
						installedIds,
						activeId: g.role === "asr" ? active.asr : active.llm,
						pendingId,
						onPull: (v) => void handlePull(v),
						onDelete: (id) => {
							if (window.confirm("删除这个模型？磁盘空间会被释放，需要时可以重新下载。")) del.mutateAsync(id);
						},
						onActivate: (id) => void activate.mutateAsync({
							role: g.role,
							id
						})
					}, g.groupId))
				]
			}),
			storage.data ? /* @__PURE__ */ jsx(StorageBreakdown, {
				storage: storage.data,
				locale,
				gcPending: gc.isPending,
				onGc: () => void gc.mutateAsync({ targets: ["orphan_blobs", "stale_partials"] })
			}) : null
		]
	});
}
//#endregion
//#region src/features/models/ModelDetailPage.tsx
/**
* 模型详情页（R-04 §9.4 线框）。
*
* ★ "准确率"一栏按 ADR-004 决策 3：**初始为空，只有用户在本机跑过基准才有数字。**
* 这条标准最初就是从这个字段提出来的 —— memo.ac 的注册表里硬编码了
* `speed: 6, quality: 2` 这类 1–6 的整数，没有任何出处。我们宁可显示"未测量"。
*/
function ModelDetailPage() {
	const { modelId = "" } = useParams();
	const { i18n } = useTranslation();
	const locale = i18n.language;
	const catalog = useModelsCatalogQuery("all");
	const installed = useModelsInstalledQuery();
	const benchmark = useModelBenchmarkMutation();
	const verify = useModelVerifyMutation();
	const found = useMemo(() => {
		for (const g of catalog.data?.groups ?? []) {
			const v = g.variants.find((x) => x.id === modelId);
			if (v) return {
				group: g,
				variant: v
			};
		}
		return null;
	}, [catalog.data, modelId]);
	const installedRec = installed.data?.models.find((m) => m.id === modelId) ?? null;
	if (catalog.isError) return /* @__PURE__ */ jsx("div", {
		className: "p-4",
		children: /* @__PURE__ */ jsx(ErrorBlock, {
			error: catalog.error,
			onRetry: () => void catalog.refetch()
		})
	});
	if (catalog.isLoading) return /* @__PURE__ */ jsx("p", {
		className: "p-4 text-xs text-ink-muted",
		children: "加载中…"
	});
	if (!found) return /* @__PURE__ */ jsxs("div", {
		className: "p-4",
		children: [/* @__PURE__ */ jsx(Link, {
			to: "/models",
			className: "text-xs text-accent hover:underline",
			children: "← 返回模型管理"
		}), /* @__PURE__ */ jsxs("p", {
			className: "mt-3 text-sm text-ink",
			children: [
				"目录里没有这个模型（",
				modelId,
				"）。"
			]
		})]
	});
	const { group, variant } = found;
	const bench = installedRec?.benchmark ?? variant.benchmark;
	return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto w-full max-w-3xl space-y-4 p-4",
		"data-testid": "model-detail-page",
		children: [
			/* @__PURE__ */ jsxs(Link, {
				to: "/models",
				className: "inline-flex items-center gap-1 text-xs text-accent hover:underline",
				children: [/* @__PURE__ */ jsx(ArrowLeft, {
					className: "size-3.5",
					"aria-hidden": true
				}), "返回模型管理"]
			}),
			/* @__PURE__ */ jsxs("header", { children: [/* @__PURE__ */ jsxs("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [
					/* @__PURE__ */ jsx("h1", {
						className: "text-lg font-semibold text-ink",
						children: group.displayNameZh
					}),
					/* @__PURE__ */ jsx(StatusChip, {
						tone: "neutral",
						label: variant.quantization.toUpperCase()
					}),
					installedRec ? /* @__PURE__ */ jsx(StatusChip, {
						tone: "good",
						label: "已安装"
					}) : null
				]
			}), /* @__PURE__ */ jsx("p", {
				className: "mt-1 text-sm text-ink-secondary",
				children: group.descriptionZh
			})] }),
			/* @__PURE__ */ jsxs("section", {
				className: "grid grid-cols-2 gap-3 rounded-lg border border-line bg-surface-1 p-4 text-xs sm:grid-cols-3",
				children: [
					/* @__PURE__ */ jsx(Field, {
						label: "架构",
						value: `${variant.arch} (${variant.format})`
					}),
					/* @__PURE__ */ jsx(Field, {
						label: "量化",
						value: variant.quantization.toUpperCase()
					}),
					/* @__PURE__ */ jsx(Field, {
						label: "体积",
						value: formatBytes(variant.totalSizeBytes, locale)
					}),
					/* @__PURE__ */ jsx(Field, {
						label: "语言",
						value: variant.languages.join(" / ")
					}),
					/* @__PURE__ */ jsx(Field, {
						label: "许可",
						value: variant.license.id
					}),
					/* @__PURE__ */ jsx(Field, {
						label: "目录版本",
						value: variant.catalogVersion
					})
				]
			}),
			/* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: [/* @__PURE__ */ jsx("h2", {
					className: "text-sm font-medium text-ink",
					children: "文件"
				}), /* @__PURE__ */ jsx("ul", {
					className: "mt-2 space-y-2",
					children: variant.files.map((f) => /* @__PURE__ */ jsxs("li", {
						className: "text-xs",
						children: [/* @__PURE__ */ jsxs("div", {
							className: "flex items-center justify-between gap-2",
							children: [/* @__PURE__ */ jsxs("span", {
								className: "truncate text-ink",
								children: [f.name, f.optional ? /* @__PURE__ */ jsx("span", {
									className: "ml-1 text-ink-muted",
									children: "（可选）"
								}) : null]
							}), /* @__PURE__ */ jsx("span", {
								className: "shrink-0 tabular-nums text-ink-secondary",
								children: formatBytes(f.sizeBytes, locale)
							})]
						}), /* @__PURE__ */ jsxs("code", {
							className: "mt-0.5 block truncate font-mono text-[11px] text-ink-muted",
							children: ["sha256:", f.sha256]
						})]
					}, f.sha256))
				})]
			}),
			/* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: [/* @__PURE__ */ jsx("h2", {
					className: "text-sm font-medium text-ink",
					children: "这台机器"
				}), /* @__PURE__ */ jsxs("div", {
					className: "mt-2 space-y-1",
					children: [
						/* @__PURE__ */ jsx(FitBadge, {
							fitness: variant.fitness,
							showReason: true
						}),
						/* @__PURE__ */ jsx(FitEta, { fitness: variant.fitness }),
						/* @__PURE__ */ jsxs("p", {
							className: "text-xs text-ink-muted",
							children: [
								"需内存 ",
								formatBytes(variant.requirements.ramRequiredMB * 1e6, locale),
								" · 需显存",
								" ",
								formatBytes(variant.requirements.vramRequiredMB * 1e6, locale),
								variant.requirements.computedAtContext ? `（按 ${variant.requirements.computedAtContext} 上下文，含 KV 缓存）` : ""
							]
						}),
						variant.gguf ? /* @__PURE__ */ jsxs("p", {
							className: "text-xs text-ink-muted",
							children: [
								"KV 缓存 ",
								(variant.gguf.kvBytesPerToken / 1024).toFixed(0),
								" KiB/token ·",
								" ",
								variant.gguf.blockCount,
								" 层 · 最大上下文 ",
								variant.gguf.contextLength
							]
						}) : null
					]
				})]
			}),
			/* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4",
				children: [/* @__PURE__ */ jsx("h2", {
					className: "text-sm font-medium text-ink",
					children: "准确率与速度"
				}), bench ? /* @__PURE__ */ jsxs("div", {
					className: "mt-2 space-y-1 text-xs",
					children: [/* @__PURE__ */ jsxs("p", {
						className: "text-ink",
						children: [
							"实测 RTF ",
							bench.rtf.toFixed(2),
							" —— 1 小时音频约需",
							" ",
							Math.round(bench.rtf * 60),
							" 分钟"
						]
					}), /* @__PURE__ */ jsxs("p", {
						className: "text-ink-muted",
						children: [
							"于 ",
							new Date(bench.measuredAt).toLocaleString(locale),
							" 在本机 ",
							bench.deviceName,
							"（",
							bench.backend,
							"）上用 ",
							bench.sampleDurationSec,
							" 秒测试音频实测"
						]
					})]
				}) : /* @__PURE__ */ jsxs("div", {
					className: "mt-2 space-y-2",
					children: [
						/* @__PURE__ */ jsx("p", {
							className: "text-xs text-ink-secondary",
							children: "尚未测量。我们**不显示论文里的准确率数字** —— 那些数字在你的机器、你的音频上不成立。 点下面的按钮，用内嵌测试音频在本机实测。"
						}),
						/* @__PURE__ */ jsxs(Button, {
							size: "sm",
							variant: "secondary",
							disabled: !installedRec || benchmark.isPending,
							onClick: () => void benchmark.mutateAsync(variant.id),
							"data-testid": "model-benchmark-button",
							children: [/* @__PURE__ */ jsx(Gauge, {
								className: "size-3.5",
								"aria-hidden": true
							}), benchmark.isPending ? "正在跑基准…" : "跑基准"]
						}),
						!installedRec ? /* @__PURE__ */ jsx("p", {
							className: "text-xs text-ink-muted",
							children: "需要先安装这个模型才能跑基准。"
						}) : null
					]
				})]
			}),
			/* @__PURE__ */ jsxs("section", {
				className: "flex flex-wrap items-center gap-2",
				children: [installedRec ? /* @__PURE__ */ jsxs(Button, {
					size: "sm",
					variant: "secondary",
					onClick: () => void verify.mutateAsync(variant.id),
					disabled: verify.isPending,
					children: [/* @__PURE__ */ jsx(ShieldCheck, {
						className: "size-3.5",
						"aria-hidden": true
					}), verify.isPending ? "校验中…" : "校验完整性"]
				}) : null, /* @__PURE__ */ jsxs("a", {
					href: variant.license.url,
					target: "_blank",
					rel: "noopener noreferrer",
					className: "inline-flex items-center gap-1 text-xs text-accent hover:underline",
					children: [/* @__PURE__ */ jsx(ExternalLink, {
						className: "size-3.5",
						"aria-hidden": true
					}), "查看上游与许可证"]
				})]
			})
		]
	});
}
function Field({ label, value }) {
	return /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", {
		className: "text-ink-muted",
		children: label
	}), /* @__PURE__ */ jsx("dd", {
		className: "mt-0.5 text-ink",
		children: value
	})] });
}
//#endregion
//#region src/features/models/StorageSettingsPage.tsx
/**
* `/settings/storage` —— 复用模型域的 storage API（features/models/README.md 指派）。
*/
function StorageSettingsPage() {
	const { i18n } = useTranslation();
	const locale = i18n.language;
	const storage = useModelsStorageQuery();
	const gc = useGcMutation();
	return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto w-full max-w-3xl space-y-4 p-4",
		"data-testid": "storage-settings-page",
		children: [
			/* @__PURE__ */ jsxs("header", { children: [/* @__PURE__ */ jsx("h1", {
				className: "text-lg font-semibold text-ink",
				children: "存储"
			}), /* @__PURE__ */ jsx("p", {
				className: "mt-0.5 text-xs text-ink-secondary",
				children: "模型与加速后端占用的磁盘空间。"
			})] }),
			storage.isError ? /* @__PURE__ */ jsx(ErrorBlock, {
				error: storage.error,
				onRetry: () => void storage.refetch()
			}) : null,
			storage.data ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs("section", {
				className: "rounded-lg border border-line bg-surface-1 p-4 text-xs",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "flex items-center gap-2",
						children: [/* @__PURE__ */ jsx(HardDrive, {
							className: "size-4 text-ink-muted",
							"aria-hidden": true
						}), /* @__PURE__ */ jsx("span", {
							className: "text-ink-secondary",
							children: "模型目录"
						})]
					}),
					/* @__PURE__ */ jsx("code", {
						className: "mt-1 block break-all font-mono text-[11px] text-ink",
						children: storage.data.modelsRoot
					}),
					/* @__PURE__ */ jsxs("p", {
						className: "mt-1 text-ink-secondary",
						children: [
							"卷容量 ",
							formatBytes(storage.data.volume.totalBytes, locale),
							" · 剩余",
							" ",
							formatBytes(storage.data.volume.freeBytes, locale)
						]
					})
				]
			}), /* @__PURE__ */ jsx(StorageBreakdown, {
				storage: storage.data,
				locale,
				gcPending: gc.isPending,
				onGc: () => void gc.mutateAsync({ targets: ["orphan_blobs", "stale_partials"] })
			})] }) : null
		]
	});
}
//#endregion
//#region src/features/models/Models.routes.tsx
/**
* 模型域路由片段（T-022 独占）。
*
* 由 `src/routes.tsx` 聚合 —— 分片导出是 D-05 §3.4 的反冲突设计：
* 三个并行任务各改自己的 `*.routes.tsx`，聚合文件只在新增 feature 时动一行。
*/
var modelsRoutes = [
	{
		path: "models",
		element: /* @__PURE__ */ jsx(ModelsPage, {})
	},
	{
		path: "models/:modelId",
		element: /* @__PURE__ */ jsx(ModelDetailPage, {})
	},
	{
		path: "settings/storage",
		element: /* @__PURE__ */ jsx(StorageSettingsPage, {})
	}
];
//#endregion
//#region src/features/mindmap/Mindmap.routes.tsx
var MindmapPage = lazy(() => import("./assets/MindmapPage-DwsUaSsV.js"));
var mindmapRoutes = [{
	path: "notes/:noteUid/mindmap",
	element: /* @__PURE__ */ jsx(MindmapPage, {})
}];
//#endregion
//#region src/features/notes/Notes.routes.tsx
var NotesListPage = lazy(() => import("./assets/NotesListPage-1rs4wPAf.js"));
var NoteDetailPage = lazy(() => import("./assets/NoteDetailPage-DN3N2ig7.js"));
var notesRoutes = [
	{
		index: true,
		element: /* @__PURE__ */ jsx(Navigate, {
			to: "/notes",
			replace: true
		})
	},
	{
		path: "notes",
		element: /* @__PURE__ */ jsx(NotesListPage, {})
	},
	{
		path: "notes/:noteUid",
		element: /* @__PURE__ */ jsx(NoteDetailPage, {})
	}
];
//#endregion
//#region src/features/search/Search.routes.tsx
var SearchPage = lazy(() => import("./assets/SearchPage-CvcluHbm.js"));
var searchRoutes = [{
	path: "search",
	element: /* @__PURE__ */ jsx(SearchPage, {})
}];
//#endregion
//#region src/features/recorder/Recorder.routes.tsx
var RecorderPage = lazy(() => import("./assets/RecorderPage-KRdK611c.js"));
var recorderRoutes = [{
	path: "record",
	element: /* @__PURE__ */ jsx(RecorderPage, {})
}];
//#endregion
//#region src/features/runtime/api.ts
/**
* 运行时域的 Query / Mutation hooks（T-022 独占）。
*/
/**
* 硬件探测结果。
*
* `staleTime` 放宽到 5 分钟（`app/query.ts` 的约定）：R-02 实测 `system_profiler`
* 可达数秒级，而且探测要起独立子进程真正枚举设备 —— 不该每次挂载都重跑。
*/
function useHardwareQuery() {
	return useQuery({
		queryKey: qk.runtime.hardware,
		queryFn: () => api("/runtime/hardware"),
		staleTime: STALE_TIME_OVERRIDES.hardware
	});
}
function useBackendsCatalogQuery() {
	return useQuery({
		queryKey: qk.backends.catalog,
		queryFn: () => api("/backends/catalog"),
		staleTime: STALE_TIME_OVERRIDES.catalog
	});
}
function useBackendsInstalledQuery() {
	return useQuery({
		queryKey: qk.backends.installed,
		queryFn: () => api("/backends/installed")
	});
}
/** 安装后端包 → 202 + jobId，进度走同一条全局 SSE（与模型下载共用下载器）。 */
function useBackendInstallMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id) => api("/backends/install", {
			method: "POST",
			body: { id },
			idempotencyKey: `backend:${id}`
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.jobs.all });
		}
	});
}
function useBackendRemoveMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id) => api(`/backends/${encodeURIComponent(id)}`, { method: "DELETE" }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.backends.installed });
			qc.invalidateQueries({ queryKey: qk.backends.catalog });
		}
	});
}
/** 切换当前生效的加速后端。 */
function useBackendSelectMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (backend) => api("/backends/select", {
			method: "POST",
			body: { backend }
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.backends.installed });
			qc.invalidateQueries({ queryKey: qk.runtime.hardware });
			qc.invalidateQueries({ queryKey: qk.models.catalog });
		}
	});
}
/**
* 触发后端自检。
*
* ADR-003 决策 3：自检必须跑**真实推理**（内嵌测试音频），不是"文件存在"检查 ——
* R-02 在本机实测到 `libvulkan.so.1` 存在但根本没有 GPU。loader ≠ ICD ≠ 硬件。
*/
function useBackendSelfTestMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id) => api("/backends/selftest", {
			method: "POST",
			body: { id }
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.backends.installed });
		}
	});
}
//#endregion
//#region src/components/common/BackendChip.tsx
var BACKEND_LABEL = {
	cuda: "CUDA",
	vulkan: "Vulkan",
	rocm: "ROCm",
	metal: "Metal",
	coreml: "CoreML",
	cpu: "CPU"
};
var STATE_STYLE = {
	active: {
		text: "text-good",
		label: "使用中",
		icon: /* @__PURE__ */ jsx(Zap, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		})
	},
	installed: {
		text: "text-ink-secondary",
		label: "已安装",
		icon: /* @__PURE__ */ jsx(CheckCircle2, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		})
	},
	available: {
		text: "text-accent",
		label: "可安装",
		icon: /* @__PURE__ */ jsx(Download, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		})
	},
	"not-installed": {
		text: "text-ink-muted",
		label: "不可用",
		icon: /* @__PURE__ */ jsx(CircleDashed, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		})
	},
	failed: {
		text: "text-critical",
		label: "自检失败",
		icon: /* @__PURE__ */ jsx(XCircle, {
			className: "size-3.5 shrink-0",
			"aria-hidden": true
		})
	}
};
function BackendChip({ backend, state, className }) {
	const s = STATE_STYLE[state];
	return /* @__PURE__ */ jsxs("span", {
		className: cn("inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-1 px-2 py-1 text-xs font-medium", s.text, className),
		"data-testid": `backend-chip-${backend}`,
		children: [
			backend === "cpu" ? /* @__PURE__ */ jsx(Cpu, {
				className: "size-3.5 shrink-0",
				"aria-hidden": true
			}) : s.icon,
			/* @__PURE__ */ jsx("span", {
				className: "text-ink",
				children: BACKEND_LABEL[backend]
			}),
			/* @__PURE__ */ jsx("span", {
				className: cn("text-[11px]", s.text),
				children: s.label
			})
		]
	});
}
//#endregion
//#region src/features/runtime/components/HardwareCard.tsx
/**
* 硬件探测结果卡（章程要求 2.1 的第一步："网页检测硬件"）。
*
* ★ 显存显示 **可用/总量** 两个数字，不是只显示总量。
* LM Studio 的 Settings > Hardware 只显示总量，结果在多应用抢显存时把模型误判成
* "Full GPU Offload Possible"，加载直接 OOM（其 issue #67）。我们两个都给。
* `vramFreeMB` 为 null 时明确写"未知"，不拿总量冒充可用量。
*/
function HardwareCard({ hw, locale }) {
	const gpu = hw.selectedGpuIndex != null ? hw.gpus[hw.selectedGpuIndex] : null;
	const modelsDisk = hw.disks.find((d) => d.pathFor === "models_root") ?? hw.disks[0];
	return /* @__PURE__ */ jsxs("section", {
		className: "rounded-lg border border-line bg-surface-1 p-4",
		"data-testid": "runtime-hardware-card",
		children: [
			/* @__PURE__ */ jsx("h2", {
				className: "text-sm font-medium text-ink",
				children: "你的硬件"
			}),
			/* @__PURE__ */ jsxs("dl", {
				className: "mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2",
				children: [
					/* @__PURE__ */ jsx(Row, {
						icon: /* @__PURE__ */ jsx(MonitorCog, { className: "size-4" }),
						label: "显卡",
						children: gpu ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("span", {
							className: "text-ink",
							children: gpu.name
						}), /* @__PURE__ */ jsxs("span", {
							className: "text-ink-secondary",
							children: [
								" ",
								"· 显存",
								" ",
								gpu.vramTotalMB != null ? formatBytes(gpu.vramTotalMB * 1e6, locale) : "未知",
								"（可用",
								" ",
								gpu.vramFreeMB != null ? formatBytes(gpu.vramFreeMB * 1e6, locale) : "未知",
								"）"
							]
						})] }) : hw.unifiedMemory ? /* @__PURE__ */ jsx("span", {
							className: "text-ink",
							children: "统一内存架构（显存与内存共享）"
						}) : /* @__PURE__ */ jsx("span", {
							className: "text-ink-secondary",
							children: "未检测到可用 GPU"
						})
					}),
					/* @__PURE__ */ jsxs(Row, {
						icon: /* @__PURE__ */ jsx(MemoryStick, { className: "size-4" }),
						label: "内存",
						children: [/* @__PURE__ */ jsx("span", {
							className: "text-ink",
							children: formatBytes(hw.ram.totalMB * 1e6, locale)
						}), hw.ram.availableMB != null ? /* @__PURE__ */ jsxs("span", {
							className: "text-ink-secondary",
							children: [
								" ",
								"· 可用 ",
								formatBytes(hw.ram.availableMB * 1e6, locale)
							]
						}) : null]
					}),
					/* @__PURE__ */ jsxs(Row, {
						icon: /* @__PURE__ */ jsx(Cpu, { className: "size-4" }),
						label: "处理器",
						children: [
							/* @__PURE__ */ jsx("span", {
								className: "text-ink",
								children: hw.cpu.brand
							}),
							/* @__PURE__ */ jsxs("span", {
								className: "text-ink-secondary",
								children: [
									" ",
									"· ",
									hw.cpu.physicalCores,
									" 核 / ",
									hw.cpu.logicalCores,
									" 线程"
								]
							}),
							!hw.cpu.features.includes("avx2") ? /* @__PURE__ */ jsx("span", {
								className: "text-critical",
								children: " · 不支持 AVX2"
							}) : null
						]
					}),
					/* @__PURE__ */ jsx(Row, {
						icon: /* @__PURE__ */ jsx(HardDrive, { className: "size-4" }),
						label: "模型目录",
						children: modelsDisk ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("span", {
							className: "block truncate font-mono text-[11px] text-ink",
							children: modelsDisk.path
						}), /* @__PURE__ */ jsxs("span", {
							className: "text-ink-secondary",
							children: [
								"剩余 ",
								formatBytes(modelsDisk.freeMB * 1e6, locale),
								" /",
								" ",
								formatBytes(modelsDisk.totalMB * 1e6, locale)
							]
						})] }) : /* @__PURE__ */ jsx("span", {
							className: "text-ink-secondary",
							children: "未知"
						})
					})
				]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3",
				children: [/* @__PURE__ */ jsx("span", {
					className: "text-xs text-ink-secondary",
					children: "后端："
				}), hw.backends.map((b) => /* @__PURE__ */ jsx(BackendChip, {
					backend: b.id,
					state: hw.selectedBackend === b.id ? "active" : b.installed ? "installed" : b.available ? "available" : "not-installed"
				}, b.id))]
			}),
			hw.backends.some((b) => !b.available && b.unavailableReason) ? /* @__PURE__ */ jsx("ul", {
				className: "mt-2 space-y-0.5",
				children: hw.backends.filter((b) => !b.available && b.unavailableReason).map((b) => /* @__PURE__ */ jsxs("li", {
					className: "text-[11px] text-ink-muted",
					children: [
						b.id,
						"：",
						b.unavailableReason
					]
				}, b.id))
			}) : null,
			/* @__PURE__ */ jsxs("p", {
				className: "mt-2 text-[11px] text-ink-muted",
				children: [
					"探测于 ",
					new Date(hw.detectedAt).toLocaleString(locale),
					" ·",
					" ",
					hw.os.platform,
					"/",
					hw.os.arch,
					" ",
					hw.os.version
				]
			})
		]
	});
}
function Row({ icon, label, children }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "min-w-0",
		children: [/* @__PURE__ */ jsxs("dt", {
			className: "flex items-center gap-1.5 text-ink-muted",
			children: [/* @__PURE__ */ jsx("span", {
				"aria-hidden": true,
				children: icon
			}), label]
		}), /* @__PURE__ */ jsx("dd", {
			className: "mt-0.5 min-w-0",
			children
		})]
	});
}
//#endregion
//#region src/features/runtime/components/BackendPackCard.tsx
function BackendPackCard({ pack, locale, isActive, selfTest, installing, onInstall, onRemove, onSelect, onSelfTest }) {
	const isLoadBearing = pack.tier === "builtin" || pack.backend === "cpu";
	const selfTestFailed = selfTest != null && !selfTest.passed;
	return /* @__PURE__ */ jsxs("article", {
		className: "rounded-lg border border-line bg-surface-1 p-4",
		"data-testid": `backend-pack-${pack.id}`,
		children: [
			/* @__PURE__ */ jsx("div", {
				className: "flex items-start justify-between gap-3",
				children: /* @__PURE__ */ jsxs("div", {
					className: "min-w-0",
					children: [
						/* @__PURE__ */ jsxs("div", {
							className: "flex flex-wrap items-center gap-2",
							children: [
								/* @__PURE__ */ jsx(BackendChip, {
									backend: pack.backend,
									state: isActive ? "active" : selfTestFailed ? "failed" : pack.installed ? "installed" : pack.applicable ? "available" : "not-installed"
								}),
								/* @__PURE__ */ jsx("h3", {
									className: "text-sm font-medium text-ink",
									children: pack.displayNameZh
								}),
								pack.recommended ? /* @__PURE__ */ jsx(StatusChip, {
									tone: "good",
									label: "推荐"
								}) : null,
								isLoadBearing ? /* @__PURE__ */ jsx(StatusChip, {
									tone: "neutral",
									label: "兜底后端",
									icon: /* @__PURE__ */ jsx(Lock, { className: "size-3.5" })
								}) : null
							]
						}),
						/* @__PURE__ */ jsxs("p", {
							className: "mt-1 text-xs text-ink-secondary",
							children: [
								pack.engine,
								" ",
								pack.engineVersion,
								" · ",
								pack.os,
								"/",
								pack.arch,
								" ·",
								" ",
								formatBytes(pack.totalSizeBytes, locale)
							]
						}),
						!pack.applicable && pack.inapplicableReason ? /* @__PURE__ */ jsx("p", {
							className: "mt-1 text-xs text-ink-muted",
							children: pack.inapplicableReason
						}) : null,
						pack.requiresDriver ? /* @__PURE__ */ jsxs("p", {
							className: "mt-1 text-[11px] text-ink-muted",
							children: ["需要驱动：", [
								pack.requiresDriver.nvidiaDriver && `NVIDIA ${pack.requiresDriver.nvidiaDriver}+`,
								pack.requiresDriver.vulkanApi && `Vulkan ${pack.requiresDriver.vulkanApi}+`,
								pack.requiresDriver.rocmVersion && `ROCm ${pack.requiresDriver.rocmVersion}+`,
								pack.requiresDriver.macosVersion && `macOS ${pack.requiresDriver.macosVersion}+`
							].filter(Boolean).join(" · ")]
						}) : null
					]
				})
			}),
			selfTest ? /* @__PURE__ */ jsx("div", {
				className: "mt-3 rounded border border-line bg-surface-0 p-2.5 text-xs",
				children: selfTest.passed ? /* @__PURE__ */ jsxs(Fragment, { children: [
					/* @__PURE__ */ jsx(StatusChip, {
						tone: "good",
						label: "自检通过"
					}),
					/* @__PURE__ */ jsxs("p", {
						className: "mt-1 text-ink-secondary",
						children: [
							"枚举到 ",
							selfTest.devicesFound,
							" 个设备",
							selfTest.rtf != null ? /* @__PURE__ */ jsxs(Fragment, { children: [
								" ",
								"· 实测 RTF ",
								selfTest.rtf.toFixed(2),
								"（1 小时音频约",
								" ",
								Math.round(selfTest.rtf * 60),
								" 分钟）"
							] }) : null
						]
					}),
					/* @__PURE__ */ jsxs("p", {
						className: "mt-0.5 text-[11px] text-ink-muted",
						children: [
							"于 ",
							new Date(selfTest.ranAt).toLocaleString(locale),
							" 用内嵌测试音频真实推理得出"
						]
					})
				] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
					/* @__PURE__ */ jsx(StatusChip, {
						tone: "critical",
						label: "自检失败"
					}),
					/* @__PURE__ */ jsx("p", {
						className: "mt-1 text-critical",
						children: selfTest.errorMessage ?? "未知原因"
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "mt-2 flex gap-2",
						children: [/* @__PURE__ */ jsx(Button, {
							size: "sm",
							variant: "secondary",
							onClick: () => onSelfTest(pack.id),
							children: "重试自检"
						}), /* @__PURE__ */ jsx(Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => onSelect(pack),
							children: "改用 CPU"
						})]
					})
				] })
			}) : null,
			/* @__PURE__ */ jsx("div", {
				className: "mt-3 flex flex-wrap items-center justify-end gap-2",
				children: pack.installed ? /* @__PURE__ */ jsxs(Fragment, { children: [
					!isActive ? /* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "secondary",
						onClick: () => onSelect(pack),
						children: "设为当前后端"
					}) : null,
					/* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "ghost",
						onClick: () => onSelfTest(pack.id),
						children: [/* @__PURE__ */ jsx(Play, {
							className: "size-3.5",
							"aria-hidden": true
						}), "自检"]
					}),
					/* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "ghost",
						disabled: isLoadBearing,
						title: isLoadBearing ? "CPU 后端是兜底，删除后在没有其它可用后端时会导致推理进程崩溃，因此不允许卸载" : void 0,
						onClick: () => onRemove(pack.id),
						"data-testid": `backend-remove-${pack.id}`,
						children: [/* @__PURE__ */ jsx(Trash2, {
							className: "size-3.5",
							"aria-hidden": true
						}), "卸载"]
					})
				] }) : /* @__PURE__ */ jsxs(Button, {
					size: "sm",
					variant: pack.recommended ? "primary" : "secondary",
					disabled: installing || !pack.applicable,
					onClick: () => onInstall(pack.id),
					"data-testid": `backend-install-${pack.id}`,
					children: [/* @__PURE__ */ jsx(Download, {
						className: "size-3.5",
						"aria-hidden": true
					}), installing ? "正在开始…" : `安装 ${formatBytes(pack.totalSizeBytes, locale)}`]
				})
			}),
			isLoadBearing && pack.installed ? /* @__PURE__ */ jsx("p", {
				className: "mt-1.5 text-right text-[11px] text-ink-muted",
				children: "CPU 后端是永不失败的兜底，不可卸载"
			}) : null
		]
	});
}
//#endregion
//#region src/features/runtime/RuntimePage.tsx
/**
* 运行时与加速后端页 —— 章程要求 2.1 的主界面。
*
* 原文：「网页检测硬件 → 推荐后端 → 下载对应预编译二进制 → 安装 → 自检 → 显示状态」。
* 这一页要闭环覆盖这六步，用户不装 CUDA、不配环境变量、不去 README 找二进制链接。
*
* 页面被放在侧栏一级导航而不是埋进设置里：R-01 调研发现 memo.ac 把这类功能埋在设置中，
* 「模型下载卡 0%」因此成为它 FAQ 里最高频的问题。
*/
function RuntimePage() {
	const { i18n } = useTranslation();
	const locale = i18n.language;
	const hardware = useHardwareQuery();
	const catalog = useBackendsCatalogQuery();
	const installed = useBackendsInstalledQuery();
	const install = useBackendInstallMutation();
	const remove = useBackendRemoveMutation();
	const select = useBackendSelectMutation();
	const selfTest = useBackendSelfTestMutation();
	const selfTestById = useMemo(() => {
		const m = /* @__PURE__ */ new Map();
		for (const p of installed.data?.packs ?? []) m.set(p.id, p.selfTest);
		return m;
	}, [installed.data]);
	const hw = hardware.data?.hardware;
	const packs = catalog.data?.packs ?? [];
	const sorted = useMemo(() => [...packs].sort((a, b) => {
		if (a.applicable !== b.applicable) return a.applicable ? -1 : 1;
		if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
		return b.priority - a.priority;
	}), [packs]);
	const anyFailed = (installed.data?.packs ?? []).some((p) => p.selfTest && !p.selfTest.passed);
	function handleSelect(pack) {
		select.mutateAsync(pack.backend);
	}
	return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto w-full max-w-4xl space-y-4 p-4",
		"data-testid": "runtime-page",
		children: [
			/* @__PURE__ */ jsxs("header", { children: [/* @__PURE__ */ jsx("h1", {
				className: "text-lg font-semibold text-ink",
				children: "运行时与加速后端"
			}), /* @__PURE__ */ jsx("p", {
				className: "mt-0.5 text-xs text-ink-secondary",
				children: "检测硬件 → 推荐后端 → 下载安装 → 自检 → 显示状态，全部在网页里完成。"
			})] }),
			anyFailed ? /* @__PURE__ */ jsx(Banner, {
				tone: "critical",
				title: "有加速后端自检未通过",
				detail: "下面的卡片里写了具体原因。你可以重试自检，或改用 CPU 后端（永远可用）。"
			}) : null,
			hardware.isError ? /* @__PURE__ */ jsx(ErrorBlock, {
				error: hardware.error,
				onRetry: () => void hardware.refetch()
			}) : null,
			hardware.isLoading ? /* @__PURE__ */ jsx("p", {
				className: "text-xs text-ink-muted",
				children: "正在探测硬件（会真正枚举设备，可能需要几秒）…"
			}) : null,
			hw ? /* @__PURE__ */ jsx(HardwareCard, {
				hw,
				locale
			}) : null,
			/* @__PURE__ */ jsxs("section", {
				className: "space-y-3",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "flex items-baseline justify-between",
						children: [/* @__PURE__ */ jsx("h2", {
							className: "text-sm font-medium text-ink",
							children: "加速后端包"
						}), catalog.data?.stale ? /* @__PURE__ */ jsx("span", {
							className: "text-xs text-ink-muted",
							children: "离线目录"
						}) : null]
					}),
					catalog.isError ? /* @__PURE__ */ jsx(ErrorBlock, {
						error: catalog.error,
						onRetry: () => void catalog.refetch()
					}) : null,
					sorted.length === 0 && !catalog.isLoading ? /* @__PURE__ */ jsxs("p", {
						className: "rounded-lg border border-line bg-surface-1 p-4 text-xs text-ink-secondary",
						children: [/* @__PURE__ */ jsx(Cpu, {
							className: "mr-1 inline size-3.5",
							"aria-hidden": true
						}), "目录里还没有适用于这台机器的加速后端包。CPU 后端始终可用。"]
					}) : null,
					sorted.map((p) => /* @__PURE__ */ jsx(BackendPackCard, {
						pack: p,
						locale,
						isActive: installed.data?.selectedBackend === p.backend && p.installed,
						selfTest: selfTestById.get(p.id) ?? null,
						installing: install.isPending && install.variables === p.id,
						onInstall: (id) => void install.mutateAsync(id),
						onRemove: (id) => {
							if (window.confirm("卸载这个加速后端？之后可以重新下载。")) remove.mutateAsync(id);
						},
						onSelect: handleSelect,
						onSelfTest: (id) => void selfTest.mutateAsync(id)
					}, p.id))
				]
			}),
			/* @__PURE__ */ jsxs("p", {
				className: "text-[11px] text-ink-muted",
				children: ["提示：自检里的 RTF 是**本机实测值**；模型卡片上的\"预计耗时\"是由它外推的**估算**， 外推系数尚未标定，仅供参考。", hw?.disks[0] ? ` 后端包会安装到模型目录所在卷（剩余 ${formatBytes(hw.disks[0].freeMB * 1e6, locale)}）。` : ""]
			})
		]
	});
}
//#endregion
//#region src/features/runtime/Runtime.routes.tsx
/** 运行时域路由片段（T-022 独占）。由 `src/routes.tsx` 聚合。 */
var runtimeRoutes = [{
	path: "runtime",
	element: /* @__PURE__ */ jsx(RuntimePage, {})
}];
//#endregion
//#region src/features/settings/Settings.routes.tsx
var SettingsPage = lazy(() => import("./assets/SettingsPage-D5DaAMPk.js"));
var settingsRoutes = [{
	path: "settings",
	element: /* @__PURE__ */ jsx(Navigate, {
		to: "/settings/general",
		replace: true
	})
}, {
	path: "settings/:section",
	element: /* @__PURE__ */ jsx(SettingsPage, {})
}];
//#endregion
//#region src/features/tasks/Tasks.routes.tsx
var TasksPage = lazy(() => import("./assets/TasksPage-CcHJ9Igi.js"));
var tasksRoutes = [{
	path: "tasks",
	element: /* @__PURE__ */ jsx(TasksPage, {})
}];
//#endregion
//#region src/routes.tsx
/**
* ★ 本文件**只做聚合**（D-05 §3.4 的反冲突设计）★
*
* 每个 feature 导出自己的路由片段，这里只 import 并展开。
* 三个并行任务各改各 feature 目录里的 `*.routes.tsx`，
* 本文件只在**新增一个 feature 时**才动一行 —— 写冲突被结构性消灭。
*
* T-022 / T-023 认领后在此追加：
*   import { modelsRoutes }  from './features/models/Models.routes';
*   import { runtimeRoutes } from './features/runtime/Runtime.routes';
*   import { mindmapRoutes } from './features/mindmap/Mindmap.routes';
* 并加进下面的数组。
*/
var routes = [{
	path: "/",
	element: /* @__PURE__ */ jsx(App, {}),
	children: [
		...notesRoutes,
		...captureRoutes,
		...recorderRoutes,
		...searchRoutes,
		...tasksRoutes,
		...settingsRoutes,
		...modelsRoutes,
		...runtimeRoutes,
		...mindmapRoutes
	]
}];
//#endregion
//#region src/__smoke__/render.tsx
/**
* 渲染冒烟入口（**验证用，不进产品包**）。
*
* 本机没有可用的无头浏览器（chromium 下载超时），而 `curl` 只能拿到 SPA 外壳，
* 证明不了 React 真的渲染出了东西。所以这里做一次**真实的 DOM 渲染**：
* 用 jsdom 提供 DOM 环境 + `createRoot` 客户端渲染 + `MemoryRouter`，
* 把渲染结果的文本导出，由 `scripts` 侧断言关键内容存在。
*
* 它证明的是"组件树能挂载并产出预期文本"，**不是**"端到端接通了 daemon"。
* daemon 的业务事件仍未实现，数据来自 MOCK —— 这一点不会因为本文件而改变。
*/
async function renderRoute(path) {
	initI18n();
	const container = document.createElement("div");
	container.id = "root";
	document.body.appendChild(container);
	const router = createMemoryRouter(routes, { initialEntries: [path] });
	const root = createRoot(container);
	await act(async () => {
		root.render(createElement(Providers, null, createElement(RouterProvider, { router })));
	});
	await act(async () => {
		await new Promise((r) => setTimeout(r, 350));
	});
	const text = container.textContent ?? "";
	root.unmount();
	container.remove();
	return text;
}
//#endregion
export { renderRoute };
