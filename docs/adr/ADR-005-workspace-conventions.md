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

| 路径 | 所有者 |
|------|--------|
| `scripts/build-*.{sh,mjs}`、`scripts/ci-*` | `gpu-runtime` |
| `scripts/license-report.mjs` | `oss-scout` |
| `packages/downloader/scripts/**` | `model-mgmt` |

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
| ID | 内容 | 何时清 |
|----|------|--------|
| TD-001 | 重开 `noUnusedLocals`/`noUnusedParameters` 并清理 | Wave 3 结束前 |
| TD-002 | ffmpeg / yt-dlp 适配层落地（GPL 可替换性） | T-020 |
| TD-003 | `better-sqlite3` 需用户机器有编译工具链 —— 见 T-014 待定 | T-014 结论后 |
