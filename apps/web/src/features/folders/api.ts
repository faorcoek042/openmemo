import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';

export interface FolderDto {
  uid: string;
  name: string;
  parentUid: string | null;
  color: string | null;
  /** 服务端实际还会给 sortOrder / icon —— 前端不用，但不要因为多字段而校验失败 */
  sortOrder?: number;
  icon?: string | null;
  noteCount: number;
}

/** 树节点：由扁平列表在前端组装（服务端不必关心展示形状）。 */
export interface FolderNode extends FolderDto {
  children: FolderNode[];
  /** 展示用缩进层级。服务端不下发，由前端补（见 `withDepth`）。 */
  depth: number;
}

/**
 * ⚠️ **契约订正（T-039 实测发现）**
 *
 * 我最初按"服务端给扁平列表、前端组装成树"写，返回类型写的是 `{folders: FolderDto[]}`。
 * 实际打 daemon（`GET /api/folders`，2026-08-03 实测）返回的是**已经建好的树数组**：
 * `[{uid,name,parentUid,sortOrder,color,icon,noteCount,children:[]}]`。
 *
 * 后果本来会很难看：`d.folders` 是 `undefined` → `buildTree(undefined)` →
 * `for (const f of flat)` 抛 TypeError → **整个侧栏白屏**。
 * 讽刺的是我当初特意给 `buildTree` 加了防环保护、理由正是"一条坏数据不该让侧栏白屏"，
 * 却没防住**形状本身不对**这种情况 —— 防御写在了错误的层级。
 *
 * 现在：直接消费服务端的树；`buildTree` 仅在拿到扁平数组时作为兼容路径。
 */
export function useFoldersQuery() {
  return useQuery({
    queryKey: qk.folders,
    queryFn: () => api<FolderNode[] | { folders: FolderDto[] }>('notes', '/folders'),
    select: normalizeFolders,
  });
}

/**
 * 容忍两种形状：已建好的树（daemon 实际返回）与扁平列表（早期设计）。
 * 两者都不是时返回空数组 —— **宁可侧栏空着，也不让它整个崩掉**。
 */
function normalizeFolders(d: unknown): FolderNode[] {
  if (Array.isArray(d)) return withDepth(d as FolderNode[], 0);
  if (d && typeof d === 'object' && Array.isArray((d as { folders?: unknown }).folders)) {
    return buildTree((d as { folders: FolderDto[] }).folders);
  }
  console.warn('[folders] 无法识别的响应形状，按空处理', d);
  return [];
}

/** 服务端不下发 `depth`（它是展示概念），这里补上用于缩进。 */
function withDepth(nodes: readonly FolderNode[], depth: number): FolderNode[] {
  if (depth > 8) return [];
  return nodes.map((n) => ({
    ...n,
    depth,
    children: withDepth(n.children ?? [], depth + 1),
  }));
}

/**
/**
 * 树 → 扁平（先序）。
 *
 * 放在 folders 这一侧而不是让调用方自己遍历：文件夹树的形状归本 feature 所有，
 * 别处各写一次 `children` 递归，就多一处会忘记防环的地方。
 * `depth` 已由 `withDepth` 补好，这里只做展开。
 */
export function flattenFolders(tree: readonly FolderNode[] | undefined): FolderNode[] {
  const out: FolderNode[] = [];
  const seen = new Set<string>();
  const walk = (nodes: readonly FolderNode[]) => {
    for (const n of nodes) {
      // 防环：坏数据不该让一次"查文件夹名字"变成栈溢出（与 buildTree 同一条理由）
      if (seen.has(n.uid)) continue;
      seen.add(n.uid);
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree ?? []);
  return out;
}

/**
 * 扁平 → 树。
 *
 * **必须防环**：`parentUid` 指回自己的祖先会让递归栈溢出。
 * D-02 §1.3 要求写入时做环检测，但前端不能假设服务端一定做对了 ——
 * 一个坏数据不该让整个侧栏白屏。
 */
function buildTree(flat: readonly FolderDto[]): FolderNode[] {
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
    mutationFn: (uid: string) =>
      api<{ ok: true }>('notes', `/folders/${uid}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.folders });
      // 删文件夹会把里面的笔记移到"未分类"，列表也要刷
      void qc.invalidateQueries({ queryKey: qk.notes.all });
    },
  });
}

/*
 * ★ 这里原来还有一个 `useMoveNoteMutation()`。**已删 —— 它是一次搬家的残留，不是死码。**
 *
 * 权威那一份现在是 `features/notes/api.ts` 的 `useMoveNoteToFolderMutation()`，
 * 两份实现**逐字相同**（同端点 `PUT /api/notes/:uid/folder`、同 body、同三条 invalidate）。
 *
 * 为什么会有两份：`NoteActionsMenu` 要用它，而 eslint 的分层护栏当场拦住了
 * `import … from '../folders/api'`（features/A ↮ features/B）。**护栏拦得对** ——
 * 归属上也是 notes 那一侧更正：端点是「给这条笔记换个归属」，不是「对文件夹做什么」。
 * 于是那一侧照着写了一份，而这一份没人跟着删。
 *
 * ⚠️ 它留下来的真实代价**不是多几行**，是**守卫钉错了对象**：
 * `test/components.test.tsx` 那条「移动笔记打的是 PUT 而不是 PATCH」原本 import 的是
 * **这一份**（零调用方的那份），而用户真正会走的 `useMoveNoteToFolderMutation`
 * 一条腿都没有。同一轮已把那条腿改钉到权威那份上。
 * 端点本身的坑（PATCH 处理器不读 `folderUid` 却照回 200）记在 notes 那一侧的注释里，
 * 没有丢。
 */
