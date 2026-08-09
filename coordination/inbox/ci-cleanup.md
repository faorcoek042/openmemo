# CI / Actions 清理 —— 清单与依据（**本轮不动手，等 Manager 过目**）

## [2026-08-09] e2e-import 提交

**结论先说：按"量出来"的判据，17 条 workflow 里 `删 = 0`。**
没有一条是"不再使用"的。真正能清的是**一处 action 版本不一致**（§D）。

用户点名要"清理不再使用的 action 与 CI"，而我量完之后的诚实回答是：
**这里没有死的东西可删。** 报一个"清理了 5 条"的成绩，需要我把某条腿说成没用 ——
而这一整轮反复吃的亏正是"一条腿看起来没用、其实是唯一在验某件事的东西"。

## A. 三条证据的量法

1. **最近运行时间**：`gh run list --workflow <x>.yml --limit 1`
2. **被引用**：`grep -rIl` **全文件类型**（`.mjs/.yml/.sh/.md/.json/.ts`），
   ⚠️ **不信任何现成清单** —— 孤儿检查器只扫 `.tsx?`，看不见 `.mjs` 与 `.yml`
3. **它验的事今天还有没有别人在验**：逐条读 workflow 与它调的脚本

**第 1 条的结果本身就是结论**：**17 条全部在 08-06 ～ 08-09 之间跑过，没有一条休眠。**

## B. 逐条判定

| workflow | 最近 | 触发 | 非 inbox 引用 | 判定 | 依据 |
| --- | --- | --- | --- | --- | --- |
| `build-backends` | 08-07 | dispatch | `build-bundle.mjs`、`selftest-ci-manifest.mjs`、`components.json` | **留** | 后端包的唯一产出口；dispatch 是**刻意**的（编 8 条腿、几百 MB） |
| `build-bundles` | 08-09 | auto+dispatch | `emit-e2e-attestation.mjs`、`emit-bundles-complete.mjs`、`verify-e2e-attestation.mjs` | **留** | 六条腿与发布闸门的输入源，动它等于动全部 |
| `bundle-launch-sim` | 08-08 | dispatch | `D-19` | **留（不是重复）** | 见 §C —— **它是唯一验"已发布的那堆字节"的** |
| `ci-crossplatform` | 08-09 | auto+dispatch | `lint-workflows.mjs`、`testPorts.test.ts`、`upload.test.ts` | **留 + 修** | 见 §E —— **它红是因为它抓到了东西** |
| `ci` | 08-09 | push/PR | —— | **留** | 唯一的 push/PR 门禁 |
| `cold-start-audit` | 08-08 | auto+dispatch | 60 处（含 `e2e-import-audit.mjs`、`probe-cold-timing.mjs`） | **留** | dispatch 是刻意的（真下几百 MB + 真转写） |
| `e2e-allcomponents` | 08-09 | dispatch | `check-release-refs.mjs`、`package.json` | **留（别动）** | 在发布闸门腿单里；另一路正在修它的红 |
| `e2e-browser` | 08-09 | dispatch | `check-pending-claims.mjs`、`launcher-spawn.mjs` | **留** | 在闸门腿单里 |
| `e2e-coldstart` | 08-08 | dispatch | `e2e-allcomponents.mjs`、`launcher-spawn.mjs` | **待定** | 见 §F —— 与 `cold-start-audit` 可能有重叠，我没查清 |
| `e2e-datadir` | 08-09 | dispatch | **只有它自己的 yml** | **留** | 引用数低≠没用，见 §G |
| `e2e-import` | 08-08 | dispatch | 多 | **留** | 闸门腿单 |
| `e2e-notes` | 08-08 | dispatch | 多 | **留** | 闸门腿单 |
| `e2e-record` | 08-08 | dispatch | 多 | **留** | 闸门腿单 |
| `e2e-runtime` | 08-08 | dispatch | 多 | **留** | 闸门腿单 |
| `mirror-model-blobs` | 08-06 | dispatch | `release-upload.mjs`、`lint-workflows.mjs` | **留** | `lint-workflows` 对它有专门断言（删了会带走断言） |
| `probe-cold-timing` | 08-07 | dispatch | `probe-warmup-verify.mjs`、**`apps/daemon/src/runtime/warmup.ts`** | **留** | 它是**产品里那个预热常量的出处**，删了常量就没了来源 |
| `release-upload` | 08-06 | dispatch | `selftest-release-upload.mjs`、`lint-workflows.mjs`（一整组权限断言） | **留** | 发布通道本体 |

