---
id: D-02
author: architect
status: draft
date: 2026-08-02
depends_on: D-01, ADR-001, ADR-002, ADR-003, ADR-004, R-01, R-03, R-04
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **单一 SQLite 库**（`openmemo.db`，WAL）承载全部结构化数据：笔记 / 媒体源 / 媒体产物 / 转写段落 / 说话人 / 思维导图 / 标签 / 任务队列 / 后端与模型安装记录 / 设置。**大二进制永不入库**，DB 只存**相对路径**（数据目录可整体搬迁）。
- **双 ID 约定**：内部 `id INTEGER PRIMARY KEY`（rowid 别名，FK 目标，**FTS5 `content_rowid` 与 sqlite-vec 都要求整数**），对外 `uid TEXT UNIQUE`（ULID，API 只暴露它）。这不是洁癖 —— 不这么做 FTS5 外部内容表根本接不上。
- **时间一律 `INTEGER` 毫秒**：`*_ms` 是媒体时间轴，`created_at` 等是 Unix 毫秒。**禁止浮点秒**（字幕对齐会累积误差，且不能做索引比较）。
- **思维导图库无关**：规范化表（`mindmap_nodes` + `edges` + `summaries` + `node_refs`）是**唯一真相**，`doc_cache_json` 只是可重建的读缓存。`MindMapDoc` JSON 用 **map-of-nodes（非嵌套树）** + `extensions` 命名空间，保证 mind-elixir 往返保真、markmap 只取 `text/children` 子集，并可直出 Markdown / OPML / FreeMind。
- **F5 联动的关键设计**：思维导图节点与笔记锚点**都以 `start_ms/end_ms` 为权威引用，`segment_id` 只是缓存**，再存一段 `quote` 原文。→ **重新转写后段落 id 全变，链接依然有效**（用时间 + 文本相似度重定位）。这是"能不能长期用"的分水岭。
- **检索三件套**：FTS5 外部内容表（`content='notes'` / `content='transcript_segments'`）+ `tokenize='simple'`（libsimple 中文分词）+ `sqlite-vec` 的 `vec0` 向量表；三组触发器保持同步。**混合检索用 RRF 融合**关键词与向量排名。
- **索引是可重建缓存，不是数据**：`PRAGMA user_version` 管业务 schema，`app_meta.search_index_version` 单独管索引。sqlite-vec 还是 0.1.x（R-03 已警告磁盘格式可能变），向量原文存在普通表 `embed_chunks.text` 里，vec 表随时可 drop 重建 → **扩展加载失败或格式变更都不会阻塞启动**。
- **迁移策略**：单向递增迁移（无 down），每个迁移一个事务，升级前 `VACUUM INTO backups/` 自动备份保留 3 份；`user_version > 代码支持` 时**拒绝启动**（绝不"尽力打开"，那会静默损坏数据）。
- **存储布局**：三大 OS 的标准 data 目录（**绝不用 Caches** —— 系统会清理，几 GB 模型被静默删掉是灾难，R-04 已定），媒体按 `media/<noteUid>/` 分目录、**文件名一律我们生成**（用户提供的名字只存 DB 的 `display_name`）→ 从根上消灭路径穿越与保留名问题。模型沿用 R-04 的内容寻址 `blobs/sha256-*`。
- **本轮已核实的四处订正**（读上游源码/官方文档取得，详见 §7）：① **npm 包名是 `mind-elixir` v5.14.0，不是 `mind-elixir-core`**（ADR-002/R-03/BOARD 需订正），且 `MindElixirData` **没有 `linkData`**，只有 `arrows`；② markmap 的 `transform()` 只吃 Markdown，但 `Markmap.create()` 吃 `IPureNode` → **绕过 transform 直接构造节点树**，省掉两次有损转换；③ `tokenize='simple'` 写法与 `simple_query()/simple_highlight()` 用法已由 libsimple README 逐字确认，**且原生支持拼音检索**（memo.ac 没有）；④ `vec0` 支持**元数据列（可过滤）/ `+辅助列` / `partition key`**，且分区键与 rescore/IVF/DiskANN 互斥。
- **【2026-08-02 状态升级】§4 检索三件套已由 T-014 实证跑通**：外部内容表 + 三组触发器 + `tokenize='simple'` + bm25 + `simple_query`/`simple_highlight` + **拼音检索** + WAL + 外键 + `vec0` KNN **全部通过**。§4 从"设计意图"升级为**已验证**。驱动定案 `better-sqlite3` v13 + `node:sqlite` 备胎 + 薄适配层（ADR-005 决策 6），**D-02 无需改动**。
- **由实测带回的两条硬约定（已写死在文中）**：① **写 `vec0` 的整数列一律绑 `BigInt`**——绑 JS `number` 必报 `Only integers are allows for primary key values`，两个驱动表现一致（是 sqlite-vec 的行为不是驱动 bug），转换收口到 DB 适配层，业务代码照传 `number`（§4.3）；② **扩展能力只能实测，不能读 `PRAGMA compile_options` 推断**——不列 `ENABLE_LOAD_EXTENSION` 也照样能加载，本文早期的 V-6 提法就错在这个前提上（§4.1 已写入方法论更正）。
- **未验证/存疑**：① **§1 的 26 张业务表 DDL 仍未整体执行**（T-014 只跑了 §4 的检索部分），T-016 落 `0001_init.sql` 时必须实测；② 驱动**只在 Linux x64 glibc 实测**，mac/Win/arm64/musl 全未验证，上游 issue #1509（arm64 需 GLIBC_2.38）未复现；③ libsimple 辅助函数的形参级签名仍 UNKNOWN；④ 重转写后 `quote` 相似度重定位的阈值（0.75/0.4）未调过。
- **对其他 agent 的影响**：T-011 请把 §1 的 DDL 落成 `0001_init.sql` 并**实测跑通**（含扩展加载），注意 **`mind-elixir` 包名订正**与 **Node ≥ 22 基线**，跑不通的地方回写 inbox；T-013 请注意 API 只暴露 `uid`、时间戳出入口转换（DB 毫秒整数 ↔ API ISO 字符串）、以及 §1.8 的 `model_installs` 只是**可重建索引**，权威源仍是 `manifests/*.json`；T-012 请对齐 §1.8 `backend_installs` 的 `selftest_json` 与熔断字段 `failure_count`。

---

# 详细内容

> **诚实标记**：`[已定]` = 上游 ADR/研究已裁决；`[已验证]` = 已在真实 SQLite 上跑通（注明由谁在哪个任务里跑的）；
> `[设计]` = 我的决策，未执行过 SQL；`[待核实]` = 需要实证；`UNKNOWN` = 查不到，不编。
>
> **DDL 的执行状态（2026-08-02 更新）**：
> - ✅ **§4 检索部分（FTS5 + libsimple + sqlite-vec）已由 `oss-scout` 在 T-014 实测跑通**，见 §7 V-1/V-6。
> - ⬜ **§1 的 26 张业务表 DDL 仍未整体执行** —— T-016 落 `0001_init.sql` 时以实测为准，冲突回写 inbox。

---

## §1 SQLite Schema（DDL）

### 1.0 连接级 PRAGMA（每次打开连接都要设）

```sql
PRAGMA journal_mode = WAL;        -- 读写不互相阻塞；崩溃安全
PRAGMA synchronous = NORMAL;      -- WAL 下的推荐值；最坏丢最后一个事务，不会损坏库
PRAGMA foreign_keys = ON;         -- SQLite 默认是 OFF！必须每连接显式开
PRAGMA busy_timeout = 5000;       -- 避免 SQLITE_BUSY 直接抛给用户
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -65536;       -- 64 MB 页缓存（负数 = KB）
PRAGMA mmap_size = 268435456;     -- 256 MB（Windows 上按需关闭，见注）
PRAGMA wal_autocheckpoint = 1000;
PRAGMA trusted_schema = OFF;      -- 安全：禁止 schema 中的函数在未信任上下文执行
```

注：
- `foreign_keys` 是**连接级**设置，`better-sqlite3` 每建一个连接都要重设。忘了这条 = 外键形同虚设。
- `mmap_size` 在 Windows 上与部分杀软/网络盘冲突 `[待核实]`；提供设置项可关。
- **不开 `PRAGMA case_sensitive_like`**；中文场景无意义。

### 1.1 全局约定

