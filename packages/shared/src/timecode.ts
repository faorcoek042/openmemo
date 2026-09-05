/**
 * 媒体时间码 —— **全仓唯一的一份**。
 *
 * ## 为什么它必须在 `shared` 而不是任何一端
 *
 * 收敛之前，同一个函数在仓里有**四份**（逐字等价，所以谁都没症状）：
 *
 * | 位置 | 名字 | 谁在看它的输出 |
 * | --- | --- | --- |
 * | `apps/web/src/lib/format/time.ts` | `timecode()` | 播放器、转写稿、正文里的时间锚点（屏幕上那个） |
 * | `packages/mindmap/src/timecode.ts` | `formatTimestamp()` | 导图导出的 `.md` |
 * | `apps/daemon/src/http/rest/content.ts` | `msToClock()` | 转写稿导出的 `.md` |
 * | `apps/daemon/src/db/richText.ts` | （本轮新增的那一份，**没有写**） | **FTS5 索引里的 `body_text`** |
 *
 * 第四行才是这次的起点：正文里的时间锚点是一个 atom node，`body_json` 里
 * 只有 `startMs`，**没有任何文字**。服务端的纯文本投影因此对它贡献为零 ——
 * 用户看着屏幕上的 `0:04` 去搜，`/api/search` 返回 0 条，而同一段里的普通文字搜得到
 * `[实测：A/B 对照，两次都是真的 /api/search 请求]`。
 *
 * 让 daemon 现算这个字符串是对的（`body_json` 是唯一事实来源，投影是它的函数），
 * 但**不能因此再抄第五份**：投影出来的字符串必须与用户屏幕上看到的**逐字节相同**，
 * 否则"照着屏幕搜自己的锚点"这条路会以另一种方式再断一次，而且同样不报错。
 *
 * 四个消费者里，`apps/daemon` / `apps/web` / `packages/mindmap` 都已经依赖
 * `@openmemo/shared`（`packages/mindmap` 那份的文件头当年写着「不能 import apps/web，
 * 所以一致性只能靠同一组基准向量守」—— 那条约束的正解就是这里）。而本包的文件头
 * 已经把准入条件写死：「纯类型或纯函数，无 I/O 无副作用，daemon 与浏览器包都能安全 import」。
 * 时间码函数逐条满足。
 *
 * ⚠️ **不许再出现第二份。** 由 `timecode.test.ts` 的结构守卫钉住
 *（判据：`Math.floor(… / 3600)` 全仓只许出现在本文件里）。
 */

/**
 * `754000` → `"12:34"`；超过 1 小时 → `"1:12:34"`。时间码不随 locale 变，是媒体惯例。
 *
 * ## 语义是刻意选的，不是随手写的
 *
 * - **`floor` 而不是 `round`**：媒体时间码回答的是"这一刻落在哪一秒里"。
 *   进位过的时间码指向那一刻**之后** —— 跳过去会错过用户要找的那句话的开头。
 *   （`packages/mindmap` 里两份旧实现的差异之一正是它：90500ms 一个给 `1:30`、
 *   一个给 `01:31`。）
 * - **不足一小时时分钟位不补零**（`1:30` 而不是 `01:30`）：与播放器上显示的一致。
 * - **非有限值 / 负数一律归 0**：`NaN:NaN` 这种字符串一旦写进 `.srt` 会让整个
 *   字幕文件在播放器里失效，而在我们自己的界面上完全看不出来。
 */
export function formatTimecode(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * 正文里的时间锚点节点类型名（TipTap 自定义 inline atom node）。
 *
 * **这是一个跨进程契约**，不是一个前端细节：`apps/web` 用它注册节点并序列化进
 * `body_json`，`apps/daemon` 用它在纯文本投影里认出这个节点。两边写死各自的字面量
 * 时，改名的一方不会有任何报错 —— 只是索引里悄悄少一样东西。
 */
export const TIME_ANCHOR_NODE_TYPE = 'timeAnchor' as const;

/**
 * 时间锚点在**纯文本**里的样子：`[12:34]`。
 *
 * ⚠️ **两端必须调这同一个函数，而不是各自拼一遍 `` `[${formatTimecode(ms)}]` ``。**
 *
 * - `apps/web` 的 `TimeAnchor.renderText()` —— 复制正文、`editor.getText()` 走它；
 * - `apps/daemon` 的 `extractPlainText()` —— **写进 `notes.body_text`、被 FTS5 索引的就是它**。
 *
 * 这两个字符串必须逐字节相同，否则用户复制出来的正文和他能搜到的东西对不上。
 * 拼接方式（方括号、要不要空格）本身就是那个契约的一部分，所以它也只能有一份。
 */
export function timeAnchorText(startMs: number): string {
  return `[${formatTimecode(startMs)}]`;
}