⚠️ **"手动触发"没有被算作删除理由**：`build-backends` / `cold-start-audit` /
`probe-cold-timing` 都是刻意做成手动的（贵、且不该每次 push 都跑）。
**"不自动跑"与"该删"是两件事。**

## C. `bundle-launch-sim`：独立版**没有**被嵌入版取代

两边跑的是**同一个脚本**（`simulate-user-launch.mjs`），但**问的不是同一个问题**：

| | 包从哪来 | 模式 |
| --- | --- | --- |
| `build-bundles` 内嵌（3 条腿各一次） | `steps.bundle.outputs.archive` —— **刚构建出来的** | `--mode guard` |
| `bundle-launch-sim` 独立 | **`gh release download "<tag>"`** —— **用户真正下载到的那堆字节** | `--mode diagnose` |

**独立版是唯一验"已发布产物"的东西。** 内嵌那版验的是"我们刚打出来的包能启动"，
它**结构上看不到**"上传到 release 之后那堆字节还能不能启动"
（归档被替换、上传截断、tag 指错、平台资产贴错位置 —— 都发生在构建之后）。

`v0.2.0` 的教训正是这一族：**构建绿了，用户下到手的那个打不开。**
所以这条**留**，且我建议不要合并进 `build-bundles`（合并就等于把"发布后"这一格取消掉）。

## D. 唯一真正可清的东西：`actions/download-artifact` 版本不一致

```
35  actions/setup-node@v6         ✔ 一致
35  actions/checkout@v6           ✔ 一致
21  actions/upload-artifact@v6    ✔ 一致
 5  actions/download-artifact@v6  ← 与下面这条**同仓不同版**
 3  actions/download-artifact@v7  ←
 3  ggml-org/ccache-action@v1
 2  jakoch/install-vulkan-sdk-action@v1
 1  jlumbroso/free-disk-space@v1
```

**`download-artifact` 同时钉着 v6 与 v7。** 这是本轮唯一一处"过期/不一致的 action 版本"。

⚠️ **但我没有改**，两个理由：
1. v6→v7 有行为差异（尤其 `merge-multiple` / 路径展开），**改错了会让取件静默变形**，
   而取件正是六条腿与发布闸门的入口。
2. ⚠️ **`v0.5.0` 的包正在建（run 31298961998），Manager 建好要跑六条腿。**
   这个窗口里动取件语义，红了会被误读成腿坏了。**建议发完再改，改完各腿真跑一次。**

`[未验证]` 我没有逐个确认 v6 与 v7 在这 8 处调用点上是否行为等价。

## E. `ci-crossplatform` 红在哪：**它红是因为它抓到了东西**

run `31298418469`：`linux-x64 (control)` **success**，`darwin-arm64` 与 `win32-x64` **failure**。
失败步骤是 **`CI scripts self-test`**（macOS 上另有 `Test`）。

失败内容是 `selftest-bundle.mjs` 的一整组断言，第一条是：

```
✘ ① linux-x64 完整包 → exit 0，实测「检查了 ? 条、失败 0 条」（下限 20）
```

那个 **`?`** 是关键：它没能从 `verify-bundle.sh` 的输出里解析出条数
（Linux 上是 `检查了 26 条`）。也就是说 —— **被测的 `verify-bundle.sh`（bash）
或它的调用方式在 macOS / Windows 上不成立**，而 Linux 对照组是绿的。

**这正是 `ci-crossplatform` 存在的理由**：把测试与 CI 自检搬到另外两个平台上跑。
它今天验的东西**没有别人在验**（`ci` 只跑 Linux）。