| 约定 | 规则 | 为什么 |
|---|---|---|
| **主键** | `id INTEGER PRIMARY KEY`（= rowid 别名） | FTS5 外部内容表要求 `content_rowid` 是整数；sqlite-vec 的 `rowid` 关联同理；整数 FK 更小更快 |
| **对外 ID** | 顶层实体加 `uid TEXT NOT NULL UNIQUE`（**ULID**，26 字符，字典序 ≈ 时间序） | API 只暴露 `uid`；将来导出/合并/多设备不会主键撞车；不暴露自增数量 |
| **子行** | 不加 `uid`（segments / nodes / steps / events…），它们永远在父实体上下文中被引用 | 少一列少一个索引 |
| **时间戳** | `INTEGER` = Unix **毫秒** | 整数可索引、无时区歧义、无解析开销。API 边界转 ISO-8601 UTC |
| **媒体时间** | `INTEGER` = 毫秒，列名后缀 `_ms` | 浮点秒会累积误差且无法做主键/区间索引 |
| **软删除** | 用户可见实体有 `deleted_at INTEGER`（NULL = 未删） | 误删可恢复；硬删走 `?purge=true` |
| **JSON 列** | 后缀 `_json`，存文本，用 SQLite 的 `json_*()` 查询 | 半结构化数据（参数快照、样式）不值得建表 |
| **排序** | `sort_order REAL`（分数索引） | 在两项之间插入只需取中值，不必重排整列 |
| **路径** | 一律**相对路径**（相对各自的根） | 数据目录可整体搬迁/改盘符 |
| **枚举** | `TEXT` + `CHECK` 约束 | 可读、可 grep；性能差异在本地规模下可忽略 |

> **循环外键说明**：`media_sources.thumbnail_asset_id → media_assets` 与 `media_assets.source_id → media_sources`
> 构成循环。SQLite 在**运行时**解析外键（不要求建表顺序），且两列均可空 + `ON DELETE SET NULL`，因此合法。
> 但**批量删除时需注意顺序**，建议删除走应用层事务而非纯级联 `[设计]`。

### 1.2 元数据与设置

```sql
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
```

### 1.3 组织结构：文件夹 / 笔记 / 标签

```sql
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
CREATE INDEX idx_folders_parent ON folders(parent_id, sort_order);
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
CREATE INDEX idx_notes_folder   ON notes(folder_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_updated  ON notes(updated_at DESC)            WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_status   ON notes(status)                     WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_starred  ON notes(starred, updated_at DESC)   WHERE starred = 1 AND deleted_at IS NULL;

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
CREATE UNIQUE INDEX idx_tags_norm ON tags(name_norm);

CREATE TABLE note_tags (
  note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  source     TEXT    NOT NULL DEFAULT 'user' CHECK (source IN ('user','ai')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX idx_note_tags_tag ON note_tags(tag_id);

CREATE TRIGGER tags_usage_ai AFTER INSERT ON note_tags BEGIN
  UPDATE tags SET usage_count = usage_count + 1 WHERE id = new.tag_id;
END;
CREATE TRIGGER tags_usage_ad AFTER DELETE ON note_tags BEGIN
  UPDATE tags SET usage_count = usage_count - 1 WHERE id = old.tag_id;
END;
```

> **`source='ai'`** 让"AI 自动打的标签"与"用户手打的标签"可区分 —— 重新生成时只清 AI 的，不动用户的。
> memo.ac **没有标签系统**（R-01 §A2.5 确证），这是我们的差异点之一。

### 1.4 媒体源与媒体产物

```sql
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
  external_id   TEXT,          -- 站点侧唯一 id，用于"这个视频我已经导过了"
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
CREATE INDEX idx_media_sources_note ON media_sources(note_id, is_primary);
CREATE UNIQUE INDEX idx_media_sources_dedupe
  ON media_sources(site, external_id) WHERE external_id IS NOT NULL;

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
CREATE UNIQUE INDEX idx_media_assets_path ON media_assets(rel_path);
CREATE INDEX idx_media_assets_note_role  ON media_assets(note_id, role);
CREATE INDEX idx_media_assets_sha        ON media_assets(sha256) WHERE sha256 IS NOT NULL;
```

**`role` 的语义**

| role | 内容 | 谁产生 |
|---|---|---|
| `original` | 下载/上传的原始媒体 | F1 yt-dlp / F2 上传 |
| `audio16k` | 16kHz 单声道 PCM16 WAV —— **ASR 的唯一输入格式** | ffmpeg |
| `transcode` | 浏览器可播的 mp4/m4a（原始格式浏览器放不了时才生成） | ffmpeg |
| `peaks` | 预计算波形峰值（`Uint8Array`），**必须有**，否则前端要 decode 整个音频（D-01 §5 F5） | ffmpeg + 后处理 |
| `thumbnail` / `screenshot` | 封面 / 时间点截图（摘要配图） | ffmpeg |
| `subtitle` / `export` | 导出产物（SRT/VTT/DOCX/…），可随时重建 | 导出 job |
| `archive` | F3 录音的压缩存档（webm/opus） | 浏览器 MediaRecorder 上传 |

### 1.5 转写：段落、说话人、词级时间戳

```sql
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
CREATE INDEX idx_transcripts_note ON transcripts(note_id, is_active, created_at DESC);

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
CREATE INDEX idx_segments_time    ON transcript_segments(transcript_id, start_ms, end_ms);
CREATE INDEX idx_segments_speaker ON transcript_segments(transcript_id, speaker_id);
CREATE INDEX idx_segments_chunk   ON transcript_segments(transcript_id, chunk_idx);
CREATE INDEX idx_segments_flags   ON transcript_segments(transcript_id, flags) WHERE flags != 0;

-- 翻译/双语字幕（预留，v1 是否启用见 inbox 决策项 6）
CREATE TABLE segment_translations (
  segment_id INTEGER NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  lang       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  provider   TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, lang)
) WITHOUT ROWID;
```

**设计说明**

1. **`text` / `text_raw` 分离**：用户编辑后仍能看到 ASR 原文、能"还原"、能统计 ASR 准确率。未编辑时 `text_raw` 为 NULL，不浪费空间。
2. **`words_json` 而非 `words` 表**：一场 3 小时讲座约 3000 段、5 万词。建独立表会让行数暴涨到 5 万且几乎只被"整段一起读"的模式访问 → JSON 列在这里更优。若将来要做词级搜索再拆表 `[设计]`。
3. **`flags` 位图**：`bit0` 支撑 R-01 §C11 #7 提到的 whisper 重复/幻觉顽疾 —— 检测到就标位、UI 高亮、支持"仅重跑标记段"。
4. **`is_active` 多版本转写**：F3 的"流式稿 → 离线重跑稿"（D-01 §5 F3）与"换个模型再转一遍对比"都依赖它。旧稿不删（用户可能已编辑过），只是 `is_active=0`。

### 1.6 思维导图（规范化，库无关）

```sql
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
CREATE INDEX idx_mindmaps_note ON mindmaps(note_id, updated_at DESC);

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
CREATE INDEX idx_mm_nodes_parent ON mindmap_nodes(mindmap_id, parent_id, sort_order);
CREATE INDEX idx_mm_nodes_depth  ON mindmap_nodes(mindmap_id, depth);

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
CREATE INDEX idx_mm_refs_node ON mindmap_node_refs(node_id);
CREATE INDEX idx_mm_refs_time ON mindmap_node_refs(transcript_id, start_ms);

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
CREATE INDEX idx_mm_edges_from ON mindmap_edges(from_node_id);
CREATE INDEX idx_mm_edges_to   ON mindmap_edges(to_node_id);

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
```

> **为什么规范化而不是只存一坨 JSON**（这是 ADR-002 决策 3"库无关"的落地关键）：
> ① 节点能被**全文检索**（`mindmap_nodes_fts`，§4.1）；② 节点能**独立关联时间戳**（`node_refs`）；
> ③ PATCH 能发**细粒度 op**而不是全量文档（D-01 §5 F4）；④ 换渲染器时只是换转换器，数据一行不用动；
> ⑤ 未来做增量协作/撤销栈有基础。
> `doc_cache_json` 只是**读路径的物化视图**，任何时候都能由规范表重建 —— 它坏了不影响数据完整性。

### 1.7 任务队列

```sql
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
-- 调度主查询的覆盖索引（state + 可执行时间 + 优先级 + FIFO）
CREATE INDEX idx_jobs_dispatch ON jobs(state, next_run_at, priority, created_at);
CREATE INDEX idx_jobs_lane     ON jobs(lane, state);
CREATE INDEX idx_jobs_note     ON jobs(note_id, state);
CREATE INDEX idx_jobs_lease    ON jobs(lease_expires_at) WHERE state IN ('leased','running');
CREATE UNIQUE INDEX idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

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
CREATE INDEX idx_job_events_job ON job_events(job_id, id);
CREATE INDEX idx_job_events_ts  ON job_events(ts);
```

