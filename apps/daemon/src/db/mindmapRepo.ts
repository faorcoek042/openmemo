/**
 * 思维导图仓储（D-02 §1.6 规范化表 + §2 的 `MindMapDoc`）。
 *
 * 单独一个文件而不是塞进 `repos.ts`：那个文件正被并行的另一项工作编辑，
 * 拆开可以避免写冲突（也更符合按领域分文件的习惯）。
 *
 * **持久化策略**：规范化表（`mindmap_nodes` 等）是真相，`doc_cache_json` 是读加速缓存。
 * `doc_cache_rev != revision` 即缓存失效 —— 与 D-02 §4.5「索引是可重建缓存」同一思路。
 */
import type { DatabaseHandle } from '@openmemo/db';
import type { MindMapDoc, MindMapNode } from '@openmemo/mindmap';
import { ulid } from '@openmemo/shared';

export interface MindMapRow {
  id: number;
  uid: string;
  note_id: number;
  title: string;
  revision: number;
  doc_cache_json: string | null;
  doc_cache_rev: number | null;
  generated_by: string | null;
  created_at: number;
  updated_at: number;
}

export class MindMapRepo {
  constructor(private readonly db: DatabaseHandle) {}

  byUid(uid: string): MindMapRow | undefined {
    return this.db.prepare<MindMapRow>(`SELECT * FROM mindmaps WHERE uid = :uid`).get({ uid });
  }

  listOfNote(noteId: number): MindMapRow[] {
    return this.db
      .prepare<MindMapRow>(`SELECT * FROM mindmaps WHERE note_id = :n ORDER BY created_at DESC`)
      .all({ n: noteId });
  }

  latestOfNote(noteId: number): MindMapRow | undefined {
    return this.listOfNote(noteId)[0];
  }

