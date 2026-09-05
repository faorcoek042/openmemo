-- ============================================================================
-- 0001_init.sql — 核心业务表 + 索引
-- 摘自 docs/design/D-02-data-model.md §1.2–§1.10（业务表）与 §4.3（embed_chunks）
--
-- 不含：
--   - FTS5 外部内容表 + 触发器（notes_fts / segments_fts / mindmap_nodes_fts）
--     → 见 0002_search.sql（依赖 libsimple 扩展，需可独立 drop/重建）
--   - sqlite-vec 的 vec0 虚拟表（vec_chunks）→ 由调用方按激活的 embedding 模型动态建表/重建，
--     依赖扩展加载是否成功，不属于固定迁移
--
-- 循环外键说明（D-02 §1.1 末尾）：
--   media_sources.thumbnail_asset_id → media_assets  与  media_assets.source_id → media_sources
--   构成循环；另外 notes.cover_asset_id → media_assets 与 media_assets.note_id → notes、
--   mindmaps.root_node_id → mindmap_nodes 与 mindmap_nodes.mindmap_id → mindmaps 同样是前向引用形成的环。
--   SQLite 在运行时（DML 时）而非建表时解析外键，因此建表顺序无需满足这些环，均合法。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1.2 元数据与设置
-- ---------------------------------------------------------------------------

CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
-- 约定键：
--   schema_version         与 PRAGMA user_version 冗余，便于 SQL 侧查询
--   search_index_version   FTS/向量索引版本，与业务 schema 解耦（§4.4）
--   embed_model_id         当前向量索引所用的 embedding 模型（变了要重建 vec 表）
--   embed_dim              向量维度
--   instance_id            本库的 ULID，用于诊断与"这是同一个库吗"
--   created_at / last_opened_by_version

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
-- 约定键（点分命名空间）：
--   ui.theme / ui.locale
--   asr.defaultEngineId / asr.defaultModelId / asr.language / asr.vad.*
--   llm.defaultProviderId / llm.defaultModelId / llm.baseUrl.<provider>
--   runtime.selectedBackend / runtime.selectedGpuIndex
--   download.providerOrder / download.concurrency
--   paths.modelsRoot / paths.mediaRoot
--   daemon.autostart / daemon.port
--   privacy.telemetry (永远 false，仅为可见性)