> **SSE 的 `Last-Event-ID` 不复用 `job_events.id`。** SSE 序号是 daemon 生命周期内的内存计数器，
> 格式 `"<instanceId>:<n>"`；daemon 重启后 `instanceId` 变化 → 客户端拿到不认识的前缀 → 下发
> `sync.required` 全量重拉。这样避免了"为了 SSE 而给每条广播都写一次盘"的开销（D-01 §3.3）。
> `job_events` 是**审计与 UI 时间线**，不是消息总线。

### 1.8 运行时后端与模型安装记录

> **权威源声明**：模型与后端的**权威元数据在文件系统的 `manifests/*.json`**（ADR-001 C 类 + R-04 §6.4）。
> 下面两张表是**可重建的本地索引**（为了 join、排序、外键、UI 快速查询）。
> 若两者不一致，**以文件系统为准**，DB 表重建。启动时做一次轻量对账（比对 digest 集合）。

```sql
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
CREATE INDEX idx_model_installs_role ON model_installs(role, state);
```

**"当前激活的模型/后端"不建表**，放 `settings`（`asr.defaultModelId` / `runtime.selectedBackend`），
因为它是**单值配置**，建表反而要处理"只能有一行"的约束。

### 1.9 录音会话（F3）

```sql
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
CREATE INDEX idx_recordings_state ON recordings(state);
```

### 1.10 笔记锚点（F5 反向索引）

```sql
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
CREATE INDEX idx_note_anchors_time ON note_anchors(transcript_id, start_ms);
```

> 正文里的锚点是**内联富文本节点**（真相在 `body_json`），本表是**为了反向查询而维护的规范化索引**
> （"这一秒有哪些笔记提到？"）。保存笔记时由应用层同步（先删该 note 的全部锚点再重插，事务内完成）。

---

## §2 思维导图的库无关 Schema（`MindMapDoc`）

> `[ADR-002 决策 3 硬要求]` 数据模型必须库无关；mind-elixir 与 markmap 都只是消费者。
> 正式 TS 类型建议放 `packages/mindmap/src/types.ts`（`packages/mindmap` 尚无 owner，见 inbox 决策项）。

### 2.1 结构（JSON）

```jsonc
{
  "schemaVersion": 1,
  "uid": "01J8…",                    // = mindmaps.uid
  "title": "深度学习导论 第 3 讲",
  "rootKey": "n_01J8…",
  "revision": 7,                      // 乐观锁，PATCH 必带

  // ★ map-of-nodes，不是嵌套树 ★
  "nodes": {
    "n_01J8…": {
      "key": "n_01J8…",
      "text": "反向传播",              // 【必填】纯文本 —— 最小公分母，markmap 只需要这个
      "children": ["n_01J9…", "n_01JA…"],   // 有序数组，顺序即显示顺序
      "richMd":   null,               // 可选：Markdown 片段（**加粗**、`code`、[链接]）
      "noteMd":   null,               // 可选：节点备注
      "collapsed": false,
      "side":     "auto",             // auto|left|right（仅根的直接子节点有意义）
      "style":    null,               // {color,background,fontSize,bold,italic}
      "icons":    [],                 // ["🔥"]
      "tags":     [],
      "hyperlink": null,
      "imageAssetUid": null,
      "refs": [                       // ★ F5 联动：该节点对应音频的哪一段
        { "transcriptUid": "01J…", "startMs": 754000, "endMs": 812000,
          "quote": "所以我们对损失函数求偏导…", "matchScore": 0.93 }
      ],
      "meta": { "generatedBy": "llm:qwen3-8b", "confidence": 0.81 },
      "ext":  {}                      // 节点级渲染器私有数据（往返保真）
    }
  },

  "edges": [                          // 自由连线（跨层级关联）
    { "key": "e_01J…", "from": "n_01J9…", "to": "n_01JB…", "label": "导致", "style": null }
  ],

  "summaries": [                      // 概要括号
    { "key": "s_01J…", "parent": "n_01J8…", "fromIndex": 0, "toIndex": 2, "text": "三步推导" }
  ],

  "layout": { "direction": "right", "theme": "light" },

  // 渲染器私有数据的隔离沙箱：核心 schema 保持干净，往返不丢信息
  "extensions": { "mind-elixir": { /* … */ }, "markmap": { /* … */ } }
}
```

### 2.2 五条设计约束（每条都有具体理由）

| # | 约束 | 理由 |
|---|---|---|
| 1 | **`nodes` 是 map 不是嵌套树** | ① 稳定 key → 渲染器往返、PATCH op、`refs` 外链都靠它；② O(1) 查节点；③ diff/patch 容易；④ 避免深嵌套 JSON 在 TS 里递归类型爆炸。子节点顺序用显式 `children` 数组表达，不靠对象键序（JSON 对象键序不可依赖） |
| 2 | **除 `key/text/children` 外全部可选** | markmap 只吃 `text + children`；任何"高级"字段缺失都必须能渲染。这条是"库无关"的可验证判据 |
| 3 | **`refs` 用时间区间做权威，`segmentId` 不进 JSON** | 重新转写后 segment id 全变。时间 + `quote` 能重定位；id 只在 DB 里当缓存 |
| 4 | **`extensions` / `ext` 命名空间** | 渲染器要存自己的东西（mind-elixir 的展开态、坐标缓存等）→ 给它一个隔离盒子，而不是往核心 schema 里加字段。**转换器必须原样保存与回填**，否则"编辑一次就丢样式"会成为顽疾 |
| 5 | **校验规则内建**：单根、无环、`children` 引用必须存在、深度 ≤ 32、单节点文本 ≤ 4096 字符、总节点 ≤ 20000 | LLM 会生成环和悬空引用。不校验就等着渲染器栈溢出。校验在 `packages/mindmap` 的 `validate()`，写库前必调 |

### 2.3 渲染器映射 `[已核实：直接读取上游源码]`

> 依据：`mind-elixir` v5.14.0 的 `src/types/index.ts`；
> `markmap-common` v0.18.9 的 `src/types/common.ts` + `markmap-lib` v0.18.12 的 `src/transform.ts`。
> **⚠️ 包名订正**：npm 上是 **`mind-elixir`**，`mind-elixir-core` 在 npm **404**（那是 GitHub 仓库名）。
> ADR-002 / R-03 / BOARD 的写法需按此订正 —— 请 T-011 在 `package.json` 用 `mind-elixir`。

**→ mind-elixir（可编辑，双向）**

`MindElixirData = { nodeData: NodeObj; arrows?; summaries?; direction?: 0|1|2|3; theme?; compact?; meta? }`
（**已核实：没有 `linkData` 字段**，自由连线只有 `arrows`）

| MindMapDoc | mind-elixir `NodeObj`（已核实字段名） | 备注 |
|---|---|---|
| `nodes[k].key` | `id` | 直接透传，保证往返 |
| `nodes[k].text` | `topic` | |
| `children` 数组 | `children`（**嵌套树**） | 转换时由 map 展开成嵌套；回写时摊平。注意 `parent` 是运行时注入字段，**不得手动设置、不得序列化** |
| `collapsed` | `expanded`（**布尔取反**） | 语义相反，易错点 |
| `side: auto/left/right` | `direction: 0 \| 1`（0=Left, 1=Right） | **枚举是数字不是字符串**；`auto` → 省略该字段 |
| `style` | `style: {fontSize,fontFamily,color,background,fontWeight,width,border,textDecoration}` | 我们的 `style_json` 按此子集存 |
| `icons` | `icons: string[]` | |
| `tags` | `tags: (string \| {text,style?,className?})[]` | 我们只用 `string` 形式 |
| `hyperlink` / `noteMd` | `hyperLink` / `note` | 注意 `hyperLink` 的大写 L |
| `imageAssetUid` | `image: {url,width,height,fit?}` | `url` 填 `/media/asset/<uid>` |
| — | `branchColor` | 存进我们的 `style_json` |
| `edges` | 顶层 `arrows` | |
| `summaries` | 顶层 `summaries` | |
| `refs` / `meta` / `ext` | **`metadata`（NodeObj 的通用扩展字段）** | ✅ 上游明确提供了泛型 `metadata?: M` 作为扩展位 —— 正好承载我们的 `refs`/`meta`，无需额外 hack |
| — | `dangerouslySetInnerHTML` | **禁用**（XSS 面）。我们的 `richMd` 走安全渲染，不用这条 |

> **[已核实] mind-elixir 没有通用 Markdown 导入/导出**：`Options.markdown` 只是"节点 topic 文本的渲染钩子"
> （你自己传 `marked`/`markdown-it`，它不内置解析器）。它另有 `mindElixirToPlaintext` / `plaintextToMindElixir`
> 的**纯文本大纲**双向转换，但那是**自有语法**（箭头写作 `- > [^id] >-label-> [^id]`、概要写作 `- }count label`），
> **不是标准 Markdown**。→ **我们的 Markdown 导入导出必须自己实现**（§2.4），不能指望上游。

