---
id: FX-INDEX
author: memo-compare
status: ready
date: 2026-08-07
---

# memo.ac 取证台账（v1.7.5）

当年那轮取证的产物落在 `/tmp/memoac/`（tmpfs），**已随重启消失**。
本目录是 2026-08-07 重做一遍的结果，**落盘进仓库**，供后续 agent 直接引用而不必重新下载解包。

## 只落"事实"，不落"二进制"

本目录**只包含文本事实**：通道名、配置 schema、清单、计数、文件名列表。
**没有** memo.ac 的可执行文件、模型、图标或任何受版权资源。
引用其压缩混淆产物中的代码片段仅限于识别调度逻辑所必需的最小量（均 < 400 字符）。

## 文件

| 文件                      | 内容                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **`GPU-BACKENDS.md`**     | ★ **当年那个「未验证」项的答案**。Windows 包首次解开后的 GPU 后端全貌，含 PE 导入表实测。**结论推翻了 R-01**。 |
| **`F1-F5-PARITY.md`**     | ★ 章程 F1–F5 + 要求 2.1/2.2 的逐条对照（功能点 + 实现方式两层），以及按性价比排序的差距清单。                  |
| `ipc-channels.txt`        | 342 个 `ipcMain.handle` 通道全清单（0 个 `ipcMain.on`）。                                                      |
| `settings-schema.txt`     | 设置项 schema、默认值、12 个设置页签。                                                                         |
| `feature-list.txt`        | 用户可见功能清单（据 2170 条 locale 键 + 路由表反推）。                                                        |
| `asr-engines.txt`         | 4 个本地引擎 + 3 个可下载引擎 + 4 个云 ASR 插件，及其 47 条模型条目。                                          |
| `export-formats.txt`      | 17 种文件格式 + 2 个集成，及 21 个导出/转换 IPC 通道。                                                         |
| `win-package-listing.txt` | Windows 包完整文件清单（197 文件 / 40 目录 / 1.10 GB 解包后）。                                                |

## 产物指纹（可复现）

| 包                            | 大小        | sha256                                                             |
| ----------------------------- | ----------- | ------------------------------------------------------------------ |
| `Memo_1.7.5_win32_x64.exe`    | 305,233,832 | `6a773f00b8f2a6b2b0266ac2779fbc473086981120521e8ec8133d64663e6c97` |
| `Memo_1.7.5_darwin_arm64.zip` | 322,856,974 | `ffb5f8e03d4e5c6e88c111c3f44484dcb9c573ecfe7735efe22d2ca111c13d1d` |

来源：`https://github.com/Makememo/MemoAI/releases/tag/v1.7.5`（published 2026-06-24；
2026-08-07 复查仍是最新 release）。

## 复现步骤

```bash
apt-get install -y p7zip-full          # 当年解不开 Windows 包就是因为缺这个
apt-get install -y aria2               # 单连接被限速 24 KB/s，-x16 后 2.3 MB/s

aria2c -x16 -s16 -o Memo.exe \
  https://github.com/Makememo/MemoAI/releases/download/v1.7.5/Memo_1.7.5_win32_x64.exe

7z e Memo.exe '$PLUGINSDIR/app-64.7z'  # NSIS → 内层 7z
7z x app-64.7z                          # → resources/app.asar + addon/ + presets/ …
# app.asar（42,362 条目）用纯 Python 解析，无需 npm asar
```

## 纪律

⚠️ **只做静态取证**：解包、读文件、读配置、解析 PE 导入表。
**不运行 memo.ac 的二进制、不注册账号、不向其发送任何数据。**
