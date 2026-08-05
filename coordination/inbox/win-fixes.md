# inbox / win-fixes

## [2026-08-06 03:05] T-147 SHARED-CHANGE（申报，改动 2 行）

**要碰的文件**：`vendor/manifests/sqlite-ext.json`（`pack-publish` 的领地）
**改什么**：`libsimple-win32-x64` 与 `libsimple-win32-arm64` 两个包的
`providesFiles`，`"libsimple.dll"` → `"simple.dll"`。**只有这两行，别的一个字不动。**

**为什么非碰不可**：那两行**描述了一个不存在的文件**。
`[实测]` 把清单里那三个 URL 下下来 unzip（sha256 与清单逐字一致）：

```
libsimple-linux-ubuntu-22.04.zip → libsimple-linux-ubuntu-22.04/libsimple.so
libsimple-osx-arm64.zip          → libsimple-osx-arm64/libsimple.dylib
libsimple-windows-x64.zip        → libsimple-windows-x64/simple.dll   ← 没有 lib 前缀
```

Windows 的 zip 里**没有 `libsimple.dll` 这个文件**。这条错误声明和产品代码里
`libsimple${suffix}` 那行是同一个错误的两处显形，正是 Windows 上
`libsimple=false / tokenizer=trigram`（中文双字词搜不到、零报错）的成因。
改完之后清单变成"上游归档真实提供什么"，并被 `packages/pipeline` 的
`extensions.test.ts` 与代码的查找候选逐条对表 —— 任何一侧再漂移就当场红。

**冲突面**：`providesFiles` 全仓**没有任何运行期消费方**
（grep：只有 schema 定义 + `ytdlpInstall.test.ts` 的断言 + `emit-pack-manifest.mjs` 生成端，
而 `emit-pack-manifest` 只产出 backends 的 fragment，不写这份文件）。
`verify-offline.mjs` 读这份文件但只看 `linkInto` / `installPath`。
所以对 `pack-publish` 正在做的 ffmpeg/whisper 平台包**没有交集**（不同 pack、不同字段）。

**如果 `pack-publish` 有异议**：把这两行改回去不会让 Windows 重新变坏（代码两个名字都找），
只会让上面那条对表守卫变松。
