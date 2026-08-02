import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { EXPORT_FORMATS, buildExport, safeName, type ExportFormat } from './export';
import { surfaceState } from '../../lib/api/surfaces';
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

  /**
   * 优先走服务端导出，接不通才用前端生成。
   *
   * daemon 落地了 `GET /api/notes/:uid/export?format=` 之后，服务端版本更权威：
   * 它握有完整数据（不受前端分页/懒加载影响），并且能给出正确的
   * `Content-Disposition`（含 RFC 5987 的 `filename*`，中文文件名不会变成下划线）。
   * 实测响应头：`Content-Type: application/x-subrip; charset=utf-8` +
   * `filename*=UTF-8''T-038%20%E4%B8%AD%E6%96%87…`。
   *
   * 前端那份（`export.ts`，27 个测试）保留为**离线兜底**：daemon 没起时仍能导出。
   * 两份实现是重复的 —— 这是我先做、服务端后做造成的。**如实记在 inbox，等 Manager 裁决留哪份。**
   */
  const run = (format: ExportFormat) => {
    setBusy(true);
    try {
      if (surfaceState('notes') === 'live') {
        // 让浏览器自己处理下载（保留服务端给的文件名与 MIME）
        const a = document.createElement('a');
        a.href = `/api/notes/${encodeURIComponent(note.uid)}/export?format=${format}`;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }

      const spec = EXPORT_FORMATS.find((f) => f.id === format)!;
      const blob = new Blob([buildExport({ note, segments, speakerNames: speakerNames ?? {} }, format)], {
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
          {EXPORT_FORMATS.map((f) => (
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
