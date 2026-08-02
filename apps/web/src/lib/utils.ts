import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind 类名合并。冲突时后者胜（`twMerge` 负责），条件拼接交给 `clsx`。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 本地临时 key。
 *
 * ⚠️ D-05 §2.6 硬禁忌：**前端严禁 import `@openmemo/shared` 的 ulid.ts**
 * —— 它 `import 'node:crypto'`，进浏览器包会炸（该文件也确实故意没从 index.ts 导出）。
 * 这里生成的 id **只能用作本地列表 key / 乐观占位，绝不发给服务端当 id**。
 */
export function localKey(prefix = 'tmp'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}_${rand}`;
}

/** 前沿节流：立即执行首次，其后每 `ms` 最多一次，尾包保证送达。 */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  return (...args: A) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
      return;
    }
    pending = args;
    timer ??= setTimeout(
      () => {
        timer = null;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      },
      ms - (now - last),
    );
  };
}
