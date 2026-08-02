# inbox — architect

## [2026-08-02 14:05] T-010 DONE

交付:
- `/root/memo/docs/design/D-01-architecture.md` （id: D-01，status: draft）
- `/root/memo/docs/design/D-02-data-model.md` （id: D-02，status: draft）

要点:
- D-01 覆盖：组件图 / 进程与生命周期（端口 17650 + 端口即单实例锁 + token 走 URL fragment 换 HttpOnly cookie + 优雅退出 + 崩溃恢复 + 安全模式）/ API 四通道分层（REST · **全局单 SSE** · WS · 独立 `/media` 字节流）/ 任务队列（Job-Step-**Chunk** 三层，chunk 边界 = 抢占点 = 续跑点 = 进度点）/ F1–F5 五张 mermaid 时序图 / 四个适配层 / 降级矩阵 + 熔断 / 安全（含 **7 层命令注入防护**）。
- D-02 覆盖：完整 DDL（**26 张普通表 + 4 张虚拟表**）/ 库无关 `MindMapDoc`（map-of-nodes + `extensions` 沙箱 + 损失矩阵 + MD/OPML/FreeMind 导出）/ F5 联动的**三层引用**（时间权威 + quote 重定位 + segment_id 仅缓存，**重转写后链接不失效**）/ FTS5+libsimple+sqlite-vec+RRF 混合检索 / 迁移策略 / 三 OS 存储布局。
- **我只写了这两份文档，未写任何代码**（遵守 BOARD 文件所有权表）。
- 派生了 2 个 sonnet subagent（均已完成，可复用）：`a87e28047aee41606`（forensics 挖掘）、`a1d3c731e8b1b2ec0`（上游 API 核实）。

已核实并**订正上游文档**的 3 处（重要）:
1. **npm 包名是 `mind-elixir`（v5.14.0），不是 `mind-elixir-core`** —— 后者是 GitHub 仓库名，npm 上 **404**。ADR-002 决策 3、R-03 §D7、BOARD 均写作 `mind-elixir-core`，**请 Manager 决定是否订正 ADR-002 措辞**；无论如何 T-011 写 `package.json` 时必须用 `mind-elixir`。（另：`MindElixirData` **没有 `linkData` 字段**，自由连线只有 `arrows`。）
2. **R-01 §A2.5 判定 memo.ac「无标签系统」有误** —— 本次从 `app.asar` 逆向出的 knex schema 里 `tag` / `note_tag` / `doc_tag` **三张表确实存在**（可能 UI 未开放）。不影响我们的设计（我们照样做标签），但 R-01 该条结论建议标注订正。
3. **R-01 §A2.5 的「7 个 migration 文件 [BIN]」在 `app.asar` 中无法复现** —— 全量 grep `note_mp3_path` 零命中，asar 内无应用层 migration 文件。疑似该证据来自其 GitHub 源码仓库而非打包产物，**证据等级标签 `[BIN]` 可能不准**。（memo.ac 实际是运行时 `hasTable→createTable` 幂等建表，**无 `PRAGMA user_version`**，无 schema 版本机制。）

下一步建议:
1. Wave 3 开工前必须先做 3 个 spike：① `better-sqlite3` v13 的 bundled SQLite 能否 `loadExtension` 加载 libsimple/sqlite-vec（R-03 §U-5 已列，**决定 §4 全部检索方案是否降级**）；② 浏览器 WebGPU(transformers.js) 转写是否真能用（决定 L0 档存废）；③ Vulkan vs CUDA 的 whisper 实测（ADR-003 决策 3 明说是临时立场）。
2. D-01/D-02 目前是 `draft`。建议在 T-011 把 `0001_init.sql` **实测跑通**、T-013 的 D-03 契约定稿后，我再做一轮收敛并转 `ready`。
3. `packages/mindmap` 在 BOARD 的文件所有权表里**无 owner**，但 D-02 §2 的类型与转换器需要有人写 —— 建议 Wave 3 的 T-023 认领。

需要 Manager 决策:
1. **API Key / secrets 存储方式**。选项 A：SQLite `secrets` 表明文 + 文件 0600/目录 0700 + UI 明确告知"未加密"（零依赖，v1 默认）；选项 B：OS keychain（macOS Security / Windows DPAPI / libsecret）—— 但 `keytar` 已归档无维护，需自己写或找替代原生依赖，**跨平台成本不低且与"无 Electron"的 web-first 架构不太合拍**。我倾向 A + schema 已预留 `enc` 字段可平滑升级。
2. **默认端口拍板**。我提议 **17650**（已确认在 Linux/Windows/macOS 三家的临时端口段之外，且不撞 3000/5173/8080/11434/1234/9588）。端口一旦定下需同步给 T-011（快捷方式壳）、T-013（前端 baseURL）。**注意：端口稳定不是美观问题——浏览器的麦克风授权按 origin 隔离，端口变了 F3 每次都要重新授权。**
3. **`/ws/asr-worker`（浏览器 WebGPU 作为 ASR worker）的协议归谁写**。它跨了 T-013 的 `packages/shared` 契约边界（T-013 的任务书是 REST/SSE 契约）。建议：契约仍归 T-013 落在 shared 里，实现归 Wave 3 的 T-020/T-021。若 Manager 认为 L0 档不值得做，请明说 —— 我会把它从 D-01 §6.1 降级为"可选实验特性"。
4. **是否引入 workspace 层级**。memo.ac 有（为共用电脑设计），我**建议不引入**，只做 `folders` 自引用树。个人自用场景多一层导航的成本大于收益，且日后加 workspace 只是给现有表加一列 + 一次迁移，代价可控。
5. **对外 ULID `uid` + 对内整数 PK 的双 ID 约定需 T-013 认可**。这不是洁癖：FTS5 外部内容表的 `content_rowid` 与 sqlite-vec 的 rowid 关联**都要求整数**，不这么做检索方案接不上。API 只暴露 `uid`。请 Manager 转达给 T-013 以免 D-03 与 D-02 冲突。
6. **翻译 / 双语字幕 / 字幕导出是否进 v1**。章程 F1–F5 未包含，但 memo.ac 有 30 个相关 IPC 通道，是其主打卖点之一。D-02 已预留 `segment_translations` 表（不启用则可从 `0001_init.sql` 移除）。请裁决。
7. **Node 版本基线 = 22**（次要，但需尽快同步给 T-011/T-012）。`better-sqlite3` v13.0.2 的 `engines.node` 硬性要求 `>= 22`（已核实 package.json）。若 T-011 已按更低版本建骨架，需要改。
8. **ADR-002 措辞是否订正**（见上文"已核实并订正上游文档"第 1 条）。这是事实性订正，不推翻 ADR-002 的任何决策实质。

诚实声明:
- D-01/D-02 中**没有任何一行代码被执行过**，所有 DDL、时序图、接口签名均为设计意图。文中已逐条标注 `[已定]/[设计]/[待核实]/UNKNOWN`，两份文档各自末尾有独立的"待验证清单"（D-01 §10 共 9 条，D-02 §7 共 11 条）。
- 未编造任何 API、版本号或性能数字。所有版本号（`mind-elixir` 5.14.0、`markmap-lib` 0.18.12、`sqlite-vec` v0.1.9、`libsimple` v0.7.1、`better-sqlite3` 13.0.2）均由 subagent 于 2026-08-02 直接从 npm registry / GitHub API / 上游源码取得。
- 未修改任何他人的交付物；未创建 ADR；`/root/memo-forensics/` 只读引用，未复制其源码进本仓库。
