import { useState } from 'react';
import { arr } from '../../lib/safe';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';

import { useAddTagMutation, useRemoveTagMutation } from './api';

/**
 * 标签编辑器。
 *
 * 此前标签**只显示不能改** —— `tags` / `note_tags` 表和 API 形状都在，
 * 缺的就是这个入口。章程 F5 要求"标签"，只读的标签等于没有标签。
 */
export function TagEditor({
  noteUid,
  tags,
}: {
  noteUid: string;
  /** 服务端可能不给这个字段 —— 组件自己兜住，不要求调用方保证 */
  tags: readonly { uid: string; name: string; color: string | null }[] | undefined;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const add = useAddTagMutation();
  const remove = useRemoveTagMutation();

  const commit = () => {
    const name = draft.trim();
    setDraft('');
    setAdding(false);
    if (name) add.mutate({ noteUid, name });
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {arr(tags).map((tag) => (
        <span
          key={tag.uid}
          className="group inline-flex items-center gap-1 rounded bg-surface-0 px-1.5 py-0.5 text-xs text-ink-secondary"
        >
          {tag.name}
          <button
            type="button"
            onClick={() => remove.mutate({ noteUid, tagUid: tag.uid })}
            aria-label={t('notes.removeTag', { name: tag.name })}
            className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-critical"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}

      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft('');
              setAdding(false);
            }
          }}
          placeholder={t('notes.newTag')}
          aria-label={t('notes.newTag')}
          className="h-6 w-24 rounded border border-line bg-surface-0 px-1.5 text-xs text-ink"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink-secondary"
        >
          <Plus className="size-3" aria-hidden />
          {t('notes.addTag')}
        </button>
      )}
    </span>
  );
}
