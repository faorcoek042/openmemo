import { c as registerMockFetcher } from "./ErrorBlock-NhqIUn2X.js";
import "./ui.store-2aoWFaa7.js";
//#region src/lib/events/bus.ts
var handlers = /* @__PURE__ */ new Map();
var anyHandlers = /* @__PURE__ */ new Set();
var bus = {
	on(type, fn) {
		let set = handlers.get(type);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			handlers.set(type, set);
		}
		set.add(fn);
		return () => {
			set.delete(fn);
		};
	},
	/** 订阅全部事件（调试面板 / 连接看门狗用）。 */
	onAny(fn) {
		anyHandlers.add(fn);
		return () => {
			anyHandlers.delete(fn);
		};
	},
	emit(type, payload) {
		const set = handlers.get(type);
		if (set) for (const fn of set) try {
			fn(payload);
		} catch (err) {
			console.error(`[sse] handler for "${type}" threw`, err);
		}
		for (const fn of anyHandlers) try {
			fn(type, payload);
		} catch (err) {
			console.error("[sse] wildcard handler threw", err);
		}
	},
	/** 仅供测试与热更新使用。 */
	_reset() {
		handlers.clear();
		anyHandlers.clear();
	}
};
//#endregion
//#region ../../packages/shared/dist/events.js
/**
* Server-Sent Events contract.
*
* ADR-004 decision 5: SSE, not WebSocket, for server→client push.
* HARD CONSTRAINT: exactly ONE global stream at `GET /api/events`.
*
* Why one stream: HTTP/1.1 caps concurrent connections at 6 per origin. One stream per
* download would exhaust that with three downloads plus a transcription in flight, and
* every subsequent fetch would hang. D-05 §2.3 additionally elects a single leader tab
* via Web Locks and rebroadcasts over BroadcastChannel, so the whole browser holds one.
*
* Live microphone capture (F3) uploads audio over a WebSocket instead — that direction is
* genuinely bidirectional and binary. Transport is chosen per use case.
*
* ─────────────────────────────────────────────────────────────────────────────
* SCOPE NOTE (ADR-007 decision 1)
* Until 2026-08-02 this file only covered the model/download/backend domain (14 events).
* `architect` correctly flagged in D-05 §9 that F1–F5 had no realtime events at all,
* which would have forced T-021/T-023 to poll and lose "text on screen in 14 seconds".
* The pipeline/transcription/mindmap/note events below close that gap.
*
* D-05 did not specify payloads, so these are derived from D-01's F1–F5 sequence
* diagrams (`job.progress {step:"fetch", pct}`, `job.done {noteUid}`) and D-05 §4.1/4.3/4.6.
* Derivation is recorded in coordination/inbox/model-mgmt.md for `architect` to confirm.
* ─────────────────────────────────────────────────────────────────────────────
*/
var SSE_EVENT_TYPES = [
	"job.created",
	"job.progress",
	"job.state",
	"job.done",
	"job.failed",
	"job.blocked",
	"model.installed",
	"model.removed",
	"model.activated",
	"backend.installed",
	"backend.removed",
	"storage.changed",
	"catalog.updated",
	"sources.probed",
	"hardware.changed",
	"media.ready",
	"transcribe.started",
	"transcribe.partial",
	"transcribe.segment",
	"transcribe.done",
	"record.state",
	"mindmap.delta",
	"mindmap.done",
	"note.created",
	"note.updated",
	"note.deleted",
	"sync.required",
	"keepalive"
];
var KEEPALIVE_INTERVAL_MS = 15e3;
/** Events that carry a monotonic `seq` and must be applied in order. */
var SEQUENCED_EVENT_TYPES = ["transcribe.segment", "mindmap.delta"];
//#endregion
//#region src/lib/events/types.ts
/**
* 前端的 SSE 事件类型入口。
*
* ✅ **权威定义在 `@openmemo/shared`** —— `model-mgmt` 已按 D-05 §11 的规格落地了
* 29 个事件类型（ADR-007 决策 1）。本文件**不再重复定义**它们，只做两件事：
*   1. 转发 shared 的类型；
*   2. 定义 shared 尚未覆盖、但 UI 已经需要的少数扩展事件（下方 §扩展）。
*
* 扩展事件一律加 `x.` 前缀，**不与 shared 的命名空间冲突**，
* 等 shared 补齐后删掉这一段即可，分发层与 UI 不用改。
*/
/** 需要按单调 `seq` 应用、并检测缺口的事件。 */
function isSequenced(type) {
	return SEQUENCED_EVENT_TYPES.includes(type) || type === "x.summary.delta";
}
var EXTENSION_SSE_EVENT_TYPES = [
	"x.transcribe.replaced",
	"x.summary.delta",
	"x.summary.done",
	"x.media.asset.ready",
	"x.daemon.shutdown",
	"x.index.progress"
];
/** 前端要监听的全集 = shared 的 29 个 + 本地扩展的 6 个。 */
var ALL_SSE_EVENT_TYPES = [...SSE_EVENT_TYPES, ...EXTENSION_SSE_EVENT_TYPES];
var SEGMENT_FLAG = {
	HALLUCINATION: 1,
	LOW_CONFIDENCE: 2,
	CONFIRMED: 4,
	SILENCE: 8
};
//#endregion
//#region src/lib/api/mock.ts
/**
* ⚠️⚠️  MOCK DAEMON —— 不是真实后端  ⚠️⚠️
*
* `apps/daemon` 由 `oss-scout` 负责，尚未实现转写流水线。
* 为了让前端能被看到、被评审、被端到端验证，这里用内存实现同形状的 API 与 SSE 事件流。
*
* **诚实规则**：启用时 UI 顶部会常驻一条醒目的 MOCK 条幅，且本文件所有产出
* 都标了 `__mock: true`。**绝不允许把 mock 的运行结果说成"跑通了"。**
*
* 事件序列严格遵循 D-05 §11 的规格 —— 所以 daemon 真的实现后，
* 只要删掉 mock，分发层与 UI 一行都不用改。这既是演示，也是对规格的一次自测。
*/
var seq = 0;
var nextId = (p) => `${p}_${(++seq).toString(36).padStart(6, "0")}`;
var SAMPLE_TEXT = [
	"好，我们上节课讲到了前向传播的基本流程。",
	"那么今天要解决的核心问题是：损失怎么反向传回去。",
	"先看这个最简单的两层网络，输入是 x，中间有一个隐藏层。",
	"这里的关键在于梯度的方向 —— 它告诉我们参数该往哪边调。",
	"我们可以把它理解成一个下降的过程，沿着最陡的方向往下走。",
	"所以我们对损失函数求偏导，得到每个参数的梯度。",
	"注意这里链式法则的应用，它是整个反向传播的数学基础。",
	"老师，那如果网络很深，梯度会不会消失？",
	"很好的问题。这正是我们下节课要讲的梯度消失问题。",
	"简单说，连乘很多个小于 1 的数，结果会趋近于零。",
	"解决办法有残差连接、批归一化，还有换激活函数。",
	"我们先把基础的反向传播推导完整走一遍。"
];
var notes = /* @__PURE__ */ new Map();
var transcripts = /* @__PURE__ */ new Map();
var timers = /* @__PURE__ */ new Set();
function later(fn, ms) {
	const t = setTimeout(() => {
		timers.delete(t);
		fn();
	}, ms);
	timers.add(t);
}
function emit(type, payload) {
	bus.emit(type, {
		type,
		...payload
	});
}
function seedNote(partial) {
	const uid = partial.uid ?? nextId("note");
	const note = {
		__mock: true,
		uid,
		title: partial.title,
		kind: partial.kind ?? "media",
		status: partial.status ?? "ready",
		folderUid: null,
		durationMs: partial.durationMs ?? 6452e3,
		coverAssetUid: null,
		starred: partial.starred ?? false,
		tags: partial.tags ?? [],
		createdAt: (/* @__PURE__ */ new Date(Date.now() - 864e5)).toISOString(),
		updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		activeJobId: null,
		source: partial.source ?? {
			kind: "url",
			adapterId: "ytdlp",
			site: "youtube",
			author: "某某大学",
			inputUrl: "https://www.youtube.com/watch?v=demo"
		},
		summaryMd: partial.summaryMd ?? null,
		bodyText: "",
		language: "zh",
		assets: partial.assets ?? [],
		transcriptUid: partial.transcriptUid ?? null
	};
	notes.set(uid, note);
	return note;
}
function makeSegments(count, startSeq = 0) {
	const out = [];
	for (let i = 0; i < count; i += 1) {
		const s = startSeq + i;
		const startMs = s * 8200;
		const text = SAMPLE_TEXT[s % SAMPLE_TEXT.length];
		out.push({
			seq: s,
			startMs,
			endMs: startMs + 7600,
			text,
			speakerLabel: text.startsWith("老师") ? "SPEAKER_01" : "SPEAKER_00",
			confidence: s % 9 === 5 ? .42 : .93,
			noSpeechProb: .01,
			words: null,
			chunkIdx: Math.floor(s / 4),
			flags: s % 9 === 5 ? SEGMENT_FLAG.LOW_CONFIDENCE : s % 17 === 13 ? SEGMENT_FLAG.HALLUCINATION : 0
		});
	}
	return out;
}
function seedDemoData() {
	const n1 = seedNote({
		title: "深度学习导论 第 3 讲：反向传播",
		tags: [{
			uid: "t1",
			name: "机器学习",
			color: null
		}],
		summaryMd: "本讲从前向传播回顾出发，推导反向传播的链式法则，并引出梯度消失问题。",
		starred: true
	});
	const tUid = nextId("tr");
	n1.transcriptUid = tUid;
	n1.assets = [{
		uid: nextId("as"),
		role: "audio16k",
		mime: "audio/wav",
		bytes: 103232e3,
		durationMs: n1.durationMs,
		state: "ready"
	}, {
		uid: nextId("as"),
		role: "peaks",
		mime: "application/octet-stream",
		bytes: 451e3,
		durationMs: null,
		state: "ready"
	}];
	transcripts.set(tUid, {
		uid: tUid,
		noteUid: n1.uid,
		engineId: "whisper.cpp",
		modelId: "asr/whisper-large-v3-turbo-q5_0",
		backend: "cpu",
		language: "zh",
		status: "done",
		progress: 1,
		durationMs: n1.durationMs,
		rtf: .42,
		speakers: [{
			label: "SPEAKER_00",
			displayName: "张老师",
			color: null
		}, {
			label: "SPEAKER_01",
			displayName: "学生 A",
			color: null
		}],
		segments: makeSegments(48)
	});
	seedNote({
		title: "播客 EP.42 — 本地优先软件的未来",
		durationMs: 318e4,
		source: {
			kind: "url",
			adapterId: "direct-http",
			site: "podcast",
			author: "Local First FM",
			inputUrl: "https://example.com/ep42.mp3"
		}
	});
	seedNote({
		title: "周会录音 2026-07-29",
		kind: "recording",
		durationMs: 264e4,
		source: {
			kind: "recording",
			adapterId: null,
			site: null,
			author: null,
			inputUrl: null
		}
	});
}
/**
* F1 全流程：严格按 D-05 §11 的事件序列与顺序发。
* 时间被压缩过（真实是几十分钟），但**事件的种类、顺序、字段一模一样**。
*/
function runImportPipeline(note, jobId) {
	const totalChunks = 12;
	const transcriptUid = nextId("tr");
	const step = (name, progress, at, extra = {}) => later(() => {
		emit("job.progress", {
			jobId,
			state: "running",
			jobType: "import.url",
			noteUid: note.uid,
			progress,
			step: name,
			completedBytes: null,
			totalBytes: null,
			speedBps: null,
			etaSeconds: Math.round((1 - progress) * 360),
			...extra
		});
	}, at);
	later(() => {
		note.title = "深度学习导论 第 4 讲：梯度消失与残差连接";
		note.durationMs = 512e4;
		emit("note.updated", {
			noteUid: note.uid,
			fields: [
				"title",
				"durationMs",
				"coverAssetUid"
			]
		});
	}, 400);
	step("fetch", .08, 600, {
		completedBytes: 12e6,
		totalBytes: 148e6,
		speedBps: 82e5
	});
	step("fetch", .32, 1400, {
		completedBytes: 64e6,
		totalBytes: 148e6,
		speedBps: 91e5
	});
	step("demux", .44, 2200);
	later(() => {
		const asset = {
			uid: nextId("as"),
			role: "peaks",
			mime: "application/octet-stream",
			bytes: 38e4,
			durationMs: null,
			state: "ready"
		};
		note.assets = [
			...note.assets,
			{
				uid: nextId("as"),
				role: "audio16k",
				mime: "audio/wav",
				bytes: 8192e4,
				durationMs: note.durationMs,
				state: "ready"
			},
			asset
		];
		emit("media.asset.ready", {
			noteUid: note.uid,
			assetUid: asset.uid,
			role: "peaks",
			bytes: asset.bytes
		});
	}, 2400);
	step("vad", .5, 2600);
	later(() => {
		transcripts.set(transcriptUid, {
			uid: transcriptUid,
			noteUid: note.uid,
			engineId: "whisper.cpp",
			modelId: "asr/whisper-large-v3-turbo-q5_0",
			backend: "cpu",
			language: "zh",
			status: "running",
			progress: 0,
			durationMs: note.durationMs,
			rtf: null,
			speakers: [{
				label: "SPEAKER_00",
				displayName: null,
				color: null
			}],
			segments: []
		});
		note.transcriptUid = transcriptUid;
		note.status = "processing";
		emit("transcribe.started", {
			transcriptUid,
			noteUid: note.uid,
			jobId,
			engineId: "whisper.cpp",
			modelId: "asr/whisper-large-v3-turbo-q5_0",
			backend: "cpu",
			language: "zh",
			durationMs: note.durationMs,
			totalChunks
		});
	}, 2800);
	for (let c = 0; c < totalChunks; c += 1) later(() => {
		const segs = makeSegments(4, c * 4);
		const tr = transcripts.get(transcriptUid);
		if (tr) {
			tr.segments = [...tr.segments, ...segs];
			tr.progress = (c + 1) / totalChunks;
		}
		emit("transcribe.segment", {
			transcriptUid,
			noteUid: note.uid,
			seq: c,
			chunkIdx: c,
			segments: segs
		});
		emit("transcribe.chunk", {
			transcriptUid,
			noteUid: note.uid,
			doneChunks: c + 1,
			totalChunks,
			lastEndMs: (c * 4 + 4) * 8200
		});
		emit("job.progress", {
			jobId,
			state: "running",
			jobType: "import.url",
			noteUid: note.uid,
			progress: .5 + .45 * ((c + 1) / totalChunks),
			step: "asr",
			stepIndex: 5,
			stepCount: 7,
			completedBytes: null,
			totalBytes: null,
			speedBps: null,
			etaSeconds: Math.round((totalChunks - c - 1) * 26)
		});
	}, 3200 + c * 900);
	later(() => {
		const tr = transcripts.get(transcriptUid);
		if (tr) {
			tr.status = "done";
			tr.progress = 1;
			tr.rtf = .38;
		}
		note.status = "ready";
		note.activeJobId = null;
		emit("transcribe.done", {
			transcriptUid,
			noteUid: note.uid,
			segmentCount: 48,
			rtf: .38,
			durationMs: note.durationMs,
			speakers: [{
				label: "SPEAKER_00",
				totalMs: 41e5
			}, {
				label: "SPEAKER_01",
				totalMs: 102e4
			}]
		});
		emit("note.status", {
			noteUid: note.uid,
			status: "ready"
		});
		emit("job.progress", {
			jobId,
			state: "succeeded",
			jobType: "import.url",
			noteUid: note.uid,
			progress: 1,
			step: null,
			completedBytes: null,
			totalBytes: null,
			speedBps: null,
			etaSeconds: null
		});
	}, 14400);
	later(() => {
		emit("summary.delta", {
			noteUid: note.uid,
			seq: 0,
			textDelta: "本讲承接反向传播，"
		});
		emit("summary.delta", {
			noteUid: note.uid,
			seq: 1,
			textDelta: "重点讨论深层网络中的梯度消失问题，"
		});
		emit("summary.delta", {
			noteUid: note.uid,
			seq: 2,
			textDelta: "并给出残差连接与批归一化两条解决路径。"
		});
		emit("summary.done", {
			noteUid: note.uid,
			chars: 46
		});
	}, 15e3);
}
var mockFetcher = async (path, opts = {}) => {
	await new Promise((r) => setTimeout(r, 60));
	const method = (opts.method ?? "GET").toUpperCase();
	if (method === "GET" && path === "/notes") return { notes: [...notes.values()].sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1) };
	if (method === "GET" && path.startsWith("/notes/")) {
		const uid = path.split("/")[2];
		if (path.endsWith("/transcript")) {
			const note = notes.get(uid);
			return (note?.transcriptUid ? transcripts.get(note.transcriptUid) : null) ?? null;
		}
		const n = notes.get(uid);
		if (!n) throw Object.assign(/* @__PURE__ */ new Error("not found"), { code: "NOTE_NOT_FOUND" });
		return n;
	}
	if (method === "POST" && path === "/import/probe") {
		const { url } = opts.body;
		return {
			title: "深度学习导论 第 4 讲：梯度消失与残差连接",
			author: "某某大学",
			durationMs: 512e4,
			thumbnailUrl: null,
			site: url.includes("bilibili") ? "bilibili" : "youtube",
			adapterId: url.match(/\.(mp3|m4a|wav)(\?|$)/) ? "direct-http" : "ytdlp",
			requiresAuth: false
		};
	}
	if (method === "POST" && path === "/import/url") {
		const req = opts.body;
		const note = seedNote({
			title: req.url,
			status: "processing",
			durationMs: null,
			assets: []
		});
		const jobUid = nextId("job");
		note.activeJobId = jobUid;
		emit("note.created", {
			noteUid: note.uid,
			title: note.title,
			kind: "media",
			folderUid: null
		});
		emit("note.status", {
			noteUid: note.uid,
			status: "processing"
		});
		runImportPipeline(note, jobUid);
		return {
			jobUid,
			noteUid: note.uid
		};
	}
	if (method === "GET" && path === "/jobs") return {
		jobs: [],
		concurrencyLimit: 2
	};
	throw Object.assign(/* @__PURE__ */ new Error(`[MOCK] 未实现的接口: ${method} ${path}`), {
		code: "MOCK_NOT_IMPLEMENTED",
		retryable: false
	});
};
var installed = false;
/**
* 注册 mock 作为**回落**（T-029）。
*
* 注意语义变化：它不再全局替换 fetcher。真假选择现在按 **surface** 决定
* （见 `client.ts` 的 `api()`）—— daemon 实现了哪个端点，那个面就自动走真的。
*/
function installMockApi() {
	if (installed) return () => {};
	installed = true;
	seedDemoData();
	registerMockFetcher(mockFetcher);
	console.info("[OpenMemo] mock 回落已注册；具体哪个面用真/假由 surface 状态决定。");
	return () => {
		timers.forEach(clearTimeout);
		timers.clear();
		notes.clear();
		transcripts.clear();
		installed = false;
	};
}
function isMockEnabled() {
	return installed;
}
//#endregion
export { isSequenced as a, SEGMENT_FLAG as i, isMockEnabled as n, KEEPALIVE_INTERVAL_MS as o, ALL_SSE_EVENT_TYPES as r, bus as s, installMockApi as t };
