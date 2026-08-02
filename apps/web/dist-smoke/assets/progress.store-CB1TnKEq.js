import { n as throttle } from "./utils-BYK1OtKK.js";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
//#region src/lib/stores/progress.store.ts
var useProgressStore = create()(subscribeWithSelector((set) => ({
	byJob: {},
	clear: (jobId) => set((s) => {
		const next = { ...s.byJob };
		delete next[jobId];
		return { byJob: next };
	}),
	clearAll: () => set({ byJob: {} }),
	_commit: (batch) => set((s) => ({ byJob: {
		...s.byJob,
		...batch
	} }))
})));
/**
* 服务端已按 4Hz 节流（`PROGRESS_THROTTLE_HZ`），前端**再节流一次到 200ms**
* 才触碰 React state —— 这是 shared/events.ts 注释里明确要求的两级节流。
*/
var buffer = {};
var flush = throttle(() => {
	if (Object.keys(buffer).length === 0) return;
	useProgressStore.getState()._commit(buffer);
	buffer = {};
}, 200);
function pushProgress(snap) {
	buffer[snap.jobId] = {
		...snap,
		at: Date.now()
	};
	flush();
}
//#endregion
export { useProgressStore as n, pushProgress as t };