⚠️ **所以判定是「留 + 修」，不是「删」。** 因为它红就删它，等于**把它抓到的那个
跨平台缺陷一起删掉** —— 而这个仓库刚立过的判据是：失败会被查，**假通过不会**。
`[未验证]` 根因我只定位到"解析不出条数"，**没有查到是 macOS bash 3.2 还是 Windows 的 bash**
（本仓已有一条 `macOS bash 3.2 变量名坑` 的前科，形状相似但我没核实是不是同一个）。

## F. `e2e-coldstart`：**待定**（我说不清，所以不删）

- 不在发布闸门腿单里（闸门是 `import,notes,record,runtime,browser,allcomponents`）。
- 被 `e2e-allcomponents.mjs` 与 `launcher-spawn.mjs` 引用。
- 与 `cold-start-audit` **可能**有重叠：两者都做"全新数据目录 + 冷启动"。

**但我没有逐条比对两者的断言集**，所以不下结论。
按 Manager 的话：**"待定也是合格结论"** —— 我宁可留着一条说不清的，
也不要一次看起来干净的清理把某个唯一验证点带走。
建议：由 `e2e-coldstart` 的主人给一句"它验的哪几条是 cold-start-audit 没有的"。

## G. `e2e-datadir`：引用数最低（只有它自己），但**留**

`grep` 全仓只有它自己的 yml 提到它 —— 按"引用数"排它最像死的一条。**但那是错觉**：

- 它是**叶子腿**：workflow 直接调 `scripts/ci/datadir-migrate-audit.mjs`，
  没有别的脚本需要"引用"它。**叶子节点的引用数天然是 0。**
- 它验的是**数据目录搬迁（含跨卷）**，三平台各一次。
- ⚠️ **此刻正有一路在改这块**（`storage.ts` / `moveWithDb.ts` / `packages/db`）——
  这条腿是那批改动在 CI 上唯一的三平台验证。**这个时候删它是最坏的时机。**

**"引用数低"只说明没人从代码里叫它，不说明没人靠它。** 这正是 §A 第 3 条要问的那件事。

## H. 重复的 shell / 抽取情况

`resolve-bundle.mjs` 与 `resolve-bundle-run.sh` 已经把"取产物 → 解包 → 找包根 → 验结构"
和"挑哪一次 run"这两段抽走了（本仓为此栽过三次）。
本轮**没有再发现 5 行以上、跨多个 workflow 近乎逐字重复的 shell 块**。
`[未验证]` 我是按目视 + 关键字比对的，没有做逐行相似度扫描。

## I. `lint-workflows` 的断言数

当前 **1582 条 / 17 个 workflow**。
本轮**一条 workflow 都没删**，所以断言数**不应变化** —— 跑完仍是 1582。
将来真要删某条时：先记下删前数字，删后确认**减少量对得上那条 workflow 的断言数**，
别让某条守卫在清理里被顺手抹掉。

## J. 有没有哪一条是"唯一在验某件事"的

**有三条，都不能删：**

1. **`bundle-launch-sim`（独立版）** —— 唯一验**已发布的那堆字节**能不能启动（§C）
2. **`ci-crossplatform`** —— 唯一在 macOS/Windows 上跑测试与 CI 自检的（§E）
3. **`probe-cold-timing`** —— 产品里那个预热常量的**出处**（`warmup.ts` 引用它）

## K. 我建议的下一步（等 Manager 拍板）

1. `v0.5.0` 发完之后，**统一 `download-artifact` 到一个版本**，改完让六条腿各真跑一次。
2. **修 `ci-crossplatform`**（`selftest-bundle.mjs` 在 darwin/win 上解析不出条数），
   而不是让它一直红 —— 一条常态红的腿等于一条被删掉的腿。
3. `e2e-coldstart` 的重叠问题，由它的主人给一句话，再决定合并还是留。
4. **本轮删除数 = 0**，这是量出来的结论，不是没查。
