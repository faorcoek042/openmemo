# oss-scout 回执

## [2026-08-02 04:10] T-003 DONE

交付: `/root/memo/docs/research/R-03-oss-modules.md`（id: R-03, status: ready, TL;DR 20 行）

要点:
- D1–D12 各域 2–6 个候选 + 明确推荐，star/license/最近提交/发布日期**全部 2026-08-02 实地核实**（`gh api` + npm registry API + crates.io API + LICENSE 原文解码 + 官方文档 WebFetch）。
- 提出 **submodule / 包管理器 / 运行时下载 三分法判定规则**（§1，含决策树 + 3 条覆盖规则 R-A/R-B/R-C），结论是 C2「一律 submodule」不可字面执行，实际只有 6 个组件适合 submodule。
- 输出**许可证矩阵总表**（§3，40+ 条目，三级风险标注）+ FFmpeg 专题（§4）+ yt-dlp 专题（§5）+ 必须避免/需法务确认清单（§6）。
- 4 个已核实的硬坑：`ffmpeg-static` npm 是 GPL-3.0-or-later；yt-dlp 官方 release 二进制是 GPLv3+（仅 git 仓库/PyPI 是 Unlicense）；tldraw 专有许可；ten-vad 带非竞争条款。
- `vendor/` 布局 + `.gitmodules` 草案见 §7，**未执行任何 git 命令**（遵守边界，待 ADR 批准后由 T-011 执行）。

下一步建议:
- Manager 就 §1 判定规则写 ADR；同时批准 §6.1 的 CI 许可证白名单强制（`cargo-deny` + license-checker）。
- T-011 骨架搭建时必须实测 U-5（rusqlite bundled + load_extension 能否加载 libsimple/sqlite-vec）与 FFmpeg LGPL 自建（尤其 macOS）。
- `model-mgmt`(R-04) 请复用 §7.1 的 `vendor/manifests/*.json` 清单格式；模型权重许可证（L-5/U-3/U-4）整体移交 R-04。

需要 Manager 决策:
1. **C2 是否按 §1 三分法修订**（这是本文最核心的请求，其余结论都依赖它）。
2. **F1 是否采纳 §5.5 的双路径方案**（默认只做 RSS/直链，yt-dlp 降级为默认关闭的可选插件）。这直接决定商用可能性是否保留。
3. **shadcn/ui 的源码复制分发模式**与 C2「禁止复制粘贴源码」字面冲突，需 ADR 明确豁免（§2 D12 / §6.2 L-8）。
4. **是否启动法务咨询**：§6.2 列了 8 项（L-1 CLI 子进程边界、L-3 yt-dlp 分发风险、L-5 模型权重许可证为最紧要）。
5. D7 主推 `mind-elixir-core`（编辑优先，OPML/FreeMind 需自研 ~110 行序列化器）vs 备选 `simple-mind-map`（导出最全，含 xmind/pdf/md）——若产品更看重导出矩阵请回告切换。

派生 subagent 记录（未 kill，可复用）:
- `a8266c04711e120db` — FFmpeg 许可证证据收集（sonnet5，已完成）
- `a92ba69c2d5d1da17` — yt-dlp 法律/ToS/分发先例证据收集（sonnet5，已完成）

诚实声明:
- 本任务**未执行任何编译/构建**，所有"可行"结论均为基于文档与元数据的判断，标记为未跑通。
- 11 项未验证/UNKNOWN 已在文档 §8 列全，其中最关键：macOS 无维护中的 LGPL FFmpeg 预编译源（故必须自建）；所有模型权重许可证未核实。
- R-02（gpu-runtime）撰写时尚不存在，D3 的引擎选型结论以其为准，本文仅定集成方式。

---

## [2026-08-02 13:35] T-011 PROGRESS（骨架已跑通，被并发 agent 的一个类型 bug 卡住最后一步）

交付（我创建/修改的文件）:
- 根配置：`package.json`、`pnpm-workspace.yaml`、`tsconfig.json`、`tsconfig.base.json`、`.npmrc`、`.nvmrc`、`.editorconfig`、`.prettierrc.json`、`.prettierignore`、`eslint.config.js`、`.gitignore`(改)、`.gitmodules`(重写)
- 包骨架（各含 `package.json` + `tsconfig.json`）：`packages/{shared,downloader,runtime,mindmap,pipeline}`、`apps/{daemon,web}`
- 占位 `src/index.ts`：`packages/{runtime,mindmap,pipeline}`、`apps/daemon`（`shared`/`downloader` 的占位已被 `model-mgmt` 正常覆盖）
- `apps/web`：`index.html`、`vite.config.ts`、`src/{main.tsx,App.tsx,index.css}`、`src/components/ui/SOURCE.md`（ADR-002 决策 2 豁免留痕）
- `vendor/README.md`、`vendor/manifests/README.md`、`scripts/license-report.mjs`
- 5 个 submodule 已 pin 到 tag 并 stage

要点:
- **验收 4 项：3 项 EXIT=0，1 项被他人代码卡住。**
  `pnpm install` ✅ / `git submodule status` ✅（5/5 已初始化） / `license-report.mjs` ✅ / `pnpm -r build` ❌
