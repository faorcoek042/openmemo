/**
 * @openmemo/mindmap —— 占位骨架（T-011, oss-scout）
 *
 * ⚠️ 只建骨架，实现归 T-023（思维导图生成与编辑）。
 *
 * ADR-002 决策 3 的**硬性要求**：思维导图数据模型必须库无关。
 *   - 本包定义自有 schema（OpenMemo 的唯一导图事实来源）
 *   - `mind-elixir`（主编辑器）与 `markmap`（只读视图）都只是这个 schema 的**消费者**
 *   - 因此本包 **禁止依赖任何渲染库**（package.json 里只有 @openmemo/shared，
 *     这是刻意的约束，不是遗漏 —— 加了渲染库依赖就等于违反 ADR-002 决策 3）
 *   - 适配层方向：schema ⇄ mind-elixir data / schema → markmap markdown /
 *     schema → Markdown · OPML · FreeMind(.mm) · PNG · SVG（R-03 §2 D7）
 */

/** 包标识，供构建产物自检使用。占位实现将被 T-023 替换。 */
export const PACKAGE_NAME = '@openmemo/mindmap' as const;
