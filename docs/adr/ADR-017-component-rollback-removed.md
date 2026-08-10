# ADR-017 组件回滚：删掉，不实现

**状态**：已决定（T-157 ② 删前端入口 → 本次删干净后端管道）
**影响面**：`packages/downloader/src/components.ts`、`packages/shared/src/components.ts`（`ComponentStatus`）、`POST /api/components/:id/rollback`、`apps/web/src/features/components/**`

## 结论

**OpenMemo 不提供组件回滚。** 更新的诚实边界是：**下载/校验/解包失败 ⇒ 当前版本原地不动；更新成功之后没有退路。** 界面上就是这么说的，不再承诺"旧版本会保留、出问题可以一键回滚"。

## 曾经存在什么

一整套看起来完整、但**从未运行过一次**的管道：

| 符号                                | 状态                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| `stashForRollback()`                | 全仓**零调用方** ⇒ `.prev-<version>` 目录从来没被创建过 |
| `discardRollback()`                 | 零调用方（没有备份就没有什么可丢弃）                    |
| `rollback()`                        | 唯一调用方是那个恒 409 的端点                           |
| `readRollbackVersions()`            | 恒返回空 Map                                            |
| `ComponentStatus.rollbackVersion`   | 恒 `null`                                               |
| `POST /api/components/:id/rollback` | 零调用方；**openapi 从未描述过它**                      |
| 前端「回滚到 X」按钮                | **一次都没渲染过**（T-157 ② 已删）                      |

判据是用户给的那条：**「引导动作的按钮跳转后的逻辑能解决对应问题就补上，否则删掉」**。T-157 ② 删了入口，本次删掉剩下的管道 —— 因为"补上"的代价见下，而它换来的东西见「为什么不值」。

## 为什么"补上"不是接一根线（四条理由）

### 1. `by-name/` 是工具发现的搜索路径 —— **对可执行文件已不成立，对非可执行文件仍成立**

原始裁决写的是「`findInBackendPacks()` 取第一个命中，多出一个 `.prev-` 目录就会静默跑到旧二进制上」。**这句今天只对了一半**，重写如下：

- **可执行文件这条路已经修好了。** `packages/pipeline/src/tools.ts` 的 `resolveBackendTool()` 现在按 **tier → priority → 包名** 三层确定排序（`rankOf`），并且注释里明说"任何一层留成 `readdir` 顺序，这个函数就又变回看文件系统心情"。`.prev-` 目录**没有 origin 记录** ⇒ rank `[2, 0, name]` ⇒ 排在所有已知包**之后**。所以它不会再抢走 `whisper-cli`。
- **非可执行文件这条路还是老样子。** 同文件的 `findFileInBackendPacks()`（`.so`/`.dll`/词典目录走这条，因为它们没有 exec 位）**没有任何排序**：两层 `readdir` 拼候选列表，然后 `for (const c of candidates) if (await fileExists(c)) return c;` —— **纯 `readdir` 顺序，第一个存在即返回**。多一个 `.prev-` 包，`libsimple.so` / `libsimple.dll` / jieba 词典就多一个候选，谁赢看文件系统心情。`materializeSqliteExtensions()`（T-147）吃的正是这条路。

> 记这条的方式：**「部分失效」和「整条失效」是两回事。** 一条陈旧的理由不要整条划掉，要重写成还成立的那部分 —— 否则下一个人会拿"理由 1 已经不成立"当成"可以接上了"。

### 2. 磁盘无人回收

后端包最大 **678 MB**（`whispercpp-cuda-12.4-win-x64`）。`collectGarbage` 只认 `orphan_blobs` / `stale_partials`，`buildStorage` 也不统计 `.prev-*`。用户会平白少掉几百 MB，**而且在界面上看不到**。

### 3. 索引键 ≠ 查表键

`readRollbackVersions` 用**目录名**建索引（`<name>.prev-<version>` 的 `<name>`），`listComponents` 用**组件 id** 查表。这台机器上 4 个已装后端组件里 3 个两者不同（`whisper-bin-ubuntu-x64` vs `whispercpp-cpu-linux-x64`）。`rollback()` 也按 id 拼路径，同样对不上。**哪怕 `.prev-` 目录真被创建出来，也查不中。**

### 4. `kind` 映射对模型是错的

`rollbackKindOf('model') === 'asr'`，而模型是**单文件**（`by-name/asr/ggml-base-q5_1.bin`）不是目录。`fs.rename` 会把文件改名成 `xxx.bin.prev-<v>`，于是"模型不见了"。

## 为什么不值：备份下来的多半就是当前这一版

这条比上面四条更釜底抽薪，是删除决定的主要依据。

`apps/daemon/src/http/rest/components.ts` 的更新分支自己写着：**「更新 = 安装清单里钉死的那个版本」** —— `ComponentRecord` 只有 sha256、**没有下载 URL**，上游报了个更新的 tag 不等于我们手上有它的 sha256，所以不假装能升到任意上游版本。

于是：`updateAvailable` 比的是 `pinnedVersion` vs 上游 latest，**装的却是 `pinnedVersion`**。常态下 `installedVersion == pinnedVersion` ⇒ 用户点「更新」其实是**重装同一版** ⇒ 真接上回滚之后，`.prev-<同一个版本号>/` 里躺的是**当前版本的副本**，白占最多 678 MB。

> **一个备份机制，在最常见的路径上备份的是它自己。**

只有升级 OpenMemo 本体（`vendor/manifests/components.json` 的 pinned 变了）之后再点更新，备份才是真的上一版。

## 将来真要做，需要补哪一环

**先改安装临界路径。** 今天 `installer.ts` 是：

```
fs.rm(finalDir, { recursive: true, force: true })   ← 旧树被**删掉**
fs.rename(source, finalDir)
```

旧树是**删掉**的，不是挪走的 —— **没有一个"已经挪走、只是没命名成 `.prev-`"的步骤等着改名**。所以 `stashForRollback` 不是改个名字，是要把安装改成：

```
rename(finalDir → backup)   →   rename(temp → finalDir)   →   成功/失败两路收尾
```

也就是**动本仓最不该动的那条路径**。除此之外还要：

1. 把备份挪出 `by-name/`（例如 `<root>/rollback/<kind>/<组件 id>@<version>/`，顺带解决理由 3 的键不匹配）；
2. 给 `collectGarbage` 与存储统计加上这一项（理由 2）；
3. 定保留策略（留几份、什么时候丢）；
4. 区分单文件与目录（理由 4）；
5. 让「更新」能装到 pinned 以外的版本，否则见上一节 —— 备份的是它自己。

那是一次独立的功能改动，不是"接上一个调用"。

## 重新引入会被什么挡住

契约里再加回 `rollbackVersion` 而没有消费者 ⇒ **孤儿导出棘轮 + 契约字段读者门禁**会红。所以这里没有留测试用例看着 —— 一条钉住零的腿（"前端不认识这个字段"）在字段和实现都不存在之后，测的是零；**要么明确标注它测的是零，要么删掉**。此处选择删掉，由上面两道真的会红的守卫接管。
