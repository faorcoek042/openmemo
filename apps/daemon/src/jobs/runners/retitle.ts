/**
 * 「转写完能不能改笔记标题」的判定。
 *
 * 抽成纯函数是为了**能被测试锁住** —— 这条规则管的是用户数据是否被静默改写，
 * 出错时没有任何报错信号，只能靠测试守。
 */
import { basename } from 'node:path';

export interface RetitleInput {
  /** `notes.kind`：录音笔记一律不覆盖。 */
  readonly noteKind: string;
  readonly currentTitle: string;
  /** 导入时的原始输入（本地绝对路径或 URL）。 */
  readonly input: string;
  /** 媒体元数据里的标题（ffprobe / yt-dlp 给的）。 */
  readonly mediaTitle: string | null | undefined;
}

/** 导入时用的占位标题：原始输入的 basename（URL 先去掉 query/fragment）。 */
export function placeholderTitleOf(input: string): string {
  const cleaned = input.split(/[?#]/)[0] ?? input;
  return basename(cleaned);
}

/**
 * 只有当标题仍是**导入时的占位值**（或为空）时，才允许用媒体标题替换。
 *
 * 之前这里是无条件覆盖，后果：
 *   - F3 录音笔记（用户传了 title）转写完变成了 recordingUid
 *   - 用户重命名过的笔记，离线重跑后被改回文件名
 */
export function mayRetitleNote(p: RetitleInput): boolean {
  if (p.noteKind === 'recording') return false;
  if (!p.mediaTitle || !p.mediaTitle.trim()) return false;
  const current = p.currentTitle.trim();
  if (current === '') return true;
  return current === placeholderTitleOf(p.input);
}
