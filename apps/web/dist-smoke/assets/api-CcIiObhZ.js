import { i as api, m as qk } from "./ErrorBlock-NhqIUn2X.js";
import { t as Button } from "./Button-CCMyJCPF.js";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jsx, jsxs } from "react/jsx-runtime";
import { useTranslation } from "react-i18next";
import { Download, Redo2, Undo2 } from "lucide-react";
import MindElixir from "mind-elixir";
//#region ../../packages/mindmap/dist/adapters/mind-elixir.js
/**
* MindMapDoc ⇄ mind-elixir 适配器（主编辑器，**双向**）。
*
* 依据 D-02 §2.3 的字段映射表（已核实 mind-elixir v5.14.0 的 `src/types/index.ts`）。
*
* ⚠️ 本文件**不 import mind-elixir**，只按其数据形状做结构转换。
*    理由：`packages/mindmap` 必须保持库无关（ADR-002 决策 3）；
*    真正 `new MindElixir()` 的地方在 `apps/web`（归 architect）。
*    这里只做纯数据映射 —— 可以在 Node 里单测，不需要 DOM。
*/
var DIRECTION_TO_ME = {
	left: 0,
	right: 1,
	auto: void 0
};
function toMeNode(doc, key, seen) {
	const n = doc.nodes[key];
	seen.add(key);
	const out = {
		id: n.key,
		topic: n.text
	};
	if (n.collapsed !== void 0) out.expanded = !n.collapsed;
	const dir = DIRECTION_TO_ME[n.side ?? "auto"];
	if (dir !== void 0) out.direction = dir;
	if (n.style) {
		const s = {};
		if (n.style.fontSize !== void 0) s.fontSize = String(n.style.fontSize);
		if (n.style.color !== void 0) s.color = n.style.color;
		if (n.style.background !== void 0) s.background = n.style.background;
		if (n.style.bold) s.fontWeight = "bold";
		out.style = s;
	}
	if (n.icons?.length) out.icons = [...n.icons];
	if (n.tags?.length) out.tags = [...n.tags];
	if (n.hyperlink) out.hyperLink = n.hyperlink;
	if (n.noteMd) out.note = n.noteMd;
	if (n.imageAssetUid) out.image = { url: `/media/asset/${n.imageAssetUid}` };
	const metadata = { ...n.ext ?? {} };
	if (n.refs?.length) metadata["openmemoRefs"] = n.refs;
	if (n.meta && Object.keys(n.meta).length) metadata["openmemoMeta"] = n.meta;
	if (n.richMd) metadata["openmemoRichMd"] = n.richMd;
	if (Object.keys(metadata).length) out.metadata = metadata;
	const kids = n.children.filter((c) => doc.nodes[c] && !seen.has(c));
	if (kids.length) out.children = kids.map((c) => toMeNode(doc, c, seen));
	return out;
}
/** MindMapDoc → mind-elixir。map 展开成嵌套树。 */
function toMindElixir(doc) {
	const data = { nodeData: toMeNode(doc, doc.rootKey, /* @__PURE__ */ new Set()) };
	if (doc.edges?.length) data.arrows = doc.edges.map((e) => ({
		id: e.key,
		from: e.from,
		to: e.to,
		...e.label === void 0 ? {} : { label: e.label }
	}));
	if (doc.summaries?.length) data.summaries = doc.summaries.map((s) => ({
		id: s.key,
		parent: s.parent,
		start: s.fromIndex,
		end: s.toIndex,
		label: s.text
	}));
	const dir = doc.layout?.direction;
	if (dir === "left") data.direction = 0;
	else if (dir === "right") data.direction = 1;
	else if (dir === "both") data.direction = 2;
	const ext = doc.extensions?.["mind-elixir"];
	if (ext && typeof ext === "object") Object.assign(data, ext);
	return data;
}
function fromMeNode(me, nodes, parentDirection) {
	const key = me.id;
	const children = [];
	for (const c of me.children ?? []) children.push(fromMeNode(c, nodes, me.direction));
	const metadata = { ...me.metadata ?? {} };
	const refs = metadata["openmemoRefs"];
	const meta = metadata["openmemoMeta"];
	const richMd = metadata["openmemoRichMd"];
	delete metadata["openmemoRefs"];
	delete metadata["openmemoMeta"];
	delete metadata["openmemoRichMd"];
	const node = {
		key,
		text: me.topic,
		children
	};
	if (me.expanded !== void 0) node.collapsed = !me.expanded;
	if (me.direction === 0) node.side = "left";
	else if (me.direction === 1) node.side = "right";
	else if (parentDirection !== void 0) node.side = "auto";
	if (me.style) {
		const fs = me.style.fontSize === void 0 ? void 0 : Number(me.style.fontSize);
		node.style = {
			...me.style.color === void 0 ? {} : { color: me.style.color },
			...me.style.background === void 0 ? {} : { background: me.style.background },
			...fs === void 0 || Number.isNaN(fs) ? {} : { fontSize: fs },
			...me.style.fontWeight === "bold" ? { bold: true } : {}
		};
	}
	if (me.icons?.length) node.icons = me.icons;
	if (me.tags?.length) node.tags = me.tags;
	if (me.hyperLink) node.hyperlink = me.hyperLink;
	if (me.note) node.noteMd = me.note;
	if (typeof richMd === "string") node.richMd = richMd;
	if (Array.isArray(refs)) node.refs = refs;
	if (meta && typeof meta === "object") node.meta = meta;
	if (Object.keys(metadata).length) node.ext = metadata;
	if (me.image?.url) {
		const m = /\/media\/asset\/([A-Za-z0-9]+)/.exec(me.image.url);
		if (m?.[1]) node.imageAssetUid = m[1];
	}
	nodes[key] = node;
	return key;
}
/** mind-elixir → MindMapDoc。嵌套树摊平回 map。 */
function fromMindElixir(data, opts) {
	const nodes = {};
	const rootKey = fromMeNode(data.nodeData, nodes);
	const doc = {
		schemaVersion: 1,
		uid: opts.uid,
		title: opts.title ?? data.nodeData.topic,
		rootKey,
		revision: opts.revision ?? 0,
		nodes
	};
	if (data.arrows?.length) doc.edges = data.arrows.map((a) => ({
		key: a.id,
		from: a.from,
		to: a.to,
		...a.label === void 0 ? {} : { label: a.label }
	}));
	if (data.summaries?.length) doc.summaries = data.summaries.map((s) => ({
		key: s.id,
		parent: s.parent,
		fromIndex: s.start,
		toIndex: s.end,
		text: s.label
	}));
	if (data.direction === 0) doc.layout = { direction: "left" };
	else if (data.direction === 1) doc.layout = { direction: "right" };
	else if (data.direction === 2) doc.layout = { direction: "both" };
	return doc;
}
//#endregion
//#region ../../packages/mindmap/dist/adapters/markmap.js
function markmapLoss(doc) {
	let styledNodes = 0;
	let iconsOrTags = 0;
	let images = 0;
	for (const n of Object.values(doc.nodes)) {
		if (n.style) styledNodes++;
		if (n.icons?.length || n.tags?.length) iconsOrTags++;
		if (n.imageAssetUid) images++;
	}
	const edges = doc.edges?.length ?? 0;
	const summaries = doc.summaries?.length ?? 0;
	return {
		edges,
		summaries,
		styledNodes,
		iconsOrTags,
		images,
		lossy: edges + summaries + styledNodes + iconsOrTags + images > 0
	};
}
//#endregion
//#region src/features/mindmap/export.ts
async function exportMindmapBlob(instance, format, opts = {}) {
	const { noForeignObject = false, injectCss } = opts;
	if (format === "svg") return instance.exportSvg(noForeignObject, injectCss);
	return instance.exportPng(noForeignObject, injectCss);
}
/** 文件名安全化：用户提供的标题绝不能直接当文件名（D-01 §8.5 的同一条原则）。 */
function safeFileName(title, fallback = "mindmap") {
	return Array.from(title).filter((ch) => {
		const c = ch.codePointAt(0) ?? 0;
		return c > 31 && c !== 127;
	}).join("").replace(/[/\\:*?"<>|]/g, "").replace(/^\.+/, "").trim().slice(0, 80) || fallback;
}
async function downloadMindmapImage(instance, doc, format) {
	const blob = await exportMindmapBlob(instance, format);
	if (!blob) throw new Error(`导出 ${format} 失败：渲染器返回空`);
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = `${safeFileName(doc.title || "mindmap")}.${format}`;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}
//#endregion
//#region src/features/mindmap/MindmapView.tsx
/**
* F4 思维导图渲染 + **编辑**（ADR-002 决策 3）。
*
* ## 为什么是 mind-elixir 而不是 markmap
*
* 用户的原话是"**整理**思维导图"——整理 = 编辑，是主路径。
* markmap 是 Markdown → 图的单向渲染器，编辑能力弱（这正是竞品的局限）。
* mind-elixir 自带拖拽、右键菜单、撤销/重做、节点样式、自由连线，
* **这就是当初选它的全部理由**；不真的把这些接上，这个选型就白做了。
*
* ## 库无关性怎么守住
*
* 本组件是**唯一** import `mind-elixir` 的地方。
* 数据进出都经 `packages/mindmap` 的适配器（`toMindElixir` / `fromMindElixir`），
* 业务侧只见 `MindMapDoc`。换渲染器 = 换这一个文件。
*/
function MindmapView({ doc, editable = true, onChange }) {
	const { t } = useTranslation();
	const hostRef = useRef(null);
	const meRef = useRef(null);
	const [ready, setReady] = useState(false);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	useEffect(() => {
		const el = hostRef.current;
		if (!el) return;
		const me = new MindElixir({
			el,
			direction: MindElixir.RIGHT,
			editable,
			contextMenu: true,
			toolBar: true,
			keypress: true,
			allowUndo: true
		});
		me.init(toMindElixir(doc));
		meRef.current = me;
		setReady(true);
		me.bus.addListener("operation", () => {
			if (!onChangeRef.current) return;
			try {
				const next = fromMindElixir(me.getData(), { uid: doc.uid });
				onChangeRef.current(next);
			} catch (err) {
				console.error("[mindmap] fromMindElixir 失败", err);
			}
		});
		return () => {
			me.destroy();
			meRef.current = null;
			setReady(false);
		};
	}, [doc.uid, editable]);
	const loss = markmapLoss(doc);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex h-full min-h-0 flex-col",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5",
				children: [
					/* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "ghost",
						disabled: !ready,
						onClick: () => meRef.current?.undo(),
						title: t("mindmap.undo"),
						children: [/* @__PURE__ */ jsx(Undo2, { className: "size-3.5" }), t("mindmap.undo")]
					}),
					/* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "ghost",
						disabled: !ready,
						onClick: () => meRef.current?.redo(),
						title: t("mindmap.redo"),
						children: [/* @__PURE__ */ jsx(Redo2, { className: "size-3.5" }), t("mindmap.redo")]
					}),
					/* @__PURE__ */ jsx("span", {
						className: "mx-1 h-4 w-px bg-line",
						"aria-hidden": true
					}),
					/* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "ghost",
						disabled: !ready,
						onClick: () => meRef.current && void downloadMindmapImage(meRef.current, doc, "svg"),
						children: [/* @__PURE__ */ jsx(Download, { className: "size-3.5" }), "SVG"]
					}),
					/* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "ghost",
						disabled: !ready,
						onClick: () => meRef.current && void downloadMindmapImage(meRef.current, doc, "png"),
						children: [/* @__PURE__ */ jsx(Download, { className: "size-3.5" }), "PNG"]
					}),
					/* @__PURE__ */ jsx("span", {
						className: "ml-auto text-xs text-ink-muted",
						children: t("mindmap.editHint")
					})
				]
			}),
			/* @__PURE__ */ jsx("div", {
				ref: hostRef,
				className: "min-h-0 flex-1"
			}),
			loss.edges > 0 || loss.summaries > 0 ? /* @__PURE__ */ jsx("p", {
				className: "border-t border-line px-3 py-1.5 text-xs text-ink-muted",
				children: t("mindmap.markmapLoss", {
					edges: loss.edges,
					summaries: loss.summaries
				})
			}) : null
		]
	});
}
//#endregion
//#region src/features/mindmap/api.ts
function useMindmapQuery(noteUid) {
	return useQuery({
		queryKey: qk.mindmap(noteUid ?? ""),
		queryFn: () => api("notes", `/notes/${noteUid}/mindmap`),
		enabled: Boolean(noteUid)
	});
}
/**
* 保存导图。
*
* D-05 §5 F4 定的是"发操作而非全量文档"（PATCH ops），但 mind-elixir 的
* `operation` 事件给的是**操作后的完整树**，转回 MindMapDoc 也是完整文档。
* 要发细粒度 op 就得自己做 diff —— 那是性能优化，按当前"功能优先"的排序**先不做**，
* 但接口形状保持 PATCH，日后换成 ops 不影响调用方。
*/
function useSaveMindmapMutation(noteUid) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (doc) => api("notes", `/notes/${noteUid}/mindmap`, {
			method: "PATCH",
			body: { doc }
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: qk.mindmap(noteUid ?? "") });
		}
	});
}
//#endregion
export { useSaveMindmapMutation as n, MindmapView as r, useMindmapQuery as t };
