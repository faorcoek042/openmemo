---
id: ADR-005
title: 工作区约定裁决 + 所有权表修订 + 技术债登记
status: accepted
date: 2026-08-02
decider: Meta Manager
input: coordination/inbox/oss-scout.md (T-011 回执)
---

## 决策 1：`tsconfig.base.json` 暂不开 `noUnusedLocals` / `noUnusedParameters` —— **批准，但记为技术债**

`oss-scout` 原本开启，导致 `model-mgmt` 的在途代码被卡死。暂时关闭是正确的解耦判断。

**但这是暂时豁免，不是永久决定。** 登记为技术债 **TD-001**，
**Wave 3 结束前必须重新开启并清理干净**。届时由 Manager 验收。

## 决策 2：`.gitignore` / eslint 忽略 `.build/` —— **批准**

CMake 生成的 `compiler_depend.ts` 不是 TypeScript 文件，让 eslint 一次报 91 个假错误。忽略正确。

## 决策 3：文件所有权表修订（`scripts/**` 的例外）

BOARD 原把 `scripts/**` 整体划给 `gpu-runtime`，与 T-011 任务书冲突。修订为：

| 路径                                       | 所有者        |
| ------------------------------------------ | ------------- |
| `scripts/build-*.{sh,mjs}`、`scripts/ci-*` | `gpu-runtime` |
| `scripts/license-report.mjs`               | `oss-scout`   |
| `packages/downloader/scripts/**`           | `model-mgmt`  |

规则：**`scripts/` 下按文件而非目录划分所有权**，新增脚本前在 inbox 申报。

## 决策 4：`youtube-dl-exec` 的许可证盲区处理 —— **批准并推广**

`oss-scout` 发现 `pnpm licenses list` **看不到二进制 payload 的许可证**（包本身 MIT，
但下载的 yt-dlp 二进制是 GPLv3+）。他在 `license-report.mjs` 里加了
`BINARY_PAYLOAD_LICENSES` 覆盖表来修补。

**这个盲区是通用问题**（`ffmpeg-static` 同理）。要求：任何"npm 包 + 下载二进制"型依赖
都必须登记进该覆盖表，否则许可证报告是假的。

## 决策 5：GPL 污染已实体化 —— 记为技术债 TD-002

`oss-scout` 实测 `ffmpeg-static` 装出的是 `ffmpeg 7.0.2-static`，configure 含
`--enable-gpl --enable-version3 --enable-libx264/x265/frei0r/librubberband/libvidstab/libxvid`
→ **确认 GPLv3**。ADR-002 v2（个人自用档）允许，但**商用回滚成本已从理论变为实际**。

**TD-002**：`ffmpeg` 与 `yt-dlp` 必须走适配层（ADR-002 的"架构上可替换"要求），
目前**只是注释、无代码强制**。Wave 3 的 T-020 必须落地真正的适配层接口，届时 Manager 复核。

## 技术债登记表

| ID     | 内容                                              | 何时清        | 状态                      |
| ------ | ------------------------------------------------- | ------------- | ------------------------- |
| TD-001 | 重开 `noUnusedLocals`/`noUnusedParameters` 并清理 | Wave 3 结束前 | 🔴 未清                   |
| TD-002 | ffmpeg / yt-dlp 适配层落地（GPL 可替换性）        | T-020         | 🔵 进行中                 |
| TD-003 | ~~`better-sqlite3` 需用户机器有编译工具链~~       | —             | 🟢 **已关闭（前提证伪）** |

---

# 决策 6：SQLite 方案定案（T-014 实测，**关闭 TD-003**）

`oss-scout` 实测三方案后**推翻了自己在 T-011 提出的担忧**，并如实更正。这是正确的工作方式。

| 方案                      | 免编译 | FTS5 | 加载 sqlite-vec + libsimple | 插 2 万行 | 2000 次 FTS |
| ------------------------- | ------ | ---- | --------------------------- | --------- | ----------- |
| **better-sqlite3 13.0.2** | ✅     | ✅   | ✅                          | 43ms      | **101ms**   |
| `node:sqlite`（内置）     | ✅     | ✅   | ✅                          | 43ms      | 113ms       |
| `node-sqlite3-wasm`       | ✅     | ✅   | ❌ `OMIT_LOAD_EXTENSION`    | 55ms      | 306ms       |

## 裁决

**`better-sqlite3` v13 为主 + `node:sqlite` 为已验证备胎 + 中间一层薄 DB 适配层。** 采纳其推荐。

理由：

1. **TD-003 的前提是错的。** better-sqlite3 v13 已迁到 prebuildify，**8 平台预编译 `.node` 直接打在
   npm tarball 里，无 install 脚本，装时不联网**。不需要编译工具链。
2. **node-gyp 是 `oss-scout` 自己招来的** —— 他把 `better-sqlite3` 写进了 `onlyBuiltDependencies`，
   pnpm 见 `binding.gyp` 就空转一次编译，**产出 0 个 `.node`**（运行时 `dlopen` 的始终是
   `prebuilds/linux-x64.node`）。移除后 **`pnpm install` 从 1m24.8s → 500ms**。
3. **WASM 路结构性出局**：编译期就 `OMIT_LOAD_EXTENSION`，连 `loadExtension` 方法都不存在
   → 中文分词与向量检索两件套同时塌。**不是慢，是做不到。**
4. `node:sqlite` 在 **Node 22 上仍是 experimental**（实测有 ExperimentalWarning，
   `oss-scout` 下载真 Node 22.23.2 对照验证过），而 ADR-006 基线正是 22。→ 作备胎不作主力。
5. D-02 本就按 better-sqlite3 写，**迁移影响 ≈ 0**。**ADR-006 的 Node 22 基线维持不变。**

## 附带成果：D-02 的 V-6 已实证关闭

`oss-scout` 把 D-02 §4 的**全部 DDL 在真实 SQLite 上跑了一遍**（该文原自述"未在任何 SQLite 实例上执行过"）：
外部内容表、三组触发器、bm25、`simple_query/highlight`、拼音（`swdt`/`zx`/`sjz` 全命中）、
WAL、外键、`vec0` KNN —— **全部通过**。设计文档从"设计意图"升级为"已验证"。

## 由此发现 D-02 的两处必须修正（已转达 `architect`）

1. **`vec0` 的 rowid 绑 JS `number` 必失败**（两个驱动表现一致，是 sqlite-vec 的行为不是驱动 bug）
   → 须用 BigInt / 字面量 / 省略 rowid / `CAST(? AS INTEGER)`。
2. **`compile_options` 不列 `ENABLE_LOAD_EXTENSION` 也照样能加载扩展**
   → D-02 的 V-6 提法基于这个误解。**扩展能力只能实测，不能靠查 `compile_options` 推断。**

## 残留风险（未验证，如实记录）

- **只在 Linux x64 glibc 实测**；mac / Windows / arm64 / musl 的 prebuild **全未实测**（无机器）。
- 上游 open issue **#1509**：`linux-arm64.node` 要求 GLIBC_2.38 —— **未复现，是主要残留风险**。
- 性能为单次粗测；**未测并发与大规模向量**。