**→ markmap（只读）**

`IPureNode = { content: string; payload?: { fold?: number; [k]: unknown }; children: IPureNode[] }`
（布局态在 `INode.state.{id,path,key,depth,size,rect}`，由 markmap 运行时填充，我们不产出）

| MindMapDoc | markmap `IPureNode` |
|---|---|
| `text` / `richMd` | `content`（**HTML 字符串**，不是 Markdown；`richMd` 需先渲染成安全 HTML） |
| `children` | `children` |
| `collapsed` | `payload.fold`（非 0 即折叠） |
| `refs` / `meta` | 塞进 `payload` 的自定义键（markmap 会原样保留） |
| `edges` / `summaries` / `style` / `icons` | **无对应，丢失** → UI 必须明示（§2.3 损失矩阵） |

> **[已核实] 关键实现决策**：`markmap-lib.transform()` **只接受 Markdown 字符串**
> （内部 `markdown-it` → HTML → `markmap-html-parser.buildTree`），**不能直接喂 JSON 树**。
> 但 `markmap-view` 的 `Markmap.create()` 接受 `IPureNode` 对象。
> → **我们绕过 `transform()`，由 `MindMapDoc` 直接构造 `IPureNode`**，
> 避免"doc → Markdown → markdown-it → HTML → buildTree"这条四段有损链路。
> `toMarkdown(doc)` 仅用于**导出**和"编辑 Markdown 源"入口，**不在渲染路径上**。

**损失矩阵（切到 markmap 视图时 UI 必须明示）**

| 特性 | mind-elixir | markmap | 导出 MD | OPML | FreeMind |
|---|---|---|---|---|---|
| 层级 + 文本 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 折叠态 | ✅ | ✅ | ❌ | ✅(`_note`?) | ✅ |
| 节点备注 | ✅ | 降级为子项 | ✅ | ✅ | ✅ |
| 逐节点样式 | ✅ | ❌ | ❌ | ❌ | 部分 |
| 图标/标签 | ✅ | ❌ | 降级为文本 | ❌ | 部分 |
| **自由连线 `edges`** | ✅ | ❌ | ❌ | ❌ | ✅(`arrowlink`) |
| **概要 `summaries`** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **时间戳 `refs`** | 我们自绘 | 我们自绘 | 可导出为 `[12:34]` | ❌ | ❌ |
| 图片 | ✅ | ❌ | ✅(`![]()`) | ❌ | ✅ |

### 2.4 导出格式（由 `MindMapDoc` 直出，**不经过渲染器**）

| 格式 | 生成方式 | 备注 |
|---|---|---|
| **Markdown** | 标题层级或嵌套列表（可选） | 可回读（`fromMarkdown`），是与 markmap 的桥 |
| **OPML 2.0** | `<outline text="…" _note="…">` 嵌套 | 大纲工具通用（Workflowy/Dynalist/幕布） |
| **FreeMind `.mm`** | `<node TEXT="…" ID="…" FOLDED="true">`，连线用 `<arrowlink DESTINATION="…"/>` | XMind/FreeMind/MindManager 都能读；**唯一能带自由连线的通用格式** |
| **JSON** | `MindMapDoc` 原样 | 我们自己的完整备份格式，零损失 |
| **SVG / PNG** | 渲染器 `export()` → `XMLSerializer` 序列化 SVG，位图用指定 `scale` 光栅化 | **不用 `html2canvas` 截屏** —— 直接修掉 memo.ac issue #133（导出图片文字模糊，R-01 §C10 #8） |

**导入**：Markdown / OPML / FreeMind / JSON 反向转换，统一产出 `MindMapDoc` 后再入库（走同一套 `validate()`）。

---

## §3 转写稿 ↔ 音频时间轴联动（F5 核心）

### 3.1 数据结构总览

```
                    ┌────────────────────────┐
                    │  transcript_segments   │  ★ 时间轴的唯一真相
                    │  (start_ms, end_ms,    │
                    │   text, speaker_id,    │
                    │   words_json)          │
                    └───▲────────▲───────▲───┘
             按时间区间引用 │        │       │ 按时间区间引用
        ┌─────────────────┘        │       └────────────────────┐
┌───────┴────────────┐   ┌─────────┴──────────┐   ┌─────────────┴─────────┐
│ mindmap_node_refs  │   │  media_assets      │   │   note_anchors        │
│ (导图节点 → 时间)   │   │  role='peaks'      │   │ (笔记正文 → 时间)      │
│ + quote/matchScore │   │  预计算波形         │   │ + quote               │
└────────────────────┘   └────────────────────┘   └───────────────────────┘
                                   │
                            ┌──────┴───────┐
                            │  <audio>     │  currentTime ↔ 双向
                            │  /media/…    │
                            └──────────────┘
```

### 3.2 正向：播放位置 → 高亮段落

- 前端首次加载时把 `segments` 拉成**按 `start_ms` 升序的数组**，构建两级索引：
  - 段级：数组本身有序 → **二分查找** `activeIndex = upperBound(startArr, t) - 1`，O(log n)。
  - 词级（可选）：命中段后在其 `words_json` 内再二分 → karaoke 高亮。
- 更新频率：`requestAnimationFrame` + 节流到 **~10 Hz**（人眼够用，避免每帧重渲染整个列表）。
- 长稿必须**虚拟滚动**（3 小时 ≈ 3000+ 段；全量 DOM 会卡）。
- **重叠段落**：说话人分离后可能出现重叠区间。规则：`activeSegment` 取 `start_ms` 最大且 `start_ms <= t < end_ms` 的那条；重叠时全部高亮但只滚动到主段 `[设计]`。

### 3.3 反向：点击 → 定位

| 触发 | 数据路径 |
|---|---|
| 点转写段 | `segment.start_ms / 1000` → `audio.currentTime` |
| 点笔记里的时间锚点 | `note_anchors.start_ms`（或正文 `timeAnchor` 节点的 `attrs.startMs`） |
| 点思维导图节点 | `mindmap_node_refs.start_ms`（多个 ref 时取第一个，UI 给"下一处"按钮） |
| 点搜索结果 | FTS 命中 `transcript_segments.id` → 该行 `start_ms` → 打开笔记 + seek |
| 拖波形 | 像素 → 时间（`peaks` 的采样率固定，见下）→ seek |

### 3.4 波形（`role='peaks'`）格式 `[设计]`

```
生成：ffmpeg 解码 → 按固定窗口取 min/max → 量化到 Int8
文件：[magic "OMPK"(4B)][version u8][channels u8][samplesPerPixel u32][durationMs u32]
      [数据: Int8 × N × 2 (min,max)]
采样：默认 samplesPerPixel = 256（16kHz 下 = 16ms/像素）→ 1 小时音频 ≈ 2×225000 = 450 KB
```
- 前端一次 `fetch` 成 `ArrayBuffer`，`Int8Array` 直接画 canvas，**零解码开销**。
- 为什么必须预计算：浏览器 `decodeAudioData` 一个 2 小时文件会占数百 MB 内存并阻塞主线程（D-01 §5 F5）。

### 3.5 编辑与重转写后的链接稳定性（**最重要的一条**）

问题：用户在 3 小时的讲座上做了 40 个笔记锚点和一张 200 节点的思维导图，然后换了个更好的模型**重新转写** —— 段落 id 全变、边界也变。天真实现会让 240 个链接全部失效。

**解法：三层引用，逐层降级**

```
第 1 层  start_ms / end_ms       ← 权威。时间轴不变，重转写不影响
第 2 层  quote（原文片段，≤200 字）← 用于在新稿中重定位（相似度匹配）
第 3 层  segment_id              ← 仅缓存。重转写后置 NULL，按 1+2 重新解析
```

重转写后的重定位流程 `[设计，未验证准确率]`：
```
对每个 ref/anchor：
  1. 在新稿中取 [start_ms - 5s, end_ms + 5s] 窗口内的所有段
  2. 用 quote 与窗口文本做相似度匹配（归一化编辑距离 / 字符 n-gram Jaccard）
  3. score ≥ 0.75 → 更新 start_ms/end_ms 与 segment_id，写 match_score
     0.4 ≤ score < 0.75 → 保留原 start_ms，标 match_score，UI 显示"位置可能不准"角标
     score < 0.4 → 保留原时间，标记为"待人工确认"，不静默丢弃
```

