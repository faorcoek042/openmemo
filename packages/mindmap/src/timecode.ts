/**
 * 媒体时间码 —— **本包唯一的一份**。
 *
 * ## 为什么单独一个文件
 *
 * 这个函数此前在包内有**两份**，且两份的输出**不一样**：
 *
 * | 输入 ms | `adapters/markmap.ts`（旧） | `serialize/markdown.ts`（旧） |
 * |---|---|---|
 * | 90500   | `1:30`  | `01:31`   |
 * | 3599999 | `59:59` | `1:00:00` |
 *
 * 两处差异各自独立：
 * 1. `Math.floor(ms/1000)` vs `Math.round(ms/1000)` —— 后者会把 90.5s **进位到 91s**，
 *    时间码于是指向那一刻**之后**。媒体时间码的语义是"这一刻落在哪一秒里"，
 *    进位是错的：跳过去会错过用户要找的那句话的开头。
 * 2. 不足一小时时分钟位补不补零（`1:30` vs `01:30`）。
 *
 * 后果不是洁癖问题：**同一张导图**，用 markmap 看和导出成 Markdown，
 * 时间码对不上；而 Markdown 那份还与播放器（`apps/web/src/lib/format/time.ts` 的
 * `timecode()`）也对不上 —— 用户照着导出的 Markdown 去拖播放进度，会拖错地方。
 *
 * ## 保留的是哪一份、为什么
 *
 * 保留 `floor + h>0 ? h:mm:ss : m:ss`，因为它与 `apps/web` 的 `timecode()`
 * **逐字节同义**，而那个函数才是用户在播放器上真正看到的东西。
 * （`packages/mindmap` 不能 import `apps/web`，所以这里没法直接复用它。
 * 两边一致性由下面这组基准向量守着 —— 见 `timecode.test.ts`。）
 */

/**
 * `754000` → `"12:34"`；超过 1 小时 → `"1:12:34"`。
 *
 * 与 `apps/web/src/lib/format/time.ts` 的 `timecode()` 语义一致（**刻意**）。
 * 改这里之前先想清楚：导图导出的时间码和播放器的时间码必须是同一个数。
 */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
