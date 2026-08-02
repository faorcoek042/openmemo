# 待用户提供环境 / 决策的事项（持续累积，Wave 3 收口时一并上报）

> Meta Manager 维护。**agent 不要写这个文件**，有需求写自己的 inbox，我来汇总。
> 原则：凡是能被架构消解的 UNKNOWN，一律消解掉，不占用用户注意力（见"已消解"节）。

## A. 需要硬件 / 账号才能验证（当前全部标"未验证"，不阻塞开发）

| # | 事项 | 卡在哪 | 影响 | 不解决的后果 |
|---|------|--------|------|-------------|
| A-1 | **GitHub remote** | 仓库无 remote | `.github/workflows/build-backends.yml` **从未执行** | mac / Windows 的 whisper.cpp 后端二进制**产不出来** → 要求 2.1 在这两个平台无法端到端验证 |
| A-2 | **一台 NVIDIA 显卡机器** | 本机无 GPU | CUDA vs Vulkan 性能比 = UNKNOWN | **优先级已降回普通（ADR-013 §0 作废了 ADR-011 决策 2）。** 我上一轮据「中文必须用 large-v3-turbo，CPU 上仅 2.7x 实时」把它上调为最高优先级，**这个前提已被推翻**：实测 `paraformer-zh-small` **84x 实时（1 小时录音 43 秒）、专有名词 12/13**，比 turbo 快约 32 倍。无显卡的中文用户已经够用。GPU 仍值得做（英文 large 模型、LLM 推理），但**不再是产品可用性门槛** |
| A-3 | **一台 macOS 机器** | 无 | ① Gatekeeper 是否拦截下载的原生二进制 ② `better-sqlite3` mac prebuild ③ Metal/CoreML 后端 | mac 分发形态无法定案（ADR-003 决策 4 的 ad-hoc 签名方案未经实测） |
| A-4 | **一台 Windows 机器** | 无 | ① SmartScreen 行为 ② `better-sqlite3` win prebuild ③ CUDA/Vulkan 后端 | 同上 |
| A-5 | **arm64 / musl 环境** | 无 | 上游 open issue **#1509**：`better-sqlite3` 的 `linux-arm64.node` 要求 GLIBC_2.38 | Apple Silicon 与树莓派/Alpine 用户可能装不上，**未复现** |
| A-6 | **一台中国大陆机器** | 本机在美国 IP | `hf-mirror.com` 从美国 IP 一律 308 跳回 HF（地理围栏）→ 国内实际行为无法验证 | **已架构消解**（见下），仅剩"想知道"层面 |

## B. 已被架构消解的 UNKNOWN（**不需要用户操心，记录备查**）

| 原 UNKNOWN | 消解方式 |
|---|---|
| hf-mirror 国内是否可用 | 改为**可配置源列表 + 首次下载前并发探测选最快可用源 + 失败自动切换**。无论它可不可用，产品行为都正确（ADR-004 决策 1） |
| Safari 是否支持 Web Locks | 改为**特性检测 + 不可用时降级回"最后一个标签页胜出"**。无论支持与否都正确（ADR-007 决策 5） |
| 用户机器有没有编译工具链 | 前提已证伪：`better-sqlite3` v13 用 prebuildify，8 平台预编译打在 tarball 里、无 install 脚本（ADR-005 决策 6，TD-003 已关闭） |
| 装了用不上的 GPU 后端包会不会拖累性能 | 实测：**零损耗静默回落**（ADR-003 附录 A.1） |

## C. 产品方向类（非环境，纯偏好，可随时改）

| # | 事项 | 现状 | 备注 |
|---|------|------|------|
| C-1 | 桌面外壳是否要做 | ADR-003 定为**后置可选**（Tauri v2 包一层指向 daemon） | 当前 web-first 已满足"使用网页接入"，不做也能用 |
| C-2 | 翻译 / 双语字幕 / 字幕导出 | ADR-006 决策 6 **不进 v1**（章程 F1–F5 未含） | D-02 已预留表，想加随时能加 |
| C-3 | L0 浏览器 WebGPU 档 | ADR-006 决策 3 **降级为实验特性** | 理由：用户必须先装 daemon 才能开网页，而 daemon 自带 L1 CPU 后端，L0 边际价值小 |
| C-4 | 是否引入 workspace 层级 | ADR-006 决策 4 **不引入**，只做 folders 树 | 日后加只需一列 + 一次迁移 |

## D. 已记录的技术债（我自己管，不需用户决策）
见 `docs/adr/ADR-005-workspace-conventions.md` 技术债登记表：
TD-001 重开 `noUnusedLocals`（Wave 3 前）· TD-002 ffmpeg/yt-dlp 适配层（T-020 进行中）·
~~TD-003~~（已关闭，前提证伪）