**其它稳定性规则**
- **删除段落 ≠ 删除时间**：用户删掉某段转写文本，锚点仍指向该时间点（音频还在）。
- **编辑段落文本**：`text_raw` 保留 ASR 原文 → `quote` 匹配仍可用原文比对。
- **transcript 切换 `is_active`**：refs 记的是 `transcript_uid`；若指向的稿被停用，回退到该 note 的当前活跃稿并触发重定位。
- **`quote` 是必填的**（哪怕只有 20 个字）—— 没有它就没有第 2 层，重转写必然丢链接。这条要写进 F4 的 LLM 输出 schema 与"插入锚点"的前端逻辑。

### 3.6 字幕导出的时间对齐

- SRT/VTT 直接由 `start_ms/end_ms` 生成（毫秒整数 → `HH:MM:SS,mmm`，**无浮点误差**，这是 §1.1 选整数毫秒的直接收益）。
- 长段落自动拆行：按 `words_json` 的词边界 + 每行字符上限（中文 ≤ 18、英文 ≤ 42）拆分，无词级时间戳时按标点 + 时长比例插值 `[设计]`。
- 双语字幕从 `segment_translations` 取，与原文共享同一时间区间。

---

## §4 全文检索与向量检索

### 4.1 FTS5 外部内容表 + 中文分词

> `[已核实]` libsimple v0.7.1（2026-02-23，12 个预编译平台包）。README 原文示例逐字为：
> `.load libsimple` → `CREATE VIRTUAL TABLE t1 USING fts5(text, tokenize = 'simple');`
> → **`tokenize = 'simple'` 的写法确认无误**。加载走 SQLite 默认入口点约定 `sqlite3_<libname>_init`
> （`sqlite3_load_extension` 的 entryPoint 参数传 NULL 即可）。
> libsimple = `wangfenjin/simple`，**MIT OR GPL-3.0 双授权，我们选 MIT 支**（R-03 §L-6，必须写进 NOTICE）。
>
> `[已验证：T-014 实测]` **`better-sqlite3` v13.0.2** 的 `.loadExtension(path, [entryPoint])`
> 在本机成功加载了 `libsimple` 与 `sqlite-vec`，**全部 DDL 与查询跑通**（详见 §7 V-6）。
> `engines.node >= 22`（ADR-006 决策 7 已据此定基线）。
> **补充澄清**（ADR-005 决策 6）：v13 已迁到 **prebuildify**，8 平台预编译 `.node` 直接打在 npm tarball 里、
> 无 install 脚本、装时不联网 → **不需要用户机器有编译工具链**（TD-003 因此关闭）。
>
> #### ⚠️ 验证方法说明：扩展能力**只能实测，不能读 `compile_options` 推断**
>
> `[已验证：T-014]` 本文早期版本把"bundled SQLite 是否编译了 `SQLITE_ENABLE_LOAD_EXTENSION`"
> 列为待验证项，**这个提法本身建立在一个错误前提上**：
>
> > `PRAGMA compile_options` **不列出** `ENABLE_LOAD_EXTENSION`，扩展**照样能加载**。
> > （`better-sqlite3` 与 Node 22 的 `node:sqlite` 都是如此。）
>
> 原因：该宏控制的是**编译期是否移除**该能力（对应的否定宏是 `SQLITE_OMIT_LOAD_EXTENSION`），
> 未被 `OMIT` 掉时它是默认可用的，`compile_options` 里没有它**不代表没有它**。
>
> **规则（写给后来者，避免重犯）**：
> 判断某个 SQLite 构建能否加载扩展，**唯一可靠的方法是真的去 `loadExtension()` 一次并看是否抛错**。
> 反例可参考 `node-sqlite3-wasm`：它是编译期显式 `OMIT_LOAD_EXTENSION`，
> **连 `loadExtension` 方法都不存在** —— 这种才是真的不支持，而且同样是"跑一次就知道"。
> 这条方法论同样适用于本文其它"某构建是否支持某能力"类的判断。

```sql
-- 扩展加载（连接建立后立即执行，失败则降级，见 §4.5）
-- better-sqlite3: db.loadExtension('<path>/libsimple');  db.loadExtension('<path>/vec0');

-- ① 笔记
-- ⚠️ 外部内容表的 FTS 列名**必须与内容表的列名完全一致**——FTS5 会用列名去 content 表取值。
-- ⚠️ 术语澄清（已核实 SQLite 官方文档 §4.4.3）：
--    content='<表名>'  = external content table（外部内容表，我们用的就是这个）
--    content=''        = contentless table（无内容表，语义完全不同，不要混用）
-- ⚠️ 外部内容表**不支持 REPLACE 冲突处理**（会按 ABORT 处理）→ 上游写入禁用 INSERT OR REPLACE。
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
CREATE VIRTUAL TABLE mindmap_nodes_fts USING fts5(
  text, note_md,
  content = 'mindmap_nodes',
  content_rowid = 'id',
  tokenize = 'simple'
);
-- 三个触发器同上模式（略）
```

**注意事项**
1. **软删除与 FTS**：`notes.deleted_at` 置位时行还在 → FTS 仍含它。查询时 `JOIN notes ... WHERE deleted_at IS NULL` 过滤。
   （不用触发器删 FTS 行，因为恢复时还得重插，得不偿失。）
2. **批量写入**：转写按 chunk 插入 segments，触发器会逐行更新 FTS。大批量导入时可
   `INSERT INTO segments_fts(segments_fts) VALUES('rebuild')` 一次性重建更快 —— 由索引重建任务用，不在热路径用。
3. **优化**：定期 `INSERT INTO xxx_fts(xxx_fts) VALUES('optimize')`（维护 job，priority=30）。
4. **`unindexed` 列**：本设计不用，需要额外字段一律回原表 join。

### 4.2 查询与高亮

```sql
-- 段落搜索（返回可直接 seek 的时间点）
SELECT s.id, s.transcript_id, s.start_ms, s.end_ms,
       t.note_id, n.uid AS note_uid, n.title,
       highlight(segments_fts, 0, '<mark>', '</mark>') AS snippet,
       bm25(segments_fts) AS score
FROM segments_fts
JOIN transcript_segments s ON s.id = segments_fts.rowid
JOIN transcripts t ON t.id = s.transcript_id AND t.is_active = 1
JOIN notes n       ON n.id = t.note_id AND n.deleted_at IS NULL
WHERE segments_fts MATCH :q
ORDER BY score
LIMIT :limit;
```

- **中文查询串必须经 libsimple 的查询构造函数处理**（否则整句会被当成一个 token）。
  `[已核实]` libsimple README 的原文用法：
  ```sql
  SELECT simple_highlight(t1, 0, '[', ']') AS text
  FROM t1 WHERE text MATCH simple_query('中华国歌');
  ```
  提供的辅助函数（README 明列，**但未给出形参级签名**，以下为用法级确认）：
  `simple_query(text)` · `simple_highlight(表, 列序号, 开标签, 闭标签)` · `simple_highlight_pos()` ·
  `simple_snippet()` · `jieba_query()` · `jieba_dict(path)` · `pinyin_dict(path)`。
  **拼音检索原生支持**（可开关；内置 `contrib/pinyin.txt`，可用 `pinyin_dict()` 换自定义词典）
  → 这是 memo.ac 完全没有的能力，值得做成"拼音模糊搜"开关。
  实现层仍需把"查询串 → MATCH 表达式"的构造收口到 `search/queryBuilder.ts` 一个函数里，便于降级替换。
- **绝不把用户输入直接拼进 MATCH 字符串**：FTS5 的 MATCH 有自己的语法（`"` `*` `NEAR` `AND/OR/NOT` `:` `-` `^`）。
  必须转义或按 token 重组 —— 这是**注入面**（虽然只能打乱查询不能越权，但会造成语法错误与困惑）。

### 4.3 向量检索（sqlite-vec）

> `[已核实]` `sqlite-vec` **v0.1.9**（2026-03-31，npm 同版本）。语法从 README + `sqlite-vec.c` 源码交叉验证：
>
> | 语法 | 含义 |
> |---|---|
> | `CREATE VIRTUAL TABLE t USING vec0(emb float[8])` | 基本形式 |
> | `float[N]` / `int8[N]` / `bit[N]` | 支持的三种向量元素类型 |
> | `col TYPE` （普通列） | **元数据列**：可用于 `WHERE` 过滤，不参与向量索引 |
> | `+col TYPE` （加号前缀） | **辅助列**：仅透传存储，不可过滤 |
> | `col TYPE partition key` | **分区键列**，例 `user_id integer partition key` |
> | 插入值 | JSON 字符串或紧凑二进制格式均可 |
>
> ⚠️ **源码级限制**：分区键列**不能与 rescore / IVF / DiskANN 索引同时使用**。
> ⚠️ 上游 README 明确警告仍是 pre-v1，"expect breaking changes" → 见 §4.5 的可重建原则（这正是我们把
> 向量原文留在 `embed_chunks.text` 的原因）。

