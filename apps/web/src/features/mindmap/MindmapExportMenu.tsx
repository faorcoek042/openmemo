import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { surfaceState } from '../../lib/api/surfaces';
import type { ImageFormat } from './export';

/**
 * 思维导图导出入口。
 *
 * ## 为什么要有这个文件（它接的是什么）
 *
 * `GET /api/notes/:uid/export?what=mindmap&format=md|opml|mm|json` **服务端早就实现了**
 * （`apps/daemon/src/http/rest/content.ts:386` 的 mindmap 分支 + `exportMindmap()`），
 * 而在这个文件出现之前，**全 `apps/web/src` 搜 `what=mindmap` 的命中数是 0** ——
 * 唯一的导出调用点 `features/notes/ExportMenu.tsx:43` 只发 `?format=`、从不发 `what=`，
 * 于是那四种格式对用户**不存在**。写了、序列化器也测了、点不到。
 *
 * 这同时是我们在导图能力上**唯一结构性超过 memo.ac 的地方**：它是 markmap（节点不可编辑）
 * 且导出走 `html2canvas` 位图；我们是 mind-elixir（节点级可编辑）+ 矢量 SVG + 这四种结构化格式。
 *
 * ## 为什么图片与结构化格式合成**一个**菜单
 *
 * 这里原来是工具栏上两个平铺按钮（SVG / PNG）。再平铺四个 = 八个按钮挤在 420px 的侧栏里，
 * 而且**六种格式之间的差别没有地方可写**。菜单换来的正是那个位置：分两组 + 一句损耗说明。
 *
 * ## 为什么只禁用后半组
 *
 * SVG / PNG 由渲染器在浏览器里现画，daemon 不在也能出图；
 * 四种结构化格式是**服务端**产出的，daemon 不可达时只能禁用并说明 ——
 * 与 `notes/ExportMenu.tsx` 同一条判据：不给点了没反应的按钮。
 *
 * ## `<a href>` 而不是 `fetch` + Blob
 *
 * 服务端已经带了 `Content-Disposition: attachment` 与 RFC 5987 的 `filename*`
 * （中文标题不会退化成下划线，`[实测]` 见回执）。走原生链接就能原样拿到那个文件名；
 * 自己 fetch 再造 Blob 反而要把文件名逻辑在前端重写一遍 —— 那正是当年前端导出被删掉的原因。
 * 刻意**不加** `download` 属性：给了它就会用 URL 末段当文件名，把服务端那个正确的名字盖掉。
 */

/** 服务端产出的结构化格式。值即 `?format=` 的取值（`content.ts:424` 的 switch）。 */
type ServerFormat = 'md' | 'opml' | 'mm' | 'json';

const SERVER_FORMATS: readonly ServerFormat[] = ['md', 'opml', 'mm', 'json'];
const IMAGE_FORMATS: readonly ImageFormat[] = ['svg', 'png'];

function exportHref(noteUid: string, format: ServerFormat): string {
  return `/api/notes/${encodeURIComponent(noteUid)}/export?what=mindmap&format=${format}`;
}

export function MindmapExportMenu({
  noteUid,
  onExportImage,
  disabled = false,
}: {
  noteUid: string;
  /** 图片导出要拿渲染器实例，那是 `MindmapView` 的私有物 —— 这里只收一个回调，
   *  本文件因此对 mind-elixir 零依赖（库无关性守在 `MindmapView` 一处）。 */
  onExportImage: (format: ImageFormat) => void;
  /** 渲染器还没就绪 —— 此时画布是空的，导出会得到一张白图。 */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // 四种结构化格式是 daemon 产出的；daemon 不可达时它们点了也只会失败
  const live = surfaceState('notes') === 'live';

  return (
    <span className="relative">
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Download className="size-3.5" />
        {t('mindmap.export')}
      </Button>

      {open ? (
        <ul
          className="absolute left-0 z-40 mt-1 w-64 overflow-hidden rounded-md border border-line bg-surface-2 py-1 shadow-e2"
          role="menu"
        >
          <li className="px-3 pt-1 pb-0.5 text-[11px] text-ink-muted">
            {t('mindmap.exportImageGroup')}
          </li>
          {IMAGE_FORMATS.map((f) => (
            <li key={f}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onExportImage(f);
                  setOpen(false);
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-ink-secondary hover:bg-fill-hover hover:text-ink"
              >
                {t(`mindmap.exportFormats.${f}`)}
              </button>
            </li>
          ))}

          <li className="mt-1 border-t border-line px-3 pt-1.5 pb-0.5 text-[11px] text-ink-muted">
            {t('mindmap.exportDataGroup')}
          </li>
          {SERVER_FORMATS.map((f) => (
            <li key={f}>
              {live ? (
                <a
                  role="menuitem"
                  href={exportHref(noteUid, f)}
                  rel="noopener"
                  onClick={() => setOpen(false)}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink-secondary hover:bg-fill-hover hover:text-ink"
                >
                  {t(`mindmap.exportFormats.${f}`)}
                </a>
              ) : (
                <span
                  role="menuitem"
                  aria-disabled="true"
                  title={t('mindmap.exportNeedsDaemon')}
                  className="block w-full cursor-not-allowed px-3 py-1.5 text-left text-xs text-ink-muted opacity-60"
                >
                  {t(`mindmap.exportFormats.${f}`)}
                </span>
              )}
            </li>
          ))}

          {/*
            ★ 这一句是**实测出来的**，不是照着文档写的（取证见 `coordination/inbox/ui-backlog.md`）：
            拿一份带关联线 / 概要 / 备注 / 样式 / 图标 / 超链接 / 时间戳的文档过一遍四个序列化器，
            逐项数保留与丢失。结论：JSON 十项全保留；md 只保留时间戳与备注；
            opml 只保留备注与折叠态；mm 保留备注与一条无标签的 arrowlink。
            **时间戳只有 md 和 json 有** —— 而时间戳正是这张图与录音之间唯一的连接，
            用户拿 OPML 导进别的软件后再也跳不回那一秒，界面此前对此一个字都不说。
          */}
          <li className="mt-1 border-t border-line px-3 py-1.5 text-[11px] leading-relaxed text-ink-muted">
            {t('mindmap.exportLossy')}
          </li>
        </ul>
      ) : null}
    </span>
  );
}
