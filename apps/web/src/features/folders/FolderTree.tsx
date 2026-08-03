import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FolderPlus, Trash2 } from 'lucide-react';

import {
  useCreateFolderMutation,
  useDeleteFolderMutation,
  useFoldersQuery,
  type FolderNode,
} from './api';
import { activeNavTarget, NAV_FILTER_KEYS } from '../../lib/nav/activeNav';
import { cn } from '../../lib/utils';

/**
 * 侧栏文件夹树。
 *
 * 此前这里是**静态占位**：写着"文件夹 ▸ 课程 / 播客"，但既不是真数据，
 * 也不能新建/移动/删除。`folders` 表（自引用树）一直都在，缺的是这个入口 ——
 * 与标签/星标同一类问题。
 */
export function FolderTree() {
  const { t } = useTranslation();
  const { data: tree, isLoading } = useFoldersQuery();
  const create = useCreateFolderMutation();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const name = draft.trim();
    setDraft('');
    setAdding(false);
    if (name) create.mutate({ name, parentUid: null });
  };

  return (
    <div>
      <div className="flex items-center justify-between px-2.5 py-1">
        <span className="text-xs font-medium text-ink-muted">{t('nav.folders')}</span>
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label={t('folders.create')}
          className="rounded p-0.5 text-ink-muted hover:bg-fill-hover hover:text-ink"
        >
          <FolderPlus className="size-3.5" aria-hidden />
        </button>
      </div>

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
          placeholder={t('folders.name')}
          aria-label={t('folders.name')}
          className="mx-2.5 mb-1 h-6 w-[calc(100%-1.25rem)] rounded border border-line bg-surface-0 px-1.5 text-xs text-ink"
        />
      ) : null}

      {isLoading ? (
        <p className="px-2.5 py-1 text-xs text-ink-muted">{t('common.loading')}</p>
      ) : !tree || tree.length === 0 ? (
        <p className="px-2.5 py-1 text-xs text-ink-muted">{t('folders.empty')}</p>
      ) : (
        <ul role="list">
          {tree.map((node) => (
            <FolderRow key={node.uid} node={node} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 文件夹的地址。**只在这一处拼**，判定与渲染共用同一个字符串。 */
export function folderTo(uid: string): string {
  return `/notes?folder=${encodeURIComponent(uid)}`;
}

function FolderRow({ node }: { node: FolderNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [expanded, setExpanded] = useState(true);
  const del = useDeleteFolderMutation();
  const hasChildren = node.children.length > 0;

  /*
   * 与侧栏共用 `activeNavTarget`：清单里只放**这一条**文件夹地址，
   * 命中即当前页。`NAV_FILTER_KEYS` 也传过去，两边用的是同一份键名 ——
   * 否则「至多一项高亮」会在两个组件之间的缝里漏掉。
   */
  const to = folderTo(node.uid);
  const active = activeNavTarget([to], location, NAV_FILTER_KEYS) === to;

  return (
    <li>
      <div
        className="group flex items-center gap-1 rounded-md pr-1 hover:bg-fill-hover"
        style={{ paddingLeft: `${node.depth * 12 + 6}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn('rounded p-0.5 text-ink-muted', !hasChildren && 'invisible')}
          aria-label={expanded ? t('folders.collapse') : t('folders.expand')}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>

        {/*
          ★ 文件夹是**筛选视图**，判据与侧栏「星标」完全同一条（T-138c）。

          此前这里是 `NavLink` + 裸 `isActive`。`isActive` **只比 pathname**，
          而所有文件夹的 pathname 都是 `/notes` —— 于是 `[实测]`
          **每个文件夹在每个 `/notes*` 地址上都被标成「当前页」**，
          包括 `/notes?starred=1` 这种一个文件夹都没选中的地方。
          视觉上它只是 `text-ink` 与 `text-ink-secondary` 的差别，不如侧栏刺眼；
          `aria-current` 那一面则是实打实错的，而且**没有人看得见**。

          判据：**筛选不向成员延伸** —— 只在地址完全相同时才是当前页。
          `Link` 而不是 `NavLink`：后者会自己按 `isActive` 写 `aria-current`，
          外面传的只能改取值、关不掉（T-138b 在侧栏踩过同一脚）。
        */}
        <Link
          to={to}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'min-w-0 flex-1 truncate py-1 text-sm',
            active ? 'text-ink' : 'text-ink-secondary',
          )}
        >
          {node.name}
          {node.noteCount > 0 ? (
            <span className="ml-1 text-xs text-ink-muted">{node.noteCount}</span>
          ) : null}
        </Link>

        <button
          type="button"
          onClick={() => del.mutate(node.uid)}
          aria-label={t('folders.delete', { name: node.name })}
          title={t('folders.deleteHint')}
          className="rounded p-0.5 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-critical"
        >
          <Trash2 className="size-3" aria-hidden />
        </button>
      </div>

      {expanded && hasChildren ? (
        <ul role="list">
          {node.children.map((child) => (
            <FolderRow key={child.uid} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
