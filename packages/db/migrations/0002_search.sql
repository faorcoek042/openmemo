-- ============================================================================
-- 0002_search.sql — FTS5 外部内容表 + 同步触发器
-- 摘自 docs/design/D-02-data-model.md §4.1
--
-- 依赖 libsimple 扩展（tokenize = 'simple'，中文分词）在连接建立后已 loadExtension()。
-- 与 0001_init.sql 分离的原因：可独立 DROP / 重建（换分词器、修坏索引），不影响业务数据。
-- 三张表均为外部内容表（content='<表名>'），要求：
--   - FTS 列名必须与内容表列名完全一致
--   - 不支持 INSERT OR REPLACE（会按 ABORT 处理），上游写入必须走 delete+insert
-- ============================================================================

-- ① 笔记
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body_text, summary_md,
  content = 'notes',
  content_rowid = 'id',
  tokenize = 'simple'
);

CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body_text, summary_md)
  VALUES (new.id, new.title, new.body_text, new.summary_md);
END;
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_text, summary_md)
  VALUES ('delete', old.id, old.title, old.body_text, old.summary_md);
END;
CREATE TRIGGER notes_fts_au AFTER UPDATE OF title, body_text, summary_md ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_text, summary_md)
  VALUES ('delete', old.id, old.title, old.body_text, old.summary_md);
  INSERT INTO notes_fts(rowid, title, body_text, summary_md)
  VALUES (new.id, new.title, new.body_text, new.summary_md);
END;

-- ② 转写段落（搜索的主战场）
CREATE VIRTUAL TABLE segments_fts USING fts5(
  text,
  content = 'transcript_segments',
  content_rowid = 'id',
  tokenize = 'simple'
);

CREATE TRIGGER segments_fts_ai AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER segments_fts_ad AFTER DELETE ON transcript_segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER segments_fts_au AFTER UPDATE OF text ON transcript_segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;

-- ③ 思维导图节点
-- 文档原文："三个触发器同上模式（略）" —— 以下按 notes_fts / segments_fts 的既定模式补全
-- （content_rowid='id'，列为 text, note_md，UPDATE 触发器监听 text, note_md 两列）。
CREATE VIRTUAL TABLE mindmap_nodes_fts USING fts5(
  text, note_md,
  content = 'mindmap_nodes',
  content_rowid = 'id',
  tokenize = 'simple'
);

CREATE TRIGGER mindmap_nodes_fts_ai AFTER INSERT ON mindmap_nodes BEGIN
  INSERT INTO mindmap_nodes_fts(rowid, text, note_md)
  VALUES (new.id, new.text, new.note_md);
END;
CREATE TRIGGER mindmap_nodes_fts_ad AFTER DELETE ON mindmap_nodes BEGIN
  INSERT INTO mindmap_nodes_fts(mindmap_nodes_fts, rowid, text, note_md)
  VALUES ('delete', old.id, old.text, old.note_md);
END;
CREATE TRIGGER mindmap_nodes_fts_au AFTER UPDATE OF text, note_md ON mindmap_nodes BEGIN
  INSERT INTO mindmap_nodes_fts(mindmap_nodes_fts, rowid, text, note_md)
  VALUES ('delete', old.id, old.text, old.note_md);
  INSERT INTO mindmap_nodes_fts(rowid, text, note_md)
  VALUES (new.id, new.text, new.note_md);
END;
