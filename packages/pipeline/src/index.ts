/**
 * @openmemo/pipeline —— 占位骨架（T-011, oss-scout）
 *
 * ⚠️ 只建骨架，实现归 T-020（转写流水线）。
 *
 * 依赖说明（每一项都对应一条 ADR，改动前先读）：
 *   - `ffmpeg-static`   GPL-3.0 —— ADR-002 v2 明确允许（仅个人自用）。
 *                       用法必须是 **CLI 子进程**（ADR-003 决策 1），不得链接 libav*。
 *   - `youtube-dl-exec` MIT 包装器；postinstall 拉 yt-dlp 官方二进制（GPLv3+）。
 *                       ADR-002 v2「F1 直接内置 yt-dlp」。
 *
 * ⚠️ **可替换性是硬性设计要求**（ADR-002 v2 升级路径）：
 *    这两个 GPL 组件必须藏在适配层后面。若日后恢复商用意图，
 *    要能只换适配层实现（FFmpeg → 自建 LGPL 构建；yt-dlp → 可选插件），
 *    业务代码零改动。禁止把 ffmpeg / yt-dlp 的 API 泄漏到上层。
 */

/** 包标识，供构建产物自检使用。占位实现将被 T-020 替换。 */
export const PACKAGE_NAME = '@openmemo/pipeline' as const;