- `pnpm -r build` **曾在 13:26 全绿跑通**（7 个项目全部构建，含 web 的 Vite 生产构建）。
  之后 `gpu-runtime` 落地 `packages/runtime/src/probe/runProbe.ts`，引入 10 个类型错误导致现在失败。
  我已在 /tmp 用**不含任何 `@openmemo/*` 依赖**的最小样例复现，证明与骨架/契约无关（详见下方"需 Manager 决策"）。
- 三分法已落地：A 类 5 个 submodule（`.gitmodules` 带 `shallow=true` + pin + 许可证注释）；
  B 类走 pnpm workspace；C 类只建 `vendor/manifests/` 目录与格式说明（`*.json` 归 `model-mgmt`）。
- **FFmpeg 的 GPL 身份已实测坐实**：`ffmpeg-static` 装出的是 `ffmpeg 7.0.2-static`，
  configure 含 `--enable-gpl --enable-version3 --enable-libx264 --enable-libx265 --enable-frei0r
  --enable-librubberband --enable-libvidstab --enable-libxvid` → **GPLv3**。与 R-03 §4.1 的判断完全一致。
  ADR-002 v2 允许，但这意味着**当前分发物已被 GPLv3 污染**，商用回滚成本已实体化。
- `yt-dlp 2026.07.04` 二进制经 `youtube-dl-exec` postinstall 装好并可执行（`--version` 已验证）。
- **补上了一个 npm 层看不见的许可证盲区**：`youtube-dl-exec` 包是 MIT，但它下载的 yt-dlp 二进制是 GPLv3+，
  `pnpm licenses list` 看不到 payload。我在 `license-report.mjs` 里加了 `BINARY_PAYLOAD_LICENSES` 表覆盖这类情况。
  现在报告能同时抓出 `ffmpeg-static` 和 `youtube-dl-exec → yt-dlp` 两项 GPL-3.0。

下一步建议:
- `gpu-runtime` 修掉 `runProbe.ts` 后 `pnpm -r build` 应即全绿（其余 6 包已验证通过）。
- `model-mgmt` 的 `packages/downloader/src/**` 有 4 个 eslint error + 1 warning 待清（我未越界修改）。
- T-011 剩余可选项：CI workflow 归 `gpu-runtime`（`.github/workflows/**` 是他的所有权），我未创建。

需要 Manager 决策 / 转达:

1. **[请转达 gpu-runtime，我无法直接 SendMessage 到他]** `packages/runtime/src/probe/runProbe.ts` 第 166 行：
   ```ts
   kind: ProbeResult extends { ok: false; kind: infer K } ? K : never,   // → never
   ```
   `ProbeResult` 是**类型别名而非裸类型参数**，条件类型**不分配**到联合成员上，整体走 false 分支得 `never`，
   导致 10 个错误里的 8 个（TS2345）。修法：
   ```ts
   kind: Extract<ProbeResult, { ok: false }>['kind'],
   ```
   已在隔离环境验证：原写法报 TS2345，`Extract<...>` 写法通过。
   另 2 个独立错误在 `runProbe.ts:103`（TS2367）：把 `signal`(`string|null`) 当 `code`(`number|null`) 比较。

2. **我动了两处"公共约定"，若不同意请驳回**：
   (a) `tsconfig.base.json` 中**刻意不开** `noUnusedLocals`/`noUnusedParameters` —— 原本开了，
       直接卡住 `model-mgmt` 的在途代码。理由：未使用变量是 lint 关注点不该阻断编译，
       eslint 已覆盖且有 `^_` 豁免。
   (b) `.gitignore` + eslint ignores 加入 `.build/` —— `gpu-runtime` 的 CMake 产物里有名为
       `compiler_depend.ts` 的**非 TypeScript 文件**，让 eslint parser 一次报 91 个错。

3. **越界申报**：BOARD 文件所有权表把 `scripts/**` 划给 `gpu-runtime`，但 T-011 任务书明确要我写
   `scripts/license-report.mjs`。我只新建了这一个文件，未碰该目录其他内容。**请 Manager 确认或调整所有权表。**

4. **商用回滚成本提示（非阻塞，仅记录）**：ADR-002 v2 的升级路径要求 GPL 组件"架构上可替换"。
   我已在 `packages/pipeline/src/index.ts` 与 `vendor/README.md` 写死了这条约束，
   但**目前只是注释，没有代码强制**。真正的适配层要等 T-020 落地，届时需要复核。

诚实声明:
- `pnpm -r build` **当前未跑通**，真实错误输出已贴在上方第 1 条，责任在 `packages/runtime/src/**`（非我所有）。
  我用"排除 runtime 的子图"做了骨架自证：`shared + downloader + mindmap + web` 全部 EXIT=0（含 Vite 生产构建）。
- `pnpm lint` **当前未跑通**（4 error + 1 warning），全部在 `packages/downloader/src/**`（非我所有）。我的文件 0 error。
- 未执行 `git commit`（任务书未要求）。5 个 submodule 已 `git add` 但未提交。
- 未创建任何 CI workflow（`.github/workflows/**` 所有权归 `gpu-runtime`）。
- better-sqlite3 是**从源码 node-gyp 编译**通过的（本机有 Python 3.14.6 + gcc）；
  **未验证**没有编译工具链的用户机器上能否装上 —— 若成问题需改用 Node 24 内置的 `node:sqlite`。