```sql
-- 原文与元数据在普通表（**这才是数据**）
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
CREATE INDEX idx_embed_note  ON embed_chunks(note_id, seq);
CREATE INDEX idx_embed_state ON embed_chunks(state);

-- 向量索引（**可重建缓存**，维度由激活的 embedding 模型决定，故为动态 DDL）
-- 由代码在选定 embedding 模型后创建；模型变更时 DROP + 重建。
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id  integer primary key,       -- = embed_chunks.id
  embedding float[{{EMBED_DIM}}],      -- 例：1024（bge-m3）/ 768 / 384
  note_id   integer                    -- 元数据列：支持"只在这篇笔记里语义搜索"的预过滤
);
```

> **不用 `partition key`**：分区键与 rescore/IVF/DiskANN 索引互斥（上游源码限制），
> 而我们更可能用到后者。`note_id` 作为**普通元数据列**已足够支撑按笔记过滤。`[设计]`

#### ★ 写入 `vec0` 的绑定约定（**T-014 实测踩到的坑，必须遵守**）

`[已验证：oss-scout 在 T-014 实测，两个驱动表现完全一致]`

**把 JS 的 `number` 绑给 `vec0` 的 rowid / 主键列，必定失败**：

```
Error: Only integers are allows for primary key values
```

**这是 `sqlite-vec` v0.1.9 自身的行为，不是驱动 bug** —— `better-sqlite3` 与 `node:sqlite`
表现一致，换驱动救不了。原因是 JS 的 `number` 到了 SQLite 绑定层是 `FLOAT`，
而 `vec0` 对主键只接受 `INTEGER`。

**四种可用写法（均已实测通过）**：

| 写法 | 示例 |
|---|---|
| ✅ **绑 `BigInt`**（**我们的统一约定**） | `stmt.run(BigInt(chunkId), embJson, BigInt(noteId))` |
| ✅ SQL 字面量 | `INSERT INTO vec_chunks(chunk_id, …) VALUES (123, …)` |
| ✅ 省略 rowid 让其自增 | `INSERT INTO vec_chunks(embedding) VALUES (?)` |
| ✅ `CAST(? AS INTEGER)` | `VALUES (CAST(? AS INTEGER), ?)` |
| ❌ 绑 JS `number` | `stmt.run(123, …)` → 报上面的错 |

**约定（写死，不给选择余地）**：

> **凡是写入 `vec0` 虚拟表的整数列，一律绑 `BigInt`；
> 转换在 DB 适配层内部完成，业务代码继续传普通 `number`。**

理由：让每个调用方各自记得 `BigInt(...)` 是必然会漏的（漏了要到运行时才炸）。
收口到适配层（ADR-005 决策 6 定的那一层）只有一处需要正确。
适配层应提供 `vecInsert(table, {rowid, vector, meta})` 之类的窄接口，**内部统一做 `BigInt` 转换**，
并在类型层面禁止直接把 `number` 传进 `vec0` 的语句。

> 📌 这条约定同时是**双 ID 约定的落地细节**：D-02 §1.1 规定内部主键是 `INTEGER`，
> 而 sqlite-vec 正是靠这个整数 rowid 与 `embed_chunks.id` 关联 —— 绑定方式错了，整条关联链就断。
> 不写死的话 T-013 / T-016 会各写各的，跑起来才发现。

分块策略 `[设计]`：转写按**语义窗口**切（约 300–500 字，按段落边界对齐，重叠 15%），
每块记录其覆盖的 `start_ms/end_ms` → **语义搜索的结果也能直接 seek 到音频位置**（与 §3.3 一致）。

### 4.4 混合检索（RRF 融合）

```
关键词路（FTS5 bm25）  →  排名列表 A
语义路（vec kNN）      →  排名列表 B
融合：score(d) = Σ_over_lists 1 / (k + rank_i(d))    ，k = 60（RRF 常用值）
```
选 RRF 而非加权和的理由：bm25 与余弦距离**量纲完全不同**，加权和需要按语料调参且不稳定；
RRF 只用**名次**，无量纲、无需调参、对异常分值鲁棒。`[设计，未做效果评测]`

前端可切换三档：`关键词` / `语义` / `混合（默认）`。向量索引不可用时自动隐藏后两档（§4.5）。

### 4.5 索引 = 可重建缓存（关键原则）

| 场景 | 行为 |
|---|---|
| libsimple 加载失败 | FTS5 降级为内置 `tokenize='trigram'`（中文可用，效果差些）→ 标记 `search_index_version` 变更 → 后台重建 |
| sqlite-vec 加载失败 | 语义/混合检索关闭，关键词照常；UI 灰掉开关并说明原因 |
| sqlite-vec 升级导致格式不兼容 | `DROP TABLE vec_chunks` → 重建虚拟表 → 从 `embed_chunks.text` **重新算向量**（要重跑 embedding，是耗时任务，进后台队列 priority=30）|
| 换 embedding 模型 | 同上；`app_meta.embed_model_id` 与 `embed_dim` 变更即触发 |
| FTS 索引损坏 | `INSERT INTO xxx_fts(xxx_fts) VALUES('rebuild')` |

**因此：`PRAGMA user_version`（业务 schema）与 `app_meta.search_index_version`（索引）是两条独立的版本线。**
索引版本不匹配**不阻塞启动**，只在后台重建并在 UI 显示进度。这条设计直接消解了 R-03 §D9 提出的
"sqlite-vec 还是 0.1.x，磁盘格式可能变"的风险。

---

## §5 迁移策略

### 5.1 版本与执行

- 版本号 = `PRAGMA user_version`（整数，单调递增）。同时冗余写入 `app_meta.schema_version` 便于 SQL 查询。
- 迁移文件：`apps/daemon/src/db/migrations/NNNN_<slug>.sql`（复杂数据变换用同名 `.ts` 补充）。
- 执行器：
  ```
  cur = PRAGMA user_version
  if cur > MAX_SUPPORTED:  拒绝启动（D-01 §2.6）
  if cur < MAX_SUPPORTED:
      备份：VACUUM INTO 'backups/openmemo-v<cur>-<ts>.db'   ← 原子、已压缩、不锁太久
      for v in (cur+1 .. MAX_SUPPORTED):
          BEGIN IMMEDIATE
            执行 NNNN.sql / NNNN.ts
            PRAGMA user_version = v
          COMMIT            ← 每个迁移一个事务；中途失败则该版本整体回滚
      保留最近 3 份备份，其余删除
  ```
- **无 down migration**。桌面单机场景降级的正确做法是**从备份恢复**，写反向迁移是纯粹的维护负担且极易写错。

### 5.2 SQLite ALTER 的限制与应对

SQLite 只支持 `ADD COLUMN` / `RENAME TABLE` / `RENAME COLUMN` / `DROP COLUMN`(3.35+)。
改类型、加/删约束、改外键都必须**重建表**，按官方 12 步流程：

```sql
PRAGMA foreign_keys = OFF;          -- 必须在事务外
BEGIN;
  CREATE TABLE notes_new (...);      -- 新结构
  INSERT INTO notes_new SELECT ... FROM notes;
  DROP TABLE notes;
  ALTER TABLE notes_new RENAME TO notes;
  -- 重建该表的所有索引、触发器、视图（★ 极易漏，尤其是 FTS 触发器）
COMMIT;
PRAGMA foreign_key_check;           -- 必须检查，有输出就说明数据坏了
PRAGMA foreign_keys = ON;
```

**硬性规则**：
1. 任何重建表的迁移**必须**在同一个 `.sql` 里重建其全部索引与触发器（尤其 FTS 同步触发器 —— 漏了会导致索引静默停止更新，是最难查的一类 bug）。
2. 重建含 FTS 外部内容的表后，**必须**跟一条 `rebuild` 指令重建 FTS 索引。
3. 迁移里**禁止**调用任何扩展函数（libsimple/vec 可能没加载成功）。索引相关的重建走 §4.5 的独立版本线。
4. 迁移**必须幂等可重跑**（用 `IF NOT EXISTS` / 先检测再改），因为崩溃可能发生在 COMMIT 之后、`user_version` 之前（虽然我们把两者放同一事务里已经规避，但防御性写法零成本）。

### 5.3 数据修复迁移

某些变更需要读写数据（如把旧的 `mindmap` Markdown 字段转成规范化节点表）。这类走 `.ts` 迁移：
- 分批处理（每批 500 行一个事务），带进度日志；
- 大库（>100 万行）时在 daemon 启动后**后台执行**，UI 显示"正在升级数据（可继续使用）"，并对未迁移数据降级只读 `[设计]`。

