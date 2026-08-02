/**
 * @openmemo/mindmap —— 库无关的思维导图数据层（T-023, oss-scout）
 *
 * **ADR-002 决策 3 硬性要求**：数据模型必须库无关。
 * mind-elixir（主编辑器）与 markmap（只读视图）都只是这个 schema 的**消费者**。
 *
 * 本包**不依赖任何渲染库** —— 适配器只做纯数据形状转换，
 * 因此可以在 Node 里单测、不需要 DOM。真正 `new MindElixir()` 的地方在 `apps/web`。
 *
 * 分层：
 *   types.ts      MindMapDoc schema（唯一事实来源）
 *   validate.ts   校验 + 无损修复（写库前必调；LLM 会生成环和悬空引用）
 *   adapters/     ⇄ mind-elixir（双向）、→ markmap（只读，直构 IPureNode 不走 Markdown）
 *   serialize/    Markdown / OPML / FreeMind 双向
 *   generate.ts   F4：转写稿 → LLM → 导图（LLM 只给段落编号，时间戳由我们算）
 */
export * from './types.js';
export * from './validate.js';
export * from './generate.js';
export * from './adapters/mind-elixir.js';
export * from './adapters/markmap.js';
export * from './serialize/index.js';

export const PACKAGE_NAME = '@openmemo/mindmap' as const;
