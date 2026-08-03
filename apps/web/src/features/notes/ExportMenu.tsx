import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { surfaceState } from '../../lib/api/surfaces';
import type { NoteDetail } from '../../lib/api/types';

/**
 * 笔记导出入口。
 *
 * ## 为什么这里只剩一个薄调用
 *
 * 我最初在前端实现了一整套导出（TXT/MD/SRT/VTT/JSON + 27 个测试），
 * 后来服务端也实现了同样五种格式。**两份实现会漂移，而字幕格式漂移用户在播放器里才发现** ——
 * 所以裁决是删掉前端那份，只保留服务端。
 *
 * 我原来给前端那份的理由是"daemon 没起时的离线兜底"，这个理由站不住：
 * **daemon 就是这个产品**，它不在的时候网页根本打不开，所谓离线场景不存在。
 *
 * 那 27 个测试没有跟着消失 —— 它们迁到了
 * `apps/daemon/src/http/rest/content.export.test.ts`，
 * 并且**当场逮到服务端三个同类 bug**（NaN 时间码 / 空行劈开条目 / 空正文条目）。
 *
 * 服务端那份还多两样前端给不了的：完整数据（不受前端分页影响）、
 * 以及带 RFC 5987 `filename*` 的 `Content-Disposition`（中文文件名不会变成下划线）。
 */

export type ExportFormat = 'txt' | 'md' | 'srt' | 'vtt' | 'json';

const FORMATS: ExportFormat[] = ['txt', 'md', 'srt', 'vtt', 'json'];

export function ExportMenu({ note }: { note: Pick<NoteDetail, 'uid' | 'title'> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // daemon 不可达时导出无从谈起 —— 与其给一个点了没反应的按钮，不如禁用并说明
  const live = surfaceState('notes') === 'live';

  const run = (format: ExportFormat) => {
    // 交给浏览器处理下载，保留服务端给的文件名与 MIME
    const a = document.createElement('a');
    a.href = `/api/notes/${encodeURIComponent(note.uid)}/export?format=${format}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setOpen(false);
  };

  return (
    <span className="relative">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        disabled={!live}
        title={live ? undefined : t('notes.exportNeedsDaemon')}
      >
        <Download className="size-3.5" />
        {t('notes.export')}
      </Button>

      {open ? (
        <ul
          className="absolute right-0 z-40 mt-1 w-40 overflow-hidden rounded-md border border-line bg-surface-2 py-1 shadow-e2"
          role="menu"
        >
          {FORMATS.map((f) => (
            <li key={f}>
              <button
                type="button"
                role="menuitem"
                onClick={() => run(f)}
                className="w-full px-3 py-1.5 text-left text-xs text-ink-secondary hover:bg-fill-hover hover:text-ink"
              >
                {t(`notes.exportFormats.${f}`)}
              </button>
            </li>
          ))}
          {/* 需要排版引擎/ffmpeg 的格式不在这里假装能做 */}
          <li className="border-t border-line px-3 py-1.5 text-xs text-ink-muted">
            {t('notes.exportServerOnly')}
          </li>
        </ul>
      ) : null}
    </span>
  );
}
