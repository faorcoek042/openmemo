/**
 * feature 的**公开出口**（D-05 §3.1）。
 *
 * 其它 feature 只能从这里 import，**禁止深入到内部文件**
 * （`../transcript/TranscriptList` 会被 eslint 拦下，`../transcript` 放行）。
 * 这样内部结构可以随便重构，只要这个门面不变，别人就不会被打断。
 */
export { TranscriptList } from './TranscriptList';
export { WordLevelBadge } from './WordLevelBadge';
export { SegmentRow } from './SegmentRow';
export { useEditSegmentMutation, useRevertSegmentMutation, isEdited } from './api';