  /**
   * 把一份 `MindMapDoc` 整体落库（规范化表 + 缓存），**一个事务**。
   *
   * 采用"整体替换"而不是 diff：F4 生成是整图产出，diff 的复杂度换不来收益。
   * 用户在前端逐节点编辑时走 PATCH（未实现，属 T-023 之后的前端接线）。
   */
  save(p: {
    noteId: number;
    doc: MindMapDoc;
    generatedBy?: string | null;
    now?: number;
  }): MindMapRow {
    const now = p.now ?? Date.now();
    return this.db.transaction(() => {
      const existing = this.latestOfNote(p.noteId);
      let mindmapId: number;
      let revision: number;

      if (existing) {
        revision = existing.revision + 1;
        mindmapId = existing.id;
        this.db
          .prepare(
            `UPDATE mindmaps SET title=:title, revision=:rev, layout_json=:layout,
                    extensions_json=:ext, generated_by=:by, updated_at=:now WHERE id=:id`,
          )
          .run({
            id: mindmapId,
            title: p.doc.title,
            rev: revision,
            layout: p.doc.layout ? JSON.stringify(p.doc.layout) : null,
            ext: p.doc.extensions ? JSON.stringify(p.doc.extensions) : null,
            by: p.generatedBy ?? null,
            now,
          });
        // 整体替换：先清空旧节点（外键级联会带走子节点，但 root_node_id 需要先解引用）
        this.db.prepare(`UPDATE mindmaps SET root_node_id = NULL WHERE id = :id`).run({ id: mindmapId });
        this.db.prepare(`DELETE FROM mindmap_nodes WHERE mindmap_id = :id`).run({ id: mindmapId });
      } else {
        revision = 1;
        const r = this.db
          .prepare(
            `INSERT INTO mindmaps(uid, note_id, title, doc_schema_ver, revision, layout_json,
                                  extensions_json, generated_by, created_at, updated_at)
             VALUES (:uid, :note, :title, :ver, 1, :layout, :ext, :by, :now, :now)`,
          )
          .run({
            uid: ulid(now),
            note: p.noteId,
            title: p.doc.title,
            ver: p.doc.schemaVersion,
            layout: p.doc.layout ? JSON.stringify(p.doc.layout) : null,
            ext: p.doc.extensions ? JSON.stringify(p.doc.extensions) : null,
            by: p.generatedBy ?? null,
            now,
          });
        mindmapId = r.lastInsertRowid;
      }

      // ---- 写节点：先建全部行拿到 id，再回填 parent_id（避免依赖插入顺序）----
      const insert = this.db.prepare(
        `INSERT INTO mindmap_nodes(mindmap_id, node_key, sort_order, depth, text, rich_md,
                                   note_md, collapsed, side, style_json, icons_json, tags_json,
                                   hyperlink, ext_json, meta_json)
         VALUES (:m, :key, :sort, :depth, :text, :rich, :note, :collapsed, :side,
                 :style, :icons, :tags, :link, :ext, :meta)`,
      );
      const idByKey = new Map<string, number>();
      const depthByKey = new Map<string, number>();

      // 先算深度（BFS），子节点的 sort_order 用其在 children 数组里的下标
      const queue: Array<{ key: string; depth: number }> = [{ key: p.doc.rootKey, depth: 0 }];
      const order: Array<{ node: MindMapNode; depth: number; sort: number }> = [];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const cur = queue.shift() as { key: string; depth: number };
        if (seen.has(cur.key)) continue;
        seen.add(cur.key);
        const node = p.doc.nodes[cur.key];
        if (!node) continue;
        depthByKey.set(cur.key, cur.depth);
        order.push({ node, depth: cur.depth, sort: 0 });
        node.children.forEach((c, i) => {
          queue.push({ key: c, depth: cur.depth + 1 });
          // 记录在父节点里的位置
          const idx = order.findIndex((o) => o.node.key === c);
          if (idx >= 0) order[idx]!.sort = i;
        });
      }

      for (const { node, depth } of order) {
        const sort = parentIndexOf(p.doc, node.key);
        const r = insert.run({
          m: mindmapId,
          key: node.key,
          sort,
          depth,
          text: node.text,
          rich: node.richMd ?? null,
          note: node.noteMd ?? null,
          collapsed: node.collapsed ? 1 : 0,
          side: node.side ?? 'auto',
          style: node.style ? JSON.stringify(node.style) : null,
          icons: node.icons?.length ? JSON.stringify(node.icons) : null,
          tags: node.tags?.length ? JSON.stringify(node.tags) : null,
          link: node.hyperlink ?? null,
          ext: node.ext ? JSON.stringify(node.ext) : null,
          meta: node.meta ? JSON.stringify(node.meta) : null,
        });
        idByKey.set(node.key, r.lastInsertRowid);
      }

      // 回填 parent_id
      const setParent = this.db.prepare(
        `UPDATE mindmap_nodes SET parent_id = :p WHERE mindmap_id = :m AND node_key = :key`,
      );
      for (const { node } of order) {
        for (const childKey of node.children) {
          if (!idByKey.has(childKey)) continue;
          setParent.run({ p: idByKey.get(node.key) as number, m: mindmapId, key: childKey });
        }
      }

      // ---- refs（F5 联动的三层引用）----
      const rootId = idByKey.get(p.doc.rootKey);
      if (rootId !== undefined) {
        this.db.prepare(`UPDATE mindmaps SET root_node_id = :r WHERE id = :id`).run({ r: rootId, id: mindmapId });
      }
      const insertRef = this.db.prepare(
        `INSERT INTO mindmap_node_refs(node_id, transcript_id, start_ms, end_ms, quote, match_score)
         VALUES (:n, NULL, :s, :e, :q, :score)`,
      );
      for (const { node } of order) {
        const nodeId = idByKey.get(node.key);
        if (nodeId === undefined) continue;
        for (const ref of node.refs ?? []) {
          insertRef.run({
            n: nodeId,
            s: ref.startMs,
            e: ref.endMs,
            q: ref.quote,
            score: ref.matchScore ?? 1,
          });
        }
      }

      // ---- 缓存 ----
      const cached: MindMapDoc = { ...p.doc, revision };
      this.db
        .prepare(
          `UPDATE mindmaps SET doc_cache_json = :doc, doc_cache_rev = :rev, updated_at = :now WHERE id = :id`,
        )
        .run({ id: mindmapId, doc: JSON.stringify(cached), rev: revision, now });

      return this.db.prepare<MindMapRow>(`SELECT * FROM mindmaps WHERE id = :id`).get({ id: mindmapId }) as MindMapRow;
    });
  }

  /** 读回 `MindMapDoc`。缓存有效就直接用，否则返回 undefined（调用方可重建）。 */
  loadDoc(row: MindMapRow): MindMapDoc | undefined {
    if (!row.doc_cache_json || row.doc_cache_rev !== row.revision) return undefined;
    try {
      return JSON.parse(row.doc_cache_json) as MindMapDoc;
    } catch {
      return undefined;
    }
  }
}

/** 某节点在其父节点 `children` 数组中的下标；根节点为 0。 */
function parentIndexOf(doc: MindMapDoc, key: string): number {
  for (const n of Object.values(doc.nodes)) {
    const i = n.children.indexOf(key);
    if (i >= 0) return i;
  }
  return 0;
}
