import { t as cn } from "./utils-BYK1OtKK.js";
import { o as Button } from "./time-Dn1EgsA-.js";
import { useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
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
	/** 服务端给的文案。**只作未知 code 的兜底**，不作首选（D-05 §6.2）。 */
	serverMessage;
	serverMessageZh;
	/**
	* 机器可读的补救动作。ADR-007 决策 2 批准加入 `ApiErrorBody`，
	* 但 `packages/shared` 尚未落地 → 这里先按可选处理。
	*/
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
* 从 URL fragment 取出 daemon 交接的 token 并立刻抹掉。
* 抹掉是为了防止 URL 被截图 / 分享 / 进历史记录。
*/
function consumeHandoffToken() {
	if (typeof window === "undefined") return null;
	const hash = window.location.hash;
	const m = /^#t=([A-Za-z0-9_-]+)$/.exec(hash);
	if (!m) return null;
	window.history.replaceState(null, "", window.location.pathname + window.location.search);
	return m[1];
}
/** 真实 daemon 的 fetcher。基址为同 origin 的 `/api`（无 v1 段，D-01 §3.5 已订正）。 */
var httpFetcher = async (path, opts = {}) => {
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
};
/**
* 当前生效的 fetcher。
* daemon 尚未实现时由 `installMockApi()` 换成 mock —— **UI 上会显式标注 mock**。
*/
var active = httpFetcher;
function setFetcher(f) {
	active = f;
}
function api(path, opts) {
	return active(path, opts);
}
/** 媒体 URL：走 `/media/asset/<uid>`，只接受 asset uid，绝不接受路径参数（D-01 §3.1/§8.5）。 */
function mediaUrl(assetUid, variant) {
	const q = variant ? `?variant=${encodeURIComponent(variant)}` : "";
	return `/media/asset/${encodeURIComponent(assetUid)}${q}`;
}
//#endregion
//#region src/lib/format/bytes.ts
/** 字节与速率格式化。走 `Intl.NumberFormat`，不手写千分位。 */
var UNITS = [
	"B",
	"KB",
	"MB",
	"GB",
	"TB"
];
/**
* 十进制 MB（`bytes / 1e6`），与 R-04 §7.2 的口径一致 —— 模型体积、显存需求全用十进制，
* 避免"下载页显示 574 MB、系统显示 547 MiB"这种对不上的困惑。
*/
function formatBytes(bytes, locale) {
	if (bytes == null || !Number.isFinite(bytes)) return "—";
	let v = Math.max(0, bytes);
	let i = 0;
	while (v >= 1e3 && i < UNITS.length - 1) {
		v /= 1e3;
		i += 1;
	}
	const digits = v < 10 && i > 0 ? 1 : 0;
	return `${new Intl.NumberFormat(locale, {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(v)} ${UNITS[i]}`;
}
/** `8_200_000` → `"8.2 MB/s"` */
function formatSpeed(bps, locale) {
	if (bps == null || !Number.isFinite(bps) || bps <= 0) return "—";
	return `${formatBytes(bps, locale)}/s`;
}
/** `0.29` → `"29%"` */
function formatPercent(ratio, locale) {
	const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
	return new Intl.NumberFormat(locale, {
		style: "percent",
		maximumFractionDigits: 0
	}).format(clamped);
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
export { api as a, setCsrf as c, createQueryClient as d, qk as f, formatSpeed as i, setFetcher as l, formatBytes as n, consumeHandoffToken as o, formatPercent as r, mediaUrl as s, ErrorBlock as t, STALE_TIME_OVERRIDES as u };
