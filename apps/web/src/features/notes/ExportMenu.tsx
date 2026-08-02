import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { timecodeFull } from '../../lib/format/time';
import type { NoteDetail } from '../../lib/api/types';
import type { TranscriptSegmentDto } from '../../lib/events/types';

/**
 * 笔记导出（此前**零入口**）。
 *
 * ## 为什么在前端生成而不是调服务端
 *
 * TXT / Markdown / SRT / VTT / JSON 这五种都只是**已在内存里的数据的重排**——
 * 转写稿、标题、摘要前端全都有。为它们各开一个服务端端点，等于把同一份数据
 * 再跑一趟网络、再写一套序列化，还多一个"服务端版本和前端显示不一致"的失配面。
 *
 * 真正需要服务端的是 **DOCX / PDF / 烧字幕**（要排版引擎或 ffmpeg），
 * 那些留给后端，这里不假装能做。
 *
 * ## 时间码用整数毫秒转换
 *
 * `timecodeFull` 从整数毫秒生成 `HH:MM:SS.mmm`，**不经过浮点秒**——
 * 这正是 D-02 §1.1 坚持整数毫秒的直接收益：字幕不会因为累积误差而越走越偏。
 */

export type ExportFormat = 'txt' | 'md' | 'srt' | 'vtt' | 'json';

const FORMATS: { id: ExportFormat; mime: string; ext: string }[] = [
  { id: 'txt', mime: 'text/plain;charset=utf-8', ext: 'txt' },
  { id: 'md', mime: 'text/markdown;charset=utf-8', ext: 'md' },
  { id: 'srt', mime: 'application/x-subrip;charset=utf-8', ext: 'srt' },
  { id: 'vtt', mime: 'text/vtt;charset=utf-8', ext: 'vtt' },
  { id: 'json', mime: 'application/json;charset=utf-8', ext: 'json' },
];

/** 文件名安全化：用户标题绝不能直接当文件名（同 D-01 §8.5 的原则）。 */
function safeName(title: string): string {
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
  return cleaned || 'note';
}

export function buildExport(
  note: NoteDetail,
  segments: readonly TranscriptSegmentDto[],
  format: ExportFormat,
  speakerNames: Record<string, string> = {},
): string {
  const speaker = (s: TranscriptSegmentDto) =>
    s.speakerLabel ? (speakerNames[s.speakerLabel] ?? s.speakerLabel) : null;

  switch (format) {
    case 'txt':
      return [
        note.title,
        '',
        ...segments.map((s) => {
          const who = speaker(s);
          return `[${timecodeFull(s.startMs).slice(0, 8)}]${who ? ` ${who}:` : ''} ${s.text}`;
        }),
      ].join('\n');

    case 'md': {
      const lines = [`# ${note.title}`, ''];
      if (note.summaryMd) lines.push('## 摘要', '', note.summaryMd, '');
      if (note.bodyText) lines.push('## 笔记', '', note.bodyText, '');
      lines.push('## 转写稿', '');
      for (const s of segments) {
        const who = speaker(s);
        lines.push(`- \`${timecodeFull(s.startMs).slice(0, 8)}\`${who ? ` **${who}**：` : ' '}${s.text}`);
      }
      return lines.join('\n');
    }

    case 'srt':
      return segments
        .map((s, i) => {
          const from = timecodeFull(s.startMs).replace('.', ',');
          const to = timecodeFull(s.endMs).replace('.', ',');
          return `${i + 1}\n${from} --> ${to}\n${s.text}\n`;
        })
        .join('\n');

    case 'vtt':
      return [
        'WEBVTT',
        '',
        ...segments.map((s) => `${timecodeFull(s.startMs)} --> ${timecodeFull(s.endMs)}\n${s.text}\n`),
      ].join('\n');

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

export function ExportMenu({
  note,
  segments,
  speakerNames,
}: {
  note: NoteDetail;
  segments: readonly TranscriptSegmentDto[];
  speakerNames?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = (format: ExportFormat) => {
    setBusy(true);
    try {
      const spec = FORMATS.find((f) => f.id === format)!;
      const blob = new Blob([buildExport(note, segments, format, speakerNames ?? {})], {
        type: spec.mime,
      });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeName(note.title)}.${spec.ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const disabled = segments.length === 0 && !note.bodyText && !note.summaryMd;

  return (
    <span className="relative">
      <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} disabled={disabled || busy}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        {t('notes.export')}
      </Button>

      {open ? (
        <ul
          className="absolute right-0 z-40 mt-1 w-40 overflow-hidden rounded-md border border-line bg-surface-2 py-1 shadow-e2"
          role="menu"
        >
          {FORMATS.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                role="menuitem"
                onClick={() => run(f.id)}
                className="w-full px-3 py-1.5 text-left text-xs text-ink-secondary hover:bg-surface-1 hover:text-ink"
              >
                {t(`notes.exportFormats.${f.id}`)}
              </button>
            </li>
          ))}
          {/* 需要排版引擎/ffmpeg 的格式不在前端假装能做 */}
          <li className="border-t border-line px-3 py-1.5 text-xs text-ink-muted">
            {t('notes.exportServerOnly')}
          </li>
        </ul>
      ) : null}
    </span>
  );
}
