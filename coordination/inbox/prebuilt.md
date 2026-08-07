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

---

## [2026-08-08 02:20] T-预编译包（第二阶段实现） PROGRESS

交付:
- `scripts/build-bundle.mjs`（组装器）· `.github/workflows/build-bundles.yml`（三平台腿）
- `scripts/ci/verify-bundle.sh`（出厂检查，26 条）· `scripts/ci/verify-bundle-upgrade.mjs`（升级安全性，10 条）
- `scripts/ci/check-bundle-macos-floors.mjs`（macOS 分层守卫）
- `LICENSE` · 包内自动生成的 `THIRD-PARTY-NOTICES`
- `scripts/ci/check-elf-glibc.mjs`（补 GLIBCXX_/CXXABI_）+ 自检 34 例
- `scripts/ci/release-upload.mjs`（许可证闸门）+ 自检 18 例（新增 RV11/RV12）
- `scripts/ci/mirror-model-blobs.mjs`（许可证闸门）· `scripts/build-media-tools.sh`（GPL 确认闸门）
- `scripts/ci/cold-start-audit.mjs`（新增 `--bundle`）· `docs/adr/ADR-002`（撤销那一行）
- `docs/design/D-17-prebuilt-bundles.md`（补实测结果 + §10 三条 CI 发现）

要点:
- **三个平台的包都在干净机器上真的转出了非空文本**（CI 实测，run 31204790920 / 31205369931）：
  linux-x64 / win-x64 / macos-arm64 各拿到 108 字符，**借宿主 PATH 的 0 个**。
  体积全部换成实测值：176.3/41.0 · 132.0/49.0 · 192.4/59.9 MiB（未压缩/归档）。
- **sherpa 漏取当场红**：组装器无降级路径（找不到即退出 1），`verify-bundle.sh` 对**解开后的归档**
  再验一次原生件数量。两侧都反向验证过（抽掉 sherpa → exit 1）。
- **升级不坏数据目录有证据**：旧安装写数据 →**整个删掉旧安装**→ 新安装（不同路径）读同一数据目录。
  10 条断言全绿，含"数据库没被重建"与"机器指针未被改动"。
- **裁决 ② 的收益是实测到的**：`tokenizer=simple vec=on`（此前 `trigram/off`）。
- 反向验证（/tmp 隔离副本，§10）：基线绿；植入 ffmpeg / 抽 libsimple / 抽 sherpa / 抽网页 / 抽 LICENSE
  **五个变异全部 exit 1**。

需要 Manager 决策（3 条，都是 CI 实测出来的**产品事实**，不是缺陷）:
1. **⚠️ macOS 平台表与事实不一致。** 四个**上游预编译**二进制高于 README 承诺的 13.3：
   `libonnxruntime*.dylib` **15.5.0**、`sherpa-onnx.node` **14.0.0**、`ext/vec0.dylib` **14.0.0**。
   通过的：node / better-sqlite3 / **libsimple** 全是 11.0.0（**中文搜索不受影响**）。
   后果是**静默失效**（loadExtensions 不阻塞启动；sherpa 是容忍失败的懒加载）。
   我已把守卫改成分层（CORE 硬卡 13.3，可降级组各自声明 floor，上游再抬一档仍当场红），
   但 **README 的平台表是对外承诺，不在我职权内**。三个选项见 D-17 §10.2，我倾向
   「保留 13.3 + 在表里注明这两个功能各自的 floor」。
2. **daemon 的 `/api/health` 早于路由表应答**（D-17 §10.3）。`server.ts:122` 直接答 health，
   而 `main.ts:844` 才 push 路由 —— 中间有真空。Windows 上撞到了（`POST /api/folders` 404），
   Linux/macOS 没撞到。`server.ts:39` 的注释显示**单实例探测早就撞过同一个窗口**。
   我只改了自己的就绪判据；**窗口本身没修**，属 daemon 启动顺序。
   影响面：任何"health 通了就打业务接口"的调用方，含单实例探测与前端首屏。
3. **`test:ci-scripts` 需要接上我的新守卫**，但根 `package.json` 当时有版本号 agent 的在途改动，
   按"逐文件 stage"我没有碰它。请在版本号那条线落地后补上
   `verify-bundle.sh` / `verify-bundle-upgrade.mjs` 的自检挂载（或授权我来做）。

不是我的红（如实申报，未触碰）:
- `pnpm check:orphans` 现有 **2 条新的零引用导出**：`apps/web/src/features/runtime/api.ts ::
  useBreakerQuery / useBreakerResetMutation` —— 断路器那条线的在途产物（功能只做了一半）。
- `npx eslint .` 有 **1 条不是我的**：`packages/runtime/src/selfcheck.test.ts:1089 Irregular whitespace`。
  我名下的 3 条已修。

纪律自查:
- 未碰 `:10000`、`/root/data-memo`、机器指针（升级验证里有一条断言专门核对指针未被改动，全绿）。
- 未跑 `pkill`。**未建/改/删任何 release**（只 `workflow_dispatch` 跑 CI，权限是 `contents: read`）。
- 逐文件 stage，每次 commit 前 `git diff --cached --name-only` 核对；未碰 `apps/web`、
  `package.json`、`packages/runtime/src`、`apps/daemon/src`。
- 反向验证全部在 `/tmp` 隔离副本上做（§10），共享树未出现中间态。
