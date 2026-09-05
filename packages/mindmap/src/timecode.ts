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
 *
 * ## ★ 订正：「没法直接复用」在今天已经不成立了
 *
 * 这段原来写着「`packages/mindmap` 不能 import `apps/web`，所以这里没法直接复用它，
 * 两边一致性由基准向量守着」。前半句对，后半句的结论错了 —— 复用的落点从来不是
 * `apps/web`，是 `@openmemo/shared`：本包**已经依赖它**（见 package.json），
 * 而它的准入条件就是"纯函数、daemon 与浏览器都能 import"。
 *
 * 收敛的直接原因是又数出了两份：daemon 的 `msToClock()`（转写稿 `.md` 导出），
 * 以及本轮要新加的、**产出的字符串直接进 FTS5 索引**的那一份。四份靠一组基准向量
 * 互相对齐是守不住的 —— 向量只钉住"抄的时候是对的"，钉不住"以后没人再抄第五份"。
 * 现在实现只剩 `@openmemo/shared` 的 `formatTimecode()` 一份，本文件只做转发。
 *
 * 下面的基准向量**保留**：它现在钉的是"转发没有转错、语义没被换掉"，
 * 仍然是导出 `.md` 那条链路上唯一的行为断言（见 `timecode.test.ts`）。
 */
import { formatTimecode } from '@openmemo/shared';

/**
 * `754000` → `"12:34"`；超过 1 小时 → `"1:12:34"`。
 *
 * 与 `apps/web/src/lib/format/time.ts` 的 `timecode()` 语义一致 —— 现在**不是**
 * "刻意写成一样"，而是**同一个函数**（两边都转发到 `@openmemo/shared`）。
 */
export function formatTimestamp(ms: number): string {
  return formatTimecode(ms);
}
