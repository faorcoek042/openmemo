# inbox: prebuilt

## [2026-08-08 01:20] T-预编译包（调研阶段） DONE

交付: `docs/design/D-17-prebuilt-bundles.md`

要点:
- **GPL 不触发，可以发。** 三条独立成立的依据：① 生产依赖闭包 268 个包**零 GPL/AGPL/LGPL**（逐个读已安装 package.json 的 license 字段）；② ffmpeg/yt-dlp 由用户机器直连 BtbN / yt-dlp 官方 GitHub 取，我们的 Release 上只有 6 个资产且全是 MIT 的 whisper.cpp；③ 调用方式是 `spawn(绝对路径, argv, {shell:false})` —— 进程边界，非链接。
- **推荐形态：官方 node 二进制 + 目录 + 启动脚本；否掉 Node SEA。** 决定性理由：SEA 对我们**根本产不出单文件**（sherpa-onnx 的 `.node` 旁边有 3 个必须同目录的 `.so`），代价全付、好处拿不到；且 SEA 注入会摧毁 Node 官方在 macOS 上的签名+公证。
- **[实测] 该形态已在 /tmp 里装出来并跑通**：网页 HTTP 200、`db=better-sqlite3 sqlite=3.53.4`、`dataDir` 落在 /tmp。体积 linux-x64 **162.8 MiB / .tar.xz 37.4 MiB**（实测）；win-x64 ≈117.3 MiB、macos-arm64 ≈178.9 MiB（由实测分件推算）。
- **两个平台地板实测都是绿的**（用本仓自己的守卫跑官方 node 二进制）：darwin-arm64 `minos 11.0.0` ≤13.3 ✅、linux-x64 `GLIBC_2.28` ≤2.34 ✅。用户担心的 `minos 26.0.0` 不在这条路上。
- **最容易炸的是 `sherpa-onnx` 而不是 better-sqlite3**：后者是 prebuildify + N-API，一次安装拿到全部 8 平台、跨 Node 版本通用、无 install 脚本（用户机器不需要编译工具链）；前者是每平台一个 optional dep、**pnpm 只装宿主那一个**，跨平台打包必须显式去取，且独占 macOS 包 58.8 MiB。

需要 Manager 决策:
1. **这些包发到哪里？** 公开 Release = 公开分发 → 需补 LICENSE 文件 / THIRD-PARTY-NOTICES / libsimple 的 MIT election（GPL 那条**仍不触发**）。仅自用搬运则只需第二项。
2. **libsimple + sqlite-vec 要不要进包？** +5.4 MB/平台、全 MIT、不碰 GPL。不放的话默认 `tokenizer=trigram`，**中文两字词搜索返回 0 条且不报错**（已实测到该日志）。我倾向于放，但它与用户判据 2 的字面表述有张力，不擅自决定。
3. **sherpa-onnx 留还是去？** 去掉 macOS 包从 178.9 → 约 120 MiB，代价是失去流式 ASR/VAD。我倾向于留。

顺带发现（不属本任务，交 Manager 裁决）:
- **ADR-002:24 的 `@blocknote/xl-*` (GPL-3.0) ✅允许 是空头许可** —— 该包从未被采用（package.json / lockfile / node_modules / 源码四处 grep 全 0 命中），实际用的是 TipTap（全 MIT）。建议删掉那一行：留着等于给未来的人一张引入 GPL 编辑器的通行证。
- **`scripts/build-media-tools.sh` 会把 GPL 的 ffmpeg 重打包成我们的 pack**；`mirror-model-blobs.mjs` 的白名单没有许可证闸门；`release-upload.mjs` 只校验 sha256 不校验许可证。三者今天都没触发，但都是一步之遥且不会报错。建议给 `release-upload.mjs` 加闸门（判据照 §7 补充：跑错了也不造成后果）。
- `scripts/license-report.mjs` 的 `collectManifests()` 把 manifest 包装对象当成单个组件迭代，导致 **60 条 per-pack 的 `license.id`（含 7 条 GPL-3.0-or-later）从来没被读到**；committed 的 `license-report.md` 里 B 类是空的（生成当时采集失败，之后没重生成）。
- `check-elf-glibc.mjs` 只看 `GLIBC_`，看不到 `GLIBCXX_`/`CXXABI_`；better-sqlite3 的 linux-x64 prebuild 需要 `GLIBCXX_3.4.29`（GCC 11+）。承诺范围内安全，但守卫覆盖不到。
- `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 里 `esbuild` 是陈旧条目（vite 8 用 rolldown，esbuild 根本没装）。

纪律自查:
- 未碰 `:10000`（作业前后均返回 200）、未碰 `/root/data-memo`、**未碰机器指针**（内容仍是 `/root/data-memo`，mtime 仍为 2026-08-04，早于本次作业）。实测启动全程用 `OPENMEMO_POINTER_FILE` + `OPENMEMO_DATA_DIR` 指向 /tmp，端口用 17777/17778。
- 未跑 `pkill`。未建/改/删 release。未跑 `pnpm -r build` / `vite build`，`apps/web/dist` 只读（`du` 与 `cp`）。
- 未碰版本号相关文件；只**读** `scripts/lib/version.mjs` 的 `readProductVersion()`（当前 0.2.0），包名沿用它已写好的 `openmemo-<version>-<os>-<arch>.<ext>` 约定。

下一步建议:
- 等用户对上面 3 个问题裁决后再进第二阶段（实现清单见 D-17 §9）。
- 本轮**未做任何实现**，仅调研 + 设计文档。
