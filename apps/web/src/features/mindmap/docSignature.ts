/**
 * 「屏幕上这张图，和刚拿到的这份文档，是不是同一张」—— **纯判断部分**（T-139 C10）。
 *
 * ## 为什么需要它
 *
 * `MindmapView` 的渲染器实例只在 `doc.uid` 变化时重建。而 `doc.uid` **是笔记的 uid**
 * （`runners/mindmap.ts` 生成时传的就是 `note.uid`），在同一条笔记里**永远不变** ——
 * 所以那个重建条件恒不成立：重新生成成功、缓存也确实重新拉到了新文档，
 * **屏幕上还是旧的那张图**，只有手动刷新才会变（实测见回执 §C10）。
 *
 * 这不是"少订阅了一个事件"：`note.updated{changed:['mindmap']}` 一直在发、
 * 前端一直有订阅、`GET /notes/:uid/mindmap` 也确实被重新请求了（浏览器网络日志为证）。
 * **数据到了，渲染器没换。**
 *
 * ## 为什么判据是"内容签名"而不是 `revision`
 *
 * 用 `doc.revision` 当重建条件会带来一个新毛病：用户自己拖一个节点 → 防抖 600ms →
 * PATCH → revision +1 → 重新拉 → 重建渲染器 —— **用户正在编辑时视图被重置**
 * （缩放、选中、撤销栈全没）。原注释担心的"编辑时被自己覆盖"是**真问题**。
 *
 * 内容签名同时满足两边：
 *   - 别人（重新生成）改了 → 文本/结构变了 → 签名不同 → 换图 ✅
 *   - 自己刚编辑完，服务端回来的就是我这份 → 签名相同 → 不动 ✅
 *
 * 签名**只取用户看得见的东西**（标题 + 从根开始按显示顺序遍历的每个节点文本）：
 * 节点 key、样式、折叠状态、渲染器私有 `ext` 都不进签名 ——
 * 它们变了不需要打断用户，而它们在往返中最容易发生无意义的抖动。
 */
import type { MindMapDoc } from '@openmemo/mindmap';

/**
 * 文档的"看得见的内容"签名。
 *
 * 遍历自 `rootKey`，按 `children` 的数组顺序（顺序即显示顺序，D-02 §2.2）。
 * 环与悬空引用不会让它爆栈：走过的 key 不再展开（`validate()` 会拒绝这类文档，
 * 但签名函数**不许**假设输入一定合法 —— 它拿到的可能是任何一份服务端文档）。
 */
export function docSignature(doc: MindMapDoc | null | undefined): string {
  if (!doc || typeof doc !== 'object' || !doc.nodes || !doc.rootKey) return '';
  const seen = new Set<string>();
  const parts: string[] = [];

  const walk = (key: string, depth: number): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const node = doc.nodes[key];
    if (!node) return;
    parts.push(`${depth}:${node.text}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(doc.rootKey, 0);

  return JSON.stringify([doc.title, parts]);
}