CREATE TABLE secrets (
  key        TEXT PRIMARY KEY,       -- 'llm.openai.apiKey' / 'llm.anthropic.apiKey' / 'ytdlp.cookiesRef'
  value      TEXT NOT NULL,
  enc        TEXT NOT NULL DEFAULT 'plain'
             CHECK (enc IN ('plain','os-keychain-ref','aes-gcm')),
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
-- ⚠️ v1 默认 enc='plain'（文件 0600 / 目录 0700），UI 必须明确告知"未加密存储"。
--    见 D-01 §8.6 与 inbox 决策项 1。secrets 永不出现在日志、诊断包、API 响应（只回掩码）。

-- ---------------------------------------------------------------------------
-- §1.3 组织结构：文件夹 / 笔记 / 标签
-- ---------------------------------------------------------------------------

CREATE TABLE folders (
  id         INTEGER PRIMARY KEY,
  uid        TEXT    NOT NULL UNIQUE,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  sort_order REAL    NOT NULL DEFAULT 0,
  color      TEXT,
  icon       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
-- 深度上限由应用层强制（建议 ≤ 8），并在写入时做环检测。

CREATE TABLE notes (
  id           INTEGER PRIMARY KEY,
  uid          TEXT    NOT NULL UNIQUE,
  folder_id    INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  kind         TEXT    NOT NULL DEFAULT 'media'
               CHECK (kind IN ('media','recording','plain')),
  title        TEXT    NOT NULL DEFAULT '',
  body_json    TEXT,                          -- 富文本文档（TipTap JSON），可空
  body_text    TEXT    NOT NULL DEFAULT '',   -- body_json 的纯文本投影，专供 FTS（§4.1）
  summary_md   TEXT,                          -- AI 摘要（Markdown）
  status       TEXT    NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','processing','ready','partial','failed')),
  language     TEXT,
  starred      INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER,                       -- 冗余自主媒体，供列表页排序/展示，避免 join
  cover_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  opened_at    INTEGER,
  deleted_at   INTEGER
);

CREATE TABLE tags (
  id         INTEGER PRIMARY KEY,
  uid        TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,          -- 显示名（保留大小写）
  name_norm  TEXT    NOT NULL,          -- 归一化（NFKC + casefold + trim），判重用
  color      TEXT,
  parent_id  INTEGER REFERENCES tags(id) ON DELETE SET NULL,   -- 可选层级标签
  usage_count INTEGER NOT NULL DEFAULT 0,                      -- 由触发器维护，供排序
  created_at INTEGER NOT NULL
);

CREATE TABLE note_tags (
  note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  source     TEXT    NOT NULL DEFAULT 'user' CHECK (source IN ('user','ai')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, tag_id)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- §1.4 媒体源与媒体产物
-- ---------------------------------------------------------------------------

CREATE TABLE media_sources (
  id            INTEGER PRIMARY KEY,
  uid           TEXT    NOT NULL UNIQUE,
  note_id       INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  is_primary    INTEGER NOT NULL DEFAULT 1,
  kind          TEXT    NOT NULL
                CHECK (kind IN ('url','local','recording','rss_item')),
  adapter_id    TEXT,          -- 'ytdlp'|'direct-http'|'rss'|'local'  ← 可替换性可审计（D-01 §6.4）
  input_url     TEXT,          -- 用户原始输入（已通过 D-01 §8.4 校验）
  canonical_url TEXT,
  site          TEXT,          -- youtube|bilibili|xiaoyuzhou|podcast|...
  external_id   TEXT,          -- 站点侧唯一 id。⚠️ **设计意图**是"这个视频我已经导过了"，
                               --    但 createSource()（db/repos.ts）至今不写 site/external_id，
                               --    两列恒为 NULL ⇒ 下面的 idx_media_sources_dedupe 是
                               --    `WHERE external_id IS NOT NULL` 的部分索引 ⇒ **永远为空**
                               --    ⇒ **导入去重从未生效过**（重复导同一个链接会得到两条笔记）。
                               --    要接上：在导入适配器里解析出 site + external_id 再写进来。
  title         TEXT,
  author        TEXT,
  description   TEXT,
  published_at  INTEGER,
  duration_ms   INTEGER,
  thumbnail_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  probe_json    TEXT,          -- ffprobe / yt-dlp 元数据快照，原样保留供排障
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE media_assets (
  id           INTEGER PRIMARY KEY,
  uid          TEXT    NOT NULL UNIQUE,       -- /media/asset/<uid> 的寻址键（D-01 §3.1）
  note_id      INTEGER REFERENCES notes(id)          ON DELETE CASCADE,
  source_id    INTEGER REFERENCES media_sources(id)  ON DELETE CASCADE,
  role         TEXT    NOT NULL
               CHECK (role IN ('original','audio16k','transcode','thumbnail',
                               'peaks','screenshot','subtitle','export','archive')),
  rel_path     TEXT    NOT NULL,              -- 相对 <data_root>/media，绝不存绝对路径
  display_name TEXT,                          -- 用户可见名；**永不用于文件系统**（D-01 §8.5）
  mime         TEXT,
  bytes        INTEGER,
  sha256       TEXT,
  duration_ms  INTEGER,
  width        INTEGER,
  height       INTEGER,
  sample_rate  INTEGER,
  channels     INTEGER,
  codec        TEXT,
  meta_json    TEXT,
  state        TEXT    NOT NULL DEFAULT 'ready'
               CHECK (state IN ('pending','ready','missing','failed')),
  created_at   INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- §1.5 转写：段落、说话人、词级时间戳
-- ---------------------------------------------------------------------------

CREATE TABLE transcripts (
  id          INTEGER PRIMARY KEY,
  uid         TEXT    NOT NULL UNIQUE,
  note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  asset_id    INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,  -- 通常是 audio16k
  kind        TEXT    NOT NULL DEFAULT 'final'
              CHECK (kind IN ('streaming','final')),
  is_active   INTEGER NOT NULL DEFAULT 1,     -- 一个 note 可有多份（流式稿 + 离线重跑稿 + 换模型重跑）
  engine_id   TEXT    NOT NULL,               -- 'whisper.cpp'|'sherpa-onnx'|'browser-webgpu'
  model_id    TEXT,                           -- → model_installs.model_id
  backend     TEXT,                           -- cuda|vulkan|rocm|metal|coreml|cpu|webgpu
  language    TEXT,
  params_json TEXT,                           -- 完整推理参数快照 → 可复现、可对比
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','running','partial','done','failed')),
  progress    REAL    NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  rtf         REAL,                           -- 本机实测 real-time factor（ADR-004 决策 3：只存实测值）
  segment_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE speakers (
  id            INTEGER PRIMARY KEY,
  transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  label         TEXT    NOT NULL,     -- 引擎输出，如 'SPEAKER_00'
  display_name  TEXT,                 -- 用户重命名，如 '张老师'
  color         TEXT,
  total_ms      INTEGER NOT NULL DEFAULT 0,   -- 发言总时长，供"谁说得最多"统计
  UNIQUE(transcript_id, label)
);

-- ★ 核心表 ★
CREATE TABLE transcript_segments (
  id             INTEGER PRIMARY KEY,
  transcript_id  INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,        -- 段序号，从 0，稳定
  start_ms       INTEGER NOT NULL,
  end_ms         INTEGER NOT NULL,
  text           TEXT    NOT NULL,        -- 当前文本（若被编辑过即为编辑后的值）
  text_raw       TEXT,                    -- ASR 原始输出；仅当被编辑过才非空（省空间）
  edited_at      INTEGER,
  speaker_id     INTEGER REFERENCES speakers(id) ON DELETE SET NULL,
  confidence     REAL,                    -- 引擎给的置信度（whisper 用 avg_logprob 映射）
  no_speech_prob REAL,
  words_json     TEXT,                    -- 可选词级时间戳：[{"w":"你好","s":1200,"e":1450,"p":0.98}]
  chunk_idx      INTEGER,                 -- 属于哪个 ASR chunk → 续跑/重跑坏块（D-01 §4.5）
  flags          INTEGER NOT NULL DEFAULT 0,
  -- flags 位：bit0=疑似重复/幻觉  bit1=低置信  bit2=人工已确认  bit3=静音/音乐
  CHECK (end_ms >= start_ms),
  UNIQUE(transcript_id, seq)
);

-- 翻译/双语字幕（预留，v1 是否启用见 inbox 决策项 6）
CREATE TABLE segment_translations (
  segment_id INTEGER NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  lang       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  provider   TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, lang)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- §1.6 思维导图（规范化，库无关）
-- ---------------------------------------------------------------------------

CREATE TABLE mindmaps (
  id             INTEGER PRIMARY KEY,
  uid            TEXT    NOT NULL UNIQUE,
  note_id        INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title          TEXT    NOT NULL DEFAULT '',
  root_node_id   INTEGER REFERENCES mindmap_nodes(id) ON DELETE SET NULL,
  doc_schema_ver INTEGER NOT NULL DEFAULT 1,   -- MindMapDoc 的 schemaVersion（§2）
  revision       INTEGER NOT NULL DEFAULT 1,   -- 乐观锁：PATCH 必须带上，冲突返回 409
  layout_json    TEXT,                         -- {direction, theme, ...}
  extensions_json TEXT,                        -- 文档级渲染器私有数据（往返保真）
  doc_cache_json TEXT,                         -- 物化的 MindMapDoc（读加速，可随时重建）
  doc_cache_rev  INTEGER,                      -- 与 revision 不等则缓存失效
  generated_by   TEXT,                         -- 'llm:<modelId>' | 'heuristic' | 'user' | 'import'
  prompt_template_id TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE mindmap_nodes (
  id          INTEGER PRIMARY KEY,
  mindmap_id  INTEGER NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
  node_key    TEXT    NOT NULL,       -- 文档内稳定 ID（ULID）；渲染器往返、PATCH op 都用它
  parent_id   INTEGER REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
  sort_order  REAL    NOT NULL DEFAULT 0,
  depth       INTEGER NOT NULL DEFAULT 0,      -- 冗余，便于"只取前 3 层"的查询
  text        TEXT    NOT NULL DEFAULT '',     -- 纯文本（最小公分母，markmap 只需要它）
  rich_md     TEXT,                            -- 可选 Markdown 片段（加粗/链接/代码）
  note_md     TEXT,                            -- 节点备注
  collapsed   INTEGER NOT NULL DEFAULT 0,
  side        TEXT CHECK (side IN ('auto','left','right')) DEFAULT 'auto',
  style_json  TEXT,                            -- {color,background,fontSize,bold,...}
  icons_json  TEXT,                            -- ["🔥","⭐"]
  tags_json   TEXT,                            -- ["重点"]
  hyperlink   TEXT,
  image_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  ext_json    TEXT,                            -- 节点级渲染器私有数据
  meta_json   TEXT,                            -- {generatedBy, confidence, sourceWindow}
  UNIQUE(mindmap_id, node_key)
);

-- ★ F5 联动核心：导图节点 → 音频时间轴 ★
CREATE TABLE mindmap_node_refs (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
  transcript_id INTEGER REFERENCES transcripts(id) ON DELETE CASCADE,
  start_ms      INTEGER NOT NULL,       -- ★ 权威引用（重新转写后仍有效）
  end_ms        INTEGER NOT NULL,
  segment_id    INTEGER REFERENCES transcript_segments(id) ON DELETE SET NULL,  -- 仅缓存
  quote         TEXT,                   -- 引用原文片段 → 重转写后可用相似度重定位
  match_score   REAL,                   -- 重定位置信度；低于阈值则 UI 标"位置可能不准"
  CHECK (end_ms >= start_ms)
);

-- 自由连线（mind-elixir 的 arrows / linkData）
CREATE TABLE mindmap_edges (
  id           INTEGER PRIMARY KEY,
  mindmap_id   INTEGER NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
  edge_key     TEXT    NOT NULL,
  from_node_id INTEGER NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
  to_node_id   INTEGER NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
  label        TEXT,
  style_json   TEXT,
  UNIQUE(mindmap_id, edge_key)
);

-- 概要/括号（mind-elixir 的 summaries）
CREATE TABLE mindmap_summaries (
  id             INTEGER PRIMARY KEY,
  mindmap_id     INTEGER NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
  summary_key    TEXT    NOT NULL,
  parent_node_id INTEGER NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
  from_index     INTEGER NOT NULL,   -- 覆盖 parent 的第 from_index..to_index 个子节点
  to_index       INTEGER NOT NULL,
  text           TEXT    NOT NULL DEFAULT '',
  UNIQUE(mindmap_id, summary_key)
);

-- ---------------------------------------------------------------------------
-- §1.7 任务队列
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  id               INTEGER PRIMARY KEY,
  uid              TEXT    NOT NULL UNIQUE,
  type             TEXT    NOT NULL,     -- import.url|import.file|record.finalize|transcribe|
                                         -- diarize|structure.mindmap|structure.summary|embed.index|
                                         -- download.model|download.backend|backend.selftest|export.*
  plan_version     INTEGER NOT NULL DEFAULT 1,   -- 跨版本续跑保护（D-01 §4.5）
  note_id          INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  parent_job_id    INTEGER REFERENCES jobs(id)  ON DELETE CASCADE,
  idempotency_key  TEXT,
  priority         INTEGER NOT NULL DEFAULT 10,  -- 0 交互 / 10 普通 / 20 批量 / 30 维护
  lane             TEXT    NOT NULL,             -- net.download|net.llm|cpu.media|gpu.asr|gpu.llm|io.local
  state            TEXT    NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued','blocked','leased','running','paused',
                                    'succeeded','failed','cancelled')),
  blocked_code     TEXT,                  -- MISSING_ASR_MODEL / RESOURCE_DISK_FULL / ...
  remediation_json TEXT,                  -- UI 可直接渲染成按钮（D-01 §3.5/§7.1）
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  pause_requested  INTEGER NOT NULL DEFAULT 0,
  hard_cancel      INTEGER NOT NULL DEFAULT 0,
  attempt          INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  next_run_at      INTEGER NOT NULL DEFAULT 0,   -- 指数退避的下次可执行时刻
  lease_owner      TEXT,                          -- daemon instanceId
  lease_expires_at INTEGER,
  worker_pid       INTEGER,                       -- 孤儿回收用（配合 worker_started_at 防 PID 复用）
  worker_started_at INTEGER,
  progress         REAL    NOT NULL DEFAULT 0,
  current_step     TEXT,
  payload_json     TEXT    NOT NULL DEFAULT '{}',
  result_json      TEXT,
  error_code       TEXT,
  error_detail     TEXT,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE job_steps (
  id             INTEGER PRIMARY KEY,
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  name           TEXT    NOT NULL,   -- fetch|probe|demux|peaks|vad|asr|diarize|structure|index|export
  lane           TEXT    NOT NULL,
  state          TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','running','succeeded','failed','skipped')),
  progress       REAL    NOT NULL DEFAULT 0,
  attempt        INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT,             -- 如 asr: {totalChunks, doneChunkIds[], lastEndMs}
  artifact_json   TEXT,             -- 产物指针 {assetUid|relPath, bytes, sha256} → 重启后校验
  error_code     TEXT,
  error_detail   TEXT,
  started_at     INTEGER,
  finished_at    INTEGER,
  UNIQUE(job_id, seq)
);

CREATE TABLE job_events (
  id       INTEGER PRIMARY KEY,     -- 自增；UI 时间线与排障的主线
  job_id   INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  ts       INTEGER NOT NULL,
  level    TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  code     TEXT,
  message  TEXT,
  data_json TEXT
);

-- ---------------------------------------------------------------------------
-- §1.8 运行时后端与模型安装记录
-- 权威源在文件系统 manifests/*.json；这两张表是可重建的本地索引（为了 join/排序/外键/UI 查询）。
-- ---------------------------------------------------------------------------

CREATE TABLE backend_installs (
  id            INTEGER PRIMARY KEY,
  uid           TEXT    NOT NULL UNIQUE,
  component     TEXT    NOT NULL,   -- whisper.cpp|sherpa-onnx|llama.cpp|ffmpeg|yt-dlp|ggml-probe|7z
  backend       TEXT    NOT NULL,   -- cuda|vulkan|rocm|metal|coreml|cpu|none
  version       TEXT    NOT NULL,
  platform      TEXT    NOT NULL,   -- darwin|win32|linux
  arch          TEXT    NOT NULL,   -- arm64|x64
  manifest_id   TEXT,               -- vendor/manifests 条目 id（ADR-001 可追溯性要求）
  sha256        TEXT    NOT NULL,
  install_rel_path TEXT NOT NULL,   -- 相对 <data_root>/backends
  bytes         INTEGER,
  state         TEXT    NOT NULL DEFAULT 'installed'
                CHECK (state IN ('downloading','verifying','installing','installed','failed','disabled')),
  selftest_json TEXT,               -- 真实推理自检结果 {ok, rtf, deviceName, error}（ADR-003 决策 3）
  selftest_at   INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,   -- 熔断计数（D-01 §7.3）
  last_error    TEXT,
  installed_at  INTEGER,
  updated_at    INTEGER NOT NULL,
  UNIQUE(component, backend, platform, arch, version)
);

CREATE TABLE model_installs (
  id              INTEGER PRIMARY KEY,
  uid             TEXT    NOT NULL UNIQUE,
  model_id        TEXT    NOT NULL UNIQUE,   -- 与 manifests/<role>/<id>.json 的 id 一致
  role            TEXT    NOT NULL
                  CHECK (role IN ('asr','llm','vad','diarization','embedding','tts','punctuation')),
  family          TEXT,                      -- whisper|sensevoice|paraformer|qwen3|...
  quantization    TEXT,                      -- Q4_K_M|Q5_0|Q8_0|F16  ← ADR-004 补的 memo.ac 缺口①
  digest          TEXT    NOT NULL,          -- sha256，**唯一判重依据**（ADR-004 决策 4，绝不按体积）
  bytes           INTEGER,
  install_bytes   INTEGER,                   -- 解压后占用（pyannote 1.39GB→4.7GB 的教训）
  source_provider TEXT,                      -- hf|modelscope|mirror|local-import
  state           TEXT    NOT NULL DEFAULT 'installed'
                  CHECK (state IN ('downloading','verifying','installing','installed','failed')),
  ram_required_mb  INTEGER,                  -- ← ADR-004 补的 memo.ac 缺口②（CI 用 GGUF 头自动生成）
  vram_required_mb INTEGER,                  --    必须计入 KV cache
  bench_json      TEXT,                      -- 本机实测（ADR-004 决策 3：宁可空也不编数字）
  bench_at        INTEGER,
  installed_at    INTEGER,
  last_used_at    INTEGER,
  UNIQUE(digest, role)
);

-- ---------------------------------------------------------------------------
-- §1.9 录音会话（F3）
-- ---------------------------------------------------------------------------

CREATE TABLE recordings (
  id               INTEGER PRIMARY KEY,
  uid              TEXT    NOT NULL UNIQUE,   -- WS 重连时的 sessionId
  note_id          INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  transcript_id    INTEGER REFERENCES transcripts(id) ON DELETE SET NULL,   -- 流式稿
  archive_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,  -- 压缩存档
  state            TEXT    NOT NULL DEFAULT 'recording'
                   CHECK (state IN ('recording','paused','stopped','finalizing','finalized','failed')),
  sample_rate      INTEGER NOT NULL DEFAULT 16000,
  channels         INTEGER NOT NULL DEFAULT 1,
  device_label     TEXT,
  bytes_received   INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  clock_offset_ms  INTEGER NOT NULL DEFAULT 0   -- PCM 流与 MediaRecorder 存档的时钟对齐量
);

-- ---------------------------------------------------------------------------
-- §1.10 笔记锚点（F5 反向索引）
-- ---------------------------------------------------------------------------

CREATE TABLE note_anchors (
  id            INTEGER PRIMARY KEY,
  note_id       INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  anchor_key    TEXT    NOT NULL,       -- 与正文 body_json 中的 timeAnchor 节点 attrs.key 一一对应
  transcript_id INTEGER REFERENCES transcripts(id) ON DELETE SET NULL,
  start_ms      INTEGER NOT NULL,       -- ★ 权威
  end_ms        INTEGER,
  quote         TEXT,                   -- 重转写后重定位用
  asset_id      INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,  -- 截图锚点
  created_at    INTEGER NOT NULL,
  UNIQUE(note_id, anchor_key)
);

-- ---------------------------------------------------------------------------
-- §4.3 向量检索原文与元数据（普通表，这才是数据；vec_chunks 本身是可重建缓存，不在本迁移中）
-- ---------------------------------------------------------------------------

CREATE TABLE embed_chunks (
  id            INTEGER PRIMARY KEY,
  note_id       INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  transcript_id INTEGER REFERENCES transcripts(id) ON DELETE CASCADE,
  owner_kind    TEXT NOT NULL CHECK (owner_kind IN ('note','segment_range','mindmap_node')),
  owner_id      INTEGER,                 -- mindmap_node_id 等（owner_kind 决定语义）
  seq           INTEGER NOT NULL,
  start_ms      INTEGER,                 -- segment_range 时非空 → 语义搜索也能直达时间点
  end_ms        INTEGER,
  text          TEXT NOT NULL,           -- 分块原文（重建向量的依据）
  token_count   INTEGER,
  model_id      TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','indexed','stale')),
  created_at    INTEGER NOT NULL
);

-- ============================================================================
-- 索引
-- ============================================================================

CREATE INDEX idx_folders_parent ON folders(parent_id, sort_order);

CREATE INDEX idx_notes_folder   ON notes(folder_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_updated  ON notes(updated_at DESC)            WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_status   ON notes(status)                     WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_starred  ON notes(starred, updated_at DESC)   WHERE starred = 1 AND deleted_at IS NULL;

CREATE UNIQUE INDEX idx_tags_norm ON tags(name_norm);

CREATE INDEX idx_note_tags_tag ON note_tags(tag_id);

CREATE INDEX idx_media_sources_note ON media_sources(note_id, is_primary);
-- ⚠️ 这个索引今天**从不拦任何东西**：external_id 恒为 NULL（见上面该列的注释），
--    部分索引的 WHERE 把每一行都排除在外。它是**为将来准备好的**，不是在生效的功能 ——
--    别把它的存在当成"导入已经会去重了"的证据。
CREATE UNIQUE INDEX idx_media_sources_dedupe
  ON media_sources(site, external_id) WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX idx_media_assets_path ON media_assets(rel_path);
CREATE INDEX idx_media_assets_note_role  ON media_assets(note_id, role);
CREATE INDEX idx_media_assets_sha        ON media_assets(sha256) WHERE sha256 IS NOT NULL;

CREATE INDEX idx_transcripts_note ON transcripts(note_id, is_active, created_at DESC);

CREATE INDEX idx_segments_time    ON transcript_segments(transcript_id, start_ms, end_ms);
CREATE INDEX idx_segments_speaker ON transcript_segments(transcript_id, speaker_id);
CREATE INDEX idx_segments_chunk   ON transcript_segments(transcript_id, chunk_idx);
CREATE INDEX idx_segments_flags   ON transcript_segments(transcript_id, flags) WHERE flags != 0;

CREATE INDEX idx_mindmaps_note ON mindmaps(note_id, updated_at DESC);

CREATE INDEX idx_mm_nodes_parent ON mindmap_nodes(mindmap_id, parent_id, sort_order);
CREATE INDEX idx_mm_nodes_depth  ON mindmap_nodes(mindmap_id, depth);

CREATE INDEX idx_mm_refs_node ON mindmap_node_refs(node_id);
CREATE INDEX idx_mm_refs_time ON mindmap_node_refs(transcript_id, start_ms);

CREATE INDEX idx_mm_edges_from ON mindmap_edges(from_node_id);
CREATE INDEX idx_mm_edges_to   ON mindmap_edges(to_node_id);

-- 调度主查询的覆盖索引（state + 可执行时间 + 优先级 + FIFO）
CREATE INDEX idx_jobs_dispatch ON jobs(state, next_run_at, priority, created_at);
CREATE INDEX idx_jobs_lane     ON jobs(lane, state);
CREATE INDEX idx_jobs_note     ON jobs(note_id, state);
CREATE INDEX idx_jobs_lease    ON jobs(lease_expires_at) WHERE state IN ('leased','running');
CREATE UNIQUE INDEX idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_job_events_job ON job_events(job_id, id);
CREATE INDEX idx_job_events_ts  ON job_events(ts);

CREATE INDEX idx_model_installs_role ON model_installs(role, state);

CREATE INDEX idx_recordings_state ON recordings(state);

CREATE INDEX idx_note_anchors_time ON note_anchors(transcript_id, start_ms);

CREATE INDEX idx_embed_note  ON embed_chunks(note_id, seq);
CREATE INDEX idx_embed_state ON embed_chunks(state);

-- ============================================================================
-- 触发器（非 FTS）
-- ============================================================================

-- source='ai' 让"AI 自动打的标签"与"用户手打的标签"可区分 —— 重新生成时只清 AI 的，不动用户的。
CREATE TRIGGER tags_usage_ai AFTER INSERT ON note_tags BEGIN
  UPDATE tags SET usage_count = usage_count + 1 WHERE id = new.tag_id;
END;
CREATE TRIGGER tags_usage_ad AFTER DELETE ON note_tags BEGIN
  UPDATE tags SET usage_count = usage_count - 1 WHERE id = old.tag_id;
END;
