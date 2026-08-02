import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';

export interface FolderDto {
  uid: string;
  name: string;
  parentUid: string | null;
  color: string | null;
  noteCount: number;
}

/** 树节点：由扁平列表在前端组装（服务端不必关心展示形状）。 */
export interface FolderNode extends FolderDto {
  children: FolderNode[];
  depth: number;
}

export function useFoldersQuery() {
  return useQuery({
    queryKey: qk.folders,
    queryFn: () => api<{ folders: FolderDto[] }>('notes', '/folders'),
    select: (d) => buildTree(d.folders),
  });
}

/**
 * 扁平 → 树。
 *
 * **必须防环**：`parentUid` 指回自己的祖先会让递归栈溢出。
 * D-02 §1.3 要求写入时做环检测，但前端不能假设服务端一定做对了 ——
 * 一个坏数据不该让整个侧栏白屏。
 */
export function buildTree(flat: readonly FolderDto[]): FolderNode[] {
  const byUid = new Map<string, FolderNode>();
  for (const f of flat) byUid.set(f.uid, { ...f, children: [], depth: 0 });

  const roots: FolderNode[] = [];
  for (const node of byUid.values()) {
    if (!node.parentUid) {
      roots.push(node);
      continue;
    }
    const parent = byUid.get(node.parentUid);
    // 父不存在，或指向自己 → 当作根，不丢数据也不炸
    if (!parent || parent.uid === node.uid) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const seen = new Set<string>();
  const assignDepth = (nodes: FolderNode[], depth: number): FolderNode[] =>
    nodes
      .filter((n) => !seen.has(n.uid) && (seen.add(n.uid), true))
      .map((n) => ({
        ...n,
        depth,
        // 深度上限 8（D-02 §1.3），超过就不再展开 —— 环的最后一道保险
        children: depth < 8 ? assignDepth(n.children, depth + 1) : [],
      }));

  return assignDepth(roots, 0);
}

export function useCreateFolderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; parentUid?: string | null }) =>
      api<FolderDto>('notes', '/folders', { method: 'POST', body: v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.folders }),
  });
}

export function useRenameFolderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { uid: string; name: string }) =>
      api<{ ok: true }>('notes', `/folders/${v.uid}`, { method: 'PATCH', body: { name: v.name } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.folders }),
  });
}

export function useDeleteFolderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uid: string) => api<{ ok: true }>('notes', `/folders/${uid}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.folders });
      // 删文件夹会把里面的笔记移到"未分类"，列表也要刷
      void qc.invalidateQueries({ queryKey: qk.notes.all });
    },
  });
}

/** 把笔记移到某个文件夹（`null` = 移出到未分类）。 */
export function useMoveNoteMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { noteUid: string; folderUid: string | null }) =>
      api<{ ok: true }>('notes', `/notes/${v.noteUid}`, {
        method: 'PATCH',
        body: { folderUid: v.folderUid },
      }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: qk.notes.detail(v.noteUid) });
      void qc.invalidateQueries({ queryKey: qk.notes.all });
      void qc.invalidateQueries({ queryKey: qk.folders });
    },
  });
}