### 5.4 备份与恢复

| 时机 | 动作 |
|---|---|
| 每次 schema 升级前 | `VACUUM INTO backups/openmemo-v<n>-<ts>.db`（保留 3 份） |
| 用户手动 | 设置页"立即备份" |
| 定期（可选，默认关） | 每周一次，保留 4 份 |
| **恢复** | 停 daemon → 校验目标文件的 `user_version` ≤ 当前支持 → 把当前库改名为 `.corrupt-<ts>` → 复制备份就位 → 启动 |

**`VACUUM INTO` 而非文件拷贝**：它在事务中生成一致快照，不需要停机，且顺带整理碎片。
直接拷 `.db` 而不拷 `-wal` 会得到一个**旧且不完整**的库 —— 这是常见的备份事故。

---

## §6 文件存储布局

### 6.1 各 OS 根目录

| 用途 | macOS | Windows | Linux |
|---|---|---|---|
| **数据根** `<data_root>` | `~/Library/Application Support/OpenMemo` | `%LOCALAPPDATA%\OpenMemo` | `${XDG_DATA_HOME:-~/.local/share}/openmemo` |
| **缓存**（可安全删） | `~/Library/Caches/OpenMemo` | `%LOCALAPPDATA%\OpenMemo\Cache` | `${XDG_CACHE_HOME:-~/.cache}/openmemo` |
| **配置**（可选独立） | 同数据根 | 同数据根 | `${XDG_CONFIG_HOME:-~/.config}/openmemo` |
| **日志** | `<data_root>/logs`（不用 `~/Library/Logs`，保持诊断包自包含） | `<data_root>\logs` | `<data_root>/logs` |

**两条硬规则** `[已定，R-04 §6.1]`：
1. **模型与媒体绝不放 Caches 目录**——macOS 会在磁盘紧张时自动清理，几 GB 模型被静默删掉是灾难。
2. **Windows 用 `LOCALAPPDATA` 不用 `Roaming`**——域环境下漫游配置会尝试同步，几 GB 会拖垮登录。

**覆盖顺序**：`OPENMEMO_DATA_DIR` 环境变量 > `--data-dir` 参数 > 设置里的自定义路径 > 上表默认。
`OPENMEMO_MODELS` 可单独把模型目录指到大盘（笔记本 C 盘小、外置 SSD 大是常见场景）。
**必须支持"更改目录 + 迁移"**：同卷 `rename`（瞬时）；跨卷复制 + 逐文件 SHA256 校验 + 删源，带进度与可中断 `[已定，R-04 §6.1]`。

### 6.2 完整目录树

```
<data_root>/
├── openmemo.db                     主库
├── openmemo.db-wal / -shm          WAL（备份时必须一起，或用 VACUUM INTO）
├── runtime.json          (0600)    pid / port / token / instanceId（D-01 §2.3）
├── daemon.lock                     数据目录级互斥（flock / O_EXCL）
├── crash.json                      崩溃计数（安全模式判定，D-01 §2.7 D）
│
├── backups/
│   └── openmemo-v7-20260802T120000Z.db
│
├── logs/
│   ├── daemon-2026-08-02.log       结构化 JSON，保留 7 天
│   └── subprocess/<jobUid>-<step>.log
│
├── media/                          ★ 用户内容，最大的目录
│   └── <noteUid>/                  按笔记分目录（删笔记 = 删一个目录，GC 简单）
│       ├── original.mp4            ← 文件名**由我们生成**（D-01 §8.5）
│       ├── audio16k.wav            ASR 唯一输入格式
│       ├── transcode.m4a           仅在浏览器放不了原格式时生成
│       ├── peaks.ompk              预计算波形（§3.4）
│       ├── thumb.jpg
│       ├── shots/<ms>.jpg          摘要配图
│       └── archive.webm            F3 录音存档
│
├── models/                         ★ R-04 §6.2 已定的内容寻址布局，原样沿用
│   ├── blobs/sha256-<hex>[.partial][.partial.json]
│   ├── manifests/<role>/<id>.json  ← **模型元数据的权威源**（DB 表只是索引，§1.8）
│   ├── by-name/<role>/<可读名>     硬链接视图（Windows 用 hardlink 不用 symlink，无需管理员权限）
│   ├── catalog/{catalog.json,.sig,.etag,bundled.json}
│   └── state.json
│
├── backends/                       GPU 后端与工具二进制（运行时下载，ADR-001 C 类）
│   ├── <platform>-<arch>/
│   │   ├── whisper/<backend>/      cpu|cuda|vulkan|rocm|metal|coreml —— 同目录多丢几个 .so/.dll
│   │   ├── llama/<backend>/
│   │   ├── sherpa/
│   │   └── ggml-probe
│   └── manifests/                  与 vendor/manifests 对账（可追溯，ADR-001 强制配套 1）
│
├── bin/                            ffmpeg / ffprobe / yt-dlp / 7z（allowlist 的唯一来源，D-01 §8.4）
│
├── exports/                        用户触发的导出产物（可安全删）
├── plugins/                        预留（v1 不启用，D-01 §8.3）
└── tmp/                            ★ 每次启动整目录清空
    ├── uploads/<uploadUid>.part    F2 分块上传
    ├── jobs/<jobUid>/              子进程工作目录（cwd 指这里）
    └── orphans/                    GC 隔离区，保留 7 天再删
```

### 6.3 落盘规则

| 规则 | 内容 |
|---|---|
| **文件名一律我们生成** | 用户提供的名字只进 `media_assets.display_name`。从根上消灭路径穿越、Windows 保留名、NTFS ADS、Unicode 同形字、尾随点/空格（D-01 §8.5）|
| **DB 只存相对路径** | 相对各自的根（`media/` 或 `backends/`）。数据目录可整体搬迁 |
| **写入用临时名 + rename** | 先写 `<name>.tmp-<rand>`，`fsync` 后 `rename` 到目标（同卷 rename 原子）。**保证不存在"写了一半的 asset"** |
| **删除先移 `tmp/orphans/`** | 保留 7 天再真删，防误判 |
| **磁盘空间预检** | 下载/转码前检查目标卷剩余空间 ≥ 预估需求 × 1.3，不足则 job → `blocked(RESOURCE_DISK_FULL)` |
| **跨卷不硬链接** | `by-name/` 硬链接失败时降级为不创建（记 warning，非致命）`[已定，R-04 §6.2]` |

### 6.4 GC 与引用计数

```
媒体：media_assets 是唯一真相
  - 扫描 <data_root>/media/**，不在 media_assets.rel_path 中的 → tmp/orphans/（7 天后删）
  - media_assets 中 rel_path 不存在的 → state='missing'，UI 显示"文件已丢失"（不删行，用户可重新导入）
模型：blobs 引用计数 = manifests 中引用该 digest 的条目数（R-04 §6.5 已定）
后端：按 backend_installs 记录；state='disabled' 且 90 天未用 → 提示用户清理
临时：tmp/ 启动即清；exports/ 30 天未访问提示清理
```
GC 是 `priority=30` 的维护 job，**只在空闲时跑**（无 running job 且 5 分钟无 API 请求）。

---

## §7 待验证清单（诚实）

