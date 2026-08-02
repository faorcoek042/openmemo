import i18n from "i18next";
import { initReactI18next } from "react-i18next";
var zh_CN_default = {
	app: {
		"name": "OpenMemo",
		"search": "搜索",
		"tasksBadge_one": "{{count}} 个任务进行中",
		"tasksBadge_other": "{{count}} 个任务进行中",
		"theme": "主题",
		"language": "语言"
	},
	nav: {
		"newCapture": "新建捕获",
		"allNotes": "全部笔记",
		"starred": "星标",
		"record": "录音",
		"folders": "文件夹",
		"tags": "标签",
		"runtime": "运行时",
		"models": "模型",
		"settings": "设置",
		"tasks": "任务中心"
	},
	banner: {
		"mockTitle": "MOCK 模式：本地服务未接通",
		"mockDetail": "当前数据由前端内存模拟，用于 UI 评审。daemon 实现后将自动切换为真实数据。",
		"sseDegraded": "实时更新已断开，正在轮询",
		"sseReconnecting": "正在重新连接本地服务…",
		"multiTab": "当前浏览器不支持标签页选主，已为每个标签单独建立连接；建议只保留一个标签页。",
		"portDrift": "端口已从 {{expected}} 变更为 {{actual}}，浏览器会把它当作新站点，需要重新授权麦克风。",
		"shutdown": "本地服务正在退出"
	},
	capture: {
		"title": "新建捕获",
		"urlLabel": "把链接粘到这里，或把文件拖进来",
		"urlPlaceholder": "https://www.youtube.com/watch?v=…",
		"supported": "支持 YouTube / Bilibili / 播客 / RSS / 直链，或拖入本地音视频文件",
		"start": "开始",
		"probing": "正在解析…",
		"probeFailed": "无法解析该链接",
		"dropHint": "松开以导入",
		"options": {
			"model": "转写模型",
			"language": "语言",
			"auto": "自动检测",
			"diarize": "说话人分离",
			"keepVideo": "保留视频",
			"structure": "完成后生成摘要与思维导图"
		},
		"confirm": "开始转写",
		"cancel": "取消",
		"uploadExplain": "浏览器出于安全限制无法直接读取本地路径，文件会被复制到 OpenMemo 数据目录。",
		"uploading": "正在上传 {{percent}}",
		"batchCollapsed": "批量导入 · {{done}}/{{total}} 完成"
	},
	notes: {
		"title": "全部笔记",
		"empty": "还没有笔记",
		"emptyHint": "粘贴一个音视频链接就能开始",
		"search": "搜索笔记",
		"openNote": "打开笔记",
		"processing": "处理中",
		"failed": "失败",
		"partial": "部分完成",
		"untitled": "未命名"
	},
	detail: {
		"tabs": {
			"summary": "摘要",
			"mindmap": "思维导图",
			"notes": "笔记"
		},
		"transcript": "转写稿",
		"followPlayback": "跟随播放",
		"searchInNote": "段内搜索",
		"noTranscript": "尚无转写稿",
		"generating": "正在生成…",
		"summaryEmpty": "还没有摘要",
		"backgroundHint": "可以关闭此页面，任务会继续",
		"hallucination": "检测到重复，可能是幻觉",
		"retrySegment": "仅重跑此段",
		"lowConfidence": "识别置信度较低"
	},
	progress: {
		"fetch": "下载中",
		"probe": "解析中",
		"demux": "提取音轨",
		"peaks": "生成波形",
		"vad": "分析语音",
		"asr": "转写中",
		"diarize": "区分说话人",
		"structure": "整理笔记",
		"index": "建立索引",
		"chunk": "第 {{done}}/{{total}} 段",
		"eta": "剩余 {{eta}}",
		"pause": "暂停",
		"resume": "继续",
		"cancel": "取消",
		"stopping": "正在停止…",
		"retry": "重试"
	},
	recorder: {
		"title": "录音转文字",
		"device": "麦克风",
		"permNeeded": "开始录音需要麦克风权限",
		"permAllow": "允许并开始",
		"permDenied": "浏览器已阻止麦克风",
		"permDeniedHelp": "点击地址栏左侧的锁形图标 → 麦克风 → 允许，然后重新检测",
		"recheck": "重新检测",
		"start": "开始录音",
		"pause": "暂停",
		"stop": "停止并转写",
		"recording": "录音中",
		"twoPhaseNotice": "实时字幕使用快速模型，停止后会自动用更准确的模型重听一遍",
		"rerunning": "正在用 {{model}} 重新识别，以获得更准确的结果…",
		"rerunHint": "你现在看到的是快速模型的初稿，可以先编辑，编辑不会被覆盖。",
		"skipRerun": "跳过",
		"replaced": "已更新 {{updated}} 段转写 · 你编辑过的 {{preserved}} 段已保留",
		"viewDiff": "查看改动",
		"undoReplace": "撤销这次更新"
	},
	tasks: {
		"title": "任务中心",
		"running": "进行中",
		"waiting": "等待中",
		"needsAttention": "需要处理",
		"done": "已完成",
		"empty": "暂无任务",
		"backgroundNotice": "任务在本地服务中运行，关闭浏览器或本页面都不会中断。",
		"pauseAll": "全部暂停",
		"expand": "展开",
		"waitingLane": "等待「{{lane}}」通道空闲",
		"lane": {
			"net.download": "下载",
			"net.llm": "AI 调用",
			"cpu.media": "媒体处理",
			"gpu.asr": "转写",
			"gpu.llm": "本地模型",
			"io.local": "磁盘"
		}
	},
	errors: {
		"title": "出错了",
		"detailToggle": "查看详情",
		"MOCK_NOT_IMPLEMENTED": {
			"title": "该功能尚未接通",
			"detail": "本地服务还没有实现这个接口，当前处于 MOCK 模式。"
		},
		"NOTE_NOT_FOUND": {
			"title": "笔记不存在",
			"detail": "它可能已被删除。"
		},
		"INPUT_URL_INVALID": {
			"title": "链接格式不正确",
			"detail": "请粘贴一个 http 或 https 开头的完整链接。"
		},
		"MISSING_ASR_MODEL": {
			"title": "还没有安装转写模型",
			"detail": "转写需要先安装一个语音识别模型。",
			"action": "去安装"
		},
		"MISSING_BACKEND": {
			"title": "转写需要先安装加速后端",
			"detail": "",
			"action": "去安装"
		},
		"RESOURCE_DISK_FULL": {
			"title": "磁盘空间不足",
			"detail": "需要 {{required}}，当前可用 {{free}}。",
			"action": "清理空间"
		},
		"CHECKSUM_MISMATCH": {
			"title": "文件校验未通过，已丢弃",
			"detail": "下载的文件与预期的哈希不一致，为安全起见不会安装。",
			"action": "换源重下"
		},
		"UPSTREAM_AUTH": {
			"title": "该内容需要登录才能访问",
			"detail": "",
			"action": "改为拖入本地文件"
		},
		"CONTRACT_MISMATCH": {
			"title": "前端与本地服务版本不一致",
			"detail": "请刷新页面；若仍不一致，请升级应用。",
			"action": "刷新页面"
		},
		"unknown": {
			"title": "发生了未知错误",
			"detail": ""
		}
	},
	common: {
		"retry": "重试",
		"cancel": "取消",
		"confirm": "确定",
		"close": "关闭",
		"undo": "撤销",
		"loading": "加载中…",
		"notMeasured": "未测量",
		"mock": "MOCK"
	},
	settings: {
		"title": "设置",
		"general": "通用",
		"asr": "转写",
		"llm": "AI 模型",
		"storage": "存储",
		"about": "关于",
		"apiKeyPlaintextWarning": "API Key 以明文存储在 {{path}}（文件权限 0600）。任何能读取该文件的本地程序都能看到它。",
		"contractVersion": "契约版本",
		"exportDiagnostics": "导出诊断包",
		"telemetryNote": "本产品不做任何遥测上报，日志只写在本机。"
	}
};
var en_default = {
	app: {
		"name": "OpenMemo",
		"search": "Search",
		"tasksBadge_one": "{{count}} task running",
		"tasksBadge_other": "{{count}} tasks running",
		"theme": "Theme",
		"language": "Language"
	},
	nav: {
		"newCapture": "New capture",
		"allNotes": "All notes",
		"starred": "Starred",
		"record": "Record",
		"folders": "Folders",
		"tags": "Tags",
		"runtime": "Runtime",
		"models": "Models",
		"settings": "Settings",
		"tasks": "Tasks"
	},
	banner: {
		"mockTitle": "MOCK mode: local service not connected",
		"mockDetail": "Data is simulated in the browser for UI review. It will switch to real data once the daemon is implemented.",
		"sseDegraded": "Live updates disconnected — falling back to polling",
		"sseReconnecting": "Reconnecting to the local service…",
		"multiTab": "This browser cannot elect a leader tab, so each tab opened its own connection. Keeping a single tab open is recommended.",
		"portDrift": "The port changed from {{expected}} to {{actual}}. The browser treats this as a new site, so microphone access must be granted again.",
		"shutdown": "The local service is shutting down"
	},
	capture: {
		"title": "New capture",
		"urlLabel": "Paste a link here, or drop a file",
		"urlPlaceholder": "https://www.youtube.com/watch?v=…",
		"supported": "YouTube / Bilibili / podcasts / RSS / direct links — or drop a local audio or video file",
		"start": "Start",
		"probing": "Resolving…",
		"probeFailed": "Could not resolve this link",
		"dropHint": "Drop to import",
		"options": {
			"model": "Model",
			"language": "Language",
			"auto": "Auto-detect",
			"diarize": "Identify speakers",
			"keepVideo": "Keep video",
			"structure": "Generate summary and mind map when done"
		},
		"confirm": "Start transcribing",
		"cancel": "Cancel",
		"uploadExplain": "Browsers cannot read local file paths for security reasons, so the file is copied into the OpenMemo data directory.",
		"uploading": "Uploading {{percent}}",
		"batchCollapsed": "Batch import · {{done}}/{{total}} done"
	},
	notes: {
		"title": "All notes",
		"empty": "No notes yet",
		"emptyHint": "Paste an audio or video link to get started",
		"search": "Search notes",
		"openNote": "Open note",
		"processing": "Processing",
		"failed": "Failed",
		"partial": "Partial",
		"untitled": "Untitled"
	},
	detail: {
		"tabs": {
			"summary": "Summary",
			"mindmap": "Mind map",
			"notes": "Notes"
		},
		"transcript": "Transcript",
		"followPlayback": "Follow playback",
		"searchInNote": "Find in transcript",
		"noTranscript": "No transcript yet",
		"generating": "Generating…",
		"summaryEmpty": "No summary yet",
		"backgroundHint": "You can close this page — the task keeps running",
		"hallucination": "Repetition detected — possibly a hallucination",
		"retrySegment": "Re-run this segment only",
		"lowConfidence": "Low recognition confidence"
	},
	progress: {
		"fetch": "Downloading",
		"probe": "Resolving",
		"demux": "Extracting audio",
		"peaks": "Building waveform",
		"vad": "Detecting speech",
		"asr": "Transcribing",
		"diarize": "Identifying speakers",
		"structure": "Organising notes",
		"index": "Indexing",
		"chunk": "Segment {{done}}/{{total}}",
		"eta": "{{eta}} left",
		"pause": "Pause",
		"resume": "Resume",
		"cancel": "Cancel",
		"stopping": "Stopping…",
		"retry": "Retry"
	},
	recorder: {
		"title": "Record and transcribe",
		"device": "Microphone",
		"permNeeded": "Recording needs microphone access",
		"permAllow": "Allow and start",
		"permDenied": "The browser blocked microphone access",
		"permDeniedHelp": "Click the lock icon in the address bar → Microphone → Allow, then re-check",
		"recheck": "Re-check",
		"start": "Start recording",
		"pause": "Pause",
		"stop": "Stop and transcribe",
		"recording": "Recording",
		"twoPhaseNotice": "Live captions use a fast model. When you stop, a more accurate model re-listens automatically.",
		"rerunning": "Re-transcribing with {{model}} for better accuracy…",
		"rerunHint": "What you see now is a draft from the fast model. You can edit already — your edits will not be overwritten.",
		"skipRerun": "Skip",
		"replaced": "Updated {{updated}} segments · kept your {{preserved}} edited segments",
		"viewDiff": "View changes",
		"undoReplace": "Undo this update"
	},
	tasks: {
		"title": "Tasks",
		"running": "Running",
		"waiting": "Waiting",
		"needsAttention": "Needs attention",
		"done": "Completed",
		"empty": "No tasks",
		"backgroundNotice": "Tasks run in the local service. Closing this page or the browser will not interrupt them.",
		"pauseAll": "Pause all",
		"expand": "Expand",
		"waitingLane": "Waiting for the “{{lane}}” lane",
		"lane": {
			"net.download": "download",
			"net.llm": "AI",
			"cpu.media": "media",
			"gpu.asr": "transcription",
			"gpu.llm": "local model",
			"io.local": "disk"
		}
	},
	errors: {
		"title": "Something went wrong",
		"detailToggle": "Details",
		"MOCK_NOT_IMPLEMENTED": {
			"title": "Not wired up yet",
			"detail": "The local service has not implemented this endpoint. The app is running in MOCK mode."
		},
		"NOTE_NOT_FOUND": {
			"title": "Note not found",
			"detail": "It may have been deleted."
		},
		"INPUT_URL_INVALID": {
			"title": "Invalid link",
			"detail": "Paste a full http or https URL."
		},
		"MISSING_ASR_MODEL": {
			"title": "No transcription model installed",
			"detail": "Transcription needs a speech recognition model first.",
			"action": "Install"
		},
		"MISSING_BACKEND": {
			"title": "An acceleration backend must be installed first",
			"detail": "",
			"action": "Install"
		},
		"RESOURCE_DISK_FULL": {
			"title": "Not enough disk space",
			"detail": "Needs {{required}}, only {{free}} available.",
			"action": "Free up space"
		},
		"CHECKSUM_MISMATCH": {
			"title": "Checksum failed — file discarded",
			"detail": "The download did not match the expected hash, so it was not installed.",
			"action": "Retry from another source"
		},
		"UPSTREAM_AUTH": {
			"title": "This content requires sign-in",
			"detail": "",
			"action": "Import a local file instead"
		},
		"CONTRACT_MISMATCH": {
			"title": "Frontend and local service versions differ",
			"detail": "Reload the page. If the mismatch persists, update the app.",
			"action": "Reload"
		},
		"unknown": {
			"title": "Unknown error",
			"detail": ""
		}
	},
	common: {
		"retry": "Retry",
		"cancel": "Cancel",
		"confirm": "OK",
		"close": "Close",
		"undo": "Undo",
		"loading": "Loading…",
		"notMeasured": "Not measured",
		"mock": "MOCK"
	},
	settings: {
		"title": "Settings",
		"general": "General",
		"asr": "Transcription",
		"llm": "AI models",
		"storage": "Storage",
		"about": "About",
		"apiKeyPlaintextWarning": "API keys are stored in plain text at {{path}} (file mode 0600). Any local program that can read that file can read them.",
		"contractVersion": "Contract version",
		"exportDiagnostics": "Export diagnostics bundle",
		"telemetryNote": "This product sends no telemetry. Logs stay on your machine."
	}
};
//#endregion
//#region src/app/i18n/index.ts
/**
* 国际化（D-05 §6.1）。
*
* 选 `i18next` + `react-i18next` 的理由：**它是唯一零编译步骤的方案**。
* lingui 与 typesafe-i18n 都需要 extract/generate 步骤 —— Wave 3 三个任务并行，
* 多一个代码生成步骤就多一处"我本地能跑你那儿不行"。类型安全的收益抵不上这个代价。
*
* ⚠️ 版本联动：`react-i18next` 17 的 peer 硬性要求 `i18next >= 26.2.0`。装错组合会静默出错。
*
* 约定：
* - key 命名 `<feature>.<区块>.<语义>`，**禁止用中文原文当 key**（改文案就得改所有引用）。
* - 数字/日期/字节/相对时间**不进词条**，走 `lib/format/` 的 Intl 封装。
* - 错误文案按 `code` 查 `errors.<CODE>`；服务端的 `message`/`messageZh` 只作未知 code 的兜底
*   （D-05 §6.2，ADR-007 决策 3 已采纳）。
*/
var SUPPORTED_LOCALES = [{
	code: "zh-CN",
	label: "中文"
}, {
	code: "en",
	label: "English"
}];
var STORAGE_KEY = "openmemo.locale";
function detectLocale() {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved && SUPPORTED_LOCALES.some((l) => l.code === saved)) return saved;
	} catch {}
	return (typeof navigator !== "undefined" ? navigator.language : "zh-CN").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
function initI18n() {
	const lng = detectLocale();
	i18n.use(initReactI18next).init({
		resources: {
			"zh-CN": { translation: zh_CN_default },
			en: { translation: en_default }
		},
		lng,
		fallbackLng: "zh-CN",
		interpolation: { escapeValue: false },
		returnNull: false
	});
	applyDocumentLang(lng);
	return i18n;
}
function setLocale(code) {
	i18n.changeLanguage(code);
	try {
		localStorage.setItem(STORAGE_KEY, code);
	} catch {}
	applyDocumentLang(code);
}
/** `<html lang>` 必须随 locale 变（a11y 基线，D-05 §6.3）。 */
function applyDocumentLang(code) {
	if (typeof document !== "undefined") document.documentElement.lang = code;
}
//#endregion
export { initI18n as n, setLocale as r, SUPPORTED_LOCALES as t };
