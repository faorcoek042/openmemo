import { timecodeFull } from '../../lib/format/time';
import type { NoteDetail } from '../../lib/api/types';
import type { TranscriptSegmentDto } from '../../lib/events/types';

/**
 * 笔记导出的**纯逻辑**（与 React 组件分离，便于直接测试）。
 *
 * 拆出来的直接原因：字幕格式是**用户会拿去导入别的软件**的产物 ——
 * 格式错了在我们这儿看不出来、在播放器里才炸。这类东西不能只有"代码审查级保证"。
 *
 * ## SRT 与 VTT 的分隔符不是同一个（最容易搞混的一处）
 *
 * | 格式 | 毫秒分隔符 | 例 |
 * |---|---|---|
 * | SRT  | **逗号** `,` | `00:01:23,456 --> 00:01:25,000` |
 * | WebVTT | **小数点** `.` | `00:01:23.456 --> 00:01:25.000` |
 *
 * 写反了大多数播放器会静默忽略整个字幕文件（不报错，就是不显示）。
 */

export type ExportFormat = 'txt' | 'md' | 'srt' | 'vtt' | 'json';

export const EXPORT_FORMATS: { id: ExportFormat; mime: string; ext: string }[] = [
  { id: 'txt', mime: 'text/plain;charset=utf-8', ext: 'txt' },
  { id: 'md', mime: 'text/markdown;charset=utf-8', ext: 'md' },
  { id: 'srt', mime: 'application/x-subrip;charset=utf-8', ext: 'srt' },
  { id: 'vtt', mime: 'text/vtt;charset=utf-8', ext: 'vtt' },
  { id: 'json', mime: 'application/json;charset=utf-8', ext: 'json' },
];

/** 文件名安全化：用户标题绝不能直接当文件名（同 D-01 §8.5 的原则）。 */
export function safeName(title: string, fallback = 'note'): string {
  const cleaned = Array.from(title)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c > 0x1f && c !== 0x7f;
    })
    .join('')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/** SRT 时间码：`HH:MM:SS,mmm`（逗号）。 */
export function srtTime(ms: number): string {
  return timecodeFull(ms).replace('.', ',');
}

/** WebVTT 时间码：`HH:MM:SS.mmm`（小数点）。 */
export function vttTime(ms: number): string {
  return timecodeFull(ms);
}

/**
 * 字幕文本清洗。
 *
 * SRT/VTT 用**空行分隔条目**，所以正文里出现空行会把一条字幕劈成两条 ——
 * 后面的全部错位。必须把连续换行压成单个换行。
 * VTT 还要额外处理 `-->`：它是时间轴行的标记，出现在正文里会让解析器误判。
 */
export function sanitizeCueText(text: string, format: 'srt' | 'vtt'): string {
  let out = text
    .replace(/\r\n?/g, '\n') // 统一换行，避免 CRLF 混入
    .replace(/\n{2,}/g, '\n') // 空行会劈开字幕条目
    .trim();
  if (format === 'vtt') out = out.replace(/-->/g, '→');
  return out;
}

export interface BuildExportInput {
  note: Pick<NoteDetail, 'title' | 'durationMs' | 'language' | 'summaryMd' | 'bodyText'>;
  segments: readonly TranscriptSegmentDto[];
  speakerNames?: Record<string, string>;
}

export function buildExport(input: BuildExportInput, format: ExportFormat): string {
  const { note, segments, speakerNames = {} } = input;
  const speaker = (s: TranscriptSegmentDto) =>
    s.speakerLabel ? (speakerNames[s.speakerLabel] ?? s.speakerLabel) : null;

  switch (format) {
    case 'txt': {
      const lines = [note.title, ''];
      for (const s of segments) {
        const who = speaker(s);
        lines.push(`[${timecodeFull(s.startMs).slice(0, 8)}]${who ? ` ${who}:` : ''} ${s.text}`);
      }
      return lines.join('\n');
    }

    case 'md': {
      const lines = [`# ${note.title}`, ''];
      if (note.summaryMd) lines.push('## 摘要', '', note.summaryMd, '');
      if (note.bodyText) lines.push('## 笔记', '', note.bodyText, '');
      if (segments.length > 0) {
        lines.push('## 转写稿', '');
        for (const s of segments) {
          const who = speaker(s);
          lines.push(
            `- \`${timecodeFull(s.startMs).slice(0, 8)}\`${who ? ` **${who}**：` : ' '}${s.text}`,
          );
        }
      }
      return lines.join('\n');
    }

    case 'srt': {
      // 空文本的段落必须跳过：SRT 里一条没有正文的条目会让部分解析器直接放弃整个文件
      const usable = segments.filter((s) => sanitizeCueText(s.text, 'srt').length > 0);
      return usable
        .map((s, i) => {
          // 序号必须连续从 1 开始 —— 跳号同样会让某些播放器停在跳号处
          const body = sanitizeCueText(s.text, 'srt');
          return `${i + 1}\n${srtTime(s.startMs)} --> ${srtTime(s.endMs)}\n${body}\n`;
        })
        .join('\n');
    }

    case 'vtt': {
      const usable = segments.filter((s) => sanitizeCueText(s.text, 'vtt').length > 0);
      const cues = usable.map(
        (s) => `${vttTime(s.startMs)} --> ${vttTime(s.endMs)}\n${sanitizeCueText(s.text, 'vtt')}\n`,
      );
      // WEBVTT 头之后必须有一个空行，否则第一条 cue 会被吞掉
      return ['WEBVTT', '', ...cues].join('\n');
    }

    case 'json':
      return JSON.stringify(
        {
          title: note.title,
          durationMs: note.durationMs,
          language: note.language,
          summaryMd: note.summaryMd,
          bodyText: note.bodyText,
          segments,
        },
        null,
        2,
      );
  }
}