| # | 事项 | 影响 | 状态 |
|---|---|---|---|
| V-1 | 本文 DDL 是否能在真实 SQLite 上跑通 | 全局 | ✅ **已实证关闭（T-014，`oss-scout`）**：§4 的**全部 DDL 在真实 SQLite 上跑了一遍** —— 外部内容表、三组同步触发器、`tokenize='simple'`、bm25、`simple_query`/`simple_highlight`、**拼音检索**（`swdt`/`zx`/`sjz` 全命中）、WAL、外键、`vec0` 元数据列 KNN，**全部通过**。<br>⚠️ 仍未跑通的部分：§1 的 26 张业务表 DDL（jobs/notes/mindmap 等）尚未整体执行，T-016 落 `0001_init.sql` 时仍需实测 |
| V-2 | `mind-elixir` 的包名/版本/`NodeObj` 字段名 | §2.3 映射表 | ✅ **已核实**（读源码 `src/types/index.ts`）。**订正：npm 包名是 `mind-elixir` v5.14.0，不是 `mind-elixir-core`**；`MindElixirData` **无 `linkData`** |
| V-3 | `markmap-lib.transform()` 的输入 | §2.3 / 只读视图实现 | ✅ **已核实**：只吃 Markdown 字符串；但 `Markmap.create()` 吃 `IPureNode` → **改为直接构造 `IPureNode`** |
| V-4 | libsimple 的加载与 `tokenize='simple'`、辅助函数、拼音 | §4.1/§4.2 | ✅ **已核实**（README 原文）。函数**形参级签名**仍 UNKNOWN，只有用法级示例 |
| V-5 | `sqlite-vec` 的 `vec0` 语法/类型/元数据列/分区键 | §4.3 | ✅ **已核实**（README + `sqlite-vec.c` 源码交叉验证，v0.1.9） |
| V-6 | `better-sqlite3` 能否加载 libsimple / sqlite-vec | §4 全部 | ✅ **已实证关闭（T-014）**：两个扩展均加载成功、功能跑通。**R-03 §U-5 的实测项已完成。**<br>📌 本项原提法（"查 `compile_options` 是否有 `ENABLE_LOAD_EXTENSION`"）**基于错误前提**，已在 §4.1 写入方法论更正：**扩展能力只能实测，不能读 `compile_options` 推断** |
| V-6b | `vec0` 主键/rowid 的绑定方式 | §4.3 | ✅ **已实证（T-014）**：绑 JS `number` **必失败**（`Only integers are allows for primary key values`），两驱动一致 → 是 sqlite-vec v0.1.9 的行为。**已在 §4.3 写死"一律绑 `BigInt`，转换收口到 DB 适配层"** |
| V-6c | 驱动选型 | §1.0/§4 | ✅ **已定案（ADR-005 决策 6）**：`better-sqlite3` v13 为主 + `node:sqlite` 已验证备胎 + 薄 DB 适配层。**D-02 本就按 better-sqlite3 写，无需改动。**<br>⚠️ 残留风险（`oss-scout` 如实记录）：**只在 Linux x64 glibc 实测**；mac/Win/arm64/musl 的 prebuild 全未实测；上游 open issue **#1509**（`linux-arm64.node` 要求 GLIBC_2.38）未复现 |
| V-7 | 重转写后 `quote` 相似度重定位的实际准确率与阈值（0.75/0.4） | §3.5 | 未验证，需 Wave 3 用真实数据调 |
| V-8 | RRF 融合的检索效果 | §4.4 | 未做评测 |
| V-9 | 波形格式的 `samplesPerPixel=256` 是否合适（体积 vs 精度） | §3.4 | 未验证 |
| V-10 | `PRAGMA mmap_size` 在 Windows 上的兼容性 | §1.0 | 未验证（无 Windows 机器） |
| V-11 | `whisper.cpp` 是否输出可用的词级时间戳（供 `words_json`） | §1.5 / karaoke 高亮 | **待核实** |

---

## §8 附录：memo.ac v1.7.5 实际数据模型对照 `[BIN 取证，已核实]`

> 来源：本次从 `/root/memo-forensics/app.asar` 提取主进程 bundle（`dist-electron/main/index-c57c11a9.js`，11.97 MB，
> 未混淆）逆向出的 knex `createTable(...)` 字面量。**仅作参考，不复制其源码**（ADR / 章程 C2 约束）。

**它的 9 张表**：`workspace` · `folder` · `resource` · `doc` · `note` · `download` · `tag` · `note_tag` · `doc_tag`

| 我们的做法 | memo.ac 的做法 | 差异理由 |
|---|---|---|
| `PRAGMA user_version` + 有序迁移 + 升级前自动备份（§5） | **无版本机制**：运行时 `hasTable` → 不存在则 `createTable` 的幂等构建。全库 grep **`PRAGMA user_version` 零命中** | 它无法做"改列/加约束"这类演进，只能加表。我们必须能演进 |
| 笔记正文 `notes.body_json` **存库** | DB 里 `note.content` 只是索引，真正内容在磁盘 `<workspace>/<folder>/<noteId>/notes/data.json` | 内容进库才能事务一致、才能被 FTS5 索引、才能原子回滚。它的双层结构会有"DB 与文件不同步"的经典问题 |
| `transcript_segments` 带 `confidence` / `no_speech_prob` / `words_json` / `flags` | **只有 `{start, end, text(+speaker)}`**。全库 grep `avg_logprob` / `no_speech_prob` **零命中**，`confidence` 的 1 处命中是术语表匹配度、`probability` 的 5 处是语言检测概率，**都与 ASR 段落无关** | 没有置信度就做不了"低置信高亮""幻觉检测""只重跑坏块"（R-01 §C11 #7 的 whisper 重复顽疾正因此无从下手） |
| 思维导图规范化表 + 库无关 `MindMapDoc`（§1.6/§2） | **`markmap-common/lib/view@^0.15.5`，无自定义 schema**——导图就是一段 Markdown 大纲文本 | 印证 ADR-002 决策 3 的判断：markmap 路线天然不可做节点级编辑、不可给节点挂时间戳、不可存自由连线 |
| `tags` + `note_tags`（含 `source='user'\|'ai'`） | **`tag` / `note_tag` / `doc_tag` 三张表确实存在** | ⚠️ **这一条订正 R-01 §A2.5 的"未发现标签系统"判定**——底层已实现，可能只是 UI 未开放。建议 Manager 知悉 |
| 无 workspace 层（建议，见 §9 决策项 2） | 有 `workspace` 表（`{name, folder, icon, thumbnail, backgroundColor}`）+ `workspaces/index.json` | 它是为"共用电脑"设计的（R-01 §A2.5）。我们的场景是个人自用，多一层导航成本大于收益 |
| 数据根 `~/Library/Application Support/OpenMemo`（§6.1） | `~/Library/Application Support/Memo/{storage/local.db, models/, temp/, plugins/, conf/setting.conf, locales/, workspaces/index.json}` | 布局约定一致，印证 §6.1 的选择是行业惯例 |
| 单笔记目录内固定文件名（§6.2） | `thumbnail / transcribe / transcode / metadata.json / source / subtitle / project.json / resource.json / data.json` | 结构可借鉴，我们更进一步：文件名全部由我们生成（D-01 §8.5） |

**它的 342 个 IPC 通道分类**（我们的 REST 面应覆盖等价能力，用作**完备性自检清单**）：

| 域 | 数量 | 代表通道 | 我们的对应 |
|---|---|---|---|
| `llm:*` | 16 | `llm:get-services` / `llm:model-registry:update` / `llm:test-service` | LLM 适配层 + 设置（D-01 §6.2）|
| `correction:*` | 16 | `correction:correct-subtitles` / `correction:create-glossary` | v1 不做（AI 字幕纠错/术语表），预留 |
| `translate:*` | 14 | `translate:create-glossary` | `segment_translations` 已预留（§1.5），启用与否见决策项 3 |
| `ytdlp:*` | 12 | `ytdlp:download-version` / `ytdlp:check-update` / `ytdlp:export-cookies` | 媒体源适配层 + downloader（D-01 §6.4，含"独立更新 yt-dlp"）|
| 模型管理 | ~25 | `download-model` / `check-model-sha` / `import-models` | T-013 的模型 API + `model_installs`（§1.8）|
| 下载基建 | ~22 | `start-download` / `check-download-folder-space` | 统一 downloader（ADR-003 决策 6）+ 磁盘预检（§6.3）|
| 引擎/插件 | ~19–25 | `install-extensions` / `checkExtensionExists` | `backend_installs`（§1.8）+ 运行时页 |
| Whisper 控制 | 8 | `startWhisperServer` / `checkWhisperCudaExist` | ASR 适配层（D-01 §6.1）|
| 实体 CRUD | 5 条**多路复用**通道 | `note-data` / `doc-data` / `workspace-data` / `folder-data` / `resource-data` | 我们用 RESTful 资源路由，**不做单通道多路复用**（那会让契约无法用 schema 描述） |
| 窗口/导出/设备 | ~15 | `export-video` / `get-device-manager-info` | 导出 job + 运行时探测 |
| AI 顶层 | 3 | `ai-mindmap` / `ai-summarize` / `chat` | F4 结构化 job（D-01 §5 F4）|

---

## §9 需要 Manager 决策的事项

见 `coordination/inbox/architect.md`。与本文相关的：

1. **`secrets` 表的加密方式**（v1 明文 0600 vs OS keychain）。
2. **是否引入 workspace 层级**（本文只做 `folders` 树；memo.ac 有 workspace）。
3. **翻译 / 双语字幕是否进 v1**（本文已预留 `segment_translations`，未启用则该表可从 `0001_init.sql` 中移除）。
4. **`packages/mindmap` 的 owner 是谁**（BOARD 的文件所有权表未指派；§2 的类型与转换器需要有人写）。
5. **对外 ULID `uid` + 对内整数 PK** 的双 ID 约定需 T-013 在 `packages/shared` 中对齐（API 只暴露 `uid`）。
