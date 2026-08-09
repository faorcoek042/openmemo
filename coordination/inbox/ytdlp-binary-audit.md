## [2026-08-09 20:30] yt-dlp 二进制内嵌依赖清点 DONE

STATUS: DONE
交付: `docs/design/D-20-bundled-deps.md`（新增 §14，且更正了顶部 TL;DR 里已过时的
"未验证"标记），commit `9b3ea96`。

要点:
- **二进制里有 GPL，四平台全部命中**：`mutagen`（GPL-2.0-or-later）无条件打进
  linux-x64/linux-arm64/macos-arm64/win-x64 全部四份 PyInstaller 归档；Linux 两个
  平台（x64/arm64）另外内嵌真正的 GNU Readline（GPL-3.0-or-later，`nm -D` 命中
  `rl_gnu_readline_p` 符号排除了 libedit 替代品）。macOS 用系统自带 libedit（BSD，
  未内嵌）、Windows 无 readline，两边不触发这一条。
- 全程静态提取（`pyinstxtractor.py`），未运行任何一个目标二进制；4 个资产逐个
  `sha256sum` 核对与 `vendor/manifests/backends.json` 当前 pin 完全一致。Windows 因
  二进制是 CPython 3.10、沙箱是 3.14（`marshal` 不兼容），改用 `strings` 扫描
  `PYZ.pyz` 原始字节验证 mutagen 存在（48 处合法子模块名），置信度略低于其余三
  平台，已在文中标注，不冒充同等强度。
- **与 §9.2 冲突**：该表格当前把 yt-dlp 定为"内置"，理由栏本身写着"⚠️ 二进制内嵌
  依赖待清点（§1.1）"——本次交出的就是这份清单，结果是条件没通过。按 TL;DR/§9
  用户自定规则「GPL → 下载；非 GPL → 内置」，结论应把 yt-dlp 判回"下载"。**没有
  改 §9.2 表格文字**，冲突写在新增的 §14.6，交 Manager/用户裁。
- **没有按字面要求去改 `vendor/manifests/backends.json` 的 4 个 `ytdlp-*`
  `license.id`**（从 GPL-3.0-or-later 改成 Unlicense）：那会引入新的事实错误——
  这份二进制字节里真的有 GPL。而且 `LicenseInfoSchema`（单值字符串，直接被 UI
  展示给用户）在全仓 manifest 里没有复合许可证字符串的先例，表达不了"主项目
  Unlicense + 内嵌 GPL 依赖"这种组合事实。这本身依赖 §9.2 怎么裁——裁定后再改
  更省事，理由详见 D-20 §14.7。同理未动 `D-17-prebuilt-bundles.md:113`（不在指派
  范围，且它现在的取值方向歪打正着是对的）。
- 未创建 `THIRD-PARTY-NOTICES`：`find` 遍历过 `dist/`／`.build/`／整个源码树，
  这个 checkout 里目前**不存在**这份文件（只有 `node_modules/.pnpm/{prettier,
  rolldown}` 里两个同名无关文件）——与"已经在产物里"的说法对不上，如实记录这个
  出入。也没改 `build-bundle.mjs` 的 `writeNotices()`：它现在的文案明确说包不含
  ffmpeg/yt-dlp，这是 §9.2 那个悬而未决问题的下游，裁定前不动它。
- 提交前反复用 `git fetch` + `git diff HEAD origin/master -- docs/design/D-20-bundled-deps.md`
  确认该文件本身没有上游漂移（工作区里当时有其他至少两拨并发在改
  `packages/downloader`、`apps/daemon/src/http/rest`、`packages/shared` 等文件——
  均未触碰，`git show --stat` 复核提交后确实只有我这一个文件）。未建/改/删
  release；未碰 `:10000`、`/root/data-memo`、任何机器级指针；未用 `pkill`。

下一步建议:
- Manager/用户就 §14.6 的冲突裁一次：yt-dlp 改回"下载"，还是走工程规避（打包时
  剔除 mutagen 依赖树 / Linux 换不带 readline 支持的构建）再重新论证"内置"。
- 裁定落地后，再回头把 `backends.json` 的 4 个 `license.id`、`D-17:113`、
  `build-bundle.mjs` 的 `writeNotices()` 一次性改齐，避免多头各改一次。

需要 Manager 决策: 有——上面"下一步建议"里的两条（§9.2 yt-dlp 内置/下载的最终裁定；
裁定后清单/文档/脚本的落地顺序）。
