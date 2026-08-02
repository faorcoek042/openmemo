import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Check, Italic, List, ListOrdered, Loader2 } from 'lucide-react';

import { useSaveNoteBodyMutation } from './api';
import { cn } from '../../lib/utils';

/**
 * 笔记正文编辑器（TipTap）。
 *
 * ## 为什么它此前是空白
 *
 * `@tiptap/react` 早在骨架期就装好了，`notes.body_json` / `body_text` 两列也一直在，
 * 但**从来没有人能往里写一个字** —— 详情页那一栏只有一句"待接入"的占位文字。
 * `oss-scout` 同时发现后端也没有写入端点，两边都缺，所以这个字段永远是空的。
 *
 * ## 两个字段各自的用途（D-02 §1.3）
 *
 * | 列 | 存什么 | 为什么要两份 |
 * |---|---|---|
 * | `body_json` | TipTap 的文档 JSON | 保真：格式、层级、将来的时间戳锚点节点 |
 * | `body_text` | 纯文本投影 | **给 FTS5 索引用**。全文检索不可能去解析富文本 JSON |
 *
 * 所以保存时**两份一起送**，由前端做投影 —— 服务端不该为了建索引去装一个 TipTap。
 */
export function NoteEditor({
  noteUid,
  initialJson,
  editable = true,
}: {
  noteUid: string;
  initialJson: unknown;
  editable?: boolean;
}) {
  const { t } = useTranslation();
  const save = useSaveNoteBodyMutation(noteUid);
  const [dirty, setDirty] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [StarterKit],
    content: (initialJson as object) ?? '',
    editable,
    editorProps: {
      attributes: {
        class:
          'prose-sm max-w-none focus:outline-none min-h-[8rem] text-sm text-ink [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
        'aria-label': t('detail.tabs.notes'),
      },
    },
    onUpdate: ({ editor: ed }) => {
      setDirty(true);
      if (timer.current) clearTimeout(timer.current);
      // 自动保存：打字是高频操作，每次击键都发请求既浪费也会让撤销栈错乱
      timer.current = setTimeout(() => {
        save.mutate(
          { bodyJson: ed.getJSON(), bodyText: ed.getText() },
          { onSuccess: () => setDirty(false) },
        );
      }, 800);
    },
  });

  // 卸载前把未落盘的改动补一刀，避免"切走就丢"
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!editor) return <p className="text-sm text-ink-muted">{t('common.loading')}</p>;

  return (
    <div className="flex h-full flex-col">
      {editable ? (
        <div className="mb-2 flex items-center gap-1 border-b border-line pb-2">
          <ToolbarButton
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
            label={t('editor.bold')}
          >
            <Bold className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            label={t('editor.italic')}
          >
            <Italic className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            label={t('editor.bulletList')}
          >
            <List className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            label={t('editor.orderedList')}
          >
            <ListOrdered className="size-3.5" />
          </ToolbarButton>

          {/* 保存态要可见：自动保存最怕的就是用户不知道存没存 */}
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-ink-muted">
            {save.isPending ? (
              <>
                <Loader2 className="size-3 animate-spin" aria-hidden />
                {t('editor.saving')}
              </>
            ) : dirty ? (
              t('editor.unsaved')
            ) : (
              <>
                <Check className="size-3 text-good" aria-hidden />
                {t('editor.saved')}
              </>
            )}
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'rounded p-1 transition-colors',
        active ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}
