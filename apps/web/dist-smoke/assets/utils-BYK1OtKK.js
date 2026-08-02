import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
//#region src/lib/utils.ts
/** Tailwind 类名合并。冲突时后者胜（`twMerge` 负责），条件拼接交给 `clsx`。 */
function cn(...inputs) {
	return twMerge(clsx(inputs));
}
/** 前沿节流：立即执行首次，其后每 `ms` 最多一次，尾包保证送达。 */
function throttle(fn, ms) {
	let last = 0;
	let timer = null;
	let pending = null;
	return (...args) => {
		const now = Date.now();
		if (now - last >= ms) {
			last = now;
			fn(...args);
			return;
		}
		pending = args;
		timer ??= setTimeout(() => {
			timer = null;
			last = Date.now();
			if (pending) fn(...pending);
			pending = null;
		}, ms - (now - last));
	};
}
//#endregion
export { throttle as n, cn as t };
