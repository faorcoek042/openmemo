import { t as cn } from "./utils-BYK1OtKK.js";
import { t as Button } from "./Button-CCMyJCPF.js";
import { useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronRight, FlaskConical, PlugZap } from "lucide-react";
//#region src/app/query.ts
/**
* queryKey 工厂 —— **唯一来源**（D-05 §2.2）。
*
* 手写 `['notes','list']` 字面量是缓存失效失灵的头号原因，而且三个并行任务
* 各写各的必然拼错。所有 key 从这里取。
*/
var qk = {
	notes: {
		all: ["notes"],
		list: (filter = {}) => [
			"notes",
			"list",
			filter
		],
		detail: (uid) => [
			"notes",
			"detail",
			uid
		]
	},
	transcript: (noteUid) => ["transcript", noteUid],
	mindmap: (noteUid) => ["mindmap", noteUid],
	summary: (noteUid) => ["summary", noteUid],
	assets: (noteUid) => ["assets", noteUid],
	jobs: {
		all: ["jobs"],
		detail: (id) => ["jobs", id]
	},
	folders: ["folders"],
	tags: ["tags"],
	search: (q, mode) => [
		"search",
		mode,
		q
	],
	models: {
		catalog: ["models", "catalog"],
		installed: ["models", "installed"],
		storage: ["models", "storage"],
		sources: ["models", "sources"]
	},
	backends: {
		catalog: ["backends", "catalog"],
		installed: ["backends", "installed"]
	},
	runtime: { hardware: ["runtime", "hardware"] },
	settings: ["settings"]
};
function createQueryClient() {
	return new QueryClient({ defaultOptions: {
		queries: {
			staleTime: 0,
			gcTime: 3e5,
			refetchOnWindowFocus: false,
			retry: (failureCount, error) => {
				if (error?.retryable === false) return false;
				return failureCount < 1;
			}
		},
		mutations: { retry: 0 }
	} });
}
/** 例外：探测慢且贵的查询，单独放宽 staleTime（D-05 §2.2）。 */
var STALE_TIME_OVERRIDES = {
	/** R-02 §A.1 实测 `system_profiler` 可达数秒 */
	hardware: 3e5,
	/** 目录带 ETag 缓存 */
	catalog: 6e4
};
var initial = Object.fromEntries([
	"health",
	"auth",
	"events",
	"notes",
	"import",
	"transcript",
	"media",
	"jobs",
	"models",
	"backends",
	"runtime",
	"recorderWs",
	"generic"
].map((s) => [s, "unknown"]));
var useSurfaceStore = create((set) => ({
	states: initial,
	health: null,
	authed: false,
	set: (s, v) => set((st) => st.states[s] === v ? st : { states: {
		...st.states,
		[s]: v
	} }),
	setHealth: (health) => set({ health }),
	setAuthed: (authed) => set({ authed })
}));
function surfaceState(s) {
	return useSurfaceStore.getState().states[s];
}
function markSurface(s, v) {
	useSurfaceStore.getState().set(s, v);
}
/** 该面是否在用 mock 数据（UI 据此决定挂不挂 MOCK 条幅）。 */
function isSurfaceMocked(s) {
	return s === "mock" || s === "offline";
}
//#endregion
//#region src/lib/api/client.ts
var CSRF_HEADER = "X-OpenMemo-CSRF";
var CSRF_STORAGE_KEY = "openmemo.csrf";
/** 前端统一的错误对象。`code` 是稳定字符串，UI 按它查本地文案表（D-05 §6.2）。 */
var ApiError = class extends Error {
	code;
	retryable;
	status;
	details;
	/** 服务端文案。**只作未知 code 的兜底**，不作首选（ADR-007 决策 3）。 */
	serverMessage;
	serverMessageZh;
	remediation;
	constructor(status, body) {
		super(String(body.message ?? `HTTP ${status}`));
		this.name = "ApiError";
		this.status = status;
		this.code = String(body.code ?? `HTTP_${status}`);
		this.retryable = Boolean(body.retryable);
		this.details = body.details;
		this.serverMessage = String(body.message ?? "");
		this.serverMessageZh = String(body.messageZh ?? "");
		this.remediation = body.remediation ?? null;
	}
};
function getCsrf() {
	try {
		return sessionStorage.getItem(CSRF_STORAGE_KEY);
	} catch {
		return null;
	}
}
function setCsrf(token) {
	try {
		sessionStorage.setItem(CSRF_STORAGE_KEY, token);
	} catch {}
}
/**
* 从 URL fragment 取出 daemon 交接的 token 并**立刻抹掉**。
* 抹掉是为了防止 URL 被截图 / 分享 / 进浏览器历史记录。
*/
function consumeHandoffToken() {
	if (typeof window === "undefined") return null;
	const m = /^#t=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
	if (!m) return null;
	window.history.replaceState(null, "", window.location.pathname + window.location.search);
	return m[1];
}
/** 裸 fetch：不做 surface 记账，供 connect.ts 的握手阶段使用。 */
function rawFetch(path, init) {
	const h = new Headers(init?.headers);
	const method = (init?.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		const csrf = getCsrf();
		if (csrf) h.set(CSRF_HEADER, csrf);
	}
	return fetch(path, {
		...init,
		headers: h,
		credentials: "same-origin"
	});
}
/** 打真 daemon。 */
async function realFetch(path, opts = {}) {
	const { body, idempotencyKey, headers, ...rest } = opts;
	const method = (rest.method ?? "GET").toUpperCase();
	const h = new Headers(headers);
	if (body !== void 0) h.set("Content-Type", "application/json");
	if (method !== "GET" && method !== "HEAD") {
		const csrf = getCsrf();
		if (csrf) h.set(CSRF_HEADER, csrf);
		if (idempotencyKey) h.set("Idempotency-Key", idempotencyKey);
	}
	const res = await fetch(`/api${path}`, {
		...rest,
		method,
		headers: h,
		credentials: "same-origin",
		body: body === void 0 ? void 0 : JSON.stringify(body)
	});
	if (!res.ok) {
		let parsed = {};
		try {
			parsed = (await res.json()).error ?? {};
		} catch {}
		throw new ApiError(res.status, parsed);
	}
	if (res.status === 204) return void 0;
	return await res.json();
}
/** mock 回落实现，由 mock.ts 注册。 */
var mockFetcher = null;
function registerMockFetcher(f) {
	mockFetcher = f;
}
/** 这个错误是否说明"路由还没实现"，而不是业务错误。 */
function isNotImplemented(err) {
	if (!(err instanceof ApiError)) return false;
	return err.status === 404 || err.status === 501 || err.code === "NOT_FOUND" || err.code === "NOT_IMPLEMENTED";
}
async function api(a, b, c) {
	const hasSurface = typeof a === "string" && !a.startsWith("/");
	return apiCall(hasSurface ? a : "generic", hasSurface ? b : a, (hasSurface ? c : b) ?? void 0);
}
async function apiCall(surface, path, opts) {
	const state = surfaceState(surface);
	if (state === "mock" || state === "offline") {
		if (!mockFetcher) throw new ApiError(503, {
			code: "NO_BACKEND",
			message: "daemon unreachable and no mock"
		});
		return mockFetcher(path, opts);
	}
	try {
		const out = await realFetch(path, opts);
		if (state !== "live") markSurface(surface, "live");
		return out;
	} catch (err) {
		if (isNotImplemented(err) && mockFetcher) {
			markSurface(surface, "mock");
			return mockFetcher(path, opts);
		}
		if (err instanceof TypeError && mockFetcher) {
			markSurface(surface, "offline");
			return mockFetcher(path, opts);
		}
		throw err;
	}
}
/**
* 媒体 URL：走 `/media/asset/<uid>`，只接受 asset uid，绝不接受路径参数
* （D-01 §3.1 / §8.5 —— 这从根上消灭路径穿越）。
*/
function mediaUrl(assetUid, variant) {
	const q = variant ? `?variant=${encodeURIComponent(variant)}` : "";
	return `/media/asset/${encodeURIComponent(assetUid)}${q}`;
}
//#endregion
//#region src/components/common/MockNotice.tsx
/**
* 单个 API 面的"这块还是假数据"提示（T-029）。
*
* ## 为什么是按面而不是全局条幅
*
* daemon 正被逐个端点接通。全局条幅只有两种状态（全真 / 全假），
* 于是"笔记列表已经是真的、但转写还是假的"这种**真实的中间态无法表达**——
* 要么谎称全接通了，要么把已接通的部分也说成假的。两种都是失真。
*
* 按面之后，用户（和验收的人）在页面上看到的就是精确的事实：
* 哪块真、哪块假、假的那块是因为"还没实现"还是"服务没启动"。
*/
function MockNotice({ surface, className, compact }) {
	const { t } = useTranslation();
	const state = useSurfaceStore((s) => s.states[surface]);
	if (!isSurfaceMocked(state)) return null;
	const offline = state === "offline";
	const label = offline ? t("mock.offlineShort") : t("mock.notImplementedShort");
	if (compact) return /* @__PURE__ */ jsxs("span", {
		className: cn("inline-flex items-center gap-1 text-xs text-serious", className),
		title: offline ? t("mock.offlineDetail") : t("mock.notImplementedDetail"),
		children: [offline ? /* @__PURE__ */ jsx(PlugZap, {
			className: "size-3",
			"aria-hidden": true
		}) : /* @__PURE__ */ jsx(FlaskConical, {
			className: "size-3",
			"aria-hidden": true
		}), label]
	});
	return /* @__PURE__ */ jsxs("div", {
		role: "status",
		className: cn("flex items-start gap-2 rounded-md border border-line border-l-4 border-l-serious bg-surface-1 px-3 py-2 text-xs", className),
		children: [offline ? /* @__PURE__ */ jsx(PlugZap, {
			className: "mt-0.5 size-3.5 shrink-0 text-serious",
			"aria-hidden": true
		}) : /* @__PURE__ */ jsx(FlaskConical, {
			className: "mt-0.5 size-3.5 shrink-0 text-serious",
			"aria-hidden": true
		}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("div", {
			className: "font-medium text-ink",
			children: label
		}), /* @__PURE__ */ jsx("div", {
			className: "mt-0.5 text-ink-secondary",
			children: offline ? t("mock.offlineDetail") : t("mock.notImplementedDetail")
		})] })]
	});
}
/**
* 顶栏的整体连通性摘要：`已接通 4 / 模拟 3`。
* 只在**存在**模拟面时出现 —— 全部接通后它自己消失，不需要谁去删代码。
*/
function ConnectivitySummary({ className }) {
	const { t } = useTranslation();
	const states = useSurfaceStore((s) => s.states);
	const health = useSurfaceStore((s) => s.health);
	const entries = Object.entries(states);
	const live = entries.filter(([, v]) => v === "live").length;
	const mocked = entries.filter(([, v]) => isSurfaceMocked(v)).length;
	if (mocked === 0) return null;
	return /* @__PURE__ */ jsxs("span", {
		className: cn("inline-flex items-center gap-1.5 text-xs text-ink-muted", className),
		title: entries.map(([k, v]) => `${k}: ${v}`).join("\n"),
		children: [
			/* @__PURE__ */ jsx(FlaskConical, {
				className: "size-3 text-serious",
				"aria-hidden": true
			}),
			t("mock.summary", {
				live,
				mocked
			}),
			health ? /* @__PURE__ */ jsxs("span", {
				className: "text-ink-muted/70",
				children: ["· daemon v", health.version]
			}) : null
		]
	});
}
//#endregion
//#region src/components/common/ErrorBlock.tsx
/**
* 区块级错误（D-05 §5.1 的第 2 层级）：某个区域拉取失败，**其余页面照常可用**。
*
* 文案策略（D-05 §6.2，ADR-007 决策 3 已采纳）：
* 1. 优先按 `code` 查本地文案表 `errors.<CODE>`；
* 2. 查不到才回退服务端的 `message` / `messageZh`（前端版本旧、后端加了新 code 时不至于白屏）；
* 3. 技术细节折叠在"查看详情"里 —— **禁止把 error.detail 原样甩给用户**。
*
* 三段式：发生了什么 → 为什么 → 现在能做什么。
*/
function resolveErrorText(err, t, locale) {
	const key = `errors.${err instanceof ApiError ? err.code : "unknown"}`;
	const title = t(`${key}.title`, { defaultValue: "" });
	if (title) return {
		title,
		detail: t(`${key}.detail`, { defaultValue: "" }),
		action: t(`${key}.action`, { defaultValue: "" }) || void 0
	};
	if (err instanceof ApiError) {
		const server = locale.startsWith("zh") ? err.serverMessageZh || err.serverMessage : err.serverMessage;
		return {
			title: t("errors.unknown.title"),
			detail: server || err.message
		};
	}
	return {
		title: t("errors.unknown.title"),
		detail: err instanceof Error ? err.message : String(err)
	};
}
function ErrorBlock({ error, onRetry, onRemediate, className }) {
	const { t, i18n } = useTranslation();
	const [open, setOpen] = useState(false);
	const { title, detail, action } = resolveErrorText(error, t, i18n.language);
	const api = error instanceof ApiError ? error : null;
	const raw = api ? JSON.stringify({
		code: api.code,
		status: api.status,
		details: api.details
	}, null, 2) : String(error);
	return /* @__PURE__ */ jsx("div", {
		className: cn("rounded-lg border border-line bg-surface-1 p-4", className),
		children: /* @__PURE__ */ jsxs("div", {
			className: "flex items-start gap-2.5",
			children: [/* @__PURE__ */ jsx(AlertTriangle, {
				className: "mt-0.5 size-4 shrink-0 text-critical",
				"aria-hidden": true
			}), /* @__PURE__ */ jsxs("div", {
				className: "min-w-0 flex-1",
				children: [
					/* @__PURE__ */ jsx("div", {
						className: "text-sm font-medium text-ink",
						children: title
					}),
					detail ? /* @__PURE__ */ jsx("p", {
						className: "mt-1 text-sm text-ink-secondary",
						children: detail
					}) : null,
					/* @__PURE__ */ jsxs("div", {
						className: "mt-3 flex flex-wrap items-center gap-2",
						children: [
							onRetry && api?.retryable !== false ? /* @__PURE__ */ jsx(Button, {
								size: "sm",
								variant: "secondary",
								onClick: onRetry,
								children: t("common.retry")
							}) : null,
							api?.remediation && onRemediate ? /* @__PURE__ */ jsx(Button, {
								size: "sm",
								variant: "primary",
								onClick: () => onRemediate(api.remediation.action, api.remediation.params),
								children: action ?? api.remediation.action
							}) : null,
							/* @__PURE__ */ jsxs("button", {
								type: "button",
								onClick: () => setOpen((v) => !v),
								className: "inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink-secondary",
								children: [open ? /* @__PURE__ */ jsx(ChevronDown, { className: "size-3" }) : /* @__PURE__ */ jsx(ChevronRight, { className: "size-3" }), t("errors.detailToggle")]
							})
						]
					}),
					open ? /* @__PURE__ */ jsx("pre", {
						className: "mt-2 max-h-48 overflow-auto rounded-md bg-surface-0 p-2 text-xs text-ink-muted",
						children: raw
					}) : null
				]
			})]
		})
	});
}
//#endregion
export { consumeHandoffToken as a, registerMockFetcher as c, useSurfaceStore as d, STALE_TIME_OVERRIDES as f, api as i, setCsrf as l, qk as m, ConnectivitySummary as n, mediaUrl as o, createQueryClient as p, MockNotice as r, rawFetch as s, ErrorBlock as t, markSurface as u };
