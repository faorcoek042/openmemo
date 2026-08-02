# 任务看板 — OpenMemo

> 仅 Meta Manager 写。Agent 只读。进展写到自己的 `coordination/inbox/<name>.md`。

## 已生效的决策（**所有 agent 必读**）
- `docs/adr/ADR-001` 依赖引入三分法（submodule / 包管理器 / 运行时下载）
- `docs/adr/ADR-002` 许可证政策 **v2 = 个人自用档**（用户已定：仅自用 + 直接内置 yt-dlp）
- `docs/adr/ADR-003` **进程模型 = 本地 daemon + 浏览器 UI（web-first）**、GPU 后端策略、ad-hoc 签名
- `docs/adr/ADR-004` 模型管理：镜像运行时探测、schema 补量化与显存字段、SSE 单流

## 仓库布局（Manager 定，不得擅改）
```
apps/daemon/      Node.js + TS 本地服务（127.0.0.1 ONLY）
apps/web/         React SPA —— 唯一 UI
packages/shared/  共享契约：API schema + 数据模型 + TS 类型
packages/runtime/ 硬件探测 + GPU 后端包管理
packages/downloader/ 统一下载器（后端包与模型共用）
packages/pipeline/   媒体导入 → 转写 → 结构化
packages/mindmap/    库无关的思维导图数据模型 + 适配层
vendor/           git submodules（需自建的 C/C++）
vendor/manifests/ 运行时下载物清单（URL + SHA256 + 许可证）
scripts/          构建脚本
```

## Wave 1 — 研究 ✅ 全部完成
| ID | 任务 | agent | 交付物 | 状态 |
|----|------|-------|--------|------|
| T-001 | memo.ac 产品与技术取证 | `memo-researcher` | `R-01-memo-ac.md` | 🟢 |
| T-002 | 跨平台 GPU/ASR 运行时 | `gpu-runtime` | `R-02-runtime-gpu.md` | 🟢 |
| T-003 | 开源选型 + 许可证 | `oss-scout` | `R-03-oss-modules.md` | 🟢 |
| T-004 | 模型管理方案 | `model-mgmt` | `R-04-model-mgmt.md` | 🟢 |

## Wave 2 — 架构与骨架（进行中，4 并发跑满）
| ID | 任务 | agent | 交付物 | 状态 |
|----|------|-------|--------|------|
| T-010 | 总体架构 + 数据模型 | `architect` 🆕 | `docs/design/D-01`, `D-02` | 🔵 |
| T-011 | 仓库骨架 + submodule 落地 | `oss-scout` ♻️ | monorepo 骨架, `.gitmodules` | 🔵 |
| T-012 | 构建系统 + **Linux 实测 spike** | `gpu-runtime` ♻️ | `scripts/`, `packages/runtime/`, `D-04` | 🔵 |
| T-013 | 统一下载器 + API 契约固化 | `model-mgmt` ♻️ | `packages/shared/`, `manifests/`, `D-03` | 🔵 |

### 文件所有权（防写冲突，硬约束）
| agent | 独占写入 |
|-------|---------|
| `architect` | `docs/design/D-01*`, `D-02*`（**只写文档，不写代码**）|
| `oss-scout` | 根配置、`apps/*/package.json`、`vendor/`、`.gitmodules`、各包的 `tsconfig` 与占位 `index.ts` |
| `gpu-runtime` | `packages/runtime/src/**`、`scripts/**`、`.github/workflows/**`、`docs/design/D-04*` |
| `model-mgmt` | `packages/shared/src/**`、`packages/downloader/src/**`、`vendor/manifests/*.json`、`docs/design/D-03*` |

## Wave 3 — 开发（待启动）
| ID | 任务 | 状态 |
|----|------|------|
| T-020 | 转写流水线（F1/F2/F3） | ⚪ |
| T-021 | 前端：捕获 → 转写 → 笔记 UI | ⚪ |
| T-022 | 前端：运行时与模型管理页（要求 2.1/2.2） | ⚪ |
| T-023 | 思维导图生成与编辑（F4） | ⚪ |
| T-024 | 打包分发 | ⚪ |

图例：⚪ 待启动 🔵 进行中 🟢 完成 🔴 阻塞 🆕 新建 ♻️ 复用
