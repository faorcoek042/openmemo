/**
 * @openmemo/mindmap —— 库无关的思维导图数据层（T-023, oss-scout）
 *
 * **ADR-002 决策 3 硬性要求**：数据模型必须库无关。
 * mind-elixir（唯一的渲染器/编辑器）只是这个 schema 的**消费者**。
 *
 * 本包**不依赖任何渲染库** —— 适配器只做纯数据形状转换，
 * 因此可以在 Node 里单测、不需要 DOM。真正 `new MindElixir()` 的地方在 `apps/web`。
 *
 * ── ★ T-165：markmap 适配器**整块摘掉了** ────────────────────────────────────
 *
 * `adapters/markmap.ts`（`toMarkmap` / `markmapLoss` / `escapeHtml` / `IPureNode`）
 * 与 `markmap-lib` / `markmap-view` 两个依赖一起删除。理由不是"没用上"，是
 * **产品里没有、也不打算有"大纲视图"**：mind-elixir 才是选型（要的是"整理"= 编辑），
 * 而 markmap 是单向渲染器。留着它的直接代价是界面上一句假话 ——
 * `MindmapView` 会提示"切到大纲视图将不显示 N 条关联线"，
 * 而那个视图**不存在**、那些东西在现有任何一条路径上**也不会丢**。
 * 与 T-153 摘掉 `wavesurfer.js` 同一先例（零 import + 已有替代实现）。
 *
 * ⚠️ `serialize/markdown.ts` 的 `toMarkdown()` **保留** —— 它不是 markmap 的一部分，
 * 而是 `GET /api/notes/:uid/export?what=mindmap&format=md` 的实现
 * （`apps/daemon/src/http/rest/content.ts` 的 `exportMindmap()`）。删它会打掉一个真功能。
 *
 * 分层：
 *   types.ts      MindMapDoc schema（唯一事实来源）
 *   validate.ts   校验 + 无损修复（写库前必调；LLM 会生成环和悬空引用）
 *   adapters/     ⇄ mind-elixir（双向）
 *   serialize/    Markdown / OPML / FreeMind 双向
 *   generate.ts   F4：转写稿 → LLM → 导图（LLM 只给段落编号，时间戳由我们算）
 */
export * from './types.js';
export * from './timecode.js';
export * from './validate.js';
export * from './generate.js';
export * from './adapters/mind-elixir.js';
export * from './serialize/index.js';

export const PACKAGE_NAME = '@openmemo/mindmap' as const;
