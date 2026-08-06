import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { surfaceState } from '../../lib/api/surfaces';
import type { NoteDetail } from '../../lib/api/types';
import { useDeleteNoteMutation, useRenameNoteMutation } from './api';

/**
 * 笔记的「重命名 / 删除」入口（T-155）。
 *
 * ## 为什么这个文件到今天才出现
 *
 * 三条 mutation 早就写好了：`useDeleteNoteMutation` / `useRenameNoteMutation`
 * （`features/notes/api.ts`）与 `useMoveNoteMutation`（`features/folders/api.ts`），
 * daemon 侧 `DELETE /api/notes/:uid`（软删除 + `note.deleted` 事件）与
 * `PATCH /api/notes/:uid {title}` 也都是真的。**缺的只有调用方** ——
 * 全仓对这三个 hook 的引用只有「定义」和「`index.ts` 再导出」两处。
 *
 * 连文案都写好了：`notes.rename` 在两份 locale 里躺了很多轮，**零处 `t()` 读它**。
 * （`debt-cleanup` T-152 说过这件事：那 60 条死词条"最大的价值不是删掉，
 * 而是它是一张『哪些功能只写了文案』的地图"。这一条就是照着地图找到的。）
 *
 * 用户侧的后果很直白：**一条笔记建出来就删不掉、改不了名。**
 * 而侧栏的「文件夹」反倒有删除按钮（`FolderTree.tsx:155`）——
 * 同一个页面上，容器能删，里面的东西不能删。
 *
 * ## 为什么不用 `window.confirm`
 *
 * `ComponentsPage` 用的是它，但那条路在这里不合适：
 * jsdom 不实现 `confirm`（调用只打一行 "Not implemented" 并返回 undefined），
 * 于是**组件测试里"点了删除"永远走不到删除那一步**，测试会以"确认框返回假"的名义变绿。
 * 那正是本仓 ⑤A 那一族——一条永远不会失败的断言。
 * 所以确认态做成组件自己的状态：能被真的点开、真的点确认、真的发出请求。
 */
export function NoteActionsMenu({ note }: { note: Pick<NoteDetail, 'uid' | 'title'> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  /** 'menu' = 两个入口；'rename' = 输入框；'delete' = 二次确认。 */
  const [mode, setMode] = useState<'menu' | 'rename' | 'delete'>('menu');
  const [draft, setDraft] = useState(note.title);
  const boxRef = useRef<HTMLSpanElement | null>(null);

  const del = useDeleteNoteMutation();
  const rename = useRenameNoteMutation();

  // daemon 不可达时这两件事都做不成 —— 与其给一个点了没反应的按钮，不如禁用
  // （与 ExportMenu 同一条判断，理由也一样）。
  const live = surfaceState('notes') === 'live';

  const close = () => {
    setOpen(false);
    setMode('menu');
  };

  /*
   * 点菜单外面就收起来。**用 mousedown 不用 click**：
   * click 要等 mouseup，用户在菜单外按下、拖到菜单里松开时收不起来。
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const submitRename = () => {
    const title = draft.trim();
    // 空标题不是"清空标题"，是一次误操作 —— 直接当取消处理，不发请求。
    if (!title || title === note.title) {
      close();
      return;
    }
    rename.mutate({ noteUid: note.uid, title }, { onSettled: close });
  };

  const submitDelete = () => {
    /*
     * 删完**不跳转**。
     *
     * 这是刻意的：本组件同时给详情页和（将来的）列表行用，跳转该由调用方决定。
     * 详情页那边靠 `note.deleted` SSE + 查询失效自然回到"笔记不存在"，
     * 在这里硬写一个 `navigate('/notes')` 会让列表行用它的时候莫名其妙跳走。
     */
    del.mutate(note.uid, { onSettled: close });
  };

  return (
    <span className="relative" ref={boxRef}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setDraft(note.title);
          setMode('menu');
          setOpen((v) => !v);
        }}
        disabled={!live}
        aria-haspopup="menu"
        aria-expanded={open}
        title={live ? undefined : t('notes.exportNeedsDaemon')}
        data-testid="note-actions"
      >
        <MoreHorizontal className="size-3.5" />
        <span className="sr-only">{t('notes.actions')}</span>
      </Button>

      {open ? (
        <div className="absolute right-0 z-40 mt-1 w-64 overflow-hidden rounded-md border border-line bg-surface-2 py-1 shadow-e2">
          {mode === 'menu' ? (
            <ul role="menu">
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setMode('rename')}
                  data-testid="note-rename"
                  className="w-full px-3 py-1.5 text-left text-xs text-ink-secondary hover:bg-fill-hover hover:text-ink"
                >
                  {t('notes.rename')}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setMode('delete')}
                  data-testid="note-delete"
                  className="w-full px-3 py-1.5 text-left text-xs text-critical hover:bg-fill-hover"
                >
                  {t('notes.delete')}
                </button>
              </li>
            </ul>
          ) : null}

          {mode === 'rename' ? (
            <div className="px-3 py-2">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename();
                  if (e.key === 'Escape') close();
                }}
                aria-label={t('notes.rename')}
                data-testid="note-rename-input"
                className="w-full rounded border border-line bg-surface-1 px-2 py-1 text-xs text-ink"
              />
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={close}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" onClick={submitRename} data-testid="note-rename-save">
                  {t('common.confirm')}
                </Button>
              </div>
            </div>
          ) : null}

          {mode === 'delete' ? (
            <div className="px-3 py-2">
              {/*
                说"删除后不可在界面里恢复"而不是"永久删除"：DB 里是软删除（`deleted_at`），
                说成永久是不实；但当前**确实没有任何恢复入口**，说成"可恢复"更糟。
                照实说它现在是什么样。
              */}
              <p className="text-xs text-ink">{t('notes.deleteConfirm', { title: note.title })}</p>
              <p className="mt-1 text-[11px] text-ink-muted">{t('notes.deleteHint')}</p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={close}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" onClick={submitDelete} data-testid="note-delete-confirm">
                  {t('notes.delete')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
